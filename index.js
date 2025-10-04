// Janken Tournament — Full Feature, Multi-Room Safe
// ✅ ฟีเจอร์หลัก
// - janken open/join/close/status/reset (limit 20)
// - Pools A–D, cross bracket, Flex สรุปแมตช์, DM ปุ่มเลือกหมัดแบบ postback (ระบุชื่อกลุ่ม)
// - janken simulate 16  (คุณร่วมเล่นและกดหมัดใน DM ได้จริง, บอทอื่นสุ่มออกหมัด)
// - janken dm  (ส่งปุ่มเลือกหมัดซ้ำให้ผู้เล่นที่ยังไม่เลือกในกลุ่มปัจจุบัน)
// - ข้อความชม/แซวสุ่มเมื่อผู้เล่นเลือกหมัดใน DM
// - admin tools: janken admin resetme, janken admin purge [groupId]
// หมายเหตุ: เก็บสถานะในหน่วยความจำระหว่างรัน (เหมือนเดิม)

import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials'); process.exit(1);
}

const app = express();
const client = new Client(config);
const PORT = process.env.PORT || 3000;

app.get('/', (_req,res)=>res.send('✅ Janken Tournament running'));
app.post('/webhook', middleware(config), async (req, res) => {
  try { for (const ev of (req.body?.events||[])) await onEvent(ev); res.sendStatus(200); }
  catch(e){ console.error('Webhook error:', e?.response?.data || e?.message || e); res.sendStatus(200); }
});
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));

/* -------------------- STATE -------------------- */
const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];
const PRAISES = [
  h=>`เลือกได้คูลมาก ${EMOJI[h]}! รอคู่ต่อสู้อยู่ฝั่งโน้น…`,
  h=>`โอ้โห ${h.toUpperCase()} มาแบบมั่นใจสุด ๆ ✨`,
  h=>`จังหวะนี้ต้อง ${EMOJI[h]} เท่านั้น! ลุ้นผลในกลุ่มได้เลย`,
  h=>`สกิลอ่านเกมดีมาก 👍 (${h}) เดี๋ยวรู้กันว่าข่มได้ไหม!`,
  h=>`เท่เกินไปแล้ว ${EMOJI[h]} รอประกาศผลในกลุ่มนะ`
];

const rooms = new Map();       // groupId -> room
const groupNameCache = new Map(); // groupId -> name
const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });

const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const judge = (a,b)=>{ if(!a||!b) return a? 'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };

async function gName(gid){
  if (groupNameCache.has(gid)) return groupNameCache.get(gid);
  try { const s = await client.getGroupSummary(gid); if (s?.groupName){ groupNameCache.set(gid,s.groupName); return s.groupName; } }
  catch { /* ignore */ }
  return '(กลุ่มของคุณ)';
}
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const safeReply = async (t,m)=>{ try{ await client.replyMessage(t, Array.isArray(m)?m:[m]); }catch(e){ console.warn('reply fail', e?.response?.data||e?.message); } };
const safePush  = async (to,m)=>{ try{ await client.pushMessage(to, Array.isArray(m)?m:[m]); }catch(e){ console.warn('push fail',  e?.response?.data||e?.message); } };

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid,{
      admin:null, phase:'idle', stage:'pools',
      players:new Map(),
      bracket:{ round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[] }
    });
  }
  return rooms.get(gid);
}

/* -------------------- UI / FLEX -------------------- */
const matchKey = (gid, stage, pool, idx) => `${gid}|${stage}|${pool??'-'}|${idx}`;
const makePost = (gid,stage,pool,idx,hand)=>({ type:'postback', label:`${EMOJI[hand]} ${hand}`, data:`jg|${matchKey(gid,stage,pool,idx)}|${hand}`, displayText:hand });
const qrPost  = (gid,stage,pool,idx)=>({ items: HANDS.map(h=>({ type:'action', action: makePost(gid,stage,pool,idx,h) })) });

const MenuFlex = () => ({
  type:'flex', altText:'Janken Menu',
  contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' }]},
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'button', style:'primary',   action:{ type:'message', label:'Join', text:'janken join' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'Close', text:'janken close' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'Status',text:'janken status' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'Reset', text:'janken reset' } },
    ]}
  }
});

