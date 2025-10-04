// Janken Tournament — Multi-Room Safe with Flex + Postback + DM compliments
// Normal: max 20 players; Pools A–D -> cross bracket
// Simulate: 16 players (include requester), requester chooses via DM, bots auto
// Full Placement (Position Matches) for 1–16 in simulate mode
// Group name always included in DM to avoid confusion
// Flex Leaderboard 1–16 + Flex Bracket Overview
// Robust DM delivery with pending queue + 'janken dm' to flush

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ========== LINE CONFIG ========== */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials'); process.exit(1);
}

/* ========== APP BOOT ========== */
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

/* ========== STATE / UTILS ========== */
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];

const rooms = new Map();           // groupId -> room
const groupNameCache = new Map();  // groupId -> name
const pendingDMs = new Map();      // userId -> Array<messages[]> (queued payloads)

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const judge = (a,b)=>{ if(!a||!b) return a? 'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };

// --- simulate helpers ---
const isMock = uid => typeof uid === 'string' && uid.startsWith('mock_');
const randomHand = () => HANDS[Math.floor(Math.random() * HANDS.length)];

/* ===== คำชม/แซวแบบสุ่มใน DM หลังผู้เล่นเลือกหมัด ===== */
const complimentPhrases = (hand, gName) => {
  const e = EMOJI[hand] || '';
  const H = hand.toUpperCase();
  return [
    `เลือกได้คมมาก! ${H} ${e} ดูทรงแล้วมีลุ้นนะ ในกลุ่ม “${gName}” 🔥`,
    `เยี่ยม! ${H} ${e} เหมาะกับสายตาแชมป์สุด ๆ รอประกาศผลใน “${gName}” เลย 👑`,
    `โอ้โห จังหวะนี้ต้อง ${H} ${e} เท่านั้น! ไปลุ้นกันต่อใน “${gName}” 🎯`,
    `แผนดี! ${H} ${e} กำลังจะพลิกเกมแน่นอน รอดูผลใน “${gName}” 🃏`,
    `เห็นหมัดนี้แล้วใจสั่น ${H} ${e} รอคู่แข่งเลือก แล้วไปลุ้นใน “${gName}” 🎲`,
    `เซンスนักแข่งชัด ๆ — ${H} ${e} ลุ้นต่อใน “${gName}” เลย! 🚀`,
  ];
};
const pickCompliment = (hand, gName) => {
  const arr = complimentPhrases(hand, gName);
  return arr[Math.floor(Math.random()*arr.length)];
};

async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try{
    const s = await client.getGroupSummary(gid);
    if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; }
  }catch{}
  return '(กลุ่มของคุณ)';
}

async function safePush(to, msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data || e?.message); throw e; } }
async function safeReply(token, msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data || e?.message); } }

/* ====== Robust DM delivery with pending queue ====== */
function queueDM(uid, payloads){
  const q = pendingDMs.get(uid) || [];
  q.push(payloads);
  pendingDMs.set(uid, q);
}
async function pushDM(uid, payloads, gid, room){
  try{
    await safePush(uid, payloads);
  }catch(e){
    // แจ้งเตือนในกลุ่มและคิว DM ไว้ให้ผู้เล่นมากดรับเองด้วย "janken dm" ที่ 1:1
    queueDM(uid, payloads);
    let name = '(ผู้เล่น)';
    try{
      if (room && room.players.has(uid)) name = room.players.get(uid).name || name;
      else {
        const p = await client.getGroupMemberProfile(gid, uid);
        name = p?.displayName || name;
      }
    }catch{}
    const gName = await groupName(gid);
    await safePush(gid, {
      type:'text',
      text:`📣 แจ้งเตือน: ${name}\nยังส่งปุ่มเลือกหมัดใน DM ไม่ได้\nโปรดเปิดแชท 1:1 กับบอท แล้วพิมพ์ "janken dm" เพื่อรับปุ่มอีกครั้ง (กลุ่ม “${gName}”)`
    });
  }
}

/* ========== ROOM INIT ========== */
function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin:null,
      phase:'idle',            // idle | register | playing | finished
      stage:'pools',           // pools | cross | sim | finished
      players:new Map(),       // userId -> {name}
      bracket:{
        round:0,
        pools:{A:[],B:[],C:[],D:[]},
        waitingOdd:null,
        cross:[],
        sim:[]
      },
      simCtx: { key:'', title:'', queue:[], result:{}, tmp:{} },
    });
  }
  return rooms.get(gid);
}

