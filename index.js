// index.js — Janken Tournament (Full service, throttled + retry)
// --------------------------------------------------------------
// What you get
//  • Multi-room safe: encode groupId in every DM postback payload
//  • Admin-only close/reset (opener is the admin for that room)
//  • Odd-number auto BOT pairing (BOT always loses silently)
//  • BOT always ranked last in placements
//  • 20 player cap
//  • Flex menu + Opening banner (per your Thai copy)
//  • DM quick-reply + flex buttons (with group name)
//  • Announcement batching, retry/backoff, and DM throttle (to stop 429/400)
//  • Pools A–D -> winners bracket -> champion (position ladder: champion + elimination order)
//  • Clear logs to diagnose any future 400/429
//
// NOTE: This file focuses on reliability + correctness of messaging flow
//       (open/join/close -> DM choices -> resolve -> next rounds) with
//       safe API usage. Position matches are represented by elimination
//       order (rankOut) which gives complete placements deterministically
//       without spawning additional heavy rounds — suitable for LINE rate-limits.

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ================= LINE CONFIG ================= */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials');
  process.exit(1);
}

/* ================= APP BOOT ================= */
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
app.get('/', (_req, res) => res.send('✅ Janken Tournament up'));
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body?.events || [])) await handleEvent(ev);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error', err?.response?.data || err?.message || err);
    res.sendStatus(200);
  }
});

/* ================= GLOBALS ================= */
const HANDS = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const POOLS = ['A', 'B', 'C', 'D'];

const BOT_UID = 'BOT:engine';
const BOT_NAME = 'BOT 🤖';
const isBot = id => id === BOT_UID;

const rooms = new Map();               // groupId -> room state
const groupNameCache = new Map();      // groupId -> name

const nowTH = () => new Date().toLocaleString('th-TH', { hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DM_DELAY = 220;                  // throttle per DM to avoid 429

const shuffle = a => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const pretty = (room, uid) => uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';

// Judge with BOT rule: human always wins vs BOT
const judge = (a, b, aUid = null, bUid = null) => {
  if (isBot(aUid) && !isBot(bUid)) return 'B';
  if (!isBot(aUid) && isBot(bUid)) return 'A';
  if (!a || !b) return a ? 'A' : 'B';
  if (a === b) return 'DRAW';
  const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return beats[a] === b ? 'A' : 'B';
};

/* ================= Reliable send (retry + backoff) ================= */
function logApiError(prefix, err) {
  const code = err?.statusCode || err?.response?.status;
  const data = err?.response?.data || err?.originalError || err?.message;
  console.warn(`[${prefix}] status=${code}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}
async function withRetry(label, fn, tries = 4) {
  let delay = 400; // 0.4s
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = e?.statusCode || e?.response?.status;
      const retriable = [429, 500, 502, 503].includes(code);
      logApiError(`${label}#${i + 1}`, e);
      if (!retriable || i === tries - 1) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}
async function safePush(to, msgs) {
  const arr = Array.isArray(msgs) ? msgs : [msgs];
  try { await withRetry('push', () => client.pushMessage(to, arr)); }
  catch (e) { logApiError('push-final', e); }
}
async function safeReply(tk, msgs) {
  const arr = Array.isArray(msgs) ? msgs : [msgs];
  try { await withRetry('reply', () => client.replyMessage(tk, arr), 2); }
  catch (e) { logApiError('reply-final', e); }
}

/* ================= State helpers ================= */
function ensureRoom(gid) {
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin: null,
      phase: 'idle',            // idle | register | playing | finished
      stage: 'pools',           // pools | cross | finished
      players: new Map(),       // userId -> { name }
      bracket: {
        round: 0,
        pools: { A: [], B: [], C: [], D: [] },  // match: {a,b,state:'pending'|'done',moves:{},winner,loser}
        cross: [],                                // winners merged bracket
        waitingOdd: null,
      },
      rankOut: [],              // elimination order (for placements)
    });
  }
  return rooms.get(gid);
}
async function groupName(gid) {
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try {
    const s = await client.getGroupSummary(gid);
    if (s?.groupName) { groupNameCache.set(gid, s.groupName); return s.groupName; }
  } catch {}
  return '(กลุ่มของคุณ)';
}