const OpenFlex = () => ({
  type:'flex', altText:'JANKEN เปิดรับสมัคร!',
  contents:{ type:'bubble',
    hero:{ type:'box', layout:'vertical', backgroundColor:'#111', paddingAll:'24px', cornerRadius:'md',
      contents:[
        { type:'text', text:'JANKEN', weight:'bold', size:'3xl', color:'#FFD54F', align:'center' },
        { type:'text', text:'TOURNAMENT', weight:'bold', size:'xl', color:'#FFF', align:'center' },
        { type:'text', text:'เปิดรับสมัครแล้ว!', size:'sm', color:'#BDBDBD', align:'center', margin:'sm' }
      ]
    },
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'พิมพ์  janken join  เพื่อเข้าร่วม', wrap:true },
      { type:'text', text:'รับสูงสุด 20 คน', size:'sm', color:'#666' }
    ]},
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'primary', color:'#FFB74D', action:{ type:'message', label:'เข้าร่วมทันที', text:'janken join' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'ดูเมนู', text:'menu' } }
    ]}
  }
});

const ChoiceFlex = (title,gid,stage,pool,idx)=>({
  type:'flex', altText:title,
  contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:title, weight:'bold', size:'lg' }]},
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'button', style:'primary', action: makePost(gid,stage,pool,idx,'rock') },
      { type:'button', style:'primary', action: makePost(gid,stage,pool,idx,'paper') },
      { type:'button', style:'primary', action: makePost(gid,stage,pool,idx,'scissors') }
    ]},
    footer:{ type:'box', layout:'vertical', contents:[{ type:'text', text:'(แตะปุ่มเพื่อเลือกหมัดได้เลย)', size:'xs', color:'#999' }]}
  }
});

const FlexPairs = (title, lines)=>({
  type:'flex', altText:title,
  contents:{ type:'bubble',
    header:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:title, weight:'bold', size:'lg' },
      { type:'text', text: nowTH(), size:'xs', color:'#999' }
    ]},
    body:{ type:'box', layout:'vertical', spacing:'sm', contents: lines.map(t=>({ type:'text', text:t, wrap:true })) }
  }
});

function ResultFlex(title, aName, aH, bName, bH, win){
  return {
    type:'flex', altText:`${title}: ${win}`,
    contents:{ type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[{ type:'text', text:title, weight:'bold', size:'lg' }]},
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        row(aName, EMOJI[aH]), row(bName, EMOJI[bH]), { type:'separator' },
        { type:'text', text:`ผู้ชนะ: ${win}`, weight:'bold', color:'#2E7D32' }
      ]}
    }
  };
  function row(name, emo){ return { type:'box', layout:'baseline', contents:[
    { type:'text', text:name, size:'md', flex:5, wrap:true },
    { type:'text', text:emo||'', size:'lg', flex:1, align:'end' }
  ]};}
}

async function pushFlexOrText(to, title, lines){
  const chunk = 10;
  if (!lines.length) { await safePush(to, {type:'text',text:title+'\n(ไม่มีคู่ในรอบนี้)'}); return; }
  for (let i=0;i<lines.length;i+=chunk){
    const head = lines.length>chunk ? `${title} (หน้า ${Math.floor(i/chunk)+1}/${Math.ceil(lines.length/chunk)})` : title;
    try { await client.pushMessage(to, [FlexPairs(head, lines.slice(i,i+chunk))]); }
    catch { await safePush(to, { type:'text', text: [head, ...lines.slice(i,i+chunk)].join('\n') }); }
  }
}

