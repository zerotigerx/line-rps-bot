// Janken Tournament — 16-player + Position Matches (3rd–16th)
// Multi-Room safe, DM postback + DM pending queue, simulate 16 (you + mock 15)

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ================= LINE CONFIG ================= */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials'); process.exit(1);
}

/* ================= APP BOOT ================= */
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
app.get('/', (_req,res)=>res.send('✅ Janken Tournament running'));
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body?.events || [])) await handleEvent(ev);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e);
    res.sendStatus(200);
  }
});

/* ================= STATE & UTILS ================= */
const MAX_PLAYERS = 16;                       // ✅ ตาม requirement
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];

const rooms = new Map();            // groupId -> room
const groupNameCache = new Map();   // groupId -> name

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const judge = (a,b)=>{ if(!a||!b) return a? 'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };
const isMock = uid => typeof uid === 'string' && uid.startsWith('mock:');

async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try{
    const s = await client.getGroupSummary(gid);
    if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; }
  }catch{}
  return '(กลุ่มของคุณ)';
}
// ---------- replace safePush / safeReply with verbose versions ----------
async function safePush(to, msgs){
  try {
    const payload = Array.isArray(msgs) ? msgs : [msgs];
    await client.pushMessage(to, payload);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e;
    console.warn('[PUSH FAIL]', JSON.stringify(detail, null, 2), 'to:', to);
  }
}

async function safeReply(token, msgs){
  try {
    const payload = Array.isArray(msgs) ? msgs : [msgs];
    await client.replyMessage(token, payload);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e;
    console.warn('[REPLY FAIL]', JSON.stringify(detail, null, 2));
  }
}

/* -------- Room factory -------- */
function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin:null,
      phase:'idle',            // idle | register | playing | finished
      stage:'pools',           // pools | cross | finished
      players:new Map(),       // userId -> {name}
      bracket:{
        round:0,
        pools:{A:[],B:[],C:[],D:[]}, // match: {a,b,state:'pending'|'done',moves:{},winner,loser}
        waitingOdd:null,
        cross:[]
      },
      // สำหรับบันทึกผู้แพ้ในแต่ละ "ขนาดสนาม"
      // 16 -> R16 losers, 8 -> QF losers, 4 -> SF losers
      elimByField:{16:[],8:[],4:[]},
      track:{ fieldSize:null },   // บันทึกขนาดสนามของรอบที่ประกาศล่าสุด

      /* ===== Position Brackets =====
         p34:   ผู้แพ้รอบรอง (2) -> จัดอันดับ 3/4
         p58:   ผู้แพ้รอบ 8 ทีม (4) -> SF -> finals 5/6 + 7/8
         p916:  ผู้แพ้รอบ 16 ทีม (8) -> QF -> แยกสาย A,B:
                  - A: ชิง 9/10, 11/12
                  - B: ชิง 13/14, 15/16
      */
      pos:{
        p34:null,          // { matches:[{a,b,...}] , title:string }
        p58:null,          // { sf:[...], final56:[...], final78:[...] }
        p916:null          // { qf:[...], sfa:[...], sfb:[...], f910:[...], f1112:[...], f1314:[...], f1516:[...] }
      }
    });
  }
  return rooms.get(gid);
}

/* ===== Mock & Pending DM helper ===== */
const pendingDM = new Map();  // uid -> [{gid,stage,pool,idx}]
const trackPending = (uid, info) => {
  const arr = pendingDM.get(uid) || [];
  if (!arr.find(x => x.gid===info.gid && x.stage===info.stage && x.pool===info.pool && x.idx===info.idx)) {
    arr.push(info);
    pendingDM.set(uid, arr);
  }
};
const clearPending = (uid, info) => {
  const arr = pendingDM.get(uid) || [];
  const next = arr.filter(x => !(x.gid===info.gid && x.stage===info.stage && x.pool===info.pool && x.idx===info.idx));
  if (next.length) pendingDM.set(uid, next); else pendingDM.delete(uid);
};
const PRAISES = [
  g => `เลือกได้เนียน! รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${g}”`,
  g => `เซียนมาก! รอผลใน “${g}” ได้เลย`,
  g => `หมัดนี้มีของ รอดูประกาศใน “${g}”`,
  g => `โหดจัด! รอคู่ต่อสู้แล้วลุ้นกันต่อใน “${g}”`
];
const praiseLine = g => PRAISES[Math.floor(Math.random() * PRAISES.length)](g);

