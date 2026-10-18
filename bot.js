'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear, GoalXZ } = goals;
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
  replyCooldownMs: 500,
  allowTp: fileCfg.allowTp === true
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
  '重要：如果你说你要过来、下来、跟着、停下或建房子，action 必须是对应动作，绝对不能 action=none。不能说一套做一套。',
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
  const dir = path.dirname(CFG.logPath);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.log') || f.endsWith('.log.gz'));
  } catch { return null; }
  files.sort((a, b) => {
    try { return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs; } catch { return 0; }
  });
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f));
      const txt = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      const m = [...txt.matchAll(/Started serving on (\d+)/g)];
      if (m.length) return parseInt(m[m.length - 1][1], 10);
    } catch {}
  }
  return null;
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
let lastHouse = null;
try { lastHouse = JSON.parse(fs.readFileSync(path.join(__dirname, 'lastHouse.json'), 'utf8')); } catch {}
let goalSince = 0;
function saveHouse () { try { fs.writeFileSync(path.join(__dirname, 'lastHouse.json'), JSON.stringify(lastHouse)); } catch {} }

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

function doAction (action, targetName) {
  const target = (targetName && bot.players[targetName] && bot.players[targetName].entity) || nearestPlayerEntity();
  if (!target && !targetName && action !== 'stop' && action !== 'wander') return;
  try {
    if (action === 'follow') {
      const name = targetName || (target ? playerNameOf(target) : null);
      startWalking(name, target, true);
      log('action follow', name);
    } else if (action === 'come') {
      comeTo(target, targetName);
    } else if (action === 'stop') {
      stopWalking();
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
      buildHouse(false);
    } else if (action === 'build_villa') {
      pendingBuild = false;
      buildHouse(true);
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

const lastKnown = {};
const lastKnownAt = {};
let posRequestName = null;
let posRequestAt = 0;
let walkMisses = 0;
let walkTimer = null;

function requestPos (name) {
  const now = Date.now();
  if (!name || now - posRequestAt < 4000) return;
  posRequestName = name;
  posRequestAt = now;
  cmd(`/data get entity ${name} Pos`);
}
let walkName = null;
let walkKeep = false;
let walkTarget = null;
let lastWalkPos = null;
let lastGoalKey = '';
let lastWalkLog = 0;
let manualUntil = 0;
let manualTimer = null;
let walkMovements = null;
let hardStuck = 0;
let bestDist = Infinity;
let noProgressSince = 0;
let stuckTicks = 0;

function stopWalking () {
  if (walkTimer) clearInterval(walkTimer);
  if (manualTimer) clearInterval(manualTimer);
  manualTimer = null;
  manualUntil = 0;
  if (bot) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(k, false); } catch {}
    }
  }
  walkTimer = null;
  walkName = null;
  walkTarget = null;
  walkKeep = false;
  stuckTicks = 0;
  lastWalkPos = null;
  lastGoalKey = '';
}

let diggingOut = false;
let digTimer = null;

function digOut () {
  if (!walkMovements || diggingOut) return;
  diggingOut = true;
  clearManual();
  log('digging out');
  walkMovements.canDig = true;
  lastGoalKey = '';
  bestDist = Infinity;
  noProgressSince = Date.now();
  walkTick();
  if (digTimer) clearTimeout(digTimer);
  digTimer = setTimeout(() => {
    diggingOut = false;
    walkMovements.canDig = false;
    lastGoalKey = '';
    log('stop digging');
  }, 12000);
}

function clearManual () {
  manualUntil = 0;
  if (bot) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(k, false); } catch {}
    }
  }
  lastGoalKey = '';
}

let lastDoorTry = 0;
let manualDigging = false;
let lastManualDigTry = 0;
function tryOpenDoor () {
  if (!bot || !bot.entity) return false;
  if (Date.now() - lastDoorTry < 3000) return false;
  lastDoorTry = Date.now();
  const bp = bot.entity.position;
  const doors = [];
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -4; dz <= 4; dz++) {
        const b = bot.blockAt(bp.offset(dx, dy, dz));
        if (b && b.name && b.name.includes('door')) doors.push(b);
      }
    }
  }
  let opened = 0;
  for (const d of doors.slice(0, 4)) {
    try {
      const props = d.getProperties ? d.getProperties() : {};
      if (props.open === true || props.open === 'true') continue;
      bot.activateBlock(d);
      opened++;
    } catch {}
  }
  if (opened) { log('opened door(s):', opened); lastGoalKey = ''; return true; }
  return false;
}