/* ========== FLEX / UI ========== */
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
        { type:'separator' },
        { type:'text', text:'สำหรับทดสอบ', size:'xs', color:'#999' },
        { type:'button', style:'secondary', action:{ type:'message', label:'Simulate (16 with placement)', text:'janken simulate' } },
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
          { type:'text', text:'รับสมัครสูงสุด 20 คน เท่านั้น', size:'sm', color:'#666', margin:'sm' }
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
  }catch{
    await safePush(to, { type:'text', text:[title, ...lines].join('\n') });
  }
}

/* ====== Flex Bracket Overview (สวย ๆ 2 คอลัมน์) ====== */
function bracketPairsToColumns(pairs, room){
  const items = pairs.map(([a,b], i)=>({
    type:'box', layout:'horizontal', spacing:'sm', contents:[
      { type:'text', text:`${i+1}.`, size:'xs', color:'#90CAF9', flex:1, align:'end' },
      { type:'text', text:pretty(room,a), size:'sm', flex:6, wrap:true },
      { type:'text', text:'vs', size:'xs', color:'#9E9E9E', align:'center', flex:2 },
      { type:'text', text:pretty(room,b), size:'sm', flex:6, wrap:true }
    ]
  }));
  const half = Math.ceil(items.length/2);
  return [ items.slice(0,half), items.slice(half) ];
}
function bracketOverviewFlex(title, pairs, room){
  const [left, right] = bracketPairsToColumns(pairs, room);
  return {
    type:'flex', altText:title,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:title, weight:'bold', size:'lg' },
        { type:'text', text: nowTH(), size:'xxs', color:'#999' },
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        {
          type:'box', layout:'horizontal', spacing:'md', contents:[
            { type:'box', layout:'vertical', spacing:'xs', width:'50%', contents:left },
            { type:'box', layout:'vertical', spacing:'xs', width:'50%', contents:right }
          ]
        }
      ]}
    }
  };
}

/* ====== Flex Leaderboard 1–16 ====== */
function colorByRank(rank){
  if (rank===1) return '#FFD54F';
  if (rank===2) return '#E0E0E0';
  if (rank===3) return '#D4AF37';
  return '#FFFFFF';
}
function rowEntry(rank, name){
  const color = colorByRank(rank);
  return {
    type:'box', layout:'baseline', spacing:'sm',
    contents:[
      { type:'text', text:String(rank).padStart(2,' '), weight:'bold', size:'sm', color:'#90CAF9', flex:1, align:'end' },
      { type:'text', text:name, size:'sm', wrap:true, color:'#212121', flex:7 }
    ],
    backgroundColor: rank<=3 ? color+'1F' : undefined,
    cornerRadius: rank<=3 ? 'md' : undefined,
    paddingAll: rank<=3 ? '6px' : undefined
  };
}
function leaderboardFlex16(gName, ordered){
  const left = ordered.slice(0,8).map(x=>rowEntry(x.rank, x.name));
  const right= ordered.slice(8,16).map(x=>rowEntry(x.rank, x.name));
  return {
    type:'flex',
    altText:`ผลจัดอันดับ 1–16 — ${gName}`,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'📊 FINAL STANDINGS', weight:'bold', size:'lg', color:'#FFFFFF' },
        { type:'text', text:`${gName}`, size:'xs', color:'#E0E0E0' },
        { type:'text', text:nowTH(), size:'xxs', color:'#BDBDBD' }
      ], backgroundColor:'#121212', paddingAll:'16px' },
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        {
          type:'box', layout:'horizontal', spacing:'md', contents:[
            { type:'box', layout:'vertical', spacing:'xs', width:'50%', contents:left },
            { type:'box', layout:'vertical', spacing:'xs', width:'50%', contents:right }
          ]
        },
        { type:'separator' },
        { type:'text', text:'Top 3 Highlighted • Janken Tournament', size:'xs', color:'#9E9E9E', align:'center' }
      ]},
      styles:{ body:{ backgroundColor:'#FAFAFA' } }
    }
  };
}

