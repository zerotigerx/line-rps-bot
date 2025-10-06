// index.js — Janken Tournament (full: hero-image + queue/retry + position matches)
// Ready to deploy on Render/Node (Express + @line/bot-sdk)
// ------------------------------------------------------
// ✅ Requirements covered
// - Multi-room safe: every postback encodes groupId
// - Announcement text per spec; add group name; Flex hero (no external image)
// - Admin-only: only opener can close/reset
// - 20 players max; odd count → auto add BOT; human always wins vs BOT; BOT ranks last
// - Flex menus in group; DM shows group name; praise/tease copy randomized
// - Queue + retry + staggered push to avoid 400/429 bursts
// - Main tournament (pools→cross) + Position Matches (3–4, 5–8, 9–16) until full ranking
// - Safe fallbacks when Flex/Push fails
// ------------------------------------------------------

import 'dotenv/config'
import express from 'express'
import { middleware, Client } from '@line/bot-sdk'

/* ========== LINE CONFIG ========== */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
}
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials');
  process.exit(1)
}

/* ========== APP BOOT ========== */
const app = express()
const client = new Client(config)
const PORT = process.env.PORT || 3000

app.get('/', (_req, res) => res.send('✅ Janken Tournament running'))
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body?.events || [])) await handleEvent(ev)
    res.sendStatus(200)
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e)
    res.sendStatus(200)
  }
})
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`))

/* ========== GLOBAL/STATE ========== */
const HANDS = ['rock', 'paper', 'scissors']
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' }
const POOLS = ['A', 'B', 'C', 'D']

const BOT_UID = 'BOT:engine'
const BOT_NAME = 'BOT 🤖'
const isBot = (id) => id === BOT_UID

function isRealUserId(id) {
  return typeof id === 'string' && id.startsWith('U')
}

const rooms = new Map() // groupId -> room state
const groupNameCache = new Map()

const nowTH = () => new Date().toLocaleString('th-TH', { hour12: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shuffle = (a) => {
  const x = [...a]
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[x[i], x[j]] = [x[j], x[i]]
  }
  return x
}
const pretty = (room, uid) => (uid ? (room.players.get(uid)?.name || '(?)') : 'Bot');

const judge = (a, b, aUid = null, bUid = null) => {
  // Human vs BOT: human wins silently
  if (isBot(aUid) && !isBot(bUid)) return 'B'
  if (!isBot(aUid) && isBot(bUid)) return 'A'
  if (!a || !b) return a ? 'A' : 'B'
  if (a === b) return 'DRAW'
  const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' }
  return beats[a] === b ? 'A' : 'B'
}

async function groupName(gid) {
  if (groupNameCache.has(gid)) return groupNameCache.get(gid)
  try {
    const s = await client.getGroupSummary(gid)
    if (s?.groupName) {
      groupNameCache.set(gid, s.groupName)
      return s.groupName
    }
  } catch {}
  return '(กลุ่มของคุณ)'
}

/* ========== SAFE PUSH/REPLY with queue+retry ========== */
const MAX_RETRY = 4
const BASE_DELAY = 350 // ms between pushes to reduce 400/429

async function pushWithRetry(to, messages, attempt = 1) {
  try {
    await client.pushMessage(to, Array.isArray(messages) ? messages : [messages])
  } catch (e) {
    const status = e?.status || e?.response?.status
    const recoverable = status === 400 || status === 429 || status === 500 || status === 503
    if (recoverable && attempt < MAX_RETRY) {
      const backoff = Math.min(2000, BASE_DELAY * attempt * 2)
      console.warn(`[push#${attempt}] status=${status} → retry in ${backoff}ms`)
      await sleep(backoff)
      return pushWithRetry(to, messages, attempt + 1)
    }
    console.error('[push-final] status=' + status, e?.response?.data || e)
    throw e
  }
}
async function replyWithRetry(token, messages, attempt = 1) {
  try {
    await client.replyMessage(token, Array.isArray(messages) ? messages : [messages])
  } catch (e) {
    const status = e?.status || e?.response?.status
    const recoverable = status === 400 || status === 429 || status === 500 || status === 503
    if (recoverable && attempt < MAX_RETRY) {
      const backoff = Math.min(2000, BASE_DELAY * attempt * 2)
      console.warn(`[reply#${attempt}] status=${status} → retry in ${backoff}ms`)
      await sleep(backoff)
      return replyWithRetry(token, messages, attempt + 1)
    }
    console.error('[reply-final] status=' + status, e?.response?.data || e)
    throw e
  }
}