/* ================= FLEX / UI ================= */
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
function openBannerFlex(){
  return {
    type:'flex', altText:'JANKEN TOURNAMENT เปิดแล้ว!',
    contents:{
      type:'bubble',
      hero:{ type:'box', layout:'vertical', backgroundColor:'#111', contents:[
        { type:'text', text:'JANKEN', weight:'bold', size:'3xl', color:'#FFD54F', align:'center' },
        { type:'text', text:'TOURNAMENT', weight:'bold', size:'xl', color:'#FFFFFF', align:'center' },
        { type:'text', text:'เปิดรับสมัครแล้ว!', size:'sm', color:'#BDBDBD', align:'center', margin:'sm' }
      ], paddingAll:'24px', cornerRadius:'md' },
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text:'ใครจะเป็นแชมป์สายเป่ายิงฉุบของกลุ่มนี้?', wrap:true },
        { type:'box', layout:'vertical', backgroundColor:'#F5F5F5', cornerRadius:'md', paddingAll:'12px', contents:[
          { type:'text', text:'วิธีเข้าร่วม', weight:'bold' },
          { type:'text', text:'พิมพ์  janken join  ในห้องแชทนี้', size:'sm', color:'#666' },
          { type:'text', text:`รับสมัครสูงสุด ${MAX_PLAYERS} คน เท่านั้น`, size:'sm', color:'#666', margin:'sm' }
        ]}
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'button', style:'primary', color:'#FFB74D', action:{ type:'message', label:'เข้าร่วมทันที', text:'janken join' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'ดูเมนู', text:'menu' } }
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

/* ====== DM postback builders ====== */
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

/* ====== Send Choice DM (with pending + fallback) ====== */
async function sendChoiceDM(uid, gid, stage, pool, idx) {
  if (isMock(uid)) return; // mock ไม่ต้อง DM
  const gName = await groupName(gid);
  const title = stage.startsWith('p')
    ? `📝 รอบสาย ${pool} ของทัวร์กลุ่ม “${gName}”`
    : `📝 ${stageTitle(stage)} ของทัวร์กลุ่ม “${gName}”`;

  trackPending(uid, { gid, stage, pool, idx });

  try {
    await safePush(uid, [
      {
        type: 'text',
        text: `${title}\nเลือกหมัดของคุณได้เลย 👇`,
        quickReply: qrPostback(gid, stage, pool, idx)
      },
      choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, stage, pool, idx),
      { type:'text', text:`เลือกแล้วจะมีประกาศผลในกลุ่ม “${gName}”` }
    ]);
  } catch (e) {
    console.warn('DM push failed:', e?.response?.data || e?.message);
    await safePush(gid, {
      type:'text',
      text:
`⚠️ แจ้งเตือน: ${pretty(rooms.get(gid), uid)} ยังรับปุ่มเลือกหมัดใน DM ไม่ได้
กรุณาเปิดแชท 1:1 กับบอท แล้วพิมพ์ "janken dm" เพื่อรับปุ่มอีกครั้ง
(กลุ่ม “${gName}”)`
    });
  }
}

/* ================= SEEDING & ANNOUNCE ================= */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };
function seedPoolsFrom(ids){
  const pools={A:[],B:[],C:[],D:[]}, shuffled=shuffle(ids); let i=0;
  for(const id of shuffled){ pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  return pools;
}
const allPoolsDone = pools => POOLS.every(k => pools[k].every(m => m.state==='done'));
const poolWinners = pools => POOLS.reduce((acc,k)=> (acc[k] = pools[k].map(m=>m.winner).filter(Boolean), acc), {});
function participantsCountFromPools(pools){
  let c=0; for(const k of POOLS) for(const m of pools[k]) c+= (m.a?1:0)+(m.b?1:0); return c;
}
function participantsCountFromList(list){
  let c=0; for (const m of list) c+= (m.a?1:0)+(m.b?1:0); return c;
}

function autoMockMoveForMatch(m){
  for (const uid of [m.a, m.b]) {
    if (uid && isMock(uid) && !m.moves[uid]) {
      m.moves[uid] = HANDS[Math.floor(Math.random()*3)];
    }
  }
}

async function announcePoolsRound(gid, room, title){
  // บันทึกขนาดสนามของรอบนี้ (ใช้ระบุว่า round นี้คือ 16 หรือ 8 หรือ 4)
  room.track.fieldSize = participantsCountFromPools(room.bracket.pools);

  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await tryPushFlexOrText(gid, title, lines);

  // DM ปุ่มเลือกหมัด + auto mock
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m, i) => {
      autoMockMoveForMatch(m);
      for (const uid of [m.a, m.b]) if (uid) {
        await sendChoiceDM(uid, gid, 'pools', k, i);
      }
    });
  }
}

