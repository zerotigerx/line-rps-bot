// index.js — Janken Tournament (Full Service)
// Multi-room safe / Admin-only close+reset / Odd -> BOT / Human always wins vs BOT (silent)
// BOT always ranked last / Flex menus & results / DM with postback buttons & compliments
// + Simulate 16 (include the real user) / Position Matches to place 3rd..N (full pipeline)

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
const PRAISES = [
  (h)=>`เลือกได้คูลมาก ${EMOJI[h]}!`,
  (h)=>`โอ้โห ${h.toUpperCase()} มาแบบมั่นใจสุด ๆ ✨`,
  (h)=>`จังหวะนี้ต้อง ${EMOJI[h]} เท่านั้น!`,
  (h)=>`สกิลอ่านเกมดีมาก 👍 (${h})`,
  (h)=>`เท่เกินไปแล้ว ${EMOJI[h]}!`
];

// BOT settings
const BOT_UID  = 'BOT:engine';
const BOT_NAME = 'BOT 🤖';
const isBot = uid => uid === BOT_UID;

// memory state per group
const rooms = new Map();             // groupId -> room
const groupNameCache = new Map();    // groupId -> name

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const pretty = (room, uid) => uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

/** มนุษย์ชนะบอทเสมอ (เงียบ ๆ) */
const judge = (aHand, bHand, aUid=null, bUid=null) => {
  if (isBot(aUid) && !isBot(bUid)) return 'B';
  if (!isBot(aUid) && isBot(bUid)) return 'A';
  if (!aHand || !bHand) return aHand ? 'A' : 'B';
  if (aHand === bHand)  return 'DRAW';
  const beats = { rock:'scissors', paper:'rock', scissors:'paper' };
  return beats[aHand] === bHand ? 'A' : 'B';
};

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin: null,               // userId ของผู้เปิด (ผู้จัด)
      phase: 'idle',             // idle | register | playing | finished
      stage: 'pools',            // pools | cross | finished
      players: new Map(),        // userId -> { name, isBot? }
      bracket: {
        round: 0,
        pools: { A:[], B:[], C:[], D:[] },
        cross: [],
        waitingOdd: null,
        pos: [],
        posRound: 0,
      },
      losers: [],                // ผู้แพ้ทั้งหมด (สำหรับ Position Matches)
      rankOut: [],               // เก็บลำดับผู้ตกรอบ (เวลาจริง)
      finalChampion: null,
    });
  }
  return rooms.get(gid);
}

async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try{ const s = await client.getGroupSummary(gid); if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; } }
  catch{}
  return '(กลุ่มของคุณ)';
}

async function safePush(to, msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data || e?.message); } }
async function safeReply(token, msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data || e?.message); } }

/* ===================== UI / FLEX ===================== */
function openBannerFlex(groupName='กลุ่มของคุณ'){
  return {
    type:'flex', altText:'JANKEN TOURNAMENT เปิดแล้ว!',
    contents:{ type:'bubble',
      hero:{ type:'box', layout:'vertical', backgroundColor:'#111', paddingAll:'24px', cornerRadius:'md', contents:[
        { type:'text', text:'JANKEN', weight:'bold', size:'3xl', color:'#FFD54F', align:'center' },
        { type:'text', text:'TOURNAMENT', weight:'bold', size:'xl', color:'#FFFFFF', align:'center' },
        { type:'text', text:`กลุ่ม “${groupName}”`, size:'sm', color:'#BDBDBD', align:'center', margin:'sm' },
      ]},
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

function menuFlex(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{ type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' }]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary',   action:{ type:'message', label:'Join',   text:'janken join' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Close',  text:'janken close' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Status', text:'janken status' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Reset',  text:'janken reset' } },
      ]}
    }
  };
}

function buildFlexRoundPairs(title, lines){
  return { type:'flex', altText:title, contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:title, weight:'bold', size:'lg' },
      { type:'text', text: nowTH(), size:'xs', color:'#999' }
    ]},
    body:{ type:'box', layout:'vertical', spacing:'sm', contents: lines.map(t=>({ type:'text', text:t, wrap:true })) }
  }};
}