async function safePush(to, msg) {
  try {
    // LINE SDK รับ object เดี่ยว หรือ array (≤ 5 ข้อความ)
    await client.pushMessage(to, msg);
  } catch (e) {
    const code = e?.response?.status;
    const data = e?.response?.data;   // <<<<< ข้อนี้สำคัญ จะมีข้อความอธิบายสาเหตุ
    console.error('PUSH_ERROR', { to, code, data, sample: JSON.stringify(msg).slice(0, 400) });
    throw e;
  }
}
async function safeReply(token, messages) {
  try { await replyWithRetry(token, messages) } catch {}
}

// push many users with stagger
async function pushBulkStagger(recipients, builder, gap = BASE_DELAY, gid = null, room = null) {
  const targets = (recipients || []).filter(isRealUserId);   // <<<< กรองผู้รับตรงนี้
  for (const uid of targets) {
    try {
      await safePush(uid, builder(uid));
    } catch (e) {
      // แจ้งเตือนในกลุ่มเมื่อส่ง DM ไม่สำเร็จ (ช่วยดีบัก)
      const code = e?.response?.status;
      if (gid && code) {
        await safePush(gid, { type: 'text', text: `❗️ส่ง DM ให้ผู้เล่นบางคนไม่สำเร็จ (code ${code})` });
      }
    }
    await sleep(gap);
  }
}

/* ========== ROOM INITIALIZER ========== */
function ensureRoom(gid) {
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin: null,
      phase: 'idle', // idle | register | playing | finished
      stage: 'pools', // pools | cross | finished
      players: new Map(), // userId -> { name, isBot? }
      bracket: {
        round: 0,
        pools: { A: [], B: [], C: [], D: [] }, // match: {a,b,state,moves,winner,loser}
        cross: [],
        waitingOdd: null,
      },
      // ranking helpers
      rankOut: [],                // full ordered ranking (1..n) when finished
      rankBuckets: { final: [], semi: [], quarter: [], r16: [] },
      // position matches module
      position: {
        active: false,
        third: null,
        fiveToEight: null,
        nineToSixteen: null,
        labels: {},
      },
    })
  }
  return rooms.get(gid)
}

/* ========== FLEX / UI ========== */
function menuFlex() {
  return {
    type: 'flex',
    altText: 'Janken Menu',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '🎌 Janken Tournament', weight: 'bold', size: 'lg' },
      ]},
      body: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary',   action: { type: 'message', label: 'Join',   text: 'janken join' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Close',  text: 'janken close' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Status', text: 'janken status' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'Reset',  text: 'janken reset' } },
      ]},
    }
  }
}

function openBannerFlex(group) {
  return {
    type: 'flex', altText: 'JANKEN TOURNAMENT เปิดแล้ว!',
    contents: {
      type: 'bubble',
      hero: { type: 'box', layout: 'vertical', backgroundColor: '#111', contents: [
        { type: 'text', text: 'JANKEN', weight: 'bold', size: '3xl', color: '#FFD54F', align: 'center' },
        { type: 'text', text: 'TOURNAMENT', weight: 'bold', size: 'xl', color: '#FFFFFF', align: 'center' },
        { type: 'text', text: `กลุ่ม “${group}”`, size: 'sm', color: '#BDBDBD', align: 'center', margin: 'sm' },
      ], paddingAll: '24px', cornerRadius: 'md' },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', wrap: true },
        { type: 'box', layout: 'vertical', backgroundColor: '#F5F5F5', cornerRadius: 'md', paddingAll: '12px', contents: [
          { type: 'text', text: 'กด Join เพื่อเข้าร่วมการแข่งขัน', size: 'sm', color: '#666' },
          { type: 'text', text: 'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', size: 'sm', color: '#666', margin: 'sm' },
          { type: 'text', text: '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)', size: 'xs', color: '#999', margin: 'sm' },
        ] },
      ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#4CAF50', action: { type: 'message', label: 'Join', text: 'janken join' } },
      ]}
    }
  }
}

function buildFlexRoundPairs(title, lines) {
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg' },
        { type: 'text', text: nowTH(), size: 'xs', color: '#999' },
      ]},
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: lines.map(t => ({ type: 'text', text: t, wrap: true })) }
    }
  }
}