function stageTitle(stage){
  const map = {
    cross: 'รอบรวม (ข้ามสาย)',
    p34_sf: 'ชิงที่ 3/4',
    p58_sf: 'จัดอันดับ 5–8 (รอบรอง)',
    p58_f56: 'ชิงที่ 5/6',
    p58_f78: 'ชิงที่ 7/8',
    p916_qf: 'จัดอันดับ 9–16 (รอบ 8 ทีม)',
    p916_sfa: 'จัดอันดับ 9–12 (รอบรอง)',
    p916_sfb: 'จัดอันดับ 13–16 (รอบรอง)',
    p916_f910: 'ชิงที่ 9/10',
    p916_f1112: 'ชิงที่ 11/12',
    p916_f1314: 'ชิงที่ 13/14',
    p916_f1516: 'ชิงที่ 15/16'
  };
  return map[stage] || stage;
}

async function announceCrossRound(gid, room, title){
  room.track.fieldSize = participantsCountFromList(room.bracket.cross);
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  for (let i=0;i<room.bracket.cross.length;i++){
    const m = room.bracket.cross[i];
    autoMockMoveForMatch(m);
    for (const uid of [m.a,m.b]) if (uid){
      await sendChoiceDM(uid, gid, 'cross', null, i);
    }
  }
}

/* ======= Announce helpers for Position stages ======= */
function toMatchObjects(ids){ return toPairs(ids).map(([a,b])=>({a,b,state:'pending',moves:{},winner:null,loser:null})); }

async function announceGeneric(gid, room, list, stage, title){
  const lines = list.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);
  for (let i=0;i<list.length;i++){
    const m=list[i]; autoMockMoveForMatch(m);
    for (const uid of [m.a,m.b]) if (uid) await sendChoiceDM(uid,gid,stage,null,i);
  }
}

/* ================= FLEX ผลการแข่ง ================= */
function flexMatchResult(title, aName, aH, bName, bH, winName){
  return {
    type:'flex', altText:`${title}: ${winName}`,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' } ]},
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
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
      ]}
    }
  };
}