function startManual (ms) {
  if (!bot || !bot.entity) return;
  if (tryOpenDoor()) { lastGoalKey = ''; return; }
  manualUntil = Date.now() + ms;
  try { bot.pathfinder.setGoal(null); } catch {}
  lastGoalKey = '';
  if (!manualTimer) manualTimer = setInterval(manualWalkTick, 300);
  log('manual walk for', ms, 'ms');
}

function targetPos () {
  const name = walkName || (walkTarget ? playerNameOf(walkTarget) : null);
  const live = name ? (bot.players[name] && bot.players[name].entity) : null;
  const pos = live ? live.position : (name ? lastKnown[name] : (walkTarget ? walkTarget.position : null));
  return { name, live, pos };
}

async function manualDigAhead () {
  if (manualDigging) return;
  try {
    const { pos } = targetPos();
    if (!pos) return;
    const bp = bot.entity.position;
    const dx = pos.x - bp.x, dz = pos.z - bp.z;
    const yaw = Math.atan2(-dx, dz);
    const fx = -Math.sin(yaw), fz = Math.cos(yaw);
    for (const dy of [0, 1]) {
      const b = bot.blockAt(bp.offset(fx * 1.2, dy, fz * 1.2));
      if (b && b.boundingBox === 'block' && b.diggable) {
        manualDigging = true;
        log('manual dig', b.name);
        try { await bot.dig(b, true); } catch (e) { log('dig failed', e.message); }
        manualDigging = false;
        return;
      }
    }
  } catch (e) {
    manualDigging = false;
  }
}

function manualWalkTick () {
  if (!bot || !bot.entity) return;
  if (Date.now() > manualUntil) {
    clearManual();
    walkTick();
    return;
  }
  try {
    const { pos } = targetPos();
    if (!pos) { clearManual(); return; }
    const bp = bot.entity.position;
    if (Math.hypot(bp.x - pos.x, bp.z - pos.z) <= 2.5) { clearManual(); stopWalking(); return; }
    const dx = pos.x - bp.x, dz = pos.z - bp.z;
    const yaw = Math.atan2(-dx, dz);
    bot.look(yaw, 0, true);
    const fx = -Math.sin(yaw), fz = Math.cos(yaw);
    const solid = (b) => b && b.boundingBox === 'block';
    const at = (ox, oy, oz) => bot.blockAt(bp.offset(ox, oy, oz));
    const feet = at(fx * 1.1, 0.1, fz * 1.1);
    const head = at(fx * 1.1, 1.4, fz * 1.1);
    const floorAhead = at(fx * 1.1, -0.9, fz * 1.1);
    const floorFar = at(fx * 1.8, -2.2, fz * 1.8);
    if ((solid(feet) || solid(head)) && Date.now() - lastManualDigTry > 1500) {
      lastManualDigTry = Date.now();
      manualDigAhead();
    }
    if (solid(feet) && !solid(head)) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 260);
    } else if (solid(feet) || solid(head)) {
      const ly = yaw - Math.PI / 4, ry = yaw + Math.PI / 4;
      const ok = (yy) => !solid(at(-Math.sin(yy) * 1.3, 0.6, Math.cos(yy) * 1.3));
      const dir = ok(ly) ? 'left' : (ok(ry) ? 'right' : null);
      if (dir) {
        bot.setControlState(dir, true);
        setTimeout(() => { try { bot.setControlState(dir, false); } catch {} }, 500);
      } else {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 260);
      }
    }
    const targetBelow = pos.y < bp.y - 1.2;
    if (!solid(floorAhead) && !solid(floorFar) && !targetBelow) {
      // 前方是大落差且目标不在下方，先别直冲
      bot.setControlState('forward', false);
      const side = Math.random() < 0.5 ? 'left' : 'right';
      bot.setControlState(side, true);
      setTimeout(() => { try { bot.setControlState(side, false); } catch {} }, 450);
    } else {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      if (targetBelow && !solid(floorAhead)) {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 280);
      }
    }
  } catch (e) {
    log('manual error:', e.message);
  }
}

