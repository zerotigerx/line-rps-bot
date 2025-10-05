// index.js
// Janken Tournament — Multi-room safe / Admin-only close+reset / Odd -> BOT / Human always wins vs BOT
// LINE Messaging API (Node + @line/bot-sdk)

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ===================== LINE CONFIG ===================== */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials'); process.exit(1);
}

/* ===================== APP BOOT ===================== */
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('✅ Janken Tournament running'));
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body?.events || [])) await handleEvent(ev);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e);
    res.sendStatus(200);
  }
});
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));

/* ===================== CONSTANTS / HELPERS ===================== */
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];

const BOT_UID  = 'BOT:engine';
const BOT_NAME = 'BOT 🤖';
const isBot = uid => uid === BOT_UID;

const rooms = new Map();             // groupId -> room
const groupNameCache = new Map();    // groupId -> name

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });

const shuffle = arr => {
  const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
};
const pretty = (room, uid) => uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';

/** ใส่ชื่อผู้แพ้ตามลำดับการตกรอบ; เอาไว้ทำ ranking ตอนจบทัวร์ */
const markEliminated = (room, uid) => {
  if (!uid) return;
  if (!room.rankOut.some(x => x === uid)) room.rankOut.push(uid);
};

/** มนุษย์ชนะบอทเสมอ (เงียบ ๆ) */
const judge = (aHand, bHand, aUid=null, bUid=null) => {
  if (isBot(aUid) && !isBot(bUid)) return 'B';
  if (!isBot(aUid) && isBot(bUid)) return 'A';
  if (!aHand || !bHand) return aHand ? 'A' : 'B';
  if (aHand === bHand)  return 'DRAW';
  const beats = { rock:'scissors', paper:'rock', scissors:'paper' };
  return beats[aHand] === bHand ? 'A' : 'B';
};

async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try {
    const s = await client.getGroupSummary(gid);
    if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; }
  } catch {}
  return '(กลุ่มของคุณ)';
}

async function safePush(to, msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data || e?.message); } }
async function safeReply(token, msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data || e?.message); } }

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin: null,               // userId ของผู้เปิด (ผู้จัด)
      phase: 'idle',             // idle | register | playing | finished
      stage: 'pools',            // pools | cross | finished
      players: new Map(),        // userId -> { name, isBot? }
      bracket: {
        round: 0,
        pools: { A:[], B:[], C:[], D:[] },  // match = {a,b,state:'pending'|'done', moves:{}, winner, loser}
        cross: [],
        waitingOdd: null
      },
      rankOut: []               // เก็บลำดับผู้ตกรอบตามเวลา (ไว้ทำ ranking สุดท้าย)
    });
  }
  return rooms.get(gid);
}

/* ===================== FLEX / UI ===================== */
function menuFlex(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' }
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary',   action:{ type:'message', label:'Join',   text:'janken join' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Close',  text:'janken close' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Status', text:'janken status' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Reset',  text:'janken reset' } },
      ]}
    }
  };
}

function openBannerFlex(groupName='กลุ่มของคุณ'){
  return {
    type:'flex', altText:'JANKEN TOURNAMENT เปิดแล้ว!',
    contents:{
      type:'bubble',
      hero:{ type:'box', layout:'vertical', backgroundColor:'#111', contents:[
        { type:'text', text:'JANKEN',     weight:'bold', size:'3xl', color:'#FFD54F', align:'center' },
        { type:'text', text:'TOURNAMENT', weight:'bold', size:'xl',  color:'#FFFFFF', align:'center' },
        { type:'text', text:`กลุ่ม “${groupName}”`, size:'sm', color:'#BDBDBD', align:'center', margin:'sm' }
      ], paddingAll:'24px', cornerRadius:'md' },
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text:'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', wrap:true },
        { type:'box', layout:'vertical', backgroundColor:'#F5F5F5', cornerRadius:'md', paddingAll:'12px', contents:[
          { type:'text', text:'กด Join เพื่อเข้าร่วมการแข่งขัน', size:'sm', color:'#666' },
          { type:'text', text:'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', size:'sm', color:'#666', margin:'sm' },
          { type:'text', text:'(⏳ เมื่อครบแล้ว ผู้จัดจะเป็นผู้เริ่มแข่งให้เอง)', size:'xs', color:'#999', margin:'sm' }
        ]}
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'button', style:'primary', color:'#4CAF50', action:{ type:'message', label:'Join', text:'janken join' } }
      ]}
    }
  };
}