/* ================= EVENT HANDLER ================= */
async function handleEvent(e){

  /* --- POSTBACK: ผู้เล่นกดปุ่มใน DM --- */
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const data = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (data[0] === 'jg') {
      const gid   = data[1];
      const stage = data[2];
      const pool  = data[3] === '-' ? null : data[3];
      const idx   = Number(data[4]);
      const hand  = data[5];
      const uid   = e.source.userId;

      if (!rooms.has(gid)) return;
      const room = rooms.get(gid);
      const gName = await groupName(gid);

      const ack = async () =>
        safeReply(e.replyToken, { type:'text', text:`รับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  ${praiseLine(gName)}` });

      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand; clearPending(uid,{gid,stage,pool,idx}); await ack();
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand; clearPending(uid,{gid,stage,pool,idx}); await ack();
          await tryCloseMatch_Cross(gid, room, idx);
        }
      } else {
        // Position stages:
        await postbackPositionResolver(gid, room, stage, idx, uid, hand, e.replyToken);
      }
    }
    return;
  }

  /* --- ข้อความใน DM --- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const t = (e.message.text||'').trim().toLowerCase();
    if (t === 'janken dm' || t === 'jankenmd' || t === 'dm') {
      const list = pendingDM.get(e.source.userId) || [];
      if (!list.length) {
        await safeReply(e.replyToken, { type:'text', text:'ยังไม่มีแมตช์ค้างอยู่ครับ หากอยู่ระหว่างแข่ง เดี๋ยวระบบจะส่งให้ใหม่อัตโนมัติ' });
        return;
      }
      for (const info of list) await sendChoiceDM(e.source.userId, info.gid, info.stage, info.pool, info.idx);
      return;
    }
    await safeReply(e.replyToken, {
      type:'text',
      text:'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกันครับ 🙏'
    });
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

        // ===== Debug: บอก id ตัวเอง + กลุ่ม เพื่อเช็คว่าบอทที่คุยอยู่ตัวเดียวกับที่ตั้งค่า token ไหม
    case 'whoami': {
      const uid = e.source.userId;
      const groupId = e.source.groupId;
      await safeReply(e.replyToken, {
        type: 'text',
        text: [
          '🧪 Debug /whoami',
          `• userId: ${uid}`,
          `• groupId: ${groupId}`,
          `• กรุณาเปิดแชท 1:1 กับบอทนี้ แล้วพิมพ์ "hello" ให้มีประวัติคุยกัน`,
          `จากนั้นกลับมากลุ่มและลอง "janken testdm"`,
        ].join('\n')
      });
      break;
    }

    // ===== Debug: ทดสอบ DM หาตัวคนสั่งเอง
    case 'testdm': {
      const uid = e.source.userId;
      const gName = await groupName(e.source.groupId);
      await safeReply(e.replyToken, { type:'text', text:'🧪 กำลังลองส่ง DM ให้คุณ…' });

      try{
        await client.pushMessage(uid, [
          { type:'text', text:`DM ทดสอบจากบอท ✅ (กลุ่ม “${gName}”)` },
          { type:'text', text:'ถ้าข้อความนี้ถึง แปลว่าบอทส่ง DM ถึงคุณได้ปกติ 🎯' }
        ]);
        await safePush(e.source.groupId, { type:'text', text:'✅ DM ทดสอบ: ส่งถึงคุณสำเร็จ' });
      }catch(e){
        const detail = e?.response?.data || e?.message || e;
        await safePush(e.source.groupId, {
          type:'text',
          text:'❌ DM ทดสอบล้มเหลว\n' + JSON.stringify(detail, null, 2)
        });
        console.warn('[TESTDM FAIL]', JSON.stringify(detail, null, 2), 'to:', uid);
      }
      break;
    }

    case 'open': {
      room.admin  = room.admin || e.source.userId;
      room.phase  = 'register';
      room.stage  = 'pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[] };
      room.elimByField={16:[],8:[],4:[]};
      room.pos={p34:null,p58:null,p916:null};

      const announce = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'พิมพ์  👉  janken join  เพื่อเข้าร่วมการแข่งขัน',
        `รับสมัครสูงสุด ${MAX_PLAYERS} คน เท่านั้น ‼️`,
        '',
        '⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์  "janken close"  เพื่อเริ่มแข่งได้เลย!'
      ].join('\n');

      await safePush(gid, { type:'text', text: announce });
      await safePush(gid, openBannerFlex());
      await safeReply(e.replyToken, [ menuFlex(), { type:'text', text:'🟢 เปิดรับสมัครแล้ว (พิมพ์ janken join เพื่อเข้าร่วม)' } ]);
      break;
    }

    case 'join': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่เปิดรับสมัคร'}); break; }
      if (room.players.size >= MAX_PLAYERS) { await safeReply(e.replyToken, {type:'text', text:`❌ ทัวร์นาเมนต์เต็มแล้ว (${MAX_PLAYERS} คน)`}); break; }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, { name });
      await safeReply(e.replyToken, { type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX_PLAYERS})` });
      break;
    }

    case 'close': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size < 2)   { await safeReply(e.replyToken, {type:'text', text:'ต้องมีอย่างน้อย 2 คน'}); break; }

      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) room.bracket.waitingOdd = ids.pop();
      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1;
      room.phase='playing';
      room.stage='pools';

      const title = `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`;
      await safePush(gid, { type:'text', text:title });
      await announcePoolsRound(gid, room, title);
      await safePush(gid, { type:'text', text:`📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    case 'simulate': {
      // สร้าง 16 คน: คุณ 1 + mock 15 แล้วเริ่มแข่งทันที
      room.admin  = e.source.userId;
      room.phase  = 'playing';
      room.stage  = 'pools';
      room.players = new Map();
      room.elimByField={16:[],8:[],4:[]};
      room.pos={p34:null,p58:null,p916:null};

      room.players.set(e.source.userId, { name: displayName || 'You' });
      for (let i=1;i<=15;i++) room.players.set(`mock:${i}`, { name:`Player${i}` });

      const ids = [...room.players.keys()];
      room.bracket = { round:1, pools:seedPoolsFrom(ids), waitingOdd:null, cross:[] };

      await safePush(gid, {
        type:'text',
        text:
`🧪 เริ่มจำลอง (Placement ครบ 1–16) — ผู้เล่น 16 คน (กลุ่ม “${gName}”)
- คุณจะเลือกหมัดใน DM ได้จริง
- ผู้เล่น mock จะออกอัตโนมัติ
หากใครไม่ได้รับ DM ให้ไปคุย 1:1 กับบอทแล้วพิมพ์ "janken dm"`
      });

      const lines=[];
      for (const k of POOLS) {
        if (!room.bracket.pools[k].length) continue;
        lines.push(`สาย ${k}`);
        room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
      }
      await tryPushFlexOrText(gid, '📣 รอบ 16 ทีม (Main Bracket)', lines);

      await announcePoolsRound(gid, room, '📣 รอบ 16 ทีม (Main Bracket)');
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
      rooms.delete(gid);
      await safeReply(e.replyToken, { type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ================= MATCH RESOLUTION (Main Bracket) ================= */