/* ================= Flex / UI ================= */
function openBannerFlex(gn) {
  return {
    type: 'flex', altText: 'JANKEN TOURNAMENT เปิดแล้ว!',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box', layout: 'vertical', backgroundColor: '#111', paddingAll: '24px', cornerRadius: 'md',
        contents: [
          { type: 'text', text: 'JANKEN', weight: 'bold', size: '3xl', color: '#FFD54F', align: 'center' },
          { type: 'text', text: 'TOURNAMENT', weight: 'bold', size: 'xl', color: '#FFFFFF', align: 'center' },
          { type: 'text', text: `กลุ่ม “${gn}”`, size: 'sm', color: '#BDBDBD', align: 'center', margin: 'sm' },
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: 'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', wrap: true },
          { type: 'box', layout: 'vertical', backgroundColor: '#F5F5F5', cornerRadius: 'md', paddingAll: '12px', contents: [
            { type: 'text', text: 'กด Join เพื่อเข้าร่วมการแข่งขัน', size: 'sm', color: '#666' },
            { type: 'text', text: 'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', size: 'sm', color: '#666', margin: 'sm' },
            { type: 'text', text: '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)', size: 'xs', color: '#999', margin: 'sm' },
          ] }
        ]
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#4CAF50', action: { type: 'message', label: 'Join', text: 'janken join' } },
      ] }
    }
  };
}
function menuFlex() {
  return {
    type: 'flex', altText: 'Janken Menu',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: '🎌 Janken Tournament', weight: 'bold', size: 'lg' } ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'button', style: 'primary', action: { type: 'message', label: 'Join', text: 'janken join' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Close', text: 'janken close' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Status', text: 'janken status' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Reset', text: 'janken reset' } },
      ] }
    }
  };
}

const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-' }|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) => ({
  type: 'postback', label: `${EMOJI[hand]} ${hand.toUpperCase()}`,
  data: `jg|${matchKey(gid, stage, pool, idx)}|${hand}`,
  displayText: hand
});
const qrPostback = (gid, stage, pool, idx) => ({ items: HANDS.map(h => ({ type: 'action', action: makePostback(gid, stage, pool, idx, h) })) });

function choiceFlexPostback(title, gid, stage, pool, idx) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: title, weight: 'bold', size: 'lg' } ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'rock') },
        { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'paper') },
        { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'scissors') },
      ] },
      footer: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: '(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size: 'xs', color: '#999' } ] }
    }
  };
}

function buildFlexRoundPairs(title, lines) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: title, weight: 'bold', size: 'lg' }, { type: 'text', text: nowTH(), size: 'xs', color: '#999' } ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: lines.map(t => ({ type: 'text', text: t, wrap: true })) }
    }
  };
}
async function tryPushFlexOrText(to, title, lines) {
  const MAX = 10;
  const chunks = []; for (let i = 0; i < lines.length; i += MAX) chunks.push(lines.slice(i, i + MAX));
  try {
    if (!chunks.length) { await safePush(to, { type: 'text', text: `${title}\n(ไม่มีคู่ในรอบนี้)` }); return; }
    for (let i = 0; i < chunks.length; i++) {
      const head = chunks.length > 1 ? `${title} (หน้า ${i + 1}/${chunks.length})` : title;
      await safePush(to, [ buildFlexRoundPairs(head, chunks[i]) ]);
      await sleep(200);
    }
  } catch {
    await safePush(to, { type: 'text', text: [title, ...lines].join('\n') });
  }
}