function buildFlexRoundPairs(title, lines){
  return {
    type:'flex', altText:title, contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:title, weight:'bold', size:'lg' },
        { type:'text', text: nowTH(), size:'xs', color:'#999' }
      ]},
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:
        lines.map(t=>({ type:'text', text:t, wrap:true }))
      }
    }
  };
}
async function tryPushFlexOrText(to, title, lines){
  const MAX = 10;
  const chunks=[]; for(let i=0;i<lines.length;i+=MAX) chunks.push(lines.slice(i,i+MAX));
  try{
    if (!chunks.length) { await safePush(to,{type:'text',text:title+'\n(ไม่มีคู่ในรอบนี้)'}); return; }
    for(let i=0;i<chunks.length;i++){
      const head = chunks.length>1 ? `${title} (หน้า ${i+1}/${chunks.length})` : title;
      await client.pushMessage(to, [buildFlexRoundPairs(head, chunks[i])]);
    }
  }catch(e){
    await safePush(to, { type:'text', text:[title, ...lines].join('\n') });
  }
}

/* ===== DM Buttons (postback-safe with group key) ===== */
const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-' }|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) =>
  ({ type:'postback', label:`${EMOJI[hand]} ${hand.toUpperCase()}`, data:`jg|${matchKey(gid,stage,pool,idx)}|${hand}`, displayText:hand });

const qrPostback = (gid, stage, pool, idx) => ({
  items: HANDS.map(h => ({ type:'action', action: makePostback(gid,stage,pool,idx,h) }))
});

function choiceFlexPostback(title, gid, stage, pool, idx) {
  return {
    type:'flex', altText:title,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:title, weight:'bold', size:'lg' }]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'rock') },
        { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'paper') },
        { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'scissors') },
      ]},
      footer:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size:'xs', color:'#999' }
      ]}
    }
  };
}

/* ===================== SEEDING / ANNOUNCE ===================== */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };

function seedPoolsFrom(ids){
  const pools={A:[],B:[],C:[],D:[]}, shuffled=shuffle(ids); let i=0;
  for(const id of shuffled){ pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  return pools;
}
const allPoolsDone = pools => POOLS.every(k => pools[k].every(m => m.state==='done'));
const poolWinners = pools => POOLS.reduce((acc,k)=> (acc[k] = pools[k].map(m=>m.winner).filter(Boolean), acc), {});

async function announcePoolsRound(gid, room, title){
  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m, i) => {
      for (const uid of [m.a, m.b]) if (uid && !isBot(uid)) {
        await safePush(uid, [
          { type:'text', text:`📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'pools', k, i) },
          choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'pools', k, i),
          { type:'text', text: randomPraise(`รับทราบคิวสู้แล้ว! เลือกเสร็จรอลุ้นผลในกลุ่ม “${gName}”`) }
        ]);
      }
    });
  }
}

async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);
  for (let idx=0; idx<room.bracket.cross.length; idx++){
    const m = room.bracket.cross[idx];
    for (const uid of [m.a,m.b]) if (uid && !isBot(uid)){
      await safePush(uid, [
        { type:'text', text:`📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'cross', null, idx) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'cross', null, idx),
        { type:'text', text: randomPraise(`เลือกแล้วรอลุ้นผลในกลุ่ม “${gName}” เลย!`) }
      ]);
    }
  }
}

/* ชม/แซวแบบสุ่ม */
const PRAISES = [
  (t)=>`ฟีลลิ่งดีมาก! (${t}) ✨`,
  (t)=>`โคตรคูล! (${t}) 😎`,
  (t)=>`มั่นใจแบบมีชั้นเชิง (${t}) ✅`,
  (t)=>`สไตล์จัด ๆ (${t}) 🔥`,
];
function randomPraise(base){
  const pick = PRAISES[Math.floor(Math.random()*PRAISES.length)]('ที่เลือก');
  return `${pick}\n${base}`;
}

/* ===================== FLEX แสดงผลแมตช์ ===================== */
function flexMatchResult(title, aName, aH, bName, bH, winName){
  return {
    type:'flex', altText:`${title}: ${winName}`,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' } ]},
      body:{
        type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'box', layout:'baseline', contents:[
            { type:'text', text:aName, size:'md', flex:5, wrap:true },
            { type:'text', text:EMOJI[aH]||'', size:'lg', flex:1, align:'end' }
          ]},
          { type:'box', layout:'baseline', contents:[
            { type:'text', text:bName, size:'md', flex:5, wrap:true },
            { type:'text', text:EMOJI[bH]||'', size:'lg', flex:1, align:'end' }
          ]},
          { type:'separator' },
          { type:'text', text:`ผู้ชนะ: ${winName}`, weight:'bold', color:'#2E7D32' }
        ]
      }
    }
  };
}

