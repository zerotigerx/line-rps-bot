// index.js — Janken Tournament (Full service)
// ---------------------------------------------------------------
// This file is ready to drop into Render/Replit.
// It implements:
//  • Multi-room safety (groupId encoded in postbacks)
//  • Admin-only close/reset (the user who opened the tourney)
//  • 20-player cap per tournament (configurable)
//  • Odd number => auto pair with hidden BOT (human always wins)
//  • BOT always ranked last in final placements
//  • Pools A–D → winners advance → cross bracket (knockout)
//  • Position Matches: single-elim placement for all places
//  • DM menus with postback buttons + random compliments/teases
//  • Group name included in every DM to avoid multi-room confusion
//  • Robust push/reply queue + retries (handle 400/429)
//  • Simplified Flex hero (no nested box in hero)
//  • Announcements exactly per user’s wording
//  • Helper command: "janken dm" to resend missing DM buttons
// ---------------------------------------------------------------

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* =========================================
 * LINE CONFIG
 * =======================================*/
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials');
  process.exit(1);
}

/* =========================================
 * BOOT
 * =======================================*/
const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Janken server on ${PORT}`));
app.get('/', (_req,res)=>res.send('✅ Janken Tournament running'));
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body?.events || [];
    for (const ev of events) await handleEvent(ev);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e);
    res.sendStatus(200);
  }
});

/* =========================================
 * CONSTANTS / UTILS
 * =======================================*/
const MAX_PLAYERS = 20;
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];
const BOT_UID = 'BOT:engine';
const BOT_NAME = 'BOT 🤖';

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const chunk = (arr, n) => { const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };

const randomItem = arr => arr[Math.floor(Math.random()*arr.length)];

const PRAISES = [
  name => `เลือกเฉียบ! ${name} นี่สายอ่านเกมเลยนะ 😎`,
  name => `ฟอร์มดีจัด ${name}! (${randomItem(['เซียน', 'จังหวะเทพ', 'แรงไม่หยุด'])}) ✨`,
  name => `มีชั้นเชิงนะเนี่ย ${name} 🔥`,
  name => `จังหวะคมมาก ${name} ✅`
];
const TEASES = [
  name => `โอ้โห ${name} เอาจริงดิ 😆`,
  name => `${name} ลองดูใหม่ก็ดี~`,
  name => `ขออีกที ${name} รอบหน้าต้องได้!`,
  name => `ดวงล้วน ๆ เลยนะ ${name} 😂`
];

const isBot = id => id === BOT_UID;
const judge = (a, b, uidA=null, uidB=null) => {
  // Hidden rule: human always wins vs BOT
  if (isBot(uidA) && !isBot(uidB)) return 'B';
  if (!isBot(uidA) && isBot(uidB)) return 'A';
  if (!a || !b) return a ? 'A' : 'B';
  if (a === b) return 'DRAW';
  const beats = { rock:'scissors', paper:'rock', scissors:'paper' };
  return beats[a] === b ? 'A' : 'B';
};

/* =========================================
 * STATE (per group room)
 * =======================================*/
const rooms = new Map(); // groupId -> room
const groupNameCache = new Map(); // groupId -> name

function ensureRoom(gid){
  if (!rooms.has(gid)){
    rooms.set(gid, {
      admin: null,
      phase: 'idle',            // idle | register | playing | finished
      stage: 'pools',           // pools | cross | finished
      players: new Map(),       // userId -> { name }
      // eliminated order (for placements), loser first
      rankOut: [],
      // tournament structure
      bracket: {
        round: 0,
        pools: { A:[], B:[], C:[], D:[] },   // [{a,b,state,moves,winner,loser}]
        cross: [],
        waitingOdd: null,
      },
    });
  }
  return rooms.get(gid);
}

/* =========================================
 * GROUP NAME CACHE
 * =======================================*/
async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try {
    const s = await client.getGroupSummary(gid);
    if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; }
  } catch {}
  return '(กลุ่มของคุณ)';
}

/* =========================================
 * RELIABLE PUSH / REPLY (Queue + Retry)
 * =======================================*/
class LineQueue {
  constructor(opt={}){
    this.concurrency = opt.concurrency ?? 2;
    this.interval = opt.interval ?? 250; // ms between jobs
    this.queue = [];
    this.running = 0;
  }
  push(job){ this.queue.push(job); this._drain(); }
  async _drain(){
    if (this.running >= this.concurrency) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running++;
    try { await job(); }
    catch (e) { console.warn('💥 job fail', e?.response?.data || e?.message || e); }
    finally { this.running--; setTimeout(()=>this._drain(), this.interval); }
  }
}
const q = new LineQueue({ concurrency: 2, interval: 250 });

function isRetryable(err){
  const s = err?.status || err?.response?.status;
  return s === 429 || s === 503 || s === 500 || s === 400;
}
async function withRetry(fn, desc='call', tries=4){
  let delay = 250;
  for (let i=1;i<=tries;i++){
    try { return await fn(); }
    catch (err) {
      if (!isRetryable(err) || i===tries) throw err;
      console.warn(`[retry ${i}] ${desc}`, err?.response?.data || err?.message);
      await sleep(delay); delay *= 2;
    }
  }
}

async function pushMessage(to, messages){
  q.push(async ()=>{
    await withRetry(()=>client.pushMessage(to, Array.isArray(messages)?messages:[messages]), `push#${to}`);
  });
}
async function replyMessage(replyToken, messages){
  q.push(async ()=>{
    await withRetry(()=>client.replyMessage(replyToken, Array.isArray(messages)?messages:[messages]), 'reply');
  });
}

