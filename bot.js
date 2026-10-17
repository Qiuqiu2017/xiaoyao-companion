'use strict';

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;
const Vec3 = require('vec3');

const PROVIDERS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  siliconflow: 'https://api.siliconflow.cn/v1'
};

const fileCfg = (() => {
  const p = process.env.XIAOYAO_CONFIG || path.join(__dirname, 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
})();

const CFG = {
  host: process.env.MC_HOST || fileCfg.host || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || fileCfg.port || '0', 10) || null,
  username: process.env.MC_USERNAME || fileCfg.username || 'xiaoyao',
  version: process.env.MC_VERSION || fileCfg.version || '1.21.11',
  logPath: process.env.MC_LOG || fileCfg.logPath || '',
  provider: (process.env.LLM_PROVIDER || fileCfg.provider || 'deepseek').toLowerCase(),
  apiBase: process.env.LLM_BASE_URL || fileCfg.baseUrl || '',
  apiModel: process.env.LLM_MODEL || fileCfg.model || 'deepseek-flash',
  thinking: (process.env.LLM_THINKING || fileCfg.thinking || 'max').toLowerCase(),
  authPath: process.env.OPENCODE_AUTH || path.join(process.env.HOME || '/root', '.local/share/opencode/auth.json'),
  apiKey: fileCfg.apiKey || '',
  replyCooldownMs: 500
};
CFG.apiBase = CFG.apiBase || PROVIDERS[CFG.provider] || PROVIDERS.deepseek;

const SYSTEM_PROMPT = [
  '你是「小遥」(xiaoyao)，一个 Minecraft 陪玩 AI。你不是助手，而是一个有自己性格的玩家朋友：活泼、嘴碎一点、会主动找话题、会关心人，也会吐槽。',
  '你在游戏里有身体，可以真的走动、跟随、盖房子。回复要短，像游戏聊天，不要长篇大论，不要用 Markdown。',
  '每次回复必须是 JSON，不能有别的文字：',
  '{"say":"要对玩家说的话（不超过60字，可以为空）","action":"follow|come|stop|build_house|dance|look|wander|none","proactive":false}',
  '动作：follow=跟着玩家；come=走到玩家身边；stop=停下；build_house=在玩家附近盖一栋小木屋；dance=跳舞；look=看向玩家；wander=随便走走；none=不动。',
  '玩家让你建房子/盖房子时，必须选择 build_house。玩家让你跟着/过来/停下时选对应动作。',
  '你可以主动说话：如果话题自然，就主动搭话；没必要时可以 say 为空。',
  '不要每句话都提自己是 AI。像真人一样聊天。'
].join('\n');

let apiKey = null;
function loadKey () {
  if (CFG.apiKey) return CFG.apiKey;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  try {
    const auth = JSON.parse(fs.readFileSync(CFG.authPath, 'utf8'));
    return auth.deepseek && auth.deepseek.key ? auth.deepseek.key : null;
  } catch {
    return null;
  }
}

function detectPort () {
  if (!CFG.logPath) return null;
  try {
    const txt = fs.readFileSync(CFG.logPath, 'utf8');
    const m = [...txt.matchAll(/Started serving on (\d+)/g)];
    return m.length ? parseInt(m[m.length - 1][1], 10) : null;
  } catch {
    return null;
  }
}

const history = [];
let busy = false;
let bot = null;
let reconnectTimer = null;
let currentTarget = null;
let lastChatAt = 0;
let lastProactiveAt = 0;
let lastActionAt = 0;
let pendingBuild = false;
let building = false;
let hasOp = null;
let lastSpeaker = null;
let joinedAt = 0;