async function tryPushFlexOrText(to, title, lines) {
  const MAX = 10
  const chunks = []
  for (let i = 0; i < lines.length; i += MAX) chunks.push(lines.slice(i, i + MAX))
  try {
    if (!chunks.length) { await safePush(to, { type: 'text', text: title + '\n(ไม่มีคู่ในรอบนี้)' }); return }
    for (let i = 0; i < chunks.length; i++) {
      const head = chunks.length > 1 ? `${title} (หน้า ${i + 1}/${chunks.length})` : title
      await pushWithRetry(to, [buildFlexRoundPairs(head, chunks[i])])
      await sleep(120)
    }
  } catch (e) {
    await safePush(to, { type: 'text', text: [title, ...lines].join('\n') })
  }
}

/* ====== DM buttons with POSTBACK (multi-room safe) ====== */
const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-' }|${idx}`
function makePostback(gid, stage, pool, idx, move) {
  const map = { rock: ['✊ Rock', 'Rock'], paper: ['✋ Paper', 'Paper'], scissors: ['✌ Scissors', 'Scissors'] }
  const [label, displayText] = map[move]
  return {
    type: 'postback',
    label,
    data: `move=${move}&gid=${gid}&stage=${stage}&pool=${pool}&idx=${idx}`,
    displayText
  }
}

const qrPostback = (gid, stage, pool, idx) => ({
  items: HANDS.map(h => ({ type: 'action', action: makePostback(gid, stage, pool, idx, h) }))
})

function choiceFlexPostback(title, gid, stage, pool, idx) {
  return {
    type: 'flex',
    altText: title || 'เลือกหมัดในการดวล',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'rock'),     color: '#ff6666', height: 'sm' },
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'paper'),    color: '#66ccff', height: 'sm' },
          { type: 'button', style: 'primary', action: makePostback(gid, stage, pool, idx, 'scissors'), color: '#99cc66', height: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size: 'xs', color: '#999' }]
      }
    }
  }
}

/* ========== ANNOUNCE HELPERS (Main bracket) ========== */
const toPairs = ids => { const out = []; for (let i = 0; i < ids.length; i += 2) out.push([ids[i] || null, ids[i + 1] || null]); return out }
// กระจายคนลงสายเท่าที่จำเป็น (อย่างน้อย 1 สาย)
// เพื่อเลี่ยงเคส 2 คนถูกแยกคนละสายจนได้บาย
function seedPoolsFrom(ids) {
  // เตรียมโครง 4 สายไว้ก่อน กันโค้ดส่วนอื่นอ้าง POOLS ครบชุด
  const pools = { A: [], B: [], C: [], D: [] };

  // จำนวนสายที่ใช้จริง = min(4, floor(n/2)) อย่างน้อย 1
  const n = ids.length;
  const poolCount = Math.max(1, Math.min(4, Math.floor(n / 2))) || 1;
  const keys = POOLS.slice(0, poolCount);

  const shuffled = shuffle(ids);
  let i = 0;
  for (const id of shuffled) {
    pools[keys[i % keys.length]].push(id);
    i++;
  }

  // จับคู่ภายในแต่ละสาย (ถ้าเหลือคี่จะได้ [uid, null] = บาย)
  for (const k of POOLS) {
    const pairs = toPairs(pools[k]);
    pools[k] = pairs.map(([a, b]) => ({
      a, b, state: 'pending', moves: {}, winner: null, loser: null
    }));
  }
  return pools;
}
const allPoolsDone = pools => POOLS.every(k => pools[k].every(m => m.state === 'done'))
const poolWinners = pools => POOLS.reduce((acc, k) => (acc[k] = pools[k].map(m => m.winner).filter(Boolean), acc), {})

const PRAISES = [
  (t) => `สุดยอด! ${t} 😎`,
  (t) => `มีชั้นเชิง ${t} ✨`,
  (t) => `โคตรคูล ${t} 🔥`,
  (t) => `ฟีลลิ่งดี ${t} ✅`,
]
const complimentForChoice = () => PRAISES[Math.floor(Math.random() * PRAISES.length)]('ที่เลือก')