function recordRoundLosers(room, matches){
  const losers = matches
    .map(m=>m.loser)
    .filter(Boolean);
  const fs = room.track.fieldSize || 0;  // 16 / 8 / 4
  if ([16,8,4].includes(fs)) {
    room.elimByField[fs].push(...losers);
  }
}

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
    const r = judge(aH,bH);
    if (r==='DRAW'){
      m.moves={}; autoMockMoveForMatch(m);
      for (const uid of [m.a,m.b]) if (uid) await sendChoiceDM(uid, gid, 'pools', k, idx);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
    try{
      await client.pushMessage(gid, [ flexMatchResult(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    }catch{
      await safePush(gid, { type:'text', text:`สาย ${k} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]} vs ${pretty(room,m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room,m.winner)}` });
    }
  } else return;

  if (!allPoolsDone(room.bracket.pools)) return;

  // เก็บผู้แพ้ของรอบนี้ตามขนาดสนาม
  const allMatches = POOLS.flatMap(kk => room.bracket.pools[kk]);
  recordRoundLosers(room, allMatches);

  const winners = poolWinners(room.bracket.pools);
  const lines=[]; for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u=>pretty(room,u)).join(', ')}`);
  await tryPushFlexOrText(gid, 'สรุปผลรอบนี้', lines);

  if (room.bracket.round===1 && room.bracket.waitingOdd){
    const flat = Object.values(winners).flat();
    if (flat.length){
      const picked = flat[Math.floor(Math.random()*flat.length)];
      room.bracket.pools = {A:[{a:room.bracket.waitingOdd,b:picked,state:'pending',moves:{},winner:null,loser:null}],B:[],C:[],D:[]};
      room.bracket.waitingOdd = null;
      room.bracket.round += 1;
      await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
      return;
    }
  }

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

  const champs = Object.values(winners).flat();
  if (champs.length === 1){
    await safePush(gid, { type:'text', text:`🏆 แชมป์: ${pretty(room,champs[0])}` });
    // ผู้แพ้ในรอบสุดท้ายคือที่ 2 จะถูกจับตอน cross ปิด (เพราะ final อยู่ใน cross ปกติ)
    room.phase='finished'; room.stage='finished';
    await startPositionMatches(gid, room);   // เริ่มจัดอันดับ
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
    const r = judge(aH,bH);
    if (r==='DRAW'){
      m.moves={}; autoMockMoveForMatch(m);
      for (const uid of [m.a,m.b]) if (uid) await sendChoiceDM(uid, gid, 'cross', null, idx);
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  try{
    await client.pushMessage(gid, [ flexMatchResult('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
  }catch{
    await safePush(gid, { type:'text', text:`ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` });
  }

  const done = room.bracket.cross.every(x=>x.state==='done');
  if (!done) return;

  // เก็บผู้แพ้ของรอบนี้ตามขนาดสนาม
  recordRoundLosers(room, room.bracket.cross);

  const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
  if (winners.length === 1){
    // final loser = room.bracket.cross.find(m=>m.loser)?.loser  -> ไว้รายงานในสรุปท้ายได้
    await safePush(gid, { type:'text', text:`🏆 แชมป์: ${pretty(room,winners[0])}` });
    room.phase='finished'; room.stage='finished';
    await startPositionMatches(gid, room);
    return;
  }
  const next=[]; for (let i=0;i<winners.length;i+=2) next.push({a:winners[i]||null, b:winners[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
  room.bracket.cross = next;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

/* ================= POSITION MATCHES ================= */
/** เริ่มต้น brackets จัดอันดับจาก room.elimByField */
async function startPositionMatches(gid, room){
  const r16 = room.elimByField[16] || [];   // 8 คน
  const qf  = room.elimByField[8]  || [];   // 4 คน
  const sf  = room.elimByField[4]  || [];   // 2 คน

  // 3rd/4th
  if (sf.length === 2){
    room.pos.p34 = { sf: toMatchObjects(sf) }; // แมตช์เดียว
    await announceGeneric(gid, room, room.pos.p34.sf, 'p34_sf', '🥉 ชิงอันดับ 3/4');
  }

  // 5th–8th  (QF losers 4 คน)
  if (qf.length === 4){
    room.pos.p58 = { sf: toMatchObjects(qf), final56:[], final78:[], sfLosers:[] };
    await announceGeneric(gid, room, room.pos.p58.sf, 'p58_sf', '🏅 จัดอันดับ 5–8 (รอบรอง)');
  }

  // 9th–16th (R16 losers 8 คน)
  if (r16.length === 8){
    room.pos.p916 = {
      qf: toMatchObjects(r16),
      sfa:[], sfb:[],
      f910:[], f1112:[], f1314:[], f1516:[]
    };
    await announceGeneric(gid, room, room.pos.p916.qf, 'p916_qf', '🎖️ จัดอันดับ 9–16 (รอบ 8 ทีม)');
  }
}

/* --- postback resolver for position stages --- */
async function postbackPositionResolver(gid, room, stage, idx, uid, hand, replyToken){
  const setMove = async (m) => {
    m.moves[uid] = hand;
    clearPending(uid, { gid, stage, pool:null, idx });
    const gName = await groupName(gid);
    await safeReply(replyToken, { type:'text', text:`รับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  ${praiseLine(gName)}` });
  };

  const closeAndAnnounce = async (title, m) => {
    const aH=m.moves[m.a], bH=m.moves[m.b];
    try{
      await client.pushMessage(gid, [ flexMatchResult(title, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    }catch{
      await safePush(gid, { type:'text', text:`${title}\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` });
    }
  };

  // ===== p34: single match =====
  if (stage==='p34_sf'){
    const m = room.pos.p34.sf[idx];
    if (m?.state!=='pending' || (uid!==m.a && uid!==m.b)) return;
    await setMove(m);

    if (m.moves[m.a] && m.moves[m.b]){
      const r=judge(m.moves[m.a], m.moves[m.b]);
      if (r==='DRAW'){ m.moves={}; autoMockMoveForMatch(m); for (const u of [m.a,m.b]) if (u) await sendChoiceDM(u,gid,'p34_sf',null,idx); return; }
      m.winner = r==='A'? m.a:m.b; m.loser = r==='A'? m.b:m.a; m.state='done';
      await closeAndAnnounce('🥉 ชิงอันดับ 3/4', m);
    }
    return;
  }

  // ===== p58 =====
  if (stage==='p58_sf' || stage==='p58_f56' || stage==='p58_f78'){
    let list=null, title='';
    if (stage==='p58_sf'){ list=room.pos.p58.sf; title='🏅 จัดอันดับ 5–8 (รอบรอง)'; }
    if (stage==='p58_f56'){ list=room.pos.p58.final56; title='🏅 ชิงอันดับ 5/6'; }
    if (stage==='p58_f78'){ list=room.pos.p58.final78; title='🏅 ชิงอันดับ 7/8'; }
    const m=list[idx];
    if (!m || m.state!=='pending' || (uid!==m.a && uid!==m.b)) return;
    await setMove(m);

    if (m.moves[m.a] && m.moves[m.b]){
      const r=judge(m.moves[m.a], m.moves[m.b]);
      if (r==='DRAW'){ m.moves={}; autoMockMoveForMatch(m); for (const u of [m.a,m.b]) if (u) await sendChoiceDM(u,gid,stage,null,idx); return; }
      m.winner = r==='A'? m.a:m.b; m.loser = r==='A'? m.b:m.a; m.state='done';
      await closeAndAnnounce(title, m);

      // transition
      if (stage==='p58_sf' && list.every(x=>x.state==='done')){
        const winners = list.map(x=>x.winner), losers = list.map(x=>x.loser);
        room.pos.p58.final56 = toMatchObjects(winners);
        room.pos.p58.final78 = toMatchObjects(losers);
        await announceGeneric(gid, room, room.pos.p58.final56, 'p58_f56', '🏅 ชิงอันดับ 5/6');
        await announceGeneric(gid, room, room.pos.p58.final78, 'p58_f78', '🏅 ชิงอันดับ 7/8');
      }
    }
    return;
  }

  // ===== p916 =====
  if (stage.startsWith('p916_')){
    const lanes = {
      p916_qf:   { list: room.pos.p916.qf,   next: async ()=>{
        if (room.pos.p916.qf.every(x=>x.state==='done')){
          const winners = room.pos.p916.qf.map(x=>x.winner);
          const losers  = room.pos.p916.qf.map(x=>x.loser);
          room.pos.p916.sfa = toMatchObjects(winners);
          room.pos.p916.sfb = toMatchObjects(losers);
          await announceGeneric(gid, room, room.pos.p916.sfa, 'p916_sfa', '🎖️ 9–12 (รอบรอง)');
          await announceGeneric(gid, room, room.pos.p916.sfb, 'p916_sfb', '🎖️ 13–16 (รอบรอง)');
        }
      }, title:'🎖️ จัดอันดับ 9–16 (รอบ 8 ทีม)' },

      p916_sfa: { list: room.pos.p916.sfa, next: async ()=>{
        if (room.pos.p916.sfa.every(x=>x.state==='done')){
          const winners = room.pos.p916.sfa.map(x=>x.winner);
          const losers  = room.pos.p916.sfa.map(x=>x.loser);
          room.pos.p916.f910  = toMatchObjects(winners);
          room.pos.p916.f1112 = toMatchObjects(losers);
          await announceGeneric(gid, room, room.pos.p916.f910,  'p916_f910',  '🎖️ ชิงอันดับ 9/10');
          await announceGeneric(gid, room, room.pos.p916.f1112, 'p916_f1112', '🎖️ ชิงอันดับ 11/12');
        }
      }, title:'🎖️ 9–12 (รอบรอง)' },

      p916_sfb: { list: room.pos.p916.sfb, next: async ()=>{
        if (room.pos.p916.sfb.every(x=>x.state==='done')){
          const winners = room.pos.p916.sfb.map(x=>x.winner);
          const losers  = room.pos.p916.sfb.map(x=>x.loser);
          room.pos.p916.f1314 = toMatchObjects(winners);
          room.pos.p916.f1516 = toMatchObjects(losers);
          await announceGeneric(gid, room, room.pos.p916.f1314, 'p916_f1314', '🎖️ ชิงอันดับ 13/14');
          await announceGeneric(gid, room, room.pos.p916.f1516, 'p916_f1516', '🎖️ ชิงอันดับ 15/16');
        }
      }, title:'🎖️ 13–16 (รอบรอง)' },

      p916_f910:  { list: room.pos.p916.f910,  next: async()=>{}, title:'🎖️ ชิงอันดับ 9/10'  },
      p916_f1112: { list: room.pos.p916.f1112, next: async()=>{}, title:'🎖️ ชิงอันดับ 11/12' },
      p916_f1314: { list: room.pos.p916.f1314, next: async()=>{}, title:'🎖️ ชิงอันดับ 13/14' },
      p916_f1516: { list: room.pos.p916.f1516, next: async()=>{}, title:'🎖️ ชิงอันดับ 15/16' }
    };

    const lane = lanes[stage];
    if (!lane) return;
    const m = lane.list[idx];
    if (!m || m.state!=='pending' || (uid!==m.a && uid!==m.b)) return;
    await setMove(m);

    if (m.moves[m.a] && m.moves[m.b]){
      const r=judge(m.moves[m.a], m.moves[m.b]);
      if (r==='DRAW'){ m.moves={}; autoMockMoveForMatch(m); for (const u of [m.a,m.b]) if (u) await sendChoiceDM(u,gid,stage,null,idx); return; }
      m.winner = r==='A'? m.a:m.b; m.loser = r==='A'? m.b:m.a; m.state='done';
      await closeAndAnnounce(lane.title, m);
      await lane.next();
    }
    return;
  }
}

/* ================= END OF FILE ================= */