/* ================= Brackets helpers ================= */
const toPairs = ids => { const out = []; for (let i = 0; i < ids.length; i += 2) out.push([ids[i] || null, ids[i + 1] || null]); return out; };
function seedPoolsFrom(ids) {
  const pools = { A: [], B: [], C: [], D: [] }, shuf = shuffle(ids); let i = 0;
  for (const id of shuf) { pools[POOLS[i % 4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a, b]) => ({ a, b, state: 'pending', moves: {}, winner: null, loser: null }));
  return pools;
}
const allPoolsDone = p => POOLS.every(k => p[k].every(m => m.state === 'done'));
const poolWinners = p => POOLS.reduce((acc, k) => (acc[k] = p[k].map(m => m.winner).filter(Boolean), acc), {});

/* ================= Announce Rounds (with DM throttle) ================= */
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
    for (let i = 0; i < room.bracket.pools[k].length; i++) {
      const m = room.bracket.pools[k][i];
      for (const uid of [m.a, m.b]) if (uid) {
        await safePush(uid, [
          { type: 'text', text: `📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'pools', k, i) },
          choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'pools', k, i),
          { type: 'text', text: `เมื่อเลือกแล้ว รอลุ้นผลในกลุ่ม “${gName}” ได้เลย!` }
        ]);
        await sleep(DM_DELAY);
      }
    }
  }
}
async function announceCrossRound(gid, room, title) {
  const lines = room.bracket.cross.map((m, i) => `Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`);
  await tryPushFlexOrText(gid, title, lines);
  const gName = await groupName(gid);
  for (let i = 0; i < room.bracket.cross.length; i++) {
    const m = room.bracket.cross[i];
    for (const uid of [m.a, m.b]) if (uid) {
      await safePush(uid, [
        { type: 'text', text: `📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด`, quickReply: qrPostback(gid, 'cross', null, i) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'cross', null, i),
        { type: 'text', text: `เลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` }
      ]);
      await sleep(DM_DELAY);
    }
  }
}

/* ================= Event Handler ================= */
async function handleEvent(e) {
  // 1) Postback in DM (safe across groups)
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const parts = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (parts[0] === 'jg') {
      const gid = parts[1];
      const stage = parts[2];
      const pool = parts[3] === '-' ? null : parts[3];
      const idx = Number(parts[4]);
      const hand = parts[5];
      const uid = e.source.userId;
      if (!rooms.has(gid)) return;
      const room = rooms.get(gid);
      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          await safeReply(e.replyToken, { type: 'text', text: `รับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่ง แล้วไปลุ้นผลในกลุ่ม “${gName}”` });
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          await safeReply(e.replyToken, { type: 'text', text: `รับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่ง แล้วไปลุ้นผลในกลุ่ม “${gName}”` });
          await tryCloseMatch_Cross(gid, room, idx);
        }
      }
    }
    return;
  }

  // 2) DM text fallback
  if (e.type === 'message' && e.message.type === 'text' && e.source.type === 'user') {
    const t = (e.message.text || '').trim().toLowerCase();
    if (!HANDS.includes(t)) {
      await safeReply(e.replyToken, { type: 'text', text: 'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเมื่อเล่นหลายทัวร์พร้อมกันครับ 🙏' });
      return;
    }
    await safeReply(e.replyToken, { type: 'text', text: 'เพื่อความชัวร์ โปรดใช้ปุ่มเลือกหมัดที่ส่งไปให้แทนการพิมพ์ครับ' });
    return;
  }

  // 3) Group commands
  if (e.type !== 'message' || e.message.type !== 'text') return;
  if (!['group', 'supergroup'].includes(e.source.type)) return;

  const gid = e.source.groupId;
  const text = (e.message.text || '').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd || '').toLowerCase();
  if (c0 === 'menu') { await safeReply(e.replyToken, menuFlex()); return; }
  if (!['janken', 'rps'].includes(c0)) return;

  const action = (sub || '').toLowerCase();
  const room = ensureRoom(gid);
  const gName = await groupName(gid);

  let displayName = 'Player';
  try { const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName; } catch {}

  switch (action) {
    case 'open': {
      room.admin = e.source.userId;
      room.phase = 'register';
      room.stage = 'pools';
      room.players = new Map();
      room.bracket = { round: 0, pools: { A: [], B: [], C: [], D: [] }, cross: [], waitingOdd: null };
      room.rankOut = [];

      const announceText = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'กด Join เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คนเท่านั้น ‼️',
        '',
        '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)'
      ].join('\n');

      await safePush(gid, [
        { type: 'text', text: announceText },
        openBannerFlex(gName)
      ]);
      await safeReply(e.replyToken, [ menuFlex(), { type: 'text', text: '🟢 เปิดรับสมัครแล้ว' } ]);
      break;
    }

    case 'join': {
      if (room.phase !== 'register') { await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่เปิดรับสมัคร' }); break; }
      const MAX = 20;
      if (room.players.size >= MAX) { await safeReply(e.replyToken, { type: 'text', text: `❌ ทัวร์เต็มแล้ว (${MAX} คน)` }); break; }
      const name = (rest.join(' ') || displayName).slice(0, 40);
      room.players.set(e.source.userId, { name });
      await safeReply(e.replyToken, { type: 'text', text: `✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX})` });
      break;
    }

    case 'close': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิด (ผู้จัด) เท่านั้นที่เริ่มได้ 🙏' }); break; }
      if (room.phase !== 'register') { await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่ได้เปิดรับสมัคร' }); break; }
      if (room.players.size < 2) { await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีอย่างน้อย 2 คน' }); break; }

      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) { room.players.set(BOT_UID, { name: BOT_NAME, isBot: true }); ids.push(BOT_UID); }
      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1;
      room.phase = 'playing';
      room.stage = 'pools';

      await safePush(gid, { type: 'text', text: `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})` });
      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      await safePush(gid, { type: 'text', text: `📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    case 'status': {
      const head = room.phase === 'register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
        : room.phase === 'playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
        : room.phase === 'finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken, { type: 'text', text: head });
      break;
    }

    case 'reset': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิดเท่านั้นที่รีเซ็ตได้ 🙏' }); break; }
      rooms.delete(gid);
      await safeReply(e.replyToken, { type: 'text', text: '♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ================= Resolve Matches ================= */
async function announceMatchResultFlex(gid, title, room, m, aH, bH) {
  try {
    await client.pushMessage(gid, [ {
      type: 'flex', altText: `${title}: ${pretty(room, m.winner)}`,
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: title, weight: 'bold', size: 'lg' } ] },
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'box', layout: 'baseline', contents: [ { type: 'text', text: pretty(room, m.a), size: 'md', flex: 5, wrap: true }, { type: 'text', text: EMOJI[aH] || '', size: 'lg', flex: 1, align: 'end' } ] },
          { type: 'box', layout: 'baseline', contents: [ { type: 'text', text: pretty(room, m.b), size: 'md', flex: 5, wrap: true }, { type: 'text', text: EMOJI[bH] || '', size: 'lg', flex: 1, align: 'end' } ] },
          { type: 'separator' },
          { type: 'text', text: `ผู้ชนะ: ${pretty(room, m.winner)}`, weight: 'bold', color: '#2E7D32' }
        ] }
      }
    } ]);
  } catch {
    await safePush(gid, { type: 'text', text: `${title}\n${pretty(room, m.a)} ${EMOJI[aH] || ''} vs ${pretty(room, m.b)} ${EMOJI[bH] || ''}\nผู้ชนะ: ${pretty(room, m.winner)}` });
  }
}