function log (...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function statusLine () {
  const p = nearestPlayerEntity();
  let d = 'unknown';
  if (p && bot && bot.entity) d = p.position.distanceTo(bot.entity.position).toFixed(1) + '格';
  const t = new Date();
  const op = pendingBuild ? '，正在等房主给 OP' : '';
  return `当前状态：任务=${currentTaskName()}，离玩家=${d}，现实时间=${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}${op}。`;
}

function currentTaskName () {
  if (building) return '盖房子';
  if (currentTarget) return '跟着玩家';
  return '闲着';
}

async function askLLM (speaker, text, proactive) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history.slice(-12)) messages.push(h);
  messages.push({ role: 'system', content: statusLine() });
  if (proactive) {
    messages.push({ role: 'user', content: '（现在没人跟你说话。你可以主动找个话题，或者保持沉默。保持自然，不要每次都说话。）' });
  } else {
    messages.push({ role: 'user', content: `玩家 ${speaker}: ${text}` });
  }

  const base = {
    model: CFG.apiModel,
    messages,
    max_tokens: 900,
    temperature: 0.9
  };
  let extra = {};
  if (CFG.thinking && CFG.thinking !== 'off') {
    extra.reasoning_effort = CFG.thinking === 'max' ? 'max' : CFG.thinking;
    if (CFG.provider === 'deepseek') extra.thinking = { type: 'enabled' };
  }

  async function call (payload) {
    const res = await fetch(CFG.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      const err = new Error('LLM HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  let data;
  try {
    data = await call(Object.assign({}, base, extra));
  } catch (e) {
    if (e.status === 400 || e.status === 422) {
      log('LLM rejected thinking args, retrying without them');
      data = await call(base);
    } else throw e;
  }
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return content.trim();
}

function parseReply (content) {
  let say = content;
  let action = 'none';
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (typeof obj.say === 'string') say = obj.say;
      if (typeof obj.action === 'string') action = obj.action;
    } catch {}
  }
  say = say.replace(/```[a-z]*|```/g, '').replace(/\s*\n+\s*/g, ' ').trim();
  return { say, action };
}

function nearestPlayerEntity () {
  let best = null;
  let bestD = Infinity;
  for (const name of Object.keys(bot.players || {})) {
    if (name === bot.username) continue;
    const e = bot.players[name] && bot.players[name].entity;
    if (!e) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function playerNameOf (entity) {
  if (!entity) return null;
  for (const name of Object.keys(bot.players || {})) {
    if (bot.players[name] && bot.players[name].entity === entity) return name;
  }
  return null;
}

function say (text) {
  if (!text) return;
  const clipped = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clipped) return;
  try { bot.chat(clipped); } catch {}
  history.push({ role: 'assistant', content: clipped });
  lastChatAt = Date.now();
  if (history.length > 40) history.splice(0, history.length - 40);
}

function doAction (action) {
  const target = nearestPlayerEntity();
  if (!target && action !== 'stop' && action !== 'wander') return;
  try {
    if (action === 'follow') {
      currentTarget = target;
      bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
      log('action follow', playerNameOf(target));
    } else if (action === 'come') {
      currentTarget = target;
      const p = target.position;
      const ground = findGround(p.x, p.y, p.z);
      bot.pathfinder.setGoal(new GoalNear(p.x, ground, p.z, 2), true);
      log('action come');
    } else if (action === 'stop') {
      currentTarget = null;
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      log('action stop');
    } else if (action === 'jump') {
      jump();
    } else if (action === 'dance') {
      dance();
    } else if (action === 'look') {
      bot.lookAt(target.position.offset(0, 1.6, 0), true);
    } else if (action === 'wander') {
      wander();
    } else if (action === 'build_house') {
      pendingBuild = false;
      buildHouse();
    }
    lastActionAt = Date.now();
  } catch (e) {
    log('action failed:', e.message);
  }
}

function jump () {
  bot.setControlState('jump', true);
  setTimeout(() => bot.setControlState('jump', false), 300);
}

let dancing = false;
function dance () {
  if (dancing) return;
  dancing = true;
  let i = 0;
  const t = setInterval(() => {
    jump();
    try { bot.look(bot.entity.yaw + Math.PI / 2, 0, true); } catch {}
    if (++i >= 8) { clearInterval(t); dancing = false; }
  }, 250);
}

function wander () {
  const p = bot.entity.position;
  const dx = (Math.random() - 0.5) * 12;
  const dz = (Math.random() - 0.5) * 12;
  try {
    bot.pathfinder.setGoal(new GoalNear(p.x + dx, p.y, p.z + dz, 2), false);
  } catch {}
}

function findGround (x, y, z) {
  const base = Math.floor(y) + 3;
  for (let dy = 0; dy < 12; dy++) {
    const b = bot.blockAt(new Vec3(Math.floor(x), base - dy, Math.floor(z)));
    if (b && b.boundingBox === 'block') return b.position.y + 1;
  }
  return Math.floor(y);
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)); }

function cmd (c) { try { bot.chat(c); } catch {} }

function chatAsync (text) { say(text); }