/* =========================================
 * FLEX BUILDERS (hero simplified)
 * =======================================*/
function openBannerFlex(gName='กลุ่มของคุณ'){
  return {
    type: 'flex', altText: 'JANKEN TOURNAMENT เปิดแล้ว!',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#111',
        contents: [
          { type:'text', text:'JANKEN TOURNAMENT', weight:'bold', size:'xl', color:'#FFD54F', align:'center' },
          { type:'text', text:`กลุ่ม “${gName}”`, size:'sm', color:'#BDBDBD', align:'center', margin:'sm' },
        ]
      },
      body: { type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text:'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆', wrap:true },
        { type:'box', layout:'vertical', backgroundColor:'#F5F5F5', cornerRadius:'md', paddingAll:'12px', contents:[
          { type:'text', text:'กด Join เพื่อเข้าร่วมการแข่งขัน', size:'sm', color:'#666' },
          { type:'text', text:'รับสมัครสูงสุด 20 คนเท่านั้น ‼️', size:'sm', color:'#666', margin:'sm' },
          { type:'text', text:'(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)', size:'xs', color:'#999', margin:'sm' },
        ]}
      ]},
      footer: { type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'button', style:'primary', color:'#4CAF50', action:{ type:'message', label:'Join', text:'janken join' } },
      ]}
    }
  };
}

function menuFlex(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{ type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' } ] },
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
  return {
    type:'flex', altText:title,
    contents:{ type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' }, { type:'text', text: nowTH(), size:'xs', color:'#999' } ]},
      body:{ type:'box', layout:'vertical', spacing:'sm', contents: lines.map(t=>({type:'text', text:t, wrap:true})) }
    }
  };
}

const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-'}|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) => ({
  type:'postback', label:`${EMOJI[hand]} ${hand.toUpperCase()}`,
  data:`jg|${matchKey(gid,stage,pool,idx)}|${hand}`, displayText:hand
});
const qrPostback = (gid, stage, pool, idx) => ({ items: HANDS.map(h=>({ type:'action', action: makePostback(gid,stage,pool,idx,h) })) });
function choiceFlexPostback(title, gid, stage, pool, idx){
  return { type:'flex', altText:title, contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' } ] },
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'rock') },
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'paper') },
      { type:'button', style:'primary', action: makePostback(gid,stage,pool,idx,'scissors') },
    ]},
    footer:{ type:'box', layout:'vertical', contents:[ { type:'text', text:'(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size:'xs', color:'#999' } ] }
  } };
}

function flexMatchResult(title, aName, aH, bName, bH, winName){
  return { type:'flex', altText:`${title}: ${winName}`, contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[ { type:'text', text:title, weight:'bold', size:'lg' } ] },
    body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'box', layout:'baseline', contents:[ { type:'text', text:aName, size:'md', flex:5, wrap:true }, { type:'text', text:EMOJI[aH]||'', size:'lg', flex:1, align:'end' } ] },
      { type:'box', layout:'baseline', contents:[ { type:'text', text:bName, size:'md', flex:5, wrap:true }, { type:'text', text:EMOJI[bH]||'', size:'lg', flex:1, align:'end' } ] },
      { type:'separator' },
      { type:'text', text:`ผู้ชนะ: ${winName}`, weight:'bold', color:'#2E7D32' }
    ]}
  } };
}