function setWalkGoal (goal, key, dynamic) {
  if (key === lastGoalKey && bot.pathfinder.isMoving()) return;
  lastGoalKey = key;
  bot.pathfinder.setGoal(goal, dynamic);
}

function startWalking (name, target, keepFollowing) {
  stopWalking();
  walkName = name || (target ? playerNameOf(target) : null);
  walkTarget = target || null;
  walkKeep = !!keepFollowing;
  currentTarget = target || null;
  goalSince = Date.now();
  if (!walkName && !walkTarget) return;
  log('startWalking', walkName, walkTarget ? walkTarget.position.toString() : 'no-entity');
  if (walkTarget && walkName) { lastKnown[walkName] = walkTarget.position.clone(); lastKnownAt[walkName] = Date.now(); }
  walkMisses = 0;
  bestDist = Infinity;
  noProgressSince = Date.now();
  walkTick();
  walkTimer = setInterval(walkTick, 2500);
}

function walkTick () {
  if (!bot || !bot.entity) return;
  if (Date.now() < manualUntil) return;
  try {
    const name = walkName || (walkTarget ? playerNameOf(walkTarget) : null);
    const live = name ? (bot.players[name] && bot.players[name].entity) : null;
    if (live) {
      walkTarget = live;
      currentTarget = live;
      lastKnown[name] = live.position.clone();
      lastKnownAt[name] = Date.now();
      walkMisses = 0;
    }
    const bp = bot.entity.position;
    let pos = live ? live.position : (name ? lastKnown[name] : null);

    if (!pos) {
      if (name) {
        requestPos(name);
        walkMisses++;
        if (walkMisses > 2) {
          say('你在哪呀？我找不到你，报个坐标或者靠近点吧。');
          stopWalking();
        }
      } else {
        stopWalking();
      }
      return;
    }

    const d = bp.distanceTo(pos);
    if (d < bestDist - 1.5) { bestDist = d; noProgressSince = Date.now(); }
    if (Date.now() - noProgressSince > 10000 && !diggingOut) { digOut(); hardStuck = 0; }
    if (live && walkKeep) {
      const key = `followxz:${Math.round(pos.x)}:${Math.round(pos.z)}`;
      setWalkGoal(new GoalXZ(pos.x, pos.z), key, false);
      if (Date.now() - lastWalkLog > 5000) {
        lastWalkLog = Date.now();
        log('walk follow', name, 'd=', d.toFixed(1), 'moving=', bot.pathfinder.isMoving());
      }
      return;
    }

    const hd = Math.hypot(bp.x - pos.x, bp.z - pos.z);
    if (!walkKeep && hd <= 2.5) {
      bot.pathfinder.setGoal(null);
      try { bot.lookAt(pos.offset(0, 1.6, 0), true); } catch {}
      stopWalking();
      return;
    }

    if (live) {
      const key = `nearxz:${Math.round(pos.x)}:${Math.round(pos.z)}`;
      setWalkGoal(new GoalXZ(pos.x, pos.z), key, false);
      logWalkState(name, d);
    } else {
      const dir = pos.minus(bp).normalize();
      const wp = d > 48 ? bp.plus(dir.scaled(24)) : pos;
      const key = `xz:${Math.round(wp.x)}:${Math.round(wp.z)}`;
      setWalkGoal(new GoalXZ(wp.x, wp.z), key, false);
      logWalkState(name, d);
    }

    // 卡住检测
    const horiz = lastWalkPos ? Math.hypot(bp.x - lastWalkPos.x, bp.z - lastWalkPos.z) : 9;
    if (horiz < 0.45) {
      stuckTicks++;
      hardStuck++;
      if (hardStuck >= 3 && !diggingOut) { digOut(); hardStuck = 0; }
      jump();
      if (stuckTicks >= 2) {
        const ang = Math.random() * Math.PI * 2;
        const wp = bp.offset(Math.cos(ang) * 6, 0, Math.sin(ang) * 6);
        lastGoalKey = '';
        bot.pathfinder.setGoal(new GoalXZ(wp.x, wp.z), false);
        log('stuck, detour to', wp.x.toFixed(0), wp.z.toFixed(0));
        stuckTicks = 0;
      }
    } else {
      stuckTicks = 0;
      hardStuck = 0;
    }
    lastWalkPos = bp.clone();
  } catch (e) {
    log('walk error:', e.message);
  }
}