/* ====== DM Postback helpers ====== */
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

/* ========== SEEDING & ANNOUNCE (NORMAL) ========== */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };
function seedPoolsFrom(ids){
  const pools={A:[],B:[],C:[],D:[]}, shuffled=shuffle(ids); let i=0;
  for(const id of shuffled){ pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  return pools;
}
const allPoolsDone = pools => POOLS.every(k => pools[k].every(m => m.state==='done'));
const poolWinners = pools => POOLS.reduce((acc,k)=> (acc[k] = pools[k].map(m=>m.winner).filter(Boolean), acc), {});

/* ========== Announce helpers (NORMAL) ========== */
async function announcePoolsRound(gid, room, title){
  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await tryPushFlexOrText(gid, title, lines);

  // Bracket overview (สวย ๆ)
  const pairs = POOLS.flatMap(k => room.bracket.pools[k].map(m=>[m.a,m.b]));
  try{ await client.pushMessage(gid, [ bracketOverviewFlex(`${title} • Overview`, pairs, room) ]); }catch{}

  const gName = await groupName(gid);
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m, i) => {
      for (const uid of [m.a, m.b]) if (uid) {
        const payloads = [
          { type:'text', text:`📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'pools', k, i) },
          choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'pools', k, i),
          { type:'text', text:`เลือกแล้วรอลุ้นผลในกลุ่ม “${gName}” ได้เลย!` }
        ];
        await pushDM(uid, payloads, gid, room);
      }
    });
  }
}

async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  // Bracket overview
  const pairs = room.bracket.cross.map(m=>[m.a,m.b]);
  try{ await client.pushMessage(gid, [ bracketOverviewFlex(`${title} • Overview`, pairs, room) ]); }catch{}

  const gName = await groupName(gid);
  for (const [i, m] of room.bracket.cross.entries()){
    for (const uid of [m.a,m.b]) if (uid){
      const payloads = [
        { type:'text', text:`📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'cross', null, i) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'cross', null, i),
        { type:'text', text:`เลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` }
      ];
      await pushDM(uid, payloads, gid, room);
    }
  }
}

/* ========== FLEX ผลการแข่ง (ดูดี + fallback อัตโนมัติ) ========== */
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

/* ========== SIMULATE QUEUE (Placement 1–16) ========== */
function makeMatchesFromPairs(pairs){
  return pairs.map(([a,b])=>({ a:a||null, b:b||null, state:'pending', moves:{}, winner:null, loser:null }));
}
function enqueueStage(room, key, title, idList){
  room.simCtx.queue.push({ key, title, pairs: toPairs(idList) });
}
async function startNextSimStage(gid, room){
  const stage = room.simCtx.queue.shift();
  if (!stage){
    const ranks = room.simCtx.result;
    const gName = await groupName(gid);
    if (Object.keys(ranks).length === 16) {
      const ordered = Object.entries(ranks)
        .map(([uid,rank])=>({ uid, rank, name: pretty(room, uid) }))
        .sort((a,b)=>a.rank-b.rank);
      try {
        await client.pushMessage(gid, [ leaderboardFlex16(gName, ordered) ]);
      } catch {
        const lines = ordered.map(x=>`${x.rank}) ${x.name}`);
        await safePush(gid, { type:'text', text:`📊 ผลจัดอันดับครบ 1–16 (Simulation)\n\n${lines.join('\n')}` });
      }
    } else {
      await safePush(gid, { type:'text', text:`🏁 จำลองสิ้นสุด` });
    }
    room.phase='finished'; room.stage='finished';
    return;
  }
  room.simCtx.key = stage.key;
  room.simCtx.title = stage.title;
  room.bracket.sim = makeMatchesFromPairs(stage.pairs);

  // ส่งภาพรวม Bracket ของสเตจนี้ด้วย
  try{ await client.pushMessage(gid, [ bracketOverviewFlex(stage.title+' • Overview', stage.pairs, room) ]); }catch{}

  await announceSimRound(gid, room, stage.title);
}