async function tryCloseMatch_Pool(gid, room, k, idx) {
  const m = room.bracket.pools[k][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { m.winner = m.a; m.loser = null; m.state = 'done'; }
  else if (m.b && !m.a) { m.winner = m.b; m.loser = null; m.state = 'done'; }
  else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b);
    if (r === 'DRAW') {
      m.moves = {};
      const gName = await groupName(gid);
      for (const uid of [m.a, m.b]) if (uid) {
        await safePush(uid, [
          { type: 'text', text: `เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid, 'pools', k, idx) },
          choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', k, idx)
        ]);
        await sleep(DM_DELAY);
      }
      return;
    }
    m.winner = r === 'A' ? m.a : m.b; m.loser = r === 'A' ? m.b : m.a; m.state = 'done';
    await announceMatchResultFlex(gid, `สาย ${k} — Match ${idx + 1}`, room, m, aH, bH);
    if (m.loser) room.rankOut.unshift(m.loser);      // ใส่หัว (แพ้ออกทีหลัง ranking ดีกว่า)
  } else return;

  if (!allPoolsDone(room.bracket.pools)) return;

  const winners = poolWinners(room.bracket.pools);
  const lines = [];
  for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u => pretty(room, u)).join(', ')}`);
  await tryPushFlexOrText(gid, 'สรุปผลรอบนี้', lines);

  // ถ้ายังมีหลายคนในสายเดิม -> กางสายต่อภายในสาย
  const eachPoolSingle = POOLS.every(kk => winners[kk].length <= 1);
  if (!eachPoolSingle) {
    const next = { A: [], B: [], C: [], D: [] };
    for (const kk of POOLS) {
      const ws = winners[kk];
      for (let i = 0; i < ws.length; i += 2)
        next[kk].push({ a: ws[i] || null, b: ws[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
    }
    room.bracket.pools = next;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // รวมแชมป์สาย -> cross
  const champs = Object.values(winners).flat();
  if (champs.length === 1) {
    const champion = champs[0];
    await safePush(gid, { type: 'text', text: `🏆 แชมป์: ${pretty(room, champion)}` });
    // placements: champion first, then others by elimination order, BOT last
    const placements = [ champion, ...room.rankOut.filter(u => u !== champion && !isBot(u)) ];
    if (room.players.has(BOT_UID)) placements.push(BOT_UID);
    await showPlacements(gid, room, placements);
    room.phase = 'finished'; room.stage = 'finished';
    return;
  }
  const ids = shuffle(champs);
  const cross = []; for (let i = 0; i < ids.length; i += 2) cross.push({ a: ids[i] || null, b: ids[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
  room.stage = 'cross';
  room.bracket.cross = cross;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

async function tryCloseMatch_Cross(gid, room, idx) {
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { m.winner = m.a; m.loser = null; m.state = 'done'; }
  else if (m.b && !m.a) { m.winner = m.b; m.loser = null; m.state = 'done'; }
  else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b);
    if (r === 'DRAW') {
      m.moves = {};
      const gName = await groupName(gid);
      for (const uid of [m.a, m.b]) if (uid) {
        await safePush(uid, [
          { type: 'text', text: `เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid, 'cross', null, idx) },
          choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx)
        ]);
        await sleep(DM_DELAY);
      }
      return;
    }
    m.winner = r === 'A' ? m.a : m.b; m.loser = r === 'A' ? m.b : m.a; m.state = 'done';
    await announceMatchResultFlex(gid, 'ผลรอบรวม', room, m, aH, bH);
    if (m.loser) room.rankOut.unshift(m.loser);
  } else return;

  const done = room.bracket.cross.every(x => x.state === 'done');
  if (!done) return;

  const winners = room.bracket.cross.map(x => x.winner).filter(Boolean);
  if (winners.length === 1) {
    const champion = winners[0];
    await safePush(gid, { type: 'text', text: `🏆 แชมป์: ${pretty(room, champion)}` });
    const placements = [ champion, ...room.rankOut.filter(u => u !== champion && !isBot(u)) ];
    if (room.players.has(BOT_UID)) placements.push(BOT_UID);
    await showPlacements(gid, room, placements);
    room.phase = 'finished'; room.stage = 'finished';
    return;
  }
  const next = []; for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i] || null, b: winners[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null });
  room.bracket.cross = next;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

async function showPlacements(gid, room, order) {
  const lines = order.map((uid, i) => `${i + 1}. ${pretty(room, uid)}`);
  await tryPushFlexOrText(gid, '🏁 สรุปอันดับทั้งหมด', lines);
}

// ===== END =====