function dumpAround () {
  if (!bot || !bot.entity) return;
  const p = bot.entity.position.floored();
  log('=== around bot at', p.x, p.y, p.z, '===');
  for (let dy = -1; dy <= 2; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      let row = '';
      for (let dx = -2; dx <= 2; dx++) {
        const b = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
        row += (b ? b.name.replace('minecraft:', '').slice(0, 6) : '?').padEnd(8);
      }
      log('y' + (p.y + dy) + ' z' + (p.z + dz) + ': ' + row);
    }
  }
}

function logWalkState (name, d) {
  if (Date.now() - lastWalkLog < 5000) return;
  lastWalkLog = Date.now();
  const p = bot.entity.position;
  log('walking', name || '?', 'pos=', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1), 'd=', d.toFixed(1), 'moving=', bot.pathfinder.isMoving());
}

function comeTo (target, nameOverride) {
  const name = nameOverride || (target ? playerNameOf(target) : null);
  if (!target && !name) return;
  if (CFG.allowTp && name) {
    cmd(`/tp ${bot.username} ${name}`);
    log('tp to', name);
    if (target) setTimeout(() => { try { bot.lookAt(target.position.offset(0, 1.6, 0), true); } catch {} }, 500);
    return;
  }
  startWalking(name, target, false);
  log('action come', name);
}

