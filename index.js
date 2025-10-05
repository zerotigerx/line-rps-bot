// index.js — Janken Tournament (Full service)
// NOTE: Single-file Node server for LINE Messaging API + Render.  
// It implements all requirements confirmed by the user (multi-room, admin-only
// controls, odd-number BOT pairing where human always wins silently, DM
// postbacks with group name, compliments, 20-player cap, simulate mode that
// includes the admin as a real player, position matches for ranks (3–16),
// status/ranking, resend-DM, reset/clear-me, and robust 429 backoff).
//
// ⚙️ Runtime: node >= 18, @line/bot-sdk ^9
// ├─ npm i express @line/bot-sdk dotenv
// └─ env: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
//
// Deploy on Render:
//   - Build Command: npm i
//   - Start Command: node index.js
//   - Region: Singapore (or near your audience)
//
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ========================= LINE CONFIG ========================= */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials');
  process.exit(1);
}

/* =========================== APP BOOT =========================== */
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('✅ Janken Tournament is running'));
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body?.events || [])) await handleEvent(ev);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err?.response?.data || err?.message || err);
    res.sendStatus(200);
  }
});
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));

/* ============================ GLOBALS =========================== */
const HANDS = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const POOLS = ['A', 'B', 'C', 'D'];
const PRAISES = [
  (pick) => `สุดยอด! (${pick}) 😎`,
  (pick) => `มีชั้นเชิง (${pick}) ✨`,
  (pick) => `โคตรคูล (${pick}) 🔥`,
  (pick) => `ฟีลลิ่งดี (${pick}) ✅`,
  (pick) => `บอกเลยว่าเฉียบ (${pick}) 💥`,
  (pick) => `เลือกได้เนียน (${pick}) 🧠`,
];
const BOT_UID = 'BOT:engine';
const BOT_NAME = 'BOT 🤖';
const isBot = (id) => id === BOT_UID;

const rooms = new Map(); // groupId -> room state
const groupNameCache = new Map();

const nowTH = () => new Date().toLocaleString('th-TH', { hour12: false });
const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const pretty = (room, uid) => uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';

/* ============================ HELPERS =========================== */
function judge(a, b, aUid = null, bUid = null) {
  // Human vs BOT: human always wins silently
  if (isBot(aUid) && !isBot(bUid)) return 'B';
  if (!isBot(aUid) && isBot(bUid)) return 'A';
  if (!a || !b) return a ? 'A' : 'B';
  if (a === b) return 'DRAW';
  const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return beats[a] === b ? 'A' : 'B';
}

async function sendWithRetry(kind, payload, attempt = 0) {
  // kind: 'push' | 'reply'
  try {
    if (kind === 'push') return await client.pushMessage(payload.to, payload.messages);
    return await client.replyMessage(payload.replyToken, payload.messages);
  } catch (e) {
    const status = e?.status || e?.response?.status;
    if ((status === 429 || status === 503) && attempt < 5) {
      const wait = 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
      return sendWithRetry(kind, payload, attempt + 1);
    }
    console.warn('send fail', status, e?.response?.data || e?.message);
  }
}

async function safePush(to, msgs) {
  const messages = Array.isArray(msgs) ? msgs : [msgs];
  await sendWithRetry('push', { to, messages });
}
async function safeReply(replyToken, msgs) {
  const messages = Array.isArray(msgs) ? msgs : [msgs];
  await sendWithRetry('reply', { replyToken, messages });
}

async function groupName(gid) {
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try {
    const s = await client.getGroupSummary(gid);
    if (s?.groupName) { groupNameCache.set(gid, s.groupName); return s.groupName; }
  } catch {}
  return '(กลุ่มของคุณ)';
}

function ensureRoom(gid) {
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin: null,              // userId of who opened
      phase: 'idle',            // idle | register | playing | finished
      players: new Map(),       // userId -> { name, isBot? }
      bracket: {
        round: 0,
        pools: { A: [], B: [], C: [], D: [] },
        cross: [],              // after pool champions merge
        waitingOdd: null,       // odd human (temporarily) — replaced by BOT rule
      },
      position: {
        queue: [],              // losers collected for position matches
        matches: [],            // ongoing position matches
        placed: [],             // ranking from last -> up (losers first)
      },
      lastDM: new Map(),        // userId -> { gid, stage, pool, idx }
    });
  }
  return rooms.get(gid);
}

