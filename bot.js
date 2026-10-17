'use strict';

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;

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
  replyCooldownMs: 1200
};
CFG.apiBase = CFG.apiBase || PROVIDERS[CFG.provider] || PROVIDERS.deepseek;

const SYSTEM_PROMPT = [
  '你是「小遥」(xiaoyao)，一个由 DeepSeek 驱动的 Minecraft 陪玩机器人，正和玩家一起在 Minecraft 世界里。',
  '你的性格：活泼、自然、像朋友，说话简短。',
  '每次回复必须是一个 JSON 对象，不能包含任何其他文字：',
  '{"say":"要对玩家说的话，中文，不超过60字","action":"follow|come|stop|jump|look|none"}',
  '动作含义：follow=跟着玩家；come=走到玩家身边；stop=停下；jump=跳一下；look=看向玩家；none=不做动作。',
  '玩家让你跟着、过来、停下时，选对应动作；闲聊时选 none 或 follow。'
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
let currentTarget = null;

function log (...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function askLLM (speaker, text) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history.slice(-8)) messages.push(h);
  messages.push({ role: 'user', content: `玩家 ${speaker}: ${text}` });

  const base = {
    model: CFG.apiModel,
    messages,
    max_tokens: 900,
    temperature: 0.8
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
  for (const name of Object.keys(bot.players)) {
    if (name === bot.username) continue;
    const e = bot.players[name] && bot.players[name].entity;
    if (!e) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function doAction (action) {
  const target = nearestPlayerEntity();
  if (!target) return;
  try {
    if (action === 'follow') {
      currentTarget = target;
      bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
      log('action follow', target.username || target.name);
    } else if (action === 'come') {
      const p = target.position;
      bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 1), true);
      log('action come');
    } else if (action === 'stop') {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      log('action stop');
    } else if (action === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
    } else if (action === 'look') {
      bot.lookAt(target.position.offset(0, 1.6, 0), true);
    }
  } catch (e) {
    log('action failed:', e.message);
  }
}

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

let bot = null;
let reconnectTimer = null;

function connect () {
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
    bot.pathfinder.setMovements(movements);
    log('spawned at', bot.entity.position.toString());
    setTimeout(() => {
      try { bot.chat('小遥来啦～'); } catch {}
    }, 1200);
  });

  bot.on('chat', (username, message) => {
    if (!message || username === bot.username) return;
    handleChat(username, message).catch(e => log('chat error:', e.message));
  });

  bot.on('kicked', (reason) => {
    log('kicked:', JSON.stringify(reason).slice(0, 300));
  });
  bot.on('error', (e) => log('error:', e.message));
  bot.on('end', (reason) => {
    log('disconnected:', reason);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 10000);
    }
  });
}

let lastReplyAt = 0;
async function handleChat (username, message) {
  const text = message.trim();
  if (!text || text.startsWith('/')) return;

  history.push({ role: 'user', content: `玩家 ${username}: ${text}` });

  if (/跟着我|跟我来|过来|来这里|跟我走/.test(text)) {
    doAction('follow');
  } else if (/停下|别动|站住|不要动/.test(text)) {
    doAction('stop');
  }

  if (!apiKey || busy) return;
  const now = Date.now();
  if (now - lastReplyAt < CFG.replyCooldownMs) return;
  lastReplyAt = now;
  busy = true;
  try {
    const content = await askLLM(username, text);
    const { say, action } = parseReply(content);
    if (say) {
      const clipped = say.slice(0, 200);
      bot.chat(clipped);
      history.push({ role: 'assistant', content: clipped });
    }
    if (action && action !== 'none') doAction(action);
  } catch (e) {
    log('LLM error:', e.message);
    if (!/[?？]/.test(text) || text.length < 40) {
      // no canned spam on failure
    }
  } finally {
    busy = false;
  }
}

apiKey = loadKey();
if (!apiKey) log('warning: no DeepSeek API key found (set DEEPSEEK_API_KEY)');
connect();

process.on('SIGINT', () => { try { bot.quit(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { bot.quit(); } catch {} process.exit(0); });