/* ===================== EVENT HANDLER ===================== */
async function handleEvent(e){
  /* --- Postback: เลือกหมัดใน DM (ผูก match ด้วย groupId) --- */
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const data = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (data[0] === 'jg') {
      const gid   = data[1];
      const stage = data[2];                 // 'pools' | 'cross'
      const pool  = data[3] === '-' ? null : data[3];
      const idx   = Number(data[4]);
      const hand  = data[5];
      const uid   = e.source.userId;

      if (!rooms.has(gid)) return;
      const room = rooms.get(gid);

      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          await safeReply(e.replyToken, { type:'text', text: randomPraise(`คุณเลือก ${hand.toUpperCase()} ${EMOJI[hand]} แล้ว\nรอคู่ต่อสู้และไปลุ้นผลในกลุ่ม “${gName}”`) });
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          await safeReply(e.replyToken, { type:'text', text: randomPraise(`คุณเลือก ${hand.toUpperCase()} ${EMOJI[hand]} แล้ว\nรอคู่ต่อสู้และไปลุ้นผลในกลุ่ม “${gName}”`) });
          await tryCloseMatch_Cross(gid, room, idx);
        }
      }
    }
    return;
  }

  /* --- ข้อความใน DM: ถ้าพิมพ์เองให้แนะนำให้กดปุ่ม --- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const t = (e.message.text||'').trim().toLowerCase();
    if (HANDS.includes(t)) {
      await safeReply(e.replyToken, { type:'text', text:'เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกัน โปรดแตะปุ่มเลือกหมัดที่เราส่งให้ (มีชื่อกลุ่มระบุไว้แล้ว) 🙏' });
    } else {
      await safeReply(e.replyToken, { type:'text', text:'แตะปุ่มเลือกหมัดจากข้อความที่ส่งไปให้นะครับ (หรือรอรอบใหม่)' });
    }
    return;
  }

  /* --- คำสั่งในกลุ่ม --- */
  if (e.type!=='message' || e.message.type!=='text') return;
  if (e.source.type!=='group' && e.source.type!=='supergroup') return;

  const gid = e.source.groupId;
  const text = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();

  if (c0==='menu'){ await safeReply(e.replyToken, menuFlex()); return; }
  if (c0!=='janken' && c0!=='rps') return;

  const action = (sub||'').toLowerCase();
  const room = ensureRoom(gid);
  const gName = await groupName(gid);

  let displayName = 'Player';
  try { const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName; } catch {}

  switch(action){
    /* -------- OPEN: ตั้ง admin + ประกาศข้อความตาม requirement -------- */
    case 'open': {
      room.admin  = e.source.userId;              // ผู้เปิด = ผู้จัด
      room.phase  = 'register';
      room.stage  = 'pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[] };
      room.rankOut = [];

      const announce = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'กด Join เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คนเท่านั้น ‼️',
        '',
        '(⏳ เมื่อครบแล้ว ผู้จัดจะเป็นผู้เริ่มแข่งให้เอง)'
      ].join('\n');

      await safePush(gid, { type:'text', text: announce });
      await safePush(gid, openBannerFlex(gName));
      await safeReply(e.replyToken, [ menuFlex(), { type:'text', text:'🟢 เปิดรับสมัครแล้ว (กด Join เพื่อเข้าร่วม)' } ]);
      break;
    }

    /* -------- JOIN -------- */
    case 'join': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่เปิดรับสมัคร'}); break; }
      const MAX_PLAYERS = 20;
      if (room.players.size >= MAX_PLAYERS) { await safeReply(e.replyToken, {type:'text', text:`❌ ทัวร์นาเมนต์เต็มแล้ว (${MAX_PLAYERS} คน)`}); break; }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, { name });
      await safeReply(e.replyToken, { type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX_PLAYERS})` });
      break;
    }

    /* -------- CLOSE (admin only) -------- */
    case 'close': {
      if (room.admin !== e.source.userId) {
        await safeReply(e.replyToken, {type:'text', text:'ขออภัย เฉพาะผู้เปิดทัวร์ (ผู้จัด) เท่านั้นที่เริ่มการแข่งขันได้ 🙏'});
        break;
      }
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size < 2)   { await safeReply(e.replyToken, {type:'text', text:'ต้องมีอย่างน้อย 2 คน'}); break; }

      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) {
        room.players.set(BOT_UID, { name: BOT_NAME, isBot:true }); // เติมบอทเฉพาะเลขคี่
        ids.push(BOT_UID);
      }

      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1;
      room.phase='playing';
      room.stage='pools';

      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      await safePush(gid, { type:'text', text:`📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    /* -------- STATUS -------- */
    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing'  ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken, { type:'text', text: head });
      break;
    }

    /* -------- RESET (admin only) -------- */
    case 'reset': {
      if (room.admin !== e.source.userId) {
        await safeReply(e.replyToken, {type:'text', text:'ขออภัย เฉพาะผู้เปิดทัวร์ (ผู้จัด) เท่านั้นที่รีเซ็ตได้ 🙏'});
        break;
      }
      rooms.delete(gid);
      await safeReply(e.replyToken, { type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ===================== MATCH RESOLUTION ===================== */
async function tryCloseMatch_Pool(gid, room, k, idx){
  const m = room.bracket.pools[k][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) {
    m.winner=m.a; m.loser=null; m.state='done';
    await safePush(gid, { type:'text', text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.a)} ได้สิทธิ์บาย` });
  } else if (m.b && !m.a) {
    m.winner=m.b; m.loser=null; m.state='done';
    await safePush(gid, { type:'text', text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.b)} ได้สิทธิ์บาย` });
  } else if (aH && bH){
    const r = judge(aH,bH,m.a,m.b);
    if (r==='DRAW'){
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid && !isBot(uid)) await safePush(uid, [
        {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pools',k,idx)},
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', k, idx)
      ]);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';

    try{
      await client.pushMessage(gid, [ flexMatchResult(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    }catch{
      await safePush(gid, { type:'text', text:`สาย ${k} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` });
    }

    if (m.loser) markEliminated(room, m.loser);
  } else return;

  if (!allPoolsDone(room.bracket.pools)) return;

  const winners = poolWinners(room.bracket.pools);

  // ถัดไปรอบในสาย (ถ้ามากกว่า 1 ผู้ชนะต่อสาย)
  const eachPoolSingle = POOLS.every(kk => winners[kk].length<=1);
  if (!eachPoolSingle){
    const next={A:[],B:[],C:[],D:[]};
    for (const kk of POOLS){
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) next[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
    }
    room.bracket.pools = next;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // แชมป์จากแต่ละสาย -> cross
  const champs = Object.values(winners).flat();
  if (champs.length === 1){
    await finishTournament(gid, room, champs[0]);
    return;
  }

  const ids = shuffle(champs);
  const cross=[]; for (let i=0;i<ids.length;i+=2) cross.push({a:ids[i]||null, b:ids[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
  room.stage='cross';
  room.bracket.cross = cross;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

async function tryCloseMatch_Cross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH,m.a,m.b);
    if (r==='DRAW'){
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid && !isBot(uid)) await safePush(uid, [
        {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'cross',null,idx)},
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx)
      ]);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  try{
    await client.pushMessage(gid, [ flexMatchResult('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
  }catch{
    await safePush(gid, { type:'text', text:`ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` });
  }

  if (m.loser) markEliminated(room, m.loser);

  const done = room.bracket.cross.every(x=>x.state==='done');
  if (!done) return;

  const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
  if (winners.length === 1){
    await finishTournament(gid, room, winners[0]);
    return;
  }
  const next=[]; for (let i=0;i<winners.length;i+=2) next.push({a:winners[i]||null, b:winners[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
  room.bracket.cross = next;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

/* ===================== FINISH & RANKING ===================== */
function putBotLast(order){
  const idx = order.indexOf(BOT_UID);
  if (idx >= 0){ order.splice(idx,1); order.push(BOT_UID); }
  return order;
}
async function finishTournament(gid, room, champion){
  // สร้าง ranking: winner ขึ้นหัว, ตามด้วยคนที่ตกรอบ (ตามเวลา), บอทท้ายสุด
  const allIds = [...room.players.keys()].filter(Boolean);
  const others = allIds.filter(x => x!==champion && !room.rankOut.includes(x));
  // เผื่อมีคนที่ไม่เคยแพ้แต่หลุดจากสาย (กรณี BYE/โครงสร้าง) -> ใส่ก่อน rankOut
  const rank = [ champion, ...others, ...room.rankOut.filter(x=>x!==champion) ];
  putBotLast(rank);

  const lines = rank.map((uid,i)=> `${i+1}. ${pretty(room,uid)}`);
  try {
    await client.pushMessage(gid, [buildFlexRoundPairs('🏁 สรุปอันดับทัวร์นาเมนต์', lines)]);
  } catch {
    await safePush(gid, { type:'text', text: ['🏁 สรุปอันดับทัวร์นาเมนต์', ...lines].join('\n') });
  }
  room.phase='finished'; room.stage='finished';
}