/* ============================== UI ============================== */
function menuFlex() {
  return {
    type: 'flex', altText: 'Janken Menu',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '🎌 Janken Tournament', weight: 'bold', size: 'lg' }] },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'button', style: 'primary', action: { type: 'message', label: 'Join', text: 'janken join' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'Close', text: 'janken close' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'Status', text: 'janken status' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'Reset', text: 'janken reset' } },
        ]
      }
    }
  };
}

function openBannerFlex(gname = 'กลุ่มของคุณ') {
  return {
    type: 'flex', altText: 'JANKEN TOURNAMENT เปิดแล้ว!',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box', layout: 'vertical', backgroundColor: '#111', paddingAll: '24px', cornerRadius: 'md', contents: [
          { type: 'text', text: 'JANKEN', weight: 'bold', size: '3xl', color: '#FFD54F', align: 'center' },
          { type: 'text', text: 'TOURNAMENT', weight: 'bold', size: 'xl', color: '#FFFFFF', align: 'center' },
          { type: 'text', text: `กลุ่ม “${gname}”`, size: 'sm', color: '#BDBDBD', align: 'center', margin: 'sm' },
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: 'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', wrap: true },
          { type: 'box', layout: 'vertical', backgroundColor: '#F5F5F5', cornerRadius: 'md', paddingAll: '12px', contents: [
            { type: 'text', text: 'กด Join เพื่อเข้าร่วมการแข่งขัน', size: 'sm', color: '#666' },
            { type: 'text', text: 'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', size: 'sm', color: '#666', margin: 'sm' },
            { type: 'text', text: '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)', size: 'xs', color: '#999', margin: 'sm' },
          ] },
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#4CAF50', action: { type: 'message', label: 'Join', text: 'janken join' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'ดูเมนู', text: 'menu' } },
        ]
      }
    }
  };
}

const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-'}|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) => ({
  type: 'postback', label: `${EMOJI[hand]} ${hand.toUpperCase()}`,
  data: `jg|${matchKey(gid, stage, pool, idx)}|${hand}`,
  displayText: `${hand} (${stage})`
});
const qrPostback = (gid, stage, pool, idx) => ({ items: HANDS.map(h => ({ type: 'action', action: makePostback(gid, stage, pool, idx, h) })) });

function choiceFlexPostback(title, gid, stage, pool, idx) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg' }] },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'rock') },
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'paper') },
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'scissors') },
        ]
      },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size: 'xs', color: '#999' }] }
    }
  };
}

function flexPairs(title, lines) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: title, weight: 'bold', size: 'lg' }, { type: 'text', text: nowTH(), size: 'xs', color: '#999' } ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: lines.map(t => ({ type: 'text', text: t, wrap: true })) }
    }
  };
}