const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-' }|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) => ({ type:'postback', label:`${EMOJI[hand]} ${hand.toUpperCase()}`, data:`jg|${matchKey(gid,stage,pool,idx)}|${hand}`, displayText:hand });
const qrPostback = (gid, stage, pool, idx) => ({ items: HANDS.map(h => ({ type:'action', action: makePostback(gid,stage,pool,idx,h) })) });
function choiceFlexPostback(title, gid, stage, pool, idx){
  return { type:'flex', altText:title, contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:title, weight:'bold', size:'lg' }]},
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'rock') },
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'paper') },
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'scissors') },
    ]},
    footer:{ type:'box', layout:'vertical', contents:[{ type:'text', text:'(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size:'xs', color:'#999' }]}
  }};
}

/* ===================== SEED / ANNOUNCE ===================== */
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
          { type:'text', text:`${PRAISES[Math.floor(Math.random()*PRAISES.length)]('—')}\nเลือกแล้วรอลุ้นผลในกลุ่ม “${gName}”` }
        ]);
        await sleep(80);
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
        { type:'text', text:`${PRAISES[Math.floor(Math.random()*PRAISES.length)]('—')}\nเลือกแล้วรอลุ้นผลในกลุ่ม “${gName}”` }
      ]);
      await sleep(80);
    }
  }
}

async function tryPushFlexOrText(to, title, lines){
  const MAX = 10; const chunks=[]; for (let i=0;i<lines.length;i+=MAX) chunks.push(lines.slice(i,i+MAX));
  try{
    if (!chunks.length) { await safePush(to,{type:'text',text:title+'\n(ไม่มีคู่ในรอบนี้)'}); return; }
    for (let i=0;i<chunks.length;i++){
      const head = chunks.length>1 ? `${title} (หน้า ${i+1}/${chunks.length})` : title;
      await client.pushMessage(to, [buildFlexRoundPairs(head, chunks[i])]);
      await sleep(60);
    }
  }catch{
    await safePush(to, { type:'text', text:[title, ...lines].join('\n') });
  }
}

function flexMatchResult(title, aName, aH, bName, bH, winName){
  return { type:'flex', altText:`${title}: ${winName}`, contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' } ]},
    body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      row(aName, EMOJI[aH]), row(bName, EMOJI[bH]), { type:'separator' },
      { type:'text', text:`ผู้ชนะ: ${winName}`, weight:'bold', color:'#2E7D32' }
    ]}
  }};
  function row(name, emo){ return { type:'box', layout:'baseline', contents:[ { type:'text', text:name, size:'md', flex:5, wrap:true }, { type:'text', text:emo||'', size:'lg', flex:1, align:'end' } ]}; }
}