/* -------------------- BRACKET UTILS -------------------- */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };
function seedPoolsFrom(ids){
  const pools={A:[],B:[],C:[],D:[]}, sh=shuffle(ids); let i=0;
  for(const id of sh){ pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  return pools;
}
const poolsDone = pools => POOLS.every(k => pools[k].every(m=>m.state==='done'));
const poolWinners = pools => POOLS.reduce((acc,k)=> (acc[k]=pools[k].map(m=>m.winner).filter(Boolean),acc),{});

/* -------------------- ANNOUNCE ROUND -------------------- */
async function announcePools(gid, room, title){
  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await pushFlexOrText(gid, title, lines);

  const name = await gName(gid);
  for (const k of POOLS) {
    room.bracket.pools[k].forEach(async (m,i)=>{
      for (const uid of [m.a,m.b]) if (uid){
        await safePush(uid, [
          { type:'text', text:`📝 รอบสาย ${k} ของทัวร์ “${name}” — เลือกหมัด`, quickReply: qrPost(gid,'pools',k,i) },
          ChoiceFlex('เลือกหมัดสำหรับรอบนี้', gid,'pools',k,i),
          { type:'text', text:`เมื่อเลือกแล้ว รอดูผลในกลุ่ม “${name}” ได้เลย!` }
        ]);
      }
    });
  }
}
async function announceCross(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await pushFlexOrText(gid, title, lines);
  const name = await gName(gid);
  for (const m of room.bracket.cross){
    const idx = room.bracket.cross.indexOf(m);
    for (const uid of [m.a,m.b]) if (uid){
      await safePush(uid, [
        { type:'text', text:`📝 ${title} “${name}” — เลือกหมัด`, quickReply: qrPost(gid,'cross',null,idx) },
        ChoiceFlex('เลือกหมัดสำหรับรอบนี้', gid,'cross',null,idx),
        { type:'text', text:`เลือกเสร็จ รอประกาศผลในกลุ่ม “${name}”` }
      ]);
    }
  }
}

/* -------------------- ADMIN HELPERS -------------------- */
function cleanseRoomOfUser(room, uid){
  let touched = 0;
  if (room.players.has(uid)) { room.players.delete(uid); touched++; }
  for (const k of POOLS){
    room.bracket.pools[k].forEach(m=>{
      if (m.a===uid) { m.a=null; touched++; }
      if (m.b===uid) { m.b=null; touched++; }
      if (m.moves?.[uid]) { delete m.moves[uid]; touched++; }
      if (m.winner===uid) { m.winner=null; touched++; }
      if (m.loser===uid) { m.loser=null; touched++; }
      if (m.state==='done' && !m.winner && (m.a||m.b)) m.state='pending';
    });
  }
  (room.bracket.cross||[]).forEach(m=>{
    if (m.a===uid) { m.a=null; touched++; }
    if (m.b===uid) { m.b=null; touched++; }
    if (m.moves?.[uid]) { delete m.moves[uid]; touched++; }
    if (m.winner===uid) { m.winner=null; touched++; }
    if (m.loser===uid) { m.loser=null; touched++; }
    if (m.state==='done' && !m.winner && (m.a||m.b)) m.state='pending';
  });
  return touched;
}
function resetUserEverywhere(uid){
  let groupsTouched=0, edits=0;
  for (const [, room] of rooms){
    const t = cleanseRoomOfUser(room, uid);
    if (t>0){ groupsTouched++; edits += t; }
  }
  return { groupsTouched, edits };
}

/* -------------------- EVENT -------------------- */
async function onEvent(e){
  // POSTBACK DM
  if (e.type==='postback' && typeof e.postback?.data==='string'){
    const [tag,gid,stage,poolKey,idxStr,hand] = e.postback.data.split('|'); // jg|gid|stage|pool|-|idx|hand
    if (tag!=='jg') return;
    const pool = (poolKey==='-'? null : poolKey);
    const idx  = Number(idxStr);
    const uid  = e.source.userId;
    if (!rooms.has(gid)) return;
    const room = rooms.get(gid);

    const praise = PRAISES[Math.floor(Math.random()*PRAISES.length)]?.(hand) || 'รับทราบแล้ว ✓';
    const name = await gName(gid);

    if (stage==='pools'){
      const m = room.bracket.pools[pool]?.[idx];
      if (m?.state==='pending' && (m.a===uid || m.b===uid)){
        m.moves[uid]=hand;
        await safeReply(e.replyToken, { type:'text', text:`${praise}\n(กลุ่ม “${name}”)` });
        await closePool(gid, room, pool, idx);
      }
    } else if (stage==='cross'){
      const m = room.bracket.cross?.[idx];
      if (m?.state==='pending' && (m.a===uid || m.b===uid)){
        m.moves[uid]=hand;
        await safeReply(e.replyToken, { type:'text', text:`${praise}\n(กลุ่ม “${name}”)` });
        await closeCross(gid, room, idx);
      }
    }
    return;
  }

  // DM message (บังคับใช้ปุ่ม)
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user'){
    const t = (e.message.text||'').trim().toLowerCase();
    if (t==='hello' || t==='hi'){
      await safeReply(e.replyToken, { type:'text', text:'DM ทดสอบจากบอท ✅ (ข้อความนี้แปลว่า DM ส่งถึงคุณปกติ)' });
      return;
    }
    await safeReply(e.replyToken, { type:'text', text:'โปรดแตะปุ่มเลือกหมัดที่ส่งให้ (ระบบใส่ชื่อกลุ่มไว้แล้ว) เพื่อป้องกันสับสนเวลาเล่นหลายทัวร์พร้อมกันครับ 🙏' });
    return;
  }

  // group only
  if (e.type!=='message' || e.message.type!=='text') return;
  if (e.source.type!=='group' && e.source.type!=='supergroup') return;

  const gid = e.source.groupId;
  const room = ensureRoom(gid);
  const text = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  const action = (sub||'').toLowerCase();

  if (c0==='menu'){ await safeReply(e.replyToken, MenuFlex()); return; }
  if (c0!=='janken' && c0!=='rps') return;

  let displayName='Player';
  try{ const prof=await client.getGroupMemberProfile(gid, e.source.userId); if (prof?.displayName) displayName=prof.displayName; }catch{}

  // ADMIN
  if (action==='admin'){
    const subcmd = (rest[0]||'').toLowerCase();
    if (subcmd==='resetme'){
      const {groupsTouched,edits}=resetUserEverywhere(e.source.userId);
      await safeReply(e.replyToken,{ type:'text', text:`✅ เคลียร์ข้อมูลของคุณแล้ว\n• กลุ่มที่แตะ: ${groupsTouched}\n• รายการที่แก้ไข: ${edits}\nลองเริ่มใหม่หรือสั่ง janken dm เพื่อรับปุ่มอีกครั้งได้ครับ`});
      return;
    }
    if (subcmd==='purge'){
      const target = rest[1] || gid;
      if (!rooms.has(target)){ await safeReply(e.replyToken,{type:'text',text:`ไม่พบทัวร์ใน ${target}`}); return; }
      const r = rooms.get(target);
      if (r.admin && r.admin!==e.source.userId){ await safeReply(e.replyToken,{type:'text',text:'คุณไม่ใช่ผู้ดูแลของทัวร์นี้'}); return; }
      rooms.delete(target);
      await safeReply(e.replyToken,{type:'text',text:`🧹 Purged tournament in ${target} ✓`});
      return;
    }
    await safeReply(e.replyToken,{ type:'text', text:'admin commands:\n- janken admin resetme\n- janken admin purge [groupId]' });
    return;
  }

  // RESEND DM BUTTONS (เฉพาะกลุ่มนี้)
  if (action==='dm'){
    const name = await gName(gid);
    let sent = 0;
    // pools
    for (const k of POOLS) {
      room.bracket.pools[k].forEach((m,i)=>{
        for (const uid of [m.a,m.b]) if (uid && !m.moves[uid]){
          sent++;
          safePush(uid, [
            { type:'text', text:`ส่งปุ่มเลือกหมัดให้ใหม่แล้ว (สาย ${k} – กลุ่ม “${name}”)`, quickReply: qrPost(gid,'pools',k,i) },
            ChoiceFlex('เลือกหมัดสำหรับรอบนี้', gid,'pools',k,i)
          ]);
        }
      });
    }
    // cross
    (room.bracket.cross||[]).forEach((m,i)=>{
      for (const uid of [m.a,m.b]) if (uid && !m.moves[uid]){
        sent++;
        safePush(uid, [
          { type:'text', text:`ส่งปุ่มเลือกหมัดให้ใหม่แล้ว (รอบรวม – กลุ่ม “${name}”)`, quickReply: qrPost(gid,'cross',null,i) },
          ChoiceFlex('เลือกหมัดสำหรับรอบนี้', gid,'cross',null,i)
        ]);
      }
    });
    await safeReply(e.replyToken,{ type:'text', text: sent? `ส่งปุ่มใน DM แล้ว ${sent} รายการ` : 'ยังไม่พบผู้เล่นที่ค้างการเลือกหมัด' });
    return;
  }

  switch(action){
    case 'open': {
      room.admin = room.admin || e.source.userId;
      room.phase='register'; room.stage='pools';
      room.players = new Map();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, cross:[] };

      const name = await gName(gid);
      await safePush(gid, { type:'text', text:[
        `🎌✨ JANKEN TOURNAMENT เริ่มแล้ว! (กลุ่ม “${name}”)`,
        'พิมพ์  janken join  เพื่อเข้าร่วม (รับสูงสุด 20 คน)',
        'ครบแล้วผู้ดูแลพิมพ์  janken close  เพื่อเริ่มแข่ง'
      ].join('\n')});
      await safePush(gid, OpenFlex());
      await safeReply(e.replyToken, [MenuFlex(), {type:'text', text:'🟢 เปิดรับสมัครแล้ว'}]);
      break;
    }

    case 'join': {
      if (room.phase!=='register'){ await safeReply(e.replyToken,{type:'text',text:'ยังไม่เปิดรับสมัคร'}); break; }
      const MAX=20;
      if (room.players.size>=MAX){ await safeReply(e.replyToken,{type:'text',text:`❌ เต็มแล้ว (${MAX} คน)`}); break; }
      const name = (rest.join(' ')||displayName).slice(0,40);
      room.players.set(e.source.userId,{name});
      await safeReply(e.replyToken,{ type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX})` });
      break;
    }

    case 'close': {
      if (room.phase!=='register'){ await safeReply(e.replyToken,{type:'text',text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size<2){ await safeReply(e.replyToken,{type:'text',text:'ต้องมีอย่างน้อย 2 คน'}); break; }

      const ids=[...room.players.keys()];
      if (ids.length%2===1) room.bracket.waitingOdd=ids.pop();
      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1; room.phase='playing'; room.stage='pools';

      const name = await gName(gid);
      await safePush(gid,{type:'text',text:`📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`});
      await announcePools(gid, room, `📣 Match ${room.bracket.round}`);
      await safePush(gid,{type:'text',text:`📩 กรุณาเช็ค DM เพื่อเลือกหมัด (กลุ่ม “${name}”)`});
      break;
    }

    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัคร: ${room.players.size} คน`
                : room.phase==='playing'  ? `🎮 แข่งอยู่ — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken,{type:'text',text:head});
      break;
    }

    case 'reset': {
      rooms.delete(gid);
      await safeReply(e.replyToken,{type:'text',text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่'});
      break;
    }

    // SIMULATE 16 (คุณร่วมเล่นและกดจริง)
    case 'simulate': {
      // เตรียมห้องใหม่
      rooms.delete(gid);
      const r = ensureRoom(gid);
      r.admin = e.source.userId;
      r.phase='playing'; r.stage='pools'; r.bracket.round=1;

      // เพิ่มคุณ + 15 mock
      const me = e.source.userId;
      const mocks = Array.from({length:15}, (_,i)=>`mock-${i+1}`);
      r.players.set(me, { name: displayName });
      mocks.forEach((id,i)=> r.players.set(id, { name: `Player${i+1}` }));

      const ids=[...r.players.keys()];
      r.bracket.pools = seedPoolsFrom(ids);
      await safePush(gid,{type:'text',text:'🧪 เริ่มจำลอง (Placement ครบ 16) — ผู้เล่น 16 คน'});
      await announcePools(gid, r, '📣 รอบ 16 ทีม (Main Bracket)');

      // ส่งหมัดให้บอทสุ่ม (mock) อัตโนมัติ
      for (const k of POOLS) {
        r.bracket.pools[k].forEach((m,i)=>{
          for (const uid of [m.a,m.b]) if (uid && uid.startsWith('mock-')){
            m.moves[uid] = HANDS[Math.floor(Math.random()*3)];
          }
          // ถ้าทั้งคู่ mock และเลือกครบแล้วก็ปิดแมตช์ทันที
          setTimeout(()=>closePool(gid, r, k, i), 300);
        });
      }
      const name = await gName(gid);
      await safePush(gid,{type:'text',text:`📩 ถ้าใครไม่ได้รับ DM ให้พิมพ์ "janken dm" เพื่อรับปุ่มอีกครั้ง (กลุ่ม “${name}”)`});
      break;
    }

    default:
      await safeReply(e.replyToken, MenuFlex());
  }
}

/* -------------------- RESOLVE MATCHES -------------------- */
async function closePool(gid, room, k, idx){
  const m = room.bracket.pools[k][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; await safePush(gid,{type:'text',text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.a)} ได้สิทธิ์บาย`}); }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; await safePush(gid,{type:'text',text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.b)} ได้สิทธิ์บาย`}); }
  else if (aH && bH){
    const r = judge(aH,bH);
    if (r==='DRAW'){
      m.moves={};
      const name=await gName(gid);
      for (const uid of [m.a,m.b]) if (uid){
        await safePush(uid,[
          { type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${name}”)`, quickReply: qrPost(gid,'pools',k,idx) },
          ChoiceFlex('เลือกใหม่อีกครั้ง', gid,'pools',k,idx)
        ]);
      }
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
    try { await client.pushMessage(gid,[ ResultFlex(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
    catch { await safePush(gid,{type:'text',text:`สาย ${k} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]} vs ${pretty(room,m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room,m.winner)}`}); }
  } else return;

  if (!poolsDone(room.bracket.pools)) return;

  // รอบถัดไปใน pools
  const winners = poolWinners(room.bracket.pools);
  const lines=[]; for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u=>pretty(room,u)).join(', ')}`);
  await pushFlexOrText(gid, 'สรุปผลรอบนี้', lines);

  // กรณีเลขคี่ มี waitingOdd
  if (room.bracket.round===1 && room.bracket.waitingOdd){
    const flat = Object.values(winners).flat();
    if (flat.length){
      const picked = flat[Math.floor(Math.random()*flat.length)];
      room.bracket.pools = {A:[{a:room.bracket.waitingOdd,b:picked,state:'pending',moves:{},winner:null,loser:null}],B:[],C:[],D:[]};
      room.bracket.waitingOdd=null;
      room.bracket.round += 1;
      await announcePools(gid, room, `📣 รอบที่ ${room.bracket.round}`);
      return;
    }
  }

  // ถ้ายังมีหลายคนในแต่ละสาย จับคู่ต่อ
  const eachSingle = POOLS.every(kk=> winners[kk].length<=1);
  if (!eachSingle){
    const next={A:[],B:[],C:[],D:[]};
    for (const kk of POOLS){
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) next[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending', moves:{}, winner:null, loser:null});
    }
    room.bracket.pools=next; room.bracket.round+=1;
    await announcePools(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // เหลือแชมป์แต่ละสาย -> ไปรอบ cross
  const champs = Object.values(winners).flat();
  if (champs.length===1){
    await safePush(gid,{type:'text',text:`🏆 แชมป์: ${pretty(room,champs[0])}`});
    room.phase='finished'; room.stage='finished';
    return;
  }

  const ids = shuffle(champs);
  room.stage='cross';
  room.bracket.cross = toPairs(ids).map(([a,b])=>({a,b,state:'pending',moves:{},winner:null,loser:null}));
  room.bracket.round += 1;
  await announceCross(gid, room, '🏁 รอบรวม (ข้ามสาย)');
}

async function closeCross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH=m.moves[m.a], bH=m.moves[m.b];

  if (m.a && !m.b){ m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r=judge(aH,bH);
    if (r==='DRAW'){
      m.moves={};
      const name=await gName(gid);
      for (const uid of [m.a,m.b]) if (uid){
        await safePush(uid,[
          { type:'text', text:`เสมอ — เลือกใหม่ (กลุ่ม “${name}”)`, quickReply: qrPost(gid,'cross',null,idx) },
          ChoiceFlex('เลือกใหม่อีกครั้ง', gid,'cross',null,idx)
        ]);
      }
      return;
    }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  try { await client.pushMessage(gid,[ ResultFlex('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]); }
  catch { await safePush(gid,{type:'text',text:`ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]||''} vs ${pretty(room,m.b)} ${EMOJI[bH]||''}\nผู้ชนะ: ${pretty(room,m.winner)}`}); }

  const done = room.bracket.cross.every(x=>x.state==='done');
  if (!done) return;

  const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
  if (winners.length===1){
    await safePush(gid,{type:'text',text:`🏆 แชมป์: ${pretty(room,winners[0])}`});
    room.phase='finished'; room.stage='finished';
    return;
  }
  room.bracket.cross = toPairs(winners).map(([a,b])=>({a,b,state:'pending',moves:{},winner:null,loser:null}));
  room.bracket.round += 1;
  await announceCross(gid, room, `🏁 รอบรวม (รอบที่ ${room.bracket.round})`);
}