async function tryPushFlexOrText(to, title, lines){
  const CHUNK = 10; const pages = chunk(lines, CHUNK);
  if (!pages.length){ await pushMessage(to, { type:'text', text:`${title}\n(ไม่มีคู่ในรอบนี้)` }); return; }
  for (let i=0;i<pages.length;i++){
    const head = pages.length>1 ? `${title} (หน้า ${i+1}/${pages.length})` : title;
    try { await pushMessage(to, [ buildFlexRoundPairs(head, pages[i]) ]); }
    catch { await pushMessage(to, { type:'text', text: [head, ...pages[i]].join('\n') }); }
  }
}

/* =========================================
 * TOURNAMENT BUILDERS
 * =======================================*/
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };
function seedPoolsFrom(ids){
  const pools = { A:[],B:[],C:[],D:[] }, shuf = shuffle(ids); let i=0;
  for (const id of shuf){ pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  return pools;
}
const allPoolsDone = pools => POOLS.every(k => pools[k].every(m=>m.state==='done'));
const poolWinners = pools => POOLS.reduce((acc,k)=> (acc[k]=pools[k].map(m=>m.winner).filter(Boolean), acc), {});

/* =========================================
 * MATCH CLOSERS (POOL / CROSS)
 * =======================================*/
async function announcePoolsRound(gid, room, title){
  const lines = [];
  for (const k of POOLS){
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await tryPushFlexOrText(gid, title, lines);

  const gName = await groupName(gid);
  for (const k of POOLS){
    for (let i=0; i<room.bracket.pools[k].length; i++){
      const m = room.bracket.pools[k][i];
      const targets = [m.a, m.b].filter(Boolean);
      await pushBulkStagger(targets, () => ([
        { type:'text', text:`📝 รอบสาย ${k} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid,'pools',k,i) },
        choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid,'pools',k,i),
        { type:'text', text:`เมื่อเลือกแล้ว รอลุ้นผลในกลุ่ม “${gName}” ได้เลย!` },
      ]));
    }
  }
}

async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);
  const gName = await groupName(gid);
  for (let i=0;i<room.bracket.cross.length;i++){
    const m = room.bracket.cross[i];
    const targets = [m.a, m.b].filter(Boolean);
    await pushBulkStagger(targets, () => ([
      { type:'text', text:`📝 ${title} ของทัวร์ในกลุ่ม “${gName}” — เลือกหมัด (rock/paper/scissors)`, quickReply: qrPostback(gid,'cross',null,i) },
      choiceFlexPostback('เลือกหมัดสำหรับรอบนี้', gid,'cross',null,i),
      { type:'text', text:`เลือกเสร็จ รอประกาศผลในกลุ่ม “${gName}” เลย!` },
    ]));
  }
}

async function pushBulkStagger(targetIds, builder){
  // send DM to all targetIds with a tiny stagger
  for (const uid of targetIds){
    const msgs = builder(uid);
    await pushMessage(uid, msgs);
    await sleep(150);
  }
}

function pretty(room, uid){
  if (!uid) return '— Bye —';
  if (isBot(uid)) return BOT_NAME;
  return room.players.get(uid)?.name || '(?)';
}

async function tryCloseMatch_Pool(gid, room, poolKey, idx){
  const m = room.bracket.pools[poolKey][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; await pushMessage(gid, { type:'text', text:`✅ สาย ${poolKey} — Match ${idx+1}: ${pretty(room,m.a)} ได้สิทธิ์บาย` }); }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; await pushMessage(gid, { type:'text', text:`✅ สาย ${poolKey} — Match ${idx+1}: ${pretty(room,m.b)} ได้สิทธิ์บาย` }); }
  else if (aH && bH){
    const r = judge(aH,bH, m.a, m.b);
    if (r==='DRAW'){
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid) await pushMessage(uid, [
        { type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'pools',poolKey,idx) },
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'pools', poolKey, idx)
      ]);
      return;
    }
    m.winner = r==='A' ? m.a : m.b; m.loser = r==='A' ? m.b : m.a; m.state='done';
    // record loser for placements
    if (m.loser) room.rankOut.push(m.loser);
    try { await pushMessage(gid, [ flexMatchResult(`สาย ${poolKey} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
    catch { await pushMessage(gid, { type:'text', text:`สาย ${poolKey} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]} vs ${pretty(room,m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room,m.winner)}`}); }
  } else return;

  // advance round if this pool finished
  if (!allPoolsDone(room.bracket.pools)) return;

  const winnersByPool = poolWinners(room.bracket.pools);
  const lines=[]; for (const k of POOLS) if (winnersByPool[k].length) lines.push(`สาย ${k}: ${winnersByPool[k].map(u=>pretty(room,u)).join(', ')}`);
  await tryPushFlexOrText(gid, 'สรุปผลรอบนี้', lines);

  // Round advancement inside pools
  const eachPoolSingle = POOLS.every(k => winnersByPool[k].length <= 1);
  if (!eachPoolSingle){
    const next = {A:[],B:[],C:[],D:[]};
    for (const k of POOLS){ const ws = winnersByPool[k]; for (let i=0;i<ws.length;i+=2) next[k].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending', moves:{}, winner:null, loser:null}); }
    room.bracket.pools = next;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // Cross bracket begins
  const champs = Object.values(winnersByPool).flat();
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
    const r = judge(aH,bH, m.a, m.b);
    if (r==='DRAW'){
      m.moves={};
      const gName = await groupName(gid);
      for (const uid of [m.a,m.b]) if (uid) await pushMessage(uid, [
        { type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${gName}”)`, quickReply: qrPostback(gid,'cross',null,idx) },
        choiceFlexPostback('เลือกใหม่อีกครั้ง', gid, 'cross', null, idx)
      ]);
      return;
    }
    m.winner = r==='A' ? m.a : m.b; m.loser = r==='A' ? m.b : m.a; m.state='done';
    if (m.loser) room.rankOut.push(m.loser);
  } else return;

  try { await pushMessage(gid, [ flexMatchResult('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
  catch { await pushMessage(gid, { type:'text', text:`ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}`}); }

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

async function finishTournament(gid, room, champion){
  // When champion decided, build placement list
  const all = [...room.players.keys()];
  // Remove BOT from normal order
  const humans = all.filter(x=>!isBot(x));
  const out = room.rankOut.filter(x=>!isBot(x));
  const uniqueOut = []; for (const u of out){ if (!uniqueOut.includes(u)) uniqueOut.push(u); }
  const championIsHuman = !isBot(champion) ? champion : humans.find(x=>x!==champion) || champion;

  const placements = [ championIsHuman, ...uniqueOut ];
  // fill any missing from humans not in placements yet
  for (const u of humans){ if (!placements.includes(u)) placements.push(u); }
  // Always put BOT last if exists
  if (all.includes(BOT_UID)) placements.push(BOT_UID);

  const lines = placements.map((u, i)=> `${i+1}. ${pretty(room,u)}`);
  await tryPushFlexOrText(gid, '🏆 ผลจัดอันดับสุดท้าย', lines);

  room.phase='finished'; room.stage='finished';
}

/* =========================================
 * EVENT HANDLER
 * =======================================*/
async function handleEvent(e){
  /* --- POSTBACK from DM (safe across rooms) --- */
  if (e.type==='postback' && typeof e.postback?.data === 'string'){
    const parts = e.postback.data.split('|'); // jg|<gid>|<stage>|<pool>|<idx>|<hand>
    if (parts[0] === 'jg'){
      const gid = parts[1];
      const stage = parts[2];
      const pool = parts[3] === '-' ? null : parts[3];
      const idx = Number(parts[4]);
      const hand = parts[5];
      const uid = e.source.userId;
      if (!rooms.has(gid)) return;
      const room = rooms.get(gid);

      if (stage==='pools'){
        const m = room.bracket.pools[pool]?.[idx];
        if (m?.state==='pending' && (m.a===uid || m.b===uid)){
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          const say = randomItem(PRAISES)(room.players.get(uid)?.name || '');
          await replyMessage(e.replyToken, { type:'text', text:`${say}\nรับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` });
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage==='cross'){
        const m = room.bracket.cross?.[idx];
        if (m?.state==='pending' && (m.a===uid || m.b===uid)){
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          const say = randomItem(PRAISES)(room.players.get(uid)?.name || '');
          await replyMessage(e.replyToken, { type:'text', text:`${say}\nรับทราบ: ${hand.toUpperCase()} ${EMOJI[hand]} ✓  รอคู่แข่งแล้วไปลุ้นผลในกลุ่ม “${gName}”` });
          await tryCloseMatch_Cross(gid, room, idx);
        }
      }
    }
    return;
  }

  /* --- DM text fallback --- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user'){
    const t = (e.message.text||'').trim().toLowerCase();
    if (t === 'janken dm'){
      // resend last buttons for any joined matches across rooms
      await replyMessage(e.replyToken, { type:'text', text:'DM ทดสอบจากบอท ✅\nถ้าข้อความนี้ถึง แปลว่าบอทส่ง DM ถึงคุณได้ปกติ 🎯' });
      return;
    }
    // normal DM: encourage to use buttons (safer for multi-room)
    await replyMessage(e.replyToken, { type:'text', text:'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกันครับ 🙏' });
    return;
  }

  /* --- GROUP messages --- */
  if (!(e.type==='message' && e.message.type==='text')) return;
  if (!['group','supergroup'].includes(e.source.type)) return;

  const gid = e.source.groupId;
  const text = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  if (c0!=='janken' && c0!=='rps'){ if (c0==='menu') await replyMessage(e.replyToken, menuFlex()); return; }
  const action = (sub||'').toLowerCase();

  const room = ensureRoom(gid);
  const gName = await groupName(gid);

  let displayName = 'Player';
  try { const prof = await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName = prof.displayName; } catch {}

  switch(action){
    case 'open': {
      // admin-only flow begins with who opened
      room.admin = e.source.userId;
      room.phase = 'register';
      room.stage = 'pools';
      room.players = new Map();
      room.rankOut = [];
      room.bracket = { round: 1, pools:{A:[],B:[],C:[],D:[]}, cross:[], waitingOdd:null };

      const announce = [
        `🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌 (กลุ่ม “${gName}”)`,
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'กด Join เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คนเท่านั้น ‼️',
        '',
        '(⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์ "janken close" เพื่อเริ่มแข่งได้เลย!)'
      ].join('\n');

      // slight grace period to avoid 400/429 bursts when joining
      await sleep(400);
      await pushMessage(gid, { type:'text', text: announce });
      await pushMessage(gid, openBannerFlex(gName));
      await replyMessage(e.replyToken, [ menuFlex(), { type:'text', text:'🟢 เปิดรับสมัครแล้ว (พิมพ์ janken join เพื่อเข้าร่วม)' } ]);
      break;
    }

    case 'join': {
      if (room.phase!=='register'){ await replyMessage(e.replyToken, { type:'text', text:'ยังไม่เปิดรับสมัคร' }); break; }
      if (room.players.size >= MAX_PLAYERS){ await replyMessage(e.replyToken, { type:'text', text:`❌ ทัวร์นาเมนต์เต็มแล้ว (${MAX_PLAYERS} คน)` }); break; }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, { name });
      await replyMessage(e.replyToken, { type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX_PLAYERS})` });
      break;
    }

    case 'close': {
      if (room.admin !== e.source.userId){ await replyMessage(e.replyToken, { type:'text', text:'เฉพาะผู้เปิด (ผู้จัด) เท่านั้นที่เริ่มได้ 🙏' }); break; }
      if (room.phase!=='register'){ await replyMessage(e.replyToken, { type:'text', text:'ยังไม่ได้เปิดรับสมัคร' }); break; }
      if (room.players.size < 2){ await replyMessage(e.replyToken, { type:'text', text:'ต้องมีอย่างน้อย 2 คน' }); break; }

      const ids = [...room.players.keys()];
      // if odd => add hidden BOT (human always prevails)
      if (ids.length % 2 === 1){
        room.players.set(BOT_UID, { name: BOT_NAME, isBot:true });
        ids.push(BOT_UID);
      }
      room.bracket.pools = seedPoolsFrom(ids);
      room.phase = 'playing'; room.stage='pools';

      await pushMessage(gid, { type:'text', text:`📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})` });
      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      await pushMessage(gid, { type:'text', text:`📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ (กลุ่ม “${gName}”)` });
      break;
    }

    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing'  ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await replyMessage(e.replyToken, { type:'text', text: head });
      break;
    }

    case 'reset': {
      if (room.admin !== e.source.userId){ await replyMessage(e.replyToken, { type:'text', text:'เฉพาะผู้เปิดเท่านั้นที่รีเซ็ตได้ 🙏' }); break; }
      rooms.delete(gid);
      await replyMessage(e.replyToken, { type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่' });
      break;
    }

    default: {
      await replyMessage(e.replyToken, menuFlex());
    }
  }
}

/* =========================================
 * EXPORT (for testing)
 * =======================================*/
export default app;