function inferAction (say, action) {
  if (action && action !== 'none') return action;
  if (/下来|下去|过来|来了|到你旁边|马上到|这就来|蹦下来|找你/.test(say)) return 'come';
  if (/跟着|跟紧|陪你走|跟你走/.test(say)) return 'follow';
  if (/停下|别动|站住|不走/.test(say)) return 'stop';
  return action;
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

async function buildHouse (villa) {
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

  const r = villa ? 4 : 3;
  const x0 = baseX - r, x1 = baseX + r;
  const z0 = baseZ - r, z1 = baseZ + r;
  const y0 = floorY;
  const y1 = floorY + 1;
  const y2 = floorY + 2;
  const y3 = floorY + 3;
  const y4 = floorY + 4;
  const y5 = floorY + 5;

  say(villa ? `${pname}，别墅是吧？行，先给你起个两层小楼！` : `${pname}，收到！我在这边给你盖个小木屋，别嫌丑哈。`);

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

  if (!villa) {
    cmd(`/fill ${x1} ${y1} ${z0} ${x1} ${y3} ${z1} minecraft:oak_planks`);
    await sleep(220);
    cmd(`/fill ${x0} ${y1} ${z0} ${x0} ${y3} ${z1} minecraft:oak_planks`);
    await sleep(220);
    cmd(`/fill ${x0} ${y1} ${z1} ${x1} ${y3} ${z1} minecraft:oak_planks`);
    await sleep(220);
    cmd(`/fill ${x0} ${y1} ${z0} ${x1} ${y3} ${z0} minecraft:oak_planks`);
    await sleep(300);
    cmd(`/fill ${x0 + 1} ${y2} ${z1} ${x0 + 2} ${y2} ${z1} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x1 - 2} ${y2} ${z1} ${x1 - 1} ${y2} ${z1} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x0} ${y2} ${z0 + 2} ${x0} ${y2} ${z0 + 4} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x1} ${y2} ${z0 + 2} ${x1} ${y2} ${z0 + 4} minecraft:glass`);
    await sleep(200);
    cmd(`/fill ${x0 + 3} ${y1} ${z0} ${x0 + 3} ${y2} ${z0} minecraft:air`);
    await sleep(180);
    cmd(`/fill ${x0} ${y4} ${z0} ${x1} ${y4} ${z1} minecraft:spruce_planks`);
    await sleep(220);
    cmd(`/fill ${x0 + 1} ${y5} ${z0 + 1} ${x1 - 1} ${y5} ${z1 - 1} minecraft:spruce_planks`);
    await sleep(220);
    cmd(`/setblock ${x0 + 3} ${y1} ${z0 + 3} minecraft:lantern`);
    lastHouse = { x0, x1, z0, z1, y0, doorX: x0 + 3, doorZ: z0, r: 3 };
    saveHouse();
  } else {
    const y6 = floorY + 6, y7 = floorY + 7, y8 = floorY + 8;
    // 一楼墙
    cmd(`/fill ${x1} ${y1} ${z0} ${x1} ${y3} ${z1} minecraft:stone_bricks`);
    await sleep(180);
    cmd(`/fill ${x0} ${y1} ${z0} ${x0} ${y3} ${z1} minecraft:stone_bricks`);
    await sleep(180);
    cmd(`/fill ${x0} ${y1} ${z1} ${x1} ${y3} ${z1} minecraft:oak_planks`);
    await sleep(180);
    cmd(`/fill ${x0} ${y1} ${z0} ${x1} ${y3} ${z0} minecraft:oak_planks`);
    await sleep(220);
    // 一楼窗和门
    cmd(`/fill ${x0} ${y2} ${z0 + 2} ${x0} ${y2} ${z0 + 6} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x1} ${y2} ${z0 + 2} ${x1} ${y2} ${z0 + 6} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x0 + 4} ${y1} ${z0} ${x0 + 4} ${y2} ${z0} minecraft:air`);
    await sleep(180);
    // 二楼地板
    cmd(`/fill ${x0} ${y4} ${z0} ${x1} ${y4} ${z1} minecraft:oak_planks`);
    await sleep(220);
    // 二楼墙
    cmd(`/fill ${x1} ${y4 + 1} ${z0} ${x1} ${y6} ${z1} minecraft:white_terracotta`);
    await sleep(180);
    cmd(`/fill ${x0} ${y4 + 1} ${z0} ${x0} ${y6} ${z1} minecraft:white_terracotta`);
    await sleep(180);
    cmd(`/fill ${x0} ${y4 + 1} ${z1} ${x1} ${y6} ${z1} minecraft:oak_planks`);
    await sleep(180);
    cmd(`/fill ${x0} ${y4 + 1} ${z0} ${x1} ${y6} ${z0} minecraft:oak_planks`);
    await sleep(220);
    // 二楼窗
    cmd(`/fill ${x0} ${y5} ${z0 + 2} ${x0} ${y5} ${z0 + 6} minecraft:glass`);
    await sleep(160);
    cmd(`/fill ${x1} ${y5} ${z0 + 2} ${x1} ${y5} ${z0 + 6} minecraft:glass`);
    await sleep(160);
    // 屋顶三层
    cmd(`/fill ${x0} ${y7} ${z0} ${x1} ${y7} ${z1} minecraft:spruce_planks`);
    await sleep(220);
    cmd(`/fill ${x0 + 1} ${y8} ${z0 + 1} ${x1 - 1} ${y8} ${z1 - 1} minecraft:spruce_planks`);
    await sleep(220);
    cmd(`/fill ${x0 + 2} ${y8 + 1} ${z0 + 2} ${x1 - 2} ${y8 + 1} ${z1 - 2} minecraft:spruce_planks`);
    await sleep(220);
    cmd(`/setblock ${x0 + 4} ${y1} ${z0 + 4} minecraft:lantern`);
    await sleep(160);
    cmd(`/setblock ${x0 + 4} ${y5} ${z0 + 4} minecraft:lantern`);
    lastHouse = { x0, x1, z0, z1, y0, doorX: x0 + 4, doorZ: z0, r: 4 };
    saveHouse();
  }
  await sleep(200);

  building = false;
  say(villa ? '别墅封顶！虽然算不上宫殿，但绝对能住人。走，进去看看？' : '完工！虽然不大，但遮风挡雨够了。走，进去看看？');
  startWalking(playerNameOf(player), player, true);
}

async function decorateHouse (username) {
  if (!lastHouse) { say('还没房子呢，先让我建一个吧。'); return; }
  const { x0, x1, z0, z1, y0, doorX, doorZ } = lastHouse;
  const y = y0 + 1;
  say('行，我给它加一圈栅栏和灯，再铺条小路。');
  cmd(`/fill ${x0 - 1} ${y} ${z0 - 1} ${doorX - 1} ${y} ${z0 - 1} minecraft:oak_fence`);
  await sleep(120);
  cmd(`/fill ${doorX + 1} ${y} ${z0 - 1} ${x1 + 1} ${y} ${z0 - 1} minecraft:oak_fence`);
  await sleep(180);
  cmd(`/fill ${x0 - 1} ${y} ${z1 + 1} ${x1 + 1} ${y} ${z1 + 1} minecraft:oak_fence`);
  await sleep(180);
  cmd(`/fill ${x0 - 1} ${y} ${z0 - 1} ${x0 - 1} ${y} ${z1 + 1} minecraft:oak_fence`);
  await sleep(180);
  cmd(`/fill ${x1 + 1} ${y} ${z0 - 1} ${x1 + 1} ${y} ${z1 + 1} minecraft:oak_fence`);
  await sleep(180);
  cmd(`/setblock ${x0 - 1} ${y + 1} ${z0 - 1} minecraft:lantern`);
  await sleep(120);
  cmd(`/setblock ${x1 + 1} ${y + 1} ${z0 - 1} minecraft:lantern`);
  await sleep(120);
  cmd(`/fill ${doorX} ${y0} ${doorZ - 1} ${doorX} ${y0} ${doorZ - 6} minecraft:stone_bricks`);
  await sleep(200);
  say('装修完了，怎么样，有点样子了吧？');
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
    movements.protectDigBlocks = ['oak_planks', 'spruce_planks', 'stone_bricks', 'glass', 'white_terracotta', 'lantern'];
    walkMovements = movements;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.scaffoldingBlocks = [];
    movements.maxDropDown = 16;
    movements.allowParkour = true;
    movements.canOpenDoors = true;
    bot.pathfinder.setMovements(movements);
    joinedAt = Date.now();
    log('spawned at', bot.entity.position.toString());
    setTimeout(dumpAround, 1500);
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

  bot.on('message', (msg) => {
    try {
      const s = msg.toString();
      if (!posRequestName || Date.now() - posRequestAt > 5000) return;
      const m = s.match(/\[\s*(-?\d+(?:\.\d+)?)d?,\s*(-?\d+(?:\.\d+)?)d?,\s*(-?\d+(?:\.\d+)?)d?\s*\]/);
      if (m && /entity data|实体数据|拥有以下/.test(s)) {
        lastKnown[posRequestName] = new Vec3(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
        lastKnownAt[posRequestName] = Date.now();
        log('pos update', posRequestName, m[1], m[2], m[3]);
      }
    } catch {}
  });

  bot.on('path_update', (r) => {
    if (r.status === 'noPath' || r.status === 'timeout') {
      log('path', r.status);
      lastGoalKey = '';
      if (walkTimer) {
        if (!tryOpenDoor()) startManual(5000);
      }
    }
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
  const nm = text.match(/(?:去|到|找)\s*([A-Za-z0-9_]{3,16})\s*(?:那里|那儿|这边|这里)?/);
  if (nm && nm[1] !== bot.username && bot.players[nm[1]]) {
    doAction('come', nm[1]);
    return;
  }
  if (/别墅|大房子|两层|二层/.test(text) && /建|盖|造/.test(text)) {
    doAction('build_villa', username);
    return;
  } else if (/建(个|一个|一栋)?房|盖(个|一个|一栋)?房|造(个|一个)?房|建(个)?小屋|盖(个)?小屋|盖房子|建房子/.test(text)) {
    doAction('build_house', username);
    return;
  } else if (/优化|装修|好看|装饰|改改/.test(text) && /房/.test(text)) {
    decorateHouse(username);
    return;
  } else if (/下来|下去|过来|出来|咋不出来|到我(这里|旁边)|站我(旁边|这里)|来我(这里|旁边)|到你旁边/.test(text)) {
    doAction('come', username);
  } else if (/跟着我|跟紧我|跟我来|跟我走|跟着/.test(text)) {
    doAction('follow', username);
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
    let { say: reply, action } = parseReply(content);
    action = inferAction(reply, action);
    if (reply) { say(reply); lastChatAt = Date.now(); }
    if (action && action !== 'none') doAction(action, lastSpeaker || username);
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
    for (const n of Object.keys(bot.players || {})) {
      const e = bot.players[n] && bot.players[n].entity;
      if (e && n !== bot.username) { lastKnown[n] = e.position.clone(); lastKnownAt[n] = Date.now(); }
    }
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