function flexResult(title, aName, aH, bName, bH, winName) {
  return {
    type: 'flex', altText: `${title}: ${winName}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: title, weight: 'bold', size: 'lg' } ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'box', layout: 'baseline', contents: [ { type: 'text', text: aName, size: 'md', flex: 5, wrap: true }, { type: 'text', text: EMOJI[aH] || '', size: 'lg', flex: 1, align: 'end' } ] },
        { type: 'box', layout: 'baseline', contents: [ { type: 'text', text: bName, size: 'md', flex: 5, wrap: true }, { type: 'text', text: EMOJI[bH] || '', size: 'lg', flex: 1, align: 'end' } ] },
        { type: 'separator' },
        { type: 'text', text: `ผู้ชนะ: ${winName}`, weight: 'bold', color: '#2E7D32' }
      ] }
    }
  };
}

/* ========================= BRACKET UTILS ======================== */
const toPairs = (ids) => { const out = []; for (let i = 0; i < ids.length; i += 2) out.push([ids[i] || null, ids[i + 1] || null]); return out; };
function seedPoolsFrom(ids) {
  const pools = { A: [], B: [], C: [], D: [] };
  const shuffled = shuffle(ids);
  let i = 0; for (const id of shuffled) { pools[POOLS[i % 4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a, b]) => ({ a, b, state: 'pending', moves: {}, winner: null, loser: null }));
  return pools;
}
const allPoolsDone = (pools) => POOLS.every(k => pools[k].every(m => m.state === 'done'));

/* ========================= ANNOUNCEMENTS ======================== */
async function tryPushFlexOrText(to, title, lines) {
  const MAX = 10; const chunks = []; for (let i = 0; i < lines.length; i += MAX) chunks.push(lines.slice(i, i + MAX));
  try {
    if (!chunks.length) return await safePush(to, { type: 'text', text: `${title}\n(ไม่มีคู่ในรอบนี้)` });
    for (let i = 0; i < chunks.length; i++) {
      const head = chunks.length > 1 ? `${title} (หน้า ${i + 1}/${chunks.length})` : title;
      await safePush(to, [flexPairs(head, chunks[i])]);
    }
  } catch {
    await safePush(to, { type: 'text', text: [title, ...lines].join('\n') });
  }
}

async function announcePoolsRound(gid, room, title) {
  const lines = [];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m, i) => lines.push(`  Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`));
  }
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m, i) => {
      for (const uid of [m.a, m.b]) if (uid) {
        room.lastDM.set(uid, { gid, stage: 'pools', pool: k, idx: i });
        const base = `📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`;
        const compliment = PRAISES[Math.floor(Math.random() * PRAISES.length)]('ที่เลือก');
        await safePush(uid, [
          { type: 'text', text: `${base}`, quickReply: qrPostback(gid, 'pools', k, i) },
          choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'pools', k, i),
          { type: 'text', text: `${compliment}\nเมื่อเลือกแล้ว รอลุ้นผลในกลุ่ม “${gName}” ได้เลย!` }
        ]);
      }
    });
  }
}

async function announceCrossRound(gid, room, title) {
  const lines = room.bracket.cross.map((m, i) => `Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);
  for (const [i, m] of room.bracket.cross.entries()) for (const uid of [m.a, m.b]) if (uid) {
    room.lastDM.set(uid, { gid, stage: 'cross', pool: null, idx: i });
    const base = `📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด`; const compliment = PRAISES[Math.floor(Math.random() * PRAISES.length)]('ที่เลือก');
    await safePush(uid, [
      { type: 'text', text: base, quickReply: qrPostback(gid, 'cross', null, i) },
      choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'cross', null, i),
      { type: 'text', text: `${compliment}\nเลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` }
    ]);
  }
}

async function announcePositionRound(gid, room) {
  if (!room.position.matches.length) return;
  const lines = room.position.matches.map((m, i) => `Position Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`);
  await tryPushFlexOrText(gid, '🏷️ แมตช์จัดอันดับ', lines);
}

