// Janken Tournament (Lite) — fixed switch/case + Flex fallback + 20 players cap
import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ===== LINE config ===== */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

/* ===== Constants / State ===== */
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];

const rooms = new Map();       // groupId -> room
const userToGroup = new Map(); // userId  -> groupId (DM routing)

const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const qr = () => ({ items: HANDS.map(h=>({ type:'action', action:{ type:'message', label:h.toUpperCase(), text:h } })) });

/* ===== Helpers ===== */
async function safeReply(token,msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data||e?.message); } }
async function safePush(to,msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data||e?.message); } }

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin:null,
      phase:'idle',           // idle | register | playing | finished
      stage:'pools',          // pools | ...
      players:new Map(),      // userId -> {name}
      bracket:{
        round:0,
        pools:{A:[],B:[],C:[],D:[]},
        waitingOdd:null
      }
    });
  }
  return rooms.get(gid);
}

/* ===== Flex UI ===== */
function menuFlex(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' },
        { type:'text', text:'เมนูลัด', size:'sm', color:'#888' },
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary',   action:{ type:'message', label:'Join',    text:'janken join' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Close',   text:'janken close' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Status',  text:'janken status' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Reset',   text:'janken reset' } },
      ]},
      footer:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'เลือกหมัดใน DM ได้จาก Quick Reply', size:'xs', color:'#999' }
      ]}
    }
  };
}

// บับเบิลสรุปคู่
function buildFlexRoundPairs(title, lines) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg' },
          { type: 'text', text: nowTH(), size: 'xs', color: '#999' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: lines.map(t => ({ type: 'text', text: t, wrap: true }))
      }
    }
  };
}

// ส่ง Flex แบบแบ่งหน้า (และ fallback เป็นข้อความธรรมดา)
async function tryPushFlexOrText(to, title, lines) {
  const MAX_LINES_PER_BUBBLE = 10;
  const chunks = [];
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_BUBBLE) {
    chunks.push(lines.slice(i, i + MAX_LINES_PER_BUBBLE));
  }
  try {
    for (let i = 0; i < chunks.length; i++) {
      const pageTitle = chunks.length > 1 ? `${title} (หน้า ${i + 1}/${chunks.length})` : title;
      await client.pushMessage(to, [buildFlexRoundPairs(pageTitle, chunks[i])]);
    }
  } catch (err) {
    const text = [title, ...lines].join('\n');
    await safePush(to, { type: 'text', text });
  }
}

/* ===== Seeding / Announce ===== */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };

function seedPoolsFrom(ids){
  const pools = {A:[],B:[],C:[],D:[]};
  const shuffled = shuffle(ids);
  let i=0;
  for (const id of shuffled) { pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) {
    pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{} }));
  }
  return pools;
}

async function announcePoolsRound(gid, room, headText) {
  const lines = [];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i) =>
      lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await tryPushFlexOrText(gid, headText, lines.length ? lines : ['(ไม่มีคู่ในรอบนี้)']);

  // DM ขอมือ
  for (const k of POOLS) for (const m of room.bracket.pools[k]) for (const uid of [m.a,m.b]) if (uid){
    userToGroup.set(uid,gid);
    await safePush(uid, [{
      type:'text',
      text:`📝 รอบสาย ${k} — เลือกหมัด (rock/paper/scissors)`,
      quickReply: qr()
    }]);
  }
}

/* ===== Webhook ===== */
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const e of events) await handleEvent(e);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e);
    res.sendStatus(200);
  }
});

app.get('/', (_req,res)=>res.send('✅ Janken Tournament (Lite) running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('🚀 Server on', PORT));

/* ===== Event Handler ===== */
async function handleEvent(e){
  // DM: รับมือที่เลือก
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const choice = (e.message.text||'').trim().toLowerCase();
    if (!HANDS.includes(choice)) {
      await safeReply(e.replyToken, {type:'text', text:'พิมพ์: rock | paper | scissors', quickReply: qr()});
      return;
    }
    const gid = userToGroup.get(e.source.userId);
    if (!gid || !rooms.has(gid)) { await safeReply(e.replyToken, {type:'text', text:'ยังไม่มีแมตช์รออยู่'}); return; }
    // (เวอร์ชัน lite: เก็บไว้เฉย ๆ ยังไม่ทำตัดสินผลเพื่อโฟกัส bug เดิม)
    await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}`});
    return;
  }

  // Group only
  if (e.type!=='message' || e.message.type!=='text') return;
  if (e.source.type!=='group' && e.source.type!=='supergroup') return;

  const gid = e.source.groupId;
  const txt = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = txt.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  if (c0!=='janken' && c0!=='rps' && c0!=='menu') return;

  if (c0==='menu'){ await safeReply(e.replyToken, menuFlex()); return; }

  const room = ensureRoom(gid);

  // เอาชื่อเล่น
  let displayName = 'Player';
  try {
    const prof = await client.getGroupMemberProfile(gid, e.source.userId);
    if (prof?.displayName) displayName = prof.displayName;
  } catch {}

  const action = (sub||'').toLowerCase();

  switch (action) {

    case 'open': {
      room.admin  = room.admin || e.source.userId;
      room.phase  = 'register';
      room.stage  = 'pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null };
      await safeReply(e.replyToken, [ menuFlex(), {type:'text', text:'🟢 เปิดรับสมัครแล้ว'} ]);
      break;
    }

    case 'join': {
      if (room.phase!=='register') {
        await safeReply(e.replyToken, {type:'text', text:'ยังไม่เปิดรับสมัคร'});
        break;
      }
      const MAX_PLAYERS = 20;
      if (room.players.size >= MAX_PLAYERS) {
        await safeReply(e.replyToken, {type:'text', text:`❌ ทัวร์นาเมนต์เต็มแล้ว (${MAX_PLAYERS} คน)`});
        break;
      }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, {name});
      await safeReply(e.replyToken, {type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX_PLAYERS})`});
      break;
    }

    case 'close': {
      if (room.phase!=='register') {
        await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่ได้เปิดรับสมัคร' });
        break;
      }
      if (room.players.size < 2) {
        await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีอย่างน้อย 2 คน' });
        break;
      }

      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) room.bracket.waitingOdd = ids.pop();
      room.bracket.pools = seedPoolsFrom(ids);   // ✅ ใช้เวอร์ชันที่รับ ids อย่างเดียว
      room.bracket.round = 1;
      room.phase = 'playing';
      room.stage = 'pools';

      // ส่งหัวข้อธรรมดาก่อน (กัน Flex ล้มแล้วเงียบ)
      await safePush(gid, { type: 'text', text: `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})` });

      // ส่งสรุปคู่ (Flex+fallback)
      await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      break;
    }

    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken, {type:'text', text: head});
      break;
    }

    case 'reset': {
      rooms.delete(gid);
      await safeReply(e.replyToken, {type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่'});
      break;
    }

    default: {
      await safeReply(e.replyToken, menuFlex());
      break;
    }
  } // <-- ปิด switch(action) อย่างถูกต้อง
}