async function announcePoolsRound(gid, room, title) {
  const lines = []
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue
    lines.push(`สาย ${k}`)
    room.bracket.pools[k].forEach((m, i) => lines.push(`  Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`))
  }
  await tryPushFlexOrText(gid, title, lines)

  const gName = await groupName(gid)
  for (const k of POOLS) {
    for (let i = 0; i < room.bracket.pools[k].length; i++) {
      const m = room.bracket.pools[k][i]
      const targets = [m.a, m.b].filter(isRealUserId)
      await pushBulkStagger(targets, () => ([
        { type: 'text', text: `📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'pools', k, i) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'pools', k, i),
        { type: 'text', text: `${complimentForChoice()} เมื่อเลือกแล้ว รอลุ้นผลในกลุ่ม “${gName}”` },
      ]))
    }
  }
}

async function announceCrossRound(gid, room, title) {
  const lines = room.bracket.cross.map((m, i) => `Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`)
  await tryPushFlexOrText(gid, title, lines)

  const gName = await groupName(gid)
  for (let i = 0; i < room.bracket.cross.length; i++) {
    const m = room.bracket.cross[i]
    const targets = [m.a, m.b].filter(Boolean)
    await pushBulkStagger(targets, () => ([
      { type: 'text', text: `📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'cross', null, i) },
      choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'cross', null, i),
      { type: 'text', text: `${complimentForChoice()} เลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` },
    ]))
  }
}