/* ===================== EVENT HANDLER ===================== */
async function handleEvent(e){
  // POSTBACK (DM)
  if (e.type==='postback' && typeof e.postback?.data==='string'){
    const [tag,gid,stage,poolKey,idxStr,hand] = e.postback.data.split('|'); // jg|gid|stage|pool|-|idx|hand
    if (tag!=='jg') return;
    const pool = (poolKey==='-'? null : poolKey);
    const idx  = Number(idxStr);
    const uid  = e.source.userId;
    if (!rooms.has(gid)) return; const room = rooms.get(gid);

    if (stage==='pools'){
      const m = room.bracket.pools[pool]?.[idx];
      if (m?.state==='pending' && (m.a===uid || m.b===uid)){
        m.moves[uid] = hand;
        const gName = await groupName(gid);
        await safeReply(e.replyToken, { type:'text', text:`${PRAISES[Math.floor(Math.random()*PRAISES.length)](hand)}\nเลือกแล้ว รอผลในกลุ่ม “${gName}”` });
        await tryCloseMatch_Pool(gid, room, pool, idx);
      }
    } else if (stage==='cross'){
      const m = room.bracket.cross?.[idx];
      if (m?.state==='pending' && (m.a===uid || m.b===uid)){
        m.moves[uid] = hand;
        const gName = await groupName(gid);
        await safeReply(e.replyToken, { type:'text', text:`${PRAISES[Math.floor(Math.random()*PRAISES.length)](hand)}\nเลือกแล้ว รอผลในกลุ่ม “${gName}”` });
        await tryCloseMatch_Cross(gid, room, idx);
      }
    } else if (stage==='pos'){
      const m = room.bracket.pos?.[idx];
      if (m?.state==='pending' && (m.a===uid || m.b===uid)){
        m.moves[uid] = hand;
        const gName = await groupName(gid);
        await safeReply(e.replyToken, { type:'text', text:`${PRAISES[Math.floor(Math.random()*PRAISES.length)](hand)}\nเลือกแล้ว รอผลในกลุ่ม “${gName}”` });
        await tryCloseMatch_Position(gid, room, idx);
      }
    }
    return;
  }

  // DM text (advise to use button)
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user'){
    await safeReply(e.replyToken, { type:'text', text:'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเมื่อเล่นหลายทัวร์พร้อมกัน 🙏' });
    return;
  }

  // Group commands
  if (e.type!=='message' || e.message.type!=='text') return;
  if (!['group','supergroup'].includes(e.source.type)) return;

  const gid = e.source.groupId;
  const text = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  if (c0==='menu'){ await safeReply(e.replyToken, menuFlex()); return; }
  if (!['janken','rps'].includes(c0)) return;

  const action = (sub||'').toLowerCase();
  const room = ensureRoom(gid);
  const gName = await groupName(gid);

  let displayName='Player';
  try{ const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName; }catch{}

  switch(action){
    case 'open': {
      room.admin  = e.source.userId;              // ผู้เปิด = ผู้จัด
      room.phase  = 'register';
      room.stage  = 'pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[], pos:[], posRound:0 };
      room.losers = []; room.rankOut = []; room.finalChampion = null;

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

    case 'join': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่เปิดรับสมัคร'}); break; }
      const MAX = 20; if (room.players.size>=MAX){ await safeReply(e.replyToken,{type:'text',text:`❌ ทัวร์เต็มแล้ว (${MAX})`}); break; }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, { name });
      await safeReply(e.replyToken, { type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX})` });
      break;
    }

    case 'close': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken,{type:'text',text:'เฉพาะผู้เปิดทัวร์ (ผู้จัด) เท่านั้นที่เริ่มการแข่งขันได้ 🙏'}); break; }
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size < 2)   { await safeReply(e.replyToken, {type:'text', text:'ต้องมีอย่างน้อย 2 คน'}); break; }

      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) { room.players.set(BOT_UID, { name: BOT_NAME, isBot:true }); ids.push(BOT_UID); }

      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1; room.phase='playing'; room.stage='pools';

      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      await safePush(gid, { type:'text', text:`📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing'  ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken, { type:'text', text: head });
      break;
    }

    case 'reset': {
      if (room.admin !== e.source.userId) { await safeReply(e.replyToken,{type:'text',text:'เฉพาะผู้เปิดทัวร์ (ผู้จัด) เท่านั้นที่รีเซ็ตได้ 🙏'}); break; }
      rooms.delete(gid);
      await safeReply(e.replyToken, { type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    case 'simulate': { // janken simulate (16 people incl. you)
      // reset room
      rooms.delete(gid); const r = ensureRoom(gid);
      r.admin = e.source.userId; r.phase='playing'; r.stage='pools'; r.bracket.round=1; r.losers=[]; r.rankOut=[]; r.finalChampion=null; r.bracket.pos=[]; r.bracket.posRound=0;
      const me = e.source.userId; const meName = displayName;
      r.players.set(me, { name: meName });
      const mocks = Array.from({length:15}, (_,i)=>`mock-${i+1}`);
      mocks.forEach((id,i)=> r.players.set(id,{name:`Player${i+1}`}));
      const ids=[...r.players.keys()]; r.bracket.pools = seedPoolsFrom(ids);
      await safePush(gid,{type:'text',text:'🧪 เริ่มจำลอง 16 คน — คุณคือหนึ่งในผู้เล่น (เลือกหมัดใน DM ได้จริง)'});
      await announcePoolsRound(gid, r, '📣 รอบ 16 ทีม (Main Bracket)');
      // mock auto choose
      for (const k of POOLS) {
        r.bracket.pools[k].forEach((m,i)=>{
          for (const uid of [m.a,m.b]) if (uid && uid.startsWith('mock-')) m.moves[uid]=HANDS[Math.floor(Math.random()*3)];
          setTimeout(()=>tryCloseMatch_Pool(gid, r, k, i), 200);
        });
      }
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
      m.moves={}; const gName=await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid && !isBot(uid)) await safePush(uid,[
        {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pools',k,idx)},
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', k, idx)
      ]);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
    try{ await client.pushMessage(gid, [ flexMatchResult(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
    catch{ await safePush(gid, { type:'text', text:`สาย ${k} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` }); }

    if (m.loser) { room.losers.push(m.loser); room.rankOut.push(m.loser); }
  } else return;

  if (!allPoolsDone(room.bracket.pools)) return;

  const winners = poolWinners(room.bracket.pools);
  const eachPoolSingle = POOLS.every(kk => winners[kk].length<=1);
  if (!eachPoolSingle){
    const next={A:[],B:[],C:[],D:[]};
    for (const kk of POOLS){
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) next[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
    }
    room.bracket.pools = next; room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  const champs = Object.values(winners).flat();
  if (champs.length === 1){ await finishTournament(gid, room, champs[0]); return; }

  const ids = shuffle(champs);
  room.stage='cross'; room.bracket.cross = toPairs(ids).map(([a,b])=>({a,b,state:'pending',moves:{},winner:null,loser:null}));
  room.bracket.round += 1; await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

async function tryCloseMatch_Cross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH,m.a,m.b);
    if (r==='DRAW'){
      m.moves={}; const gName=await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid && !isBot(uid)) await safePush(uid,[
        {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'cross',null,idx)},
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx)
      ]);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  try{ await client.pushMessage(gid, [ flexMatchResult('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
  catch{ await safePush(gid, { type:'text', text:`ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` }); }

  if (m.loser) { room.losers.push(m.loser); room.rankOut.push(m.loser); }

  const done = room.bracket.cross.every(x=>x.state==='done');
  if (!done) return;

  const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
  if (winners.length === 1){ await finishTournament(gid, room, winners[0]); return; }
  room.bracket.cross = toPairs(winners).map(([a,b])=>({a,b,state:'pending',moves:{},winner:null,loser:null}));
  room.bracket.round += 1; await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

/* ===================== POSITION MATCHES (3rd..N) ===================== */
// สร้างสายจัดอันดับจากผู้แพ้ทั้งหมด (excluding champion) เพื่อจัดลำดับ 3rd..N
function makePositionPairs(room, champion){
  const ids = room.losers.filter(Boolean);
  // เอาคนที่ยังไม่เคยแพ้เลยแต่ไม่ใช่แชมป์ (กรณี bye หรือโครงสร้าง) เติมเข้าไป
  for (const uid of room.players.keys()){
    if (uid===champion) continue;
    if (!ids.includes(uid)) ids.push(uid);
  }
  // BOT ถ้ามี ให้ไปท้ายสุดเสมอ แต่ยังต้องอยู่ในลิสต์เพื่อจับคู่ถ้ายังเหลือเลขคี่
  const botIndex = ids.indexOf(BOT_UID);
  if (botIndex>=0){ ids.splice(botIndex,1); ids.push(BOT_UID); }
  return toPairs(ids);
}

async function announcePositionRound(gid, room, pairs, roundNo){
  if (!pairs.length){ await finalizeRanking(gid, room); return; }
  const lines = pairs.map((p,i)=>`Match ${i+1}: ${pretty(room,p[0])} vs ${pretty(room,p[1])}`);
  await tryPushFlexOrText(gid, `🧮 Position Matches — รอบที่ ${roundNo}`, lines);
  const gName = await groupName(gid);
  // สร้างโครงแมตช์
  room.bracket.pos = pairs.map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  for (let i=0;i<pairs.length;i++){
    const [a,b]=pairs[i];
    for (const uid of [a,b]) if (uid && !isBot(uid)){
      await safePush(uid,[
        { type:'text', text:`📝 Position Round — เลือกหมัด (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pos','-',i) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid,'pos','-',i)
      ]);
      await sleep(60);
    }
  }
}

async function tryCloseMatch_Position(gid, room, idx){
  const m = room.bracket.pos[idx];
  if (!m) return;
  const aH = m.moves[m.a], bH = m.moves[m.b];
  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH,m.a,m.b);
    if (r==='DRAW'){
      m.moves={}; const gName=await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid && !isBot(uid)) await safePush(uid,[ {type:'text',text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pos','-',idx) }, choiceFlexPostback('เลือกใหม่อีกครั้ง', gid,'pos','-',idx) ]);
      return; }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  try{ await client.pushMessage(gid,[ flexMatchResult('ผล Position', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
  catch{ await safePush(gid,{type:'text',text:`ผล Position\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}`}); }

  // ตรวจว่าจบรอบ position นี้หรือยัง
  const done = room.bracket.pos.every(x=>x.state==='done');
  if (!done) return;

  // รวมอันดับจากผล Position: ผู้แพ้ก่อน ผู้ชนะทีหลัง เพื่อได้เรียง 3rd..N
  const winners = room.bracket.pos.map(m=>m.winner).filter(Boolean);
  const losers  = room.bracket.pos.map(m=>m.loser).filter(Boolean);
  room.rankOut.push(...losers);
  room.rankOut.push(...winners);

  await finalizeRanking(gid, room);
}

/* ===================== FINISH & RANKING ===================== */
function putBotLast(order){ const idx=order.indexOf(BOT_UID); if (idx>=0){ order.splice(idx,1); order.push(BOT_UID); } return order; }

async function finishTournament(gid, room, champion){
  // เมื่อได้แชมป์จาก main bracket → เปิด Position Matches (3rd..N)
  const posPairs = makePositionPairs(room, champion);
  if (!posPairs.length){ await finalizeRanking(gid, room, champion); return; }

  room.finalChampion = champion;
  room.bracket.posRound = 1;
  await announcePositionRound(gid, room, posPairs, room.bracket.posRound);
}

async function finalizeRanking(gid, room, championParam){
  const champion = championParam || room.finalChampion;
  const allIds = [...room.players.keys()].filter(Boolean);
  const used = new Set([champion, ...room.rankOut]);
  const remain = allIds.filter(x=>!used.has(x));
  // อันดับ: 1) champion 2) ผู้ที่ยังไม่เคยแพ้/ค้าง 3) rankOut ตามลำดับ 4) บอทท้ายสุด
  let rank = [champion, ...remain, ...room.rankOut];
  rank = Array.from(new Set(rank)).filter(Boolean);
  // BOT ท้ายสุดเสมอ
  const bidx = rank.indexOf(BOT_UID); if (bidx>=0){ rank.splice(bidx,1); rank.push(BOT_UID); }

  const lines = rank.map((uid,i)=> `${i+1}. ${pretty(room,uid)}`);
  try{ await client.pushMessage(gid,[ buildFlexRoundPairs('🏁 สรุปอันดับทัวร์นาเมนต์', lines) ]); }
  catch{ await safePush(gid,{type:'text',text:['🏁 สรุปอันดับทัวร์นาเมนต์',...lines].join('\n')}); }
  room.phase='finished'; room.stage='finished';
}

/* ===================== EXPORTS ===================== */
export { };