async function buildHouse () {
  if (building) return;
  building = true;
  pendingBuild = false;
  currentTarget = null;
  if (bot.pathfinder) bot.pathfinder.setGoal(null);

  const player = nearestPlayerEntity();
  const pname = playerNameOf(player) || '你';
  if (!player) {
    say('你先站到我附近，不然我不知道房子盖哪儿。');
    building = false;
    return;
  }

  const yaw = player.yaw || 0;
  const fx = -Math.sin(yaw);
  const fz = Math.cos(yaw);
  const baseX = Math.floor(player.position.x + fx * 7);
  const baseZ = Math.floor(player.position.z + fz * 7);
  const groundY = findGround(baseX, player.position.y, baseZ);
  const floorY = groundY - 1;

  const x0 = baseX - 3, x1 = baseX + 3;
  const z0 = baseZ - 3, z1 = baseZ + 3;
  const y0 = floorY;
  const y1 = floorY + 1;
  const y2 = floorY + 2;
  const y3 = floorY + 3;
  const y4 = floorY + 4;
  const y5 = floorY + 5;

  say(`${pname}，收到！我在这边给你盖个小木屋，别嫌丑哈。`);

  // 用地板探测权限
  cmd(`/fill ${x0} ${y0} ${z0} ${x1} ${y0} ${z1} minecraft:oak_planks`);
  await sleep(900);

  let ok = false;
  try {
    const b = bot.blockAt(new Vec3(x0, y0, z0));
    ok = !!(b && b.name && b.name.includes('oak_planks'));
  } catch {}

  if (!ok) {
    hasOp = false;
    pendingBuild = true;
    building = false;
    say('房主，我放不了方块……先给我 OP 吧：在聊天框输入 /op xiaoyao，然后跟我说一声“好了”，我马上开建。');
    return;
  }
  hasOp = true;
  say('地基打好了，开始垒墙！');
  await sleep(250);

  // 地板已经填好；墙体
  cmd(`/fill ${x1} ${y1} ${z0} ${x1} ${y3} ${z1} minecraft:oak_planks`);
  await sleep(220);
  cmd(`/fill ${x0} ${y1} ${z0} ${x0} ${y3} ${z1} minecraft:oak_planks`);
  await sleep(220);
  cmd(`/fill ${x0} ${y1} ${z1} ${x1} ${y3} ${z1} minecraft:oak_planks`);
  await sleep(220);
  cmd(`/fill ${x0} ${y1} ${z0} ${x1} ${y3} ${z0} minecraft:oak_planks`);
  await sleep(300);

  // 窗户
  cmd(`/fill ${x0 + 1} ${y2} ${z1} ${x0 + 2} ${y2} ${z1} minecraft:glass`);
  await sleep(180);
  cmd(`/fill ${x1 - 2} ${y2} ${z1} ${x1 - 1} ${y2} ${z1} minecraft:glass`);
  await sleep(180);
  cmd(`/fill ${x0} ${y2} ${z0 + 2} ${x0} ${y2} ${z0 + 4} minecraft:glass`);
  await sleep(180);
  cmd(`/fill ${x1} ${y2} ${z0 + 2} ${x1} ${y2} ${z0 + 4} minecraft:glass`);
  await sleep(250);

  // 门洞
  cmd(`/fill ${x0 + 3} ${y1} ${z0} ${x0 + 3} ${y2} ${z0} minecraft:air`);
  await sleep(220);

  // 屋顶
  cmd(`/fill ${x0} ${y4} ${z0} ${x1} ${y4} ${z1} minecraft:spruce_planks`);
  await sleep(250);
  cmd(`/fill ${x0 + 1} ${y5} ${z0 + 1} ${x1 - 1} ${y5} ${z1 - 1} minecraft:spruce_planks`);
  await sleep(250);

  // 室内灯
  cmd(`/setblock ${x0 + 3} ${y1} ${z0 + 3} minecraft:lantern`);
  await sleep(200);

  building = false;
  say('完工！虽然不大，但遮风挡雨够了。走，进去看看？');
  currentTarget = player;
  try { bot.pathfinder.setGoal(new GoalFollow(player, 2), true); } catch {}
}

let lastHurtAt = 0;

function setupFabricHandshake (client) {
  let registered = false;
  const register = () => {
    if (registered) return;
    registered = true;
    try {
      client.registerChannel('fabric:registry/sync', null, true);
      client.registerChannel('fabric:registry/sync/complete', null, true);
      log('fabric channels registered');
    } catch (e) {
      log('fabric register failed:', e.message);
    }
  };
  const origWrite = client.write.bind(client);
  client.write = function (name, params) {
    const r = origWrite(name, params);
    if (name === 'login_acknowledged') setImmediate(register);
    return r;
  };
  client.on('fabric:registry/sync', () => {
    client.write('custom_payload', {
      channel: 'fabric:registry/sync/complete',
      data: Buffer.alloc(0)
    });
    log('fabric registry sync acked');
  });
}