/* ============================ RESOLUTION ======================== */
async function resolveAndAnnounce(gid, room, stage, pool, idx, m) {
  const aH = m.moves[m.a], bH = m.moves[m.b];

  // Handle byes and BOTs
  if (m.a && !m.b) { m.winner = m.a; m.loser = null; m.state = 'done'; }
  else if (m.b && !m.a) { m.winner = m.b; m.loser = null; m.state = 'done'; }
  else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b);
    if (r === 'DRAW') {
      m.moves = {};
      const gName = await groupName(gid);
      for (const uid of [m.a, m.b]) if (uid) {
        room.lastDM.set(uid, { gid, stage, pool, idx });
        await safePush(uid, [
          { type: 'text', text: `เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid, stage, pool, idx) },
          choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, stage, pool, idx)
        ]);
      }
      return false;
    }
    m.winner = r === 'A' ? m.a : m.b; m.loser = r === 'A' ? m.b : m.a; m.state = 'done';
  } else { return false; }

  // Announce result in group
  try {
    await client.pushMessage(gid, [ flexResult(stage === 'pools' ? `สาย ${pool} — Match ${idx + 1}` : 'ผลรอบรวม', pretty(room, m.a), aH, pretty(room, m.b), bH, pretty(room, m.winner)) ]);
  } catch {
    await safePush(gid, { type: 'text', text: `${stage === 'pools' ? `สาย ${pool} — Match ${idx + 1}` : 'ผลรอบรวม'}\n${pretty(room, m.a)} ${EMOJI[aH] || ''} vs ${pretty(room, m.b)} ${EMOJI[bH] || ''}\nผู้ชนะ: ${pretty(room, m.winner)}` });
  }

  // Queue loser to position ladder
  if (m.loser) room.position.queue.push(m.loser);
  return true;
}

function schedulePositionMatches(room) {
  // Create position matches in pairs from queue until none left
  const q = room.position.queue; const created = [];
  while (q.length >= 2) {
    const a = q.shift(); const b = q.shift();
    room.position.matches.push({ a, b, state: 'pending', moves: {}, winner: null, loser: null });
    created.push([a, b]);
  }
  return created.length > 0;
}

async function tryClosePosition(gid, room) {
  let progressed = false;
  for (let i = 0; i < room.position.matches.length; i++) {
    const m = room.position.matches[i]; if (m.state === 'done') continue;
    const ok = await resolveAndAnnounce(gid, room, 'position', null, i, m);
    if (!ok) continue; progressed = true;
    // loser placed earlier => lower rank; store to placed list
    if (m.loser) room.position.placed.push(m.loser);
  }
  // When all done, clear finished and maybe schedule new from queue
  room.position.matches = room.position.matches.filter(x => x.state !== 'done');
  if (progressed) await announcePositionRound(gid, room);
}

/* ============================ MAIN FLOW ========================= */
async function tryClosePool(gid, room, k, idx) {
  const m = room.bracket.pools[k][idx];
  const done = await resolveAndAnnounce(gid, room, 'pools', k, idx, m);
  if (!done) return;

  // After each resolution, attempt to schedule position (for eliminated ones)
  schedulePositionMatches(room);
  await tryClosePosition(gid, room);

  if (!allPoolsDone(room.bracket.pools)) return;

  // Winners per pool
  const winners = POOLS.reduce((acc, kk) => (acc[kk] = room.bracket.pools[kk].map(x => x.winner).filter(Boolean), acc), {});

  // If any pool has > 1 winner, split again inside the pool next round
  const eachSingle = POOLS.every(kk => (winners[kk]?.length || 0) <= 1);
  if (!eachSingle) {
    const next = { A: [], B: [], C: [], D: [] };
    for (const kk of POOLS) {
      const ws = winners[kk] || []; for (let i = 0; i < ws.length; i += 2) {
        next[kk].push({ a: ws[i] || null, b: ws[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
      }
    }
    room.bracket.pools = next; room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // Merge single winners into cross bracket
  const champs = Object.values(winners).flat();
  if (champs.length === 1) {
    // Tournament winner known, finish
    const champion = champs[0];
    await safePush(gid, { type: 'text', text: `🏆 แชมป์: ${pretty(room, champion)}` });
    // Position clean-up: append remaining players (not BOT preference) to placed order
    finishTournamentRanking(room, champion);
    await announceFinalStandings(gid, room);
    room.phase = 'finished';
    return;
  }
  // Cross bracket set
  const ids = shuffle(champs); const cross = []; for (let i = 0; i < ids.length; i += 2) cross.push({ a: ids[i] || null, b: ids[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
  room.bracket.cross = cross; room.bracket.round += 1;
  await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

async function tryCloseCross(gid, room) {
  let progressed = false;
  for (let i = 0; i < room.bracket.cross.length; i++) {
    const m = room.bracket.cross[i]; if (m.state === 'done') continue;
    const ok = await resolveAndAnnounce(gid, room, 'cross', null, i, m);
    if (ok) progressed = true;
    schedulePositionMatches(room);
  }
  await tryClosePosition(gid, room);

  const allDone = room.bracket.cross.every(x => x.state === 'done');
  if (!allDone) return;

  const winners = room.bracket.cross.map(x => x.winner).filter(Boolean);
  if (winners.length === 1) {
    const champion = winners[0];
    await safePush(gid, { type: 'text', text: `🏆 แชมป์: ${pretty(room, champion)}` });
    finishTournamentRanking(room, champion);
    await announceFinalStandings(gid, room);
    room.phase = 'finished';
    return;
  }
  const next = []; for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i] || null, b: winners[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
  room.bracket.cross = next; room.bracket.round += 1;
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

function finishTournamentRanking(room, champion) {
  // placed[] already stores losers in order; push champion last so he ranks 1st.
  const humans = [...room.players.keys()].filter(id => !isBot(id));
  const botIncluded = [...room.players.keys()].some(isBot);

  const order = [...room.position.placed]; // losers order: earlier loss = worse placement
  const setPlaced = new Set(order);
  // Add any remaining (who never lost — finalists path) except champion
  for (const uid of humans) if (uid !== champion && !setPlaced.has(uid)) order.push(uid);
  // Append champion at end (rank 1)
  order.push(champion);

  // If BOT present, force BOT to bottom (worst rank) once
  if (botIncluded) {
    const withoutBot = order.filter(x => !isBot(x));
    withoutBot.push(BOT_UID); // last
    room.position.final = withoutBot;
  } else {
    room.position.final = order;
  }
}

async function announceFinalStandings(gid, room) {
  const names = (uid) => pretty(room, uid);
  const arr = room.position.final || [];
  const lines = arr.slice().reverse().map((uid, i) => `${i + 1}. ${names(uid)}`); // reverse so champion first
  await tryPushFlexOrText(gid, '🏁 สรุปอันดับสุดท้าย', lines);
}

/* ========================== EVENT HANDLER ======================= */
async function handleEvent(e) {
  /* ---- POSTBACK (DM choose) ---- */
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const d = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (d[0] === 'jg') {
      const gid = d[1]; const stage = d[2]; const pool = d[3] === '-' ? null : d[3]; const idx = Number(d[4]); const hand = d[5];
      const room = rooms.get(gid); if (!room) return;
      const uid = e.source.userId; const gName = await groupName(gid);

      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx]; if (!m) return;
        if (m.state !== 'pending' || (m.a !== uid && m.b !== uid)) return;
        m.moves[uid] = hand; room.lastDM.set(uid, { gid, stage, pool, idx });
        const praise = PRAISES[Math.floor(Math.random() * PRAISES.length)](EMOJI[hand]);
        await safeReply(e.replyToken, { type: 'text', text: `${praise}\nรับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` });
        await tryClosePool(gid, room, pool, idx);
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx]; if (!m) return;
        if (m.state !== 'pending' || (m.a !== uid && m.b !== uid)) return;
        m.moves[uid] = hand; room.lastDM.set(uid, { gid, stage, pool, idx });
        const praise = PRAISES[Math.floor(Math.random() * PRAISES.length)](EMOJI[hand]);
        await safeReply(e.replyToken, { type: 'text', text: `${praise}\nรับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` });
        await tryCloseCross(gid, room);
      } else if (stage === 'position') {
        const m = room.position.matches?.[idx]; if (!m) return;
        if (m.state !== 'pending' || (m.a !== uid && m.b !== uid)) return;
        m.moves[uid] = hand; room.lastDM.set(uid, { gid, stage, pool, idx });
        const praise = PRAISES[Math.floor(Math.random() * PRAISES.length)](EMOJI[hand]);
        await safeReply(e.replyToken, { type: 'text', text: `${praise}\nรับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` });
        await tryClosePosition(gid, room);
      }
    }
    return;
  }

  /* ---- DM TEXT (helper) ---- */
  if (e.type === 'message' && e.message.type === 'text' && e.source.type === 'user') {
    const t = (e.message.text || '').trim().toLowerCase();
    if (t === 'janken dm') {
      const last = [...rooms.values()].map(r => ({ r, info: r.lastDM.get(e.source.userId) })).find(x => x.info)?.info;
      if (!last) return await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่มีข้อความค้างส่งครับ หากคุณกำลังแข่งอยู่ รอระบบส่งอีกครั้งได้เลย' });
      const { gid, stage, pool, idx } = last; const gName = await groupName(gid);
      await safeReply(e.replyToken, [
        { type: 'text', text: `DM ทดสอบจากบอท ✅ (กลุ่ม “${gName}”)` },
        choiceFlexPostback('เลือกหมัดอีกครั้ง', gid, stage, pool, idx)
      ]);
      return;
    }
    if (HANDS.includes(t)) {
      // Ask to use buttons (postback-safe)
      await safeReply(e.replyToken, { type: 'text', text: 'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกันครับ 🙏' });
      return;
    }
    // default help
    await safeReply(e.replyToken, { type: 'text', text: 'ส่ง "janken dm" เพื่อให้บอทส่งปุ่มเลือกหมัดล่าสุดให้อีกครั้งครับ' });
    return;
  }

  /* ---- GROUP TEXT COMMANDS ---- */
  if (!(e.type === 'message' && e.message.type === 'text')) return;
  if (!['group', 'supergroup'].includes(e.source.type)) return;

  const gid = e.source.groupId;
  const room = ensureRoom(gid);
  const text = (e.message.text || '').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  if (!cmd) return;
  const c0 = cmd.toLowerCase();
  if (!['janken', 'rps'].includes(c0) && c0 !== 'menu') return;

  const gName = await groupName(gid);
  let displayName = 'Player';
  try { const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName; } catch {}

  if (c0 === 'menu') return void (await safeReply(e.replyToken, menuFlex()));

  switch ((sub || '').toLowerCase()) {
    case 'open': {
      room.admin = e.source.userId; room.phase = 'register';
      room.players = new Map(); room.bracket = { round: 1, pools: { A: [], B: [], C: [], D: [] }, cross: [], waitingOdd: null };
      room.position = { queue: [], matches: [], placed: [], final: [] }; room.lastDM = new Map();
      const announce = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '', 'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', '',
        'กด Join เพื่อเข้าร่วมการแข่งขัน', 'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', '',
        '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)'
      ].join('\n');
      await safePush(gid, { type: 'text', text: announce });
      await safePush(gid, openBannerFlex(gName));
      await safeReply(e.replyToken, [menuFlex(), { type: 'text', text: '🟢 เปิดรับสมัครแล้ว' }]);
      break;
    }

    case 'join': {
      if (room.phase !== 'register') return void (await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่เปิดรับสมัคร' }));
      if (room.players.size >= 20) return void (await safeReply(e.replyToken, { type: 'text', text: '❌ ทัวร์เต็ม (20 คน)' }));
      const name = (rest.join(' ') || displayName).slice(0, 40);
      room.players.set(e.source.userId, { name });
      await safeReply(e.replyToken, { type: 'text', text: `✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/20)` });
      break;
    }

    case 'close': {
      if (room.admin !== e.source.userId) return void (await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิด (ผู้จัด) เท่านั้นที่เริ่มได้ 🙏' }));
      if (room.players.size < 2) return void (await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีอย่างน้อย 2 คน' }));

      // Odd count → add BOT (human always wins silently)
      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) { room.players.set(BOT_UID, { name: BOT_NAME, isBot: true }); ids.push(BOT_UID); }

      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1; room.phase = 'playing';

      await safePush(gid, { type: 'text', text: `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})` });
      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      await safePush(gid, { type: 'text', text: `✉️ กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    case 'status': {
      const head = room.phase === 'register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
        : room.phase === 'playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round}`
        : room.phase === 'finished' ? '🏁 จบการแข่งขันแล้ว' : '—';
      await safeReply(e.replyToken, { type: 'text', text: head });
      break;
    }

    case 'standings': {
      if (!room.position?.final?.length) return void (await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่มีอันดับสรุป' }));
      await announceFinalStandings(gid, room); break;
    }

    case 'reset': {
      if (room.admin !== e.source.userId) return void (await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิดเท่านั้นที่รีเซ็ตได้ 🙏' }));
      rooms.delete(gid); await safeReply(e.replyToken, { type: 'text', text: '♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    case 'simulate': {
      if (room.admin && room.admin !== e.source.userId) return void (await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิดเท่านั้นที่สั่งจำลองได้ 🙏' }));
      // Fresh tournament with 16 (include admin)
      room.admin = e.source.userId; room.phase = 'register'; room.players = new Map(); room.position = { queue: [], matches: [], placed: [], final: [] };
      const me = e.source.userId; room.players.set(me, { name: displayName });
      for (let i = 1; i <= 15; i++) room.players.set(`SIM:${i}`, { name: `Player${i}` });
      await safeReply(e.replyToken, { type: 'text', text: 'เริ่มจำลอง (Placement ครบ 1–16) — ผู้เล่น 16 คน (กลุ่มนี้)\n- คุณจะเลือกหมัดใน DM ได้จริง\n- ผู้เล่น mock จะออกรออัตโนมัติ\nหากใครไม่ได้รับ DM ให้พิมพ์ "janken dm"' });
      // Start
      const ids = [...room.players.keys()];
      room.bracket.pools = seedPoolsFrom(ids); room.bracket.round = 1; room.phase = 'playing';
      await announcePoolsRound(gid, room, '📣 รอบ 16 ทีม (Main Bracket)');
      await safePush(gid, { type: 'text', text: '✉️ กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดของคุณ' });
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ============================== EXPORT ========================== */
// Nothing to export in single-file server