/* ========== FLEX ผลการแข่ง (ดูดี + fallback) ========== */
function flexMatchResult(title, aName, aH, bName, bH, winName) {
  return {
    type: 'flex', altText: `${title}: ${winName}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg' }] },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: aName, size: 'md', flex: 5, wrap: true },
            { type: 'text', text: EMOJI[aH] || '', size: 'lg', flex: 1, align: 'end' },
          ]},
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: bName, size: 'md', flex: 5, wrap: true },
            { type: 'text', text: EMOJI[bH] || '', size: 'lg', flex: 1, align: 'end' },
          ]},
          { type: 'separator' },
          { type: 'text', text: `ผู้ชนะ: ${winName}`, weight: 'bold', color: '#2E7D32' },
        ]
      }
    }
  }
}

/* ========== POSITION MATCHES MODULE ========== */
function trackLoser(room, uid, stageHint) {
  if (!uid) return
  if (uid === BOT_UID) return // BOT ไปท้ายสุด
  const b = room.rankBuckets
  if (stageHint === 'final') b.final.push(uid)
  else if (stageHint === 'semi') b.semi.push(uid)
  else if (stageHint === 'quarter') b.quarter.push(uid)
  else if (stageHint === 'r16') b.r16.push(uid)
}

function pairUp(ids) { const out = []; for (let i = 0; i < ids.length; i += 2) out.push([ids[i] || null, ids[i + 1] || null]); return out }
function buildMiniBracket(ids) {
  const rounds = []
  const first = pairUp(ids).map(([a, b]) => ({ a, b, state: 'pending', moves: {}, winner: null, loser: null }))
  rounds.unshift(first)
  return { rounds }
}

async function startPositionMatches(gid, room) {
  const semi = [...room.rankBuckets.semi]
  const qf = [...room.rankBuckets.quarter]
  const r16 = [...room.rankBuckets.r16]

  room.position.active = true
  room.position.labels = {}

  if (semi.length === 2) room.position.third = buildMiniBracket(semi)
  if (qf.length === 4) room.position.fiveToEight = buildMiniBracket(qf)
  if (r16.length === 8) room.position.nineToSixteen = buildMiniBracket(r16)

  await announcePositionRound(gid, room)
}

async function announcePositionRound(gid, room) {
  const gName = await groupName(gid)
  const lines = []
  const pushBlock = async (matches, titlePrefix, stageKey) => {
    if (!matches) return
    const round = matches.rounds[0]
    if (!round) return
    lines.push(`${titlePrefix}`)
    round.forEach((m, i) => lines.push(`  Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`))
    for (let i = 0; i < round.length; i++) {
      const m = round[i]
      const targets = [m.a, m.b].filter((u) => u && u !== BOT_UID)
      await pushBulkStagger(targets, () => ([
        { type: 'text', text: `📝 เพลย์ออฟจัดอันดับ (${titlePrefix}) – กลุ่ม “${gName}” เลือกหมัดของคุณ` },
        choiceFlexPostback('เลือกหมัดสำหรับเพลย์ออฟ', gid, `pos:${stageKey}`, null, i),
        { type: 'text', text: `${complimentForChoice()} เมื่อเลือกแล้ว ไปลุ้นผลในกลุ่ม “${gName}”` },
      ]))
    }
  }

  await pushBlock(room.position.third, 'ชิงอันดับ 3–4', 'third')
  await pushBlock(room.position.fiveToEight, 'จัดอันดับ 5–8', '5-8')
  await pushBlock(room.position.nineToSixteen, 'จัดอันดับ 9–16', '9-16')

  if (lines.length) await tryPushFlexOrText(gid, '📣 เพลย์ออฟจัดอันดับเริ่มแล้ว', lines)
}

async function handlePositionPostback(gid, room, key, idx, hand, uid, replyToken) {
  const block = key === 'third' ? room.position.third
    : key === '5-8' ? room.position.fiveToEight
      : key === '9-16' ? room.position.nineToSixteen : null
  if (!block) return
  const round = block.rounds[0]
  const m = round?.[idx]
  if (!m) return
  if (![m.a, m.b].includes(uid)) return

  m.moves[uid] = hand
  const gName = await groupName(gid)
  await safeReply(replyToken, { type: 'text', text: `${complimentForChoice()} (เลือก ${hand.toUpperCase()} ${EMOJI[hand]})\nรอประกาศผลในกลุ่ม “${gName}”` })

  const aH = m.moves[m.a], bH = m.moves[m.b]
  if (m.a && !m.b) { m.winner = m.a; m.loser = null; m.state = 'done' }
  else if (m.b && !m.a) { m.winner = m.b; m.loser = null; m.state = 'done' }
  else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b)
    if (r === 'DRAW') {
      m.moves = {}
      for (const u of [m.a, m.b]) if (u && u !== BOT_UID) await safePush(u, [
        { type: 'text', text: `เสมอ – เลือกใหม่ (เพลย์ออฟ ${key})` },
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, `pos:${key}`, null, idx),
      ])
      return
    }
    m.winner = r === 'A' ? m.a : m.b
    m.loser = r === 'A' ? m.b : m.a
    m.state = 'done'
    try {
      await client.pushMessage(gid, [flexMatchResult(`เพลย์ออฟ ${key}`, pretty(room, m.a), aH, pretty(room, m.b), bH, pretty(room, m.winner))])
    } catch {
      await safePush(gid, { type: 'text', text: `เพลย์ออฟ ${key}\n${pretty(room, m.a)} ${EMOJI[aH] || ''} vs ${pretty(room, m.b)} ${EMOJI[bH] || ''}\nผู้ชนะ: ${pretty(room, m.winner)}` })
    }
  } else return

  await progressPositionBlock(gid, room, key)
}

async function progressPositionBlock(gid, room, key) {
  const block = key === 'third' ? room.position.third
    : key === '5-8' ? room.position.fiveToEight
      : key === '9-16' ? room.position.nineToSixteen : null
  if (!block) return
  const cur = block.rounds[0]
  if (!cur.every(m => m.state === 'done')) return

  const winners = cur.map(m => m.winner).filter(Boolean)
  const losers = cur.map(m => m.loser).filter(Boolean)

  const pushRanks = (ids, start) => {
    ids.forEach((u, i) => { if (u && !room.rankOut.includes(u)) room.rankOut.splice(start - 1 + i, 0, u) })
  }

  if (key === 'third') {
    pushRanks([winners[0], losers[0]], 3)
    room.position.third = null
  } else if (key === '5-8') {
    if (block.rounds.length === 1) {
      const next = [
        { a: winners[0] || null, b: winners[1] || null, state: 'pending', moves: {}, winner: null, loser: null },
        { a: losers[0] || null, b: losers[1] || null, state: 'pending', moves: {}, winner: null, loser: null },
      ]
      block.rounds.unshift(next)
      await announcePositionRound(gid, room)
      return
    } else {
      const final5_6 = block.rounds[0][0]
      const final7_8 = block.rounds[0][1]
      const r5 = final5_6.winner, r6 = final5_6.loser
      const r7 = final7_8.winner, r8 = final7_8.loser
      pushRanks([r5, r6, r7, r8], 5)
      room.position.fiveToEight = null
    }
  } else if (key === '9-16') {
    if (block.rounds.length === 1) {
      const next = [
        { a: winners[0] || null, b: winners[1] || null, state: 'pending', moves: {}, winner: null, loser: null }, // 9/10
        { a: winners[2] || null, b: winners[3] || null, state: 'pending', moves: {}, winner: null, loser: null }, // 11/12
        { a: losers[0] || null, b: losers[1] || null, state: 'pending', moves: {}, winner: null, loser: null },   // 13/14
        { a: losers[2] || null, b: losers[3] || null, state: 'pending', moves: {}, winner: null, loser: null },   // 15/16
      ]
      block.rounds.unshift(next)
      await announcePositionRound(gid, room)
      return
    } else {
      const r = block.rounds[0]
      const order = [r[0].winner, r[0].loser, r[1].winner, r[1].loser, r[2].winner, r[2].loser, r[3].winner, r[3].loser]
      pushRanks(order, 9)
      room.position.nineToSixteen = null
    }
  }

  if (!room.position.third && !room.position.fiveToEight && !room.position.nineToSixteen) {
    if (!room.rankOut.includes(BOT_UID) && room.players.has(BOT_UID)) room.rankOut.push(BOT_UID)

    const lines = []
    lines.push('🏁 อันดับสุดท้ายของทัวร์นี้')
    const name = (u) => (u === BOT_UID ? BOT_NAME : pretty(room, u))
    room.rankOut.forEach((u, i) => lines.push(`${i + 1}. ${name(u)}`))
    await tryPushFlexOrText(gid, 'สรุปอันดับทั้งหมด', lines)

    room.phase = 'finished'; room.stage = 'finished'
  }
}

/* ========== EVENT HANDLER ========== */
async function handleEvent(e) {
  // --- POSTBACK (DM) ---
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const data = e.postback.data.split('|') // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (data[0] === 'jg') {
      const gid = data[1]
      const stage = data[2] // 'pools' | 'cross' | 'pos:<key>'
      const pool = data[3] === '-' ? null : data[3]
      const idx = Number(data[4])
      const hand = data[5]
      const uid = e.source.userId
      if (!rooms.has(gid)) return
      const room = rooms.get(gid)

      if (stage?.startsWith('pos:')) {
        const key = stage.split(':')[1]
        await handlePositionPostback(gid, room, key, idx, hand, uid, e.replyToken)
        return
      }

      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx]
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand
          const gName = await groupName(gid)
          await safeReply(e.replyToken, { type: 'text', text: `${complimentForChoice()} (เลือก ${hand.toUpperCase()} ${EMOJI[hand]})\nรอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` })
          await tryCloseMatch_Pool(gid, room, pool, idx)
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx]
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand
          const gName = await groupName(gid)
          await safeReply(e.replyToken, { type: 'text', text: `${complimentForChoice()} (เลือก ${hand.toUpperCase()} ${EMOJI[hand]})\nรอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` })
          await tryCloseMatch_Cross(gid, room, idx)
        }
      }
    }
    return
  }

  // --- DM text fallback ---
  if (e.type === 'message' && e.message.type === 'text' && e.source.type === 'user') {
    const t = (e.message.text || '').trim().toLowerCase()
    if (!HANDS.includes(t)) {
      await safeReply(e.replyToken, { type: 'text', text: 'แตะปุ่มเพื่อเลือกหมัดได้เลย (หรือพิมพ์ rock / paper / scissors)' })
      return
    }
    await safeReply(e.replyToken, { type: 'text', text: 'เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกัน โปรดแตะปุ่มเลือกหมัดที่ส่งไปให้ (มีชื่อกลุ่มระบุไว้แล้ว) ครับ 🙏' })
    return
  }

  // --- Group commands ---
  if (e.type !== 'message' || e.message.type !== 'text') return
  if (!(e.source.type === 'group' || e.source.type === 'supergroup')) return

  const gid = e.source.groupId
  const text = (e.message.text || '').trim()
  const [cmd, sub, ...rest] = text.split(/\s+/)
  const c0 = (cmd || '').toLowerCase()
  if (c0 === 'menu') { await safeReply(e.replyToken, menuFlex()); return }
  if (c0 !== 'janken' && c0 !== 'rps') return

  const room = ensureRoom(gid)
  const gName = await groupName(gid)

  let displayName = 'Player'
  try { const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName } catch {}

  switch ((sub || '').toLowerCase()) {
    case 'open': {
      room.admin = e.source.userId
      room.phase = 'register'
      room.stage = 'pools'
      room.players = new Map()
      room.bracket = { round: 0, pools: { A: [], B: [], C: [], D: [] }, cross: [], waitingOdd: null }
      room.rankOut = []
      room.rankBuckets = { final: [], semi: [], quarter: [], r16: [] }
      room.position = { active: false, third: null, fiveToEight: null, nineToSixteen: null, labels: {} }

      const announce = [
        `🎌✨ JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'กด Join เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คนเท่านั้น ‼️',
        '',
        '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)',
      ].join('\n')

      await sleep(350)
      await safePush(gid, { type: 'text', text: announce })
      await sleep(150)
      await safePush(gid, openBannerFlex(gName))
      await sleep(150)
      await safeReply(e.replyToken, [menuFlex(), { type: 'text', text: '🟢 เปิดรับสมัครแล้ว (พิมพ์ janken join เพื่อเข้าร่วม)' }])
      break
    }

    case 'join': {
      if (room.phase !== 'register') { await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่เปิดรับสมัคร' }); break }
      if (room.players.size >= 20) { await safeReply(e.replyToken, { type: 'text', text: '❌ ทัวร์เต็ม (20 คน)' }); break }
      const name = (rest.join(' ') || displayName).slice(0, 40)
      room.players.set(e.source.userId, { name })
      await safeReply(e.replyToken, { type: 'text', text: `✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/20)` })
      break
    }

    case 'close': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิด (ผู้จัด) เท่านั้นที่เริ่มได้ 🙏' }); break }
      if (room.phase !== 'register') { await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่ได้เปิดรับสมัคร' }); break }
      if (room.players.size < 2) { await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีอย่างน้อย 2 คน' }); break }

      const ids = [...room.players.keys()]
      if (ids.length % 2 === 1) {
        room.players.set(BOT_UID, { name: BOT_NAME, isBot: true })
        ids.push(BOT_UID)
      }

      function isRealUserId(id) {
        // LINE userId จริงจะขึ้นต้นด้วย "U"
        return typeof id === 'string' && id.startsWith('U');
      }

      room.bracket.pools = seedPoolsFrom(ids)
      room.bracket.round = 1
      room.phase = 'playing'
      room.stage = 'pools'

      await safePush(gid, { type: 'text', text: `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})` })
      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`)
      await safePush(gid, { type: 'text', text: `📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` })
      break
    }

    case 'status': {
      const head = room.phase === 'register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
        : room.phase === 'playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
          : room.phase === 'finished' ? '🏁 จบการแข่งขันแล้ว' : '—'
      await safeReply(e.replyToken, { type: 'text', text: head })
      break
    }

    case 'reset': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken, { type: 'text', text: 'เฉพาะผู้เปิดเท่านั้นที่รีเซ็ตได้ 🙏' }); break }
      rooms.delete(gid)
      await safeReply(e.replyToken, { type: 'text', text: '♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' })
      break
    }

    default: await safeReply(e.replyToken, menuFlex())
  }
}

/* ========== MAIN BRACKET RESOLUTION ========== */
async function tryCloseMatch_Pool(gid, room, k, idx) {
  const m = room.bracket.pools[k][idx]
  const aH = m.moves[m.a], bH = m.moves[m.b]

  if (m.a && !m.b) {
    m.winner = m.a; m.loser = null; m.state = 'done'
    await safePush(gid, { type: 'text', text: `✅ สาย ${k} — Match ${idx + 1}: ${pretty(room, m.a)} ได้สิทธิ์บาย` })
  } else if (m.b && !m.a) {
    m.winner = m.b; m.loser = null; m.state = 'done'
    await safePush(gid, { type: 'text', text: `✅ สาย ${k} — Match ${idx + 1}: ${pretty(room, m.b)} ได้สิทธิ์บาย` })
  } else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b)
    if (r === 'DRAW') {
      m.moves = {}
      const gName = await groupName(gid)
      for (const uid of [m.a, m.b]) if (uid) await safePush(uid, [
        { type: 'text', text: `เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid, 'pools', k, idx) },
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', k, idx),
      ])
      return
    }
    m.winner = r === 'A' ? m.a : m.b; m.loser = r === 'A' ? m.b : m.a; m.state = 'done'
    try {
      await client.pushMessage(gid, [flexMatchResult(`สาย ${k} — Match ${idx + 1}`, pretty(room, m.a), aH, pretty(room, m.b), bH, pretty(room, m.winner))])
    } catch {
      await safePush(gid, { type: 'text', text: `สาย ${k} — Match ${idx + 1}\n${pretty(room, m.a)} ${EMOJI[aH]} vs ${pretty(room, m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room, m.winner)}` })
    }
  } else return

  if (!allPoolsDone(room.bracket.pools)) return

  const winners = poolWinners(room.bracket.pools)
  const lines = []
  for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u => pretty(room, u)).join(', ')}`)
  await tryPushFlexOrText(gid, 'สรุปผลรอบนี้', lines)

  // สร้างรอบถัดไปภายในสาย หรือรวมสาย
  const eachPoolSingle = POOLS.every(kk => winners[kk].length <= 1)
  if (!eachPoolSingle) {
    const next = { A: [], B: [], C: [], D: [] }
    for (const kk of POOLS) {
      const ws = winners[kk]
      for (let i = 0; i < ws.length; i += 2) next[kk].push({ a: ws[i] || null, b: ws[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null })
    }
    room.bracket.pools = next
    room.bracket.round += 1
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`)
    return
  }

  const champs = Object.values(winners).flat()
  if (champs.length === 1) {
    // แชมป์เลย (เช่นคนเดียวจากทุกสาย)
    const champion = champs[0]
    room.rankOut.push(champion)
    // เริ่มเพลย์ออฟจัดอันดับที่เหลือ
    await startPositionMatches(gid, room)
    return
  }

  const ids = shuffle(champs)
  const cross = []
  for (let i = 0; i < ids.length; i += 2) cross.push({ a: ids[i] || null, b: ids[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null })
  room.stage = 'cross'
  room.bracket.cross = cross
  room.bracket.round += 1
  await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)')
}