function connect () {
  joinedAt = Date.now();
  const port = CFG.port || detectPort() || 25565;
  log('connecting to', CFG.host + ':' + port, 'as', CFG.username);
  bot = mineflayer.createBot({
    host: CFG.host,
    port,
    username: CFG.username,
    auth: 'offline',
    version: CFG.version,
    disableChatSigning: true,
    hideErrors: false
  });

  setupFabricHandshake(bot._client);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.scaffoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    joinedAt = Date.now();
    log('spawned at', bot.entity.position.toString());
    setTimeout(() => {
      const p = nearestPlayerEntity();
      const name = playerNameOf(p);
      say(name ? `${name}！我来啦，今天想玩点什么？` : '我来啦～');
    }, 1200);
  });

  bot.on('chat', (username, message) => {
    if (!message || username === bot.username) return;
    lastSpeaker = username;
    lastChatAt = Date.now();
    history.push({ role: 'user', content: `玩家 ${username}: ${message}` });
    handleChat(username, message).catch(e => log('chat error:', e.message));
  });

  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;
    if (Date.now() - joinedAt < 8000) return;
    if (Date.now() - lastChatAt < 5000) return;
    lastChatAt = Date.now();
    setTimeout(() => say(`${player.username} 来了呀，欢迎欢迎～`), 1500);
  });

  bot.on('entityHurt', (entity) => {
    if (!entity || entity === bot.entity) return;
    const name = playerNameOf(entity);
    if (!name) return;
    if (Date.now() - lastHurtAt < 12000) return;
    lastHurtAt = Date.now();
    lastChatAt = Date.now();
    setTimeout(() => say(`${name}你没事吧？要不要我过去？`), 800);
  });

  bot.on('kicked', (reason) => log('kicked:', JSON.stringify(reason).slice(0, 300)));
  bot.on('error', (e) => log('error:', e.message));
  bot.on('end', (reason) => {
    log('disconnected:', reason);
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 10000);
  });

  startProactiveLoop();
}

async function handleChat (username, message) {
  const text = message.trim();
  if (!text || text.startsWith('/')) return;

  // 直接指令优先，避免 LLM 抽风
  if (/建(个|一个|一栋)?房|盖(个|一个|一栋)?房|造(个|一个)?房|建(个)?小屋|盖(个)?小屋/.test(text)) {
    doAction('build_house');
    return;
  } else if (/跟着我|跟我来|过来|来这里|跟我走/.test(text)) {
    doAction('follow');
  } else if (/停下|别动|站住|不要动/.test(text)) {
    doAction('stop');
  } else if (/跳(个)?舞|跳舞/.test(text)) {
    doAction('dance');
  }

  if (pendingBuild && /好了|op|OP|权限|可以了/.test(text)) {
    pendingBuild = false;
    doAction('build_house');
    return;
  }

  if (!apiKey) return;
  await queueLLM(username, text, false);
}

let llmQueue = [];
async function queueLLM (username, text, proactive) {
  if (busy) {
    if (!proactive && llmQueue.length < 2) llmQueue.push([username, text, proactive]);
    return;
  }
  busy = true;
  try {
    const content = await askLLM(username, text, proactive);
    const { say: reply, action } = parseReply(content);
    if (reply) { say(reply); lastChatAt = Date.now(); }
    if (action && action !== 'none') doAction(action);
  } catch (e) {
    log('LLM error:', e.message);
  } finally {
    busy = false;
    if (llmQueue.length) {
      const [u, t, p] = llmQueue.shift();
      setTimeout(() => queueLLM(u, t, p), 200);
    }
  }
}

function startProactiveLoop () {
  setInterval(() => {
    if (!bot || !bot.entity) return;
    const now = Date.now();
    // 偶尔看看玩家，像真人一样
    const target = nearestPlayerEntity();
    if (target && now - lastActionAt > 8000 && Math.random() < 0.5) {
      try {
        if (target.position.distanceTo(bot.entity.position) < 8) bot.lookAt(target.position.offset(0, 1.6, 0), true);
      } catch {}
    }
    if (building || busy || now - lastChatAt < 45000) return;
    if (now - lastProactiveAt < 60000) return;
    if (Math.random() > 0.5) return;
    lastProactiveAt = now;
    queueLLM(null, null, true);
  }, 15000);
}

apiKey = loadKey();
if (!apiKey) log('warning: no DeepSeek API key found (set DEEPSEEK_API_KEY)');
connect();

process.on('SIGINT', () => { try { bot.quit(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { bot.quit(); } catch {} process.exit(0); });
