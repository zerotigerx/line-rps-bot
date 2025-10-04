// Janken Tournament — Multi-Room Safe with resilient DM (postback payload + "janken dm")
// Pools A–D -> winners cross bracket. Flex menus + Quick Reply + Flex buttons in DM.
// Includes: open banner, random praise lines, simulate 16 (host included).

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

/* ========== STATE / HELPERS ========== */
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];
const MAX_PLAYERS = 20; // คงค่าเดิมไว้ (simulate 16 เฉพาะโหมดจำลอง)

const rooms = new Map();  // groupId -> room
const groupNameCache = new Map(); // groupId -> name

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const judge = (a,b)=>{ if(!a||!b) return a? 'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };

async function groupName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try{
    const s = await client.getGroupSummary(gid);
    if (s?.groupName){ groupNameCache.set(gid, s.groupName); return s.groupName; }
  }catch{}
  return '(กลุ่มของคุณ)';
}

async function safePush(to, msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data || e?.message); } }
async function safeReply(token, msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data || e?.message); } }

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
      pendingDM: new Map(),    // userId -> {stage,pool,idx}
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
          { type:'text', text:`รับสมัครสูงสุด ${MAX_PLAYERS} คน`, size:'sm', color:'#666', margin:'sm' }
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

/* ====== DM postback SAFE ====== */
const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool ?? '-' }|${idx}`;
const makePostback = (gid, stage, pool, idx, hand) =>
  ({ type:'postback', label:`${EMOJI[hand]} ${hand.toUpperCase()}`, data:`jg|${matchKey(gid,stage,pool,idx)}|${hand}`, displayText:hand });

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

/* ========== PRAISE / DM RESILIENCE HELPERS ========== */
function praiseLine(hand, groupName) {
  const lib = [
    `เลือกได้ดีนะ ${EMOJI[hand]} — รอคู่ต่อสู้ แล้วไปลุ้นผลในกลุ่ม “${groupName}” !`,
    `เท่ไม่เบา ${EMOJI[hand]} 👍  เดี๋ยวไปวัดกันใน “${groupName}”`,
    `โอ้โห… ${hand.toUpperCase()} มาเต็ม! ${EMOJI[hand]}  รอผลใน “${groupName}”`,
    `ชอบสไตล์นี้! ${EMOJI[hand]}  ไปต่อกันใน “${groupName}”`,
    `มั่นใจดีนะ ${EMOJI[hand]}  ลุ้นผลใน “${groupName}” เลย!`,
  ];
  return lib[Math.floor(Math.random() * lib.length)];
}

async function canPushUser(userId) {
  try {
    await client.pushMessage(userId, { type: 'text', text: '​' }); // zero-width char
    return true;
  } catch (e) {
    const m = e?.response?.data?.message || e?.message || '';
    if (String(m).includes('400')) return false;
    return false;
  }
}

async function sendChoiceDM(gid, room, userId, stage, pool, idx, titleOverride) {
  const ok = await canPushUser(userId);
  const gName = await groupName(gid);

  if (!ok) {
    room.pendingDM.set(userId, { stage, pool, idx });
    await safePush(gid, {
      type: 'text',
      text: `⚠️ แจ้งเตือน: ${pretty(room, userId)} ยังรับปุ่มเลือกหมัดใน DM ไม่ได้\n` +
            `กรุณาเปิดแชท 1:1 กับบอทแล้วพิมพ์ "janken dm" เพื่อรับปุ่มอีกครั้ง (กลุ่ม “${gName}”)`
    });
    return false;
  }

  const title = titleOverride || 'เลือกหมัดสำหรับรอบนี้';
  await safePush(userId, [
    {
      type:'text',
      text:`📝 การดวลในกลุ่ม “${gName}” — เลือกหมัดของคุณได้เลย`,
      quickReply: { items: HANDS.map(h => ({
        type:'action',
        action: { type:'postback', label:`${EMOJI[h]} ${h.toUpperCase()}`,
          data:`jg|${gid}|${stage}|${(pool ?? '-') }|${idx}|${h}`, displayText: h }
      })) }
    },
    choiceFlexPostback(title, gid, stage, pool ?? null, idx),
    { type:'text', text:`เลือกเสร็จแล้ว รอลุ้นผลในกลุ่ม “${gName}” นะครับ` }
  ]);
  return true;
}

/* ========== SEEDING & ANNOUNCE ========== */
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

  // DM ปุ่มเลือกหมัด (ทนกรณี DM ไม่ผ่าน)
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m, i) => {
      for (const uid of [m.a, m.b]) if (uid) {
        await sendChoiceDM(gid, room, uid, 'pools', k, i, `เลือกหมัด — สาย ${k} (Match ${i+1})`);
      }
    });
  }
}

async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await tryPushFlexOrText(gid, title, lines);

  for (let i=0; i<room.bracket.cross.length; i++){
    const m = room.bracket.cross[i];
    for (const uid of [m.a,m.b]) if (uid){
      await sendChoiceDM(gid, room, uid, 'cross', null, i, `เลือกหมัด — รอบรวม (Match ${i+1})`);
    }
  }
}

/* ========== FLEX ผลการแข่ง ========== */
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

/* ========== EVENT HANDLER ========== */
async function handleEvent(e){
  /* --- POSTBACK จาก DM (เลือกหมัดแบบชัวร์ต่อหลายกลุ่ม) --- */
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
          await safeReply(e.replyToken, { type:'text', text: praiseLine(hand, gName) });
          await tryCloseMatch_Pool(gid, room, pool, idx);
        }
      } else if (stage === 'cross') {
        const m = room.bracket.cross?.[idx];
        if (m?.state === 'pending' && (m.a === uid || m.b === uid)) {
          m.moves[uid] = hand;
          const gName = await groupName(gid);
          await safeReply(e.replyToken, { type:'text', text: praiseLine(hand, gName) });
          await tryCloseMatch_Cross(gid, room, idx);
        }
      }
    }
    return;
  }

  /* --- ข้อความใน DM (ให้ผู้ใช้พึ่งปุ่ม postback) --- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const t = (e.message.text||'').trim().toLowerCase();
    if (t === 'help' || t === 'menu') {
      await safeReply(e.replyToken, { type:'text', text:'หากคุณอยู่ระหว่างแข่งขัน ระบบได้ส่งปุ่มเลือกหมัดให้แล้ว (มีชื่อกลุ่มกำกับ) ถ้ายังไม่ได้รับให้กลับไปที่กลุ่มและพิมพ์ "janken dm" ครับ' });
      return;
    }
    await safeReply(e.replyToken, { type:'text', text:'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบุชื่อกลุ่มแล้ว) เพื่อป้องกันสับสนเมื่อคุณเล่นหลายทัวร์พร้อมกันครับ 🙏' });
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
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[] };
      room.pendingDM.clear();

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

    case 'dm': {
      // ให้ผู้เล่นรับปุ่มเลือกหมัดใหม่ กรณี DM ไม่ผ่านมาก่อน
      const pend = room.pendingDM.get(e.source.userId);
      if (!pend) { await safeReply(e.replyToken, { type:'text', text:'ยังไม่มีข้อความค้างส่งครับ หากคุณกำลังแข่งอยู่ รอระบบส่งอีกครั้งได้เลย' }); break; }
      const ok = await sendChoiceDM(gid, room, e.source.userId, pend.stage, pend.pool, pend.idx, 'เลือกหมัด (ส่งใหม่)');
      if (ok) room.pendingDM.delete(e.source.userId);
      else await safeReply(e.replyToken, { type:'text', text:'ยังส่งไม่ได้ โปรดเปิดแชท 1:1 กับบอทก่อน แล้วลอง "janken dm" อีกครั้ง' });
      break;
    }

    case 'simulate': {
      // สร้าง Bracket 16 คนอัตโนมัติและเริ่มรอบจริง โดย "คนสั่ง" ได้อยู่ใน 16 คนด้วย
      room.admin  = room.admin || e.source.userId;
      room.phase  = 'playing';
      room.stage  = 'pools';
      room.players = new Map();
      room.pendingDM.clear();

      const hostId = e.source.userId;
      room.players.set(hostId, { name: displayName });

      // เติม mock 15 คน
      for (let i=1;i<=15;i++){
        const fakeId = `mock-${gid}-${i}`;
        room.players.set(fakeId, { name: `Player${i}` });
      }

      const ids = [...room.players.keys()];
      room.bracket = { round:1, pools:seedPoolsFrom(ids), waitingOdd:null, cross:[] };

      // ประกาศ + ส่ง DM ให้เลือกหมัด
      await safePush(gid, {
        type:'text',
        text: `🧪 เริ่มจำลอง (Placement ครบ 1–16) — ผู้เล่น 16 คน (กลุ่ม “${gName}”)\n- คุณจะเลือกหมัดใน DM ได้จริง\n- ผู้เล่น mock จะออกกรอบอัตโนมัติ\nหากใครไม่ได้รับ DM ให้ไปคุย 1:1 กับบอทแล้วพิมพ์ "janken dm"`
      });
      await announcePoolsRound(gid, room, '📣 รอบ 16 ทีม (Main Bracket)');
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
    }
  }
}

/* ========== MATCH RESOLUTION ========== */
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
      for (const uid of [m.a,m.b]) if (uid)
        await sendChoiceDM(gid, room, uid, 'pools', k, idx, `เสมอ — เลือกใหม่ สาย ${k} (Match ${idx+1})`);
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

async function tryCloseMatch_Cross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH);
    if (r==='DRAW'){
      m.moves={};
      for (const uid of [m.a,m.b]) if (uid)
        await sendChoiceDM(gid, room, uid, 'cross', null, idx, `เสมอ — เลือกใหม่ รอบรวม (Match ${idx+1})`);
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