async function tryCloseMatch_Cross(gid, room, idx) {
  const m = room.bracket.cross[idx]
  const aH = m.moves[m.a], bH = m.moves[m.b]

  if (m.a && !m.b) { m.winner = m.a; m.loser = null; m.state = 'done' }
  else if (m.b && !m.a) { m.winner = m.b; m.loser = null; m.state = 'done' }
  else if (aH && bH) {
    const r = judge(aH, bH, m.a, m.b)
    if (r === 'DRAW') {
      m.moves = {}
      const gName = await groupName(gid)
      for (const uid of [m.a, m.b]) if (uid) await safePush(uid, [
        { type: 'text', text: `เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid, 'cross', null, idx) },
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx),
      ])
      return
    }
    m.winner = r === 'A' ? m.a : m.b; m.loser = r === 'A' ? m.b : m.a; m.state = 'done'
    try {
      await client.pushMessage(gid, [flexMatchResult('ผลรอบรวม', pretty(room, m.a), aH, pretty(room, m.b), bH, pretty(room, m.winner))])
    } catch {
      await safePush(gid, { type: 'text', text: `ผลรอบรวม\n${pretty(room, m.a)} ${EMOJI[aH] || ''} vs ${pretty(room, m.b)} ${EMOJI[bH] || ''}\nผู้ชนะ: ${pretty(room, m.winner)}` })
    }
  } else return

  const done = room.bracket.cross.every(x => x.state === 'done')
  if (!done) return

  const winners = room.bracket.cross.map(x => x.winner).filter(Boolean)
  const losers = room.bracket.cross.map(x => x.loser).filter(Boolean)

  if (winners.length === 1) {
    const champion = winners[0]
    if (!room.rankOut.includes(champion)) room.rankOut.push(champion)
    // เก็บผู้แพ้รอบชิง (ถ้ามี) ลงถัง final → ใช้ในเพลย์ออฟ 3–4
    if (losers.length === 1) trackLoser(room, losers[0], 'final')
    // เริ่มเพลย์ออฟจัดอันดับที่เหลือ
    await startPositionMatches(gid, room)
    return
  }

  // ยังไม่จบ: ตีความลึกของรอบเพื่อโยนผู้แพ้ลงถังที่ถูกต้อง
  // จำนวนคู่ก่อนหน้า: winners.length*2 = จำนวนผู้เล่นในรอบนี้
  const size = winners.length * 2
  if (size === 4) { // รอบรอง (semi)
    losers.forEach(u => trackLoser(room, u, 'semi'))
  } else if (size === 8) { // quarter
    losers.forEach(u => trackLoser(room, u, 'quarter'))
  } else if (size === 16) { // r16
    losers.forEach(u => trackLoser(room, u, 'r16'))
  }

  const next = []
  for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i] || null, b: winners[i + 1] || null, state: 'pending', moves: {}, winner: null, loser: null })
  room.bracket.cross = next
  room.bracket.round += 1
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`)
}