/* ========== EVENT HANDLER ========== */
async function handleEvent(e){

  /* --- POSTBACK จาก DM (เลือกหมัด) --- */
  if (e.type === 'postback' && typeof e.postback?.data === 'string') {
    const data = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (data[0] === 'jg') {
      const gid   = data[1];
      const stage = data[2];                 // 'pools' | 'cross' | 'sim'
      const pool  = data[3] === '-' ? null : data[3];
      const idx   = Number(data[4]);
      const hand  = data[5];
      const uid   = e.source.userId;

      if (!rooms.has(gid)) return;
      const room = rooms.get(gid);
      const gName = await groupName(gid);

      if (stage === 'pools') {
        const m = room.bracket.pools[pool]?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          await safeReply(e.replyToken, { type:'text', text: pickCompliment(hand, gName) });
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          await safeReply(e.replyToken, { type:'text', text: pickCompliment(hand, gName) });
          await tryCloseMatch_Cross(gid, room, idx);
        }
      } else if (stage === 'sim') {
        const m = room.bracket.sim?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          await safeReply(e.replyToken, { type:'text', text: pickCompliment(hand, gName) });
          await tryCloseMatch_Sim(gid, room, idx);
        }
      }
    }
    return;
  }

  /* --- ข้อความใน DM (ผู้ใช้ 1:1) --- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const t = (e.message.text||'').trim().toLowerCase();

    if (t === 'janken dm' || t === 'dm' || t === 'open dm') {
      const uid = e.source.userId;
      const q = pendingDMs.get(uid) || [];
      if (!q.length) {
        await safeReply(e.replyToken, { type:'text', text:'ยังไม่มีข้อความค้างส่งครับ หากคุณกำลังแข่งอยู่ รอระบบส่งอีกครั้งได้เลย' });
      } else {
        // ส่งทั้งหมดที่ค้าง
        for (const payloads of q) {
          try{ await client.replyMessage(e.replyToken, payloads); }
          catch{ try{ await client.pushMessage(uid, payloads);}catch{} }
        }
        pendingDMs.delete(uid);
      }
      return;
    }

    // พิมพ์ rock/paper/scissors -> แจ้งให้ใช้ปุ่ม
    const isHand = HANDS.includes(t);
    if (!isHand) {
      await safeReply(e.replyToken, [
        { type:'text', text:'แตะปุ่มเพื่อเลือกหมัดได้เลย (หรือพิมพ์ rock / paper / scissors)' }
      ]);
      return;
    }
    await safeReply(e.replyToken, { type:'text', text:'เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกัน โปรดกดปุ่มเลือกหมัดที่มีชื่อกลุ่มกำกับครับ 🙏' });
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
    case 'open': {
      room.admin  = room.admin || e.source.userId;
      room.phase  = 'register';
      room.stage  = 'pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[], sim:[] };
      room.simCtx = { key:'', title:'', queue:[], result:{}, tmp:{} };

      const announce = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'พิมพ์  👉  janken join  เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คน เท่านั้น ‼️',
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
      const MAX_PLAYERS = 20;
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
      rooms.delete(gid);
      await safeReply(e.replyToken, { type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    case 'simulate': {
      if (room.admin && room.admin !== e.source.userId) {
        await safeReply(e.replyToken, { type:'text', text:'❌ เฉพาะผู้สร้างเท่านั้นที่สามารถสั่ง simulate ได้' });
        break;
      }

      const requesterId = e.source.userId;
      let requesterName = 'You';
      try { const p = await client.getGroupMemberProfile(gid, requesterId); requesterName = p?.displayName || 'You'; } catch {}

      room.admin = requesterId;
      room.phase = 'playing';
      room.stage = 'sim';
      room.bracket.round = 1;
      room.simCtx = { key:'', title:'', queue:[], result:{}, tmp:{} };

      const realEntries = new Map(room.players);
      realEntries.set(requesterId, { name: requesterName });

      const MAX = 16;
      const realIds = [...realEntries.keys()];
      const others = realIds.filter(id => id !== requesterId);
      const shuffledOthers = shuffle(others);

      const selected = [requesterId, ...shuffledOthers].slice(0, MAX);
      while (selected.length < MAX) selected.push(`mock_${selected.length}`);

      const playersMap = new Map();
      for (const uid of selected) if (realEntries.has(uid)) playersMap.set(uid, { name: realEntries.get(uid).name });
      let mockNo = 1;
      for (const uid of selected) if (!playersMap.has(uid)) playersMap.set(uid, { name:`Player${mockNo++}` });
      room.players = playersMap;

      await safePush(gid, { type:'text',
        text:`🧪 เริ่มจำลอง (Placement ครบ 1–16) — ผู้เล่น ${room.players.size} คน (กลุ่ม “${gName}”)\n- คุณจะเลือกหมัดใน DM ได้จริง\n- ผู้เล่น mock จะออกรอบอัตโนมัติ\nหากใครไม่ได้รับ DM ให้ไปคุย 1:1 กับบอทแล้วพิมพ์ "janken dm"`
      });

      enqueueStage(room, 'R16', '📣 รอบ 16 ทีม (Main Bracket)', selected);
      await startNextSimStage(gid, room);
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ========== MATCH RESOLUTION (NORMAL) ========== */
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
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid) {
        const payloads = [
          {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pools',k,idx)},
          choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', k, idx)
        ];
        await pushDM(uid, payloads, gid, room);
      }
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
    room.phase='finished'; room.stage='finished';
    return;
  }

  const ids = shuffle(champs);
  const cross=[]; for (let i=0;i<ids.length;i+=2) cross.push({a:ids[i]||null, b:ids[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
  room.stage='cross';
  room.bracket.cross = cross;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

/* ========== MATCH RESOLUTION (CROSS) ========== */
async function tryCloseMatch_Cross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH);
    if (r==='DRAW'){
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid) {
        const payloads = [
          {type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'cross',null,idx)},
          choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx)
        ];
        await pushDM(uid, payloads, gid, room);
      }
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

  const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
  if (winners.length === 1){
    await safePush(gid, { type:'text', text:`🏆 แชมป์: ${pretty(room,winners[0])}` });
    room.phase='finished'; room.stage='finished';
    return;
  }
  const next=[]; for (let i=0;i<winners.length;i+=2) next.push({a:winners[i]||null, b:winners[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
  room.bracket.cross = next;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}

/* ========== SIMULATE (ประกาศ + ปิดแมตช์) ========== */
async function announceSimRound(gid, room, title){
  const lines = room.bracket.sim.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);

  for (let i=0; i<room.bracket.sim.length; i++){
    const m = room.bracket.sim[i];

    for (const uid of [m.a, m.b]) {
      if (!uid) continue;

      if (isMock(uid)) {
        m.moves[uid] = randomHand();
      } else {
        const payloads = [
          { type:'text', text:`📝 รอบจำลองในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid, 'sim', null, i) },
          choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid, 'sim', null, i),
          { type:'text', text:`เลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` }
        ];
        await pushDM(uid, payloads, gid, room);
      }
    }

    if ((m.a && isMock(m.a)) && (m.b && isMock(m.b))) {
      await tryCloseMatch_Sim(gid, room, i);
    }
  }
}

async function tryCloseMatch_Sim(gid, room, idx){
  const m = room.bracket.sim[idx];
  if (!m || m.state !== 'pending') return;

  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) {
    m.winner=m.a; m.loser=null; m.state='done';
    await safePush(gid, { type:'text', text:`✅ Match ${idx+1}: ${pretty(room,m.a)} ได้สิทธิ์บาย` });
  } else if (m.b && !m.a) {
    m.winner=m.b; m.loser=null; m.state='done';
    await safePush(gid, { type:'text', text:`✅ Match ${idx+1}: ${pretty(room,m.b)} ได้สิทธิ์บาย` });
  } else if (aH && bH){
    let r = judge(aH,bH);
    if (r === 'DRAW') {
      const aMock = isMock(m.a), bMock = isMock(m.b);
      if (aMock) m.moves[m.a] = randomHand();
      if (bMock) m.moves[m.b] = randomHand();
      const a2 = m.moves[m.a], b2 = m.moves[m.b];
      r = judge(a2, b2);
      if (r === 'DRAW') r = Math.random() > 0.5 ? 'A' : 'B';
    }

    m.winner = r==='A'? m.a : m.b; 
    m.loser  = r==='A'? m.b : m.a; 
    m.state='done';

    try{
      await client.pushMessage(gid, [ flexMatchResult(`${room.simCtx.title}`, pretty(room,m.a), m.moves[m.a], pretty(room,m.b), m.moves[m.b], pretty(room,m.winner)) ]);
    }catch{
      await safePush(gid, { type:'text', text:`${room.simCtx.title}\n${pretty(room,m.a)} ${EMOJI[m.moves[m.a]]||''} vs ${pretty(room,m.b)} ${EMOJI[m.moves[m.b]]||''}\nผู้ชนะ: ${pretty(room,m.winner)}` });
    }
  } else {
    return; // ยังรอผู้เล่นจริงเลือกหมัด
  }

  const allDone = room.bracket.sim.every(x=>x.state==='done');
  if (!allDone) return;

  const winners = room.bracket.sim.map(x=>x.winner).filter(Boolean);
  const losers  = room.bracket.sim.map(x=>x.loser ).filter(Boolean);

  const key = room.simCtx.key;
  const res = room.simCtx.result;
  switch (key) {
    case 'R16': {
      enqueueStage(room, 'QF', '📣 รอบ 8 ทีม (Quarterfinals)', winners);
      enqueueStage(room, 'PL_9_16_R1', '🎖 จัดอันดับ 9–16 (รอบแรก)', losers);
      break;
    }
    case 'QF': {
      enqueueStage(room, 'SF', '📣 รอบรองชนะเลิศ (Semifinals)', winners);
      enqueueStage(room, 'PL_5_8_R1', '🏅 จัดอันดับ 5–8 (รอบแรก)', losers);
      break;
    }
    case 'SF': {
      enqueueStage(room, 'FINAL',  '🏆 ชิงชนะเลิศ (Final)', winners);
      enqueueStage(room, 'BRONZE', '🥉 ชิงอันดับ 3–4 (Bronze)', losers);
      break;
    }
    case 'FINAL': {
      if (winners[0]) res[winners[0]] = 1;
      if (losers[0])  res[losers[0]]  = 2;
      break;
    }
    case 'BRONZE': {
      if (winners[0]) res[winners[0]] = 3;
      if (losers[0])  res[losers[0]]  = 4;
      break;
    }
    case 'PL_5_8_R1': {
      enqueueStage(room, 'PL_5_6_FINAL', '🏅 ชิงอันดับ 5–6', winners);
      enqueueStage(room, 'PL_7_8_FINAL', '🏅 ชิงอันดับ 7–8', losers);
      break;
    }
    case 'PL_5_6_FINAL': {
      if (winners[0]) res[winners[0]] = 5;
      if (losers[0])  res[losers[0]]  = 6;
      break;
    }
    case 'PL_7_8_FINAL': {
      if (winners[0]) res[winners[0]] = 7;
      if (losers[0])  res[losers[0]]  = 8;
      break;
    }
    case 'PL_9_16_R1': {
      enqueueStage(room, 'PL_9_12_SF',  '🎖 จัดอันดับ 9–12 (รองรองชนะเลิศ)', winners);
      enqueueStage(room, 'PL_13_16_SF', '🎖 จัดอันดับ 13–16 (รองรองชนะเลิศ)', losers);
      break;
    }
    case 'PL_9_12_SF': {
      enqueueStage(room, 'PL_9_10_FINAL',  '🎖 ชิงอันดับ 9–10', winners);
      enqueueStage(room, 'PL_11_12_FINAL', '🎖 ชิงอันดับ 11–12', losers);
      break;
    }
    case 'PL_13_16_SF': {
      enqueueStage(room, 'PL_13_14_FINAL', '🎖 ชิงอันดับ 13–14', winners);
      enqueueStage(room, 'PL_15_16_FINAL', '🎖 ชิงอันดับ 15–16', losers);
      break;
    }
    case 'PL_9_10_FINAL': {
      if (winners[0]) res[winners[0]] = 9;
      if (losers[0])  res[losers[0]]  = 10;
      break;
    }
    case 'PL_11_12_FINAL': {
      if (winners[0]) res[winners[0]] = 11;
      if (losers[0])  res[losers[0]]  = 12;
      break;
    }
    case 'PL_13_14_FINAL': {
      if (winners[0]) res[winners[0]] = 13;
      if (losers[0])  res[losers[0]]  = 14;
      break;
    }
    case 'PL_15_16_FINAL': {
      if (winners[0]) res[winners[0]] = 15;
      if (losers[0])  res[losers[0]]  = 16;
      break;
    }
  }

  await startNextSimStage(gid, room);
}
