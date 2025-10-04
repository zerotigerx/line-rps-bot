import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const e of events) await handleEvent(e);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e?.message || e);
    return res.sendStatus(200);
  }
});
app.get('/', (_req, res) => res.send('✅ Janken Tournament (with Position & Flex Menu)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server on ' + PORT));

/* ===================== STATE ===================== */
const rooms = new Map();       // groupId -> room
const userToGroup = new Map(); // userId  -> groupId (ต้องมีแมตช์/DM รออยู่)

const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];
const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin:null,
      phase:'idle',           // idle | register | playing | finished
      stage:'pools',          // pools | semis | final | third | finished
      players:new Map(),      // userId -> {name}
      eliminated:new Set(),   // userId ที่ตกรอบ (สำหรับสรุปอันดับรวม)
      bracket:{
        round:0,
        pools:{A:[],B:[],C:[],D:[]}, // [{a,b,state,moves,winner,loser}]
        waitingOdd:null,
        champions:[],               // แชมป์แต่ละสาย หรือผู้ชนะรอบรวมก่อนหน้า
        cross:[],                   // สำหรับรอบ semis/final ใช้ตรงนี้
        finalists:null              // {a,b, winner, loser, state}
      },
      placing:{
        third:null,   // {a,b,state:'pending'|'done',moves:{},winner,loser}
        ranking:[]    // [{userId, place}]
      }
    });
  }
  return rooms.get(gid);
}

/* ===================== HELPERS ===================== */
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const judge = (a,b)=>{ if(!a||!b) return a?'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };
const qr = () => ({
  items: HANDS.map(h=>({ type:'action', action:{ type:'message', label:h.toUpperCase(), text:h } }))
});

async function safeReply(token,msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data||e?.message); } }
async function safePush(to,msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data||e?.message); } }

/* ---- Pool pairing ---- */
function toPairs(ids){ const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; }
function seedPoolsFrom(room, ids){
  const pools = {A:[],B:[],C:[],D:[]};
  const shuffled = shuffle(ids);
  let i=0;
  for (const id of shuffled) {
    pools[POOLS[i%4]].push(id);
    i++;
  }
  for (const k of POOLS) {
    pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  }
  return pools;
}
const allDone = pools => POOLS.every(k => pools[k].every(m => m.state==='done'));
const winnersOf = pools => POOLS.reduce((acc,k)=> (acc[k]=pools[k].map(m=>m.winner).filter(Boolean), acc), {});

/* ---- Announce & DM ---- */
async function announcePoolsRound(gid, room, headText){
  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await safePush(gid, [{type:'text', text:headText}, {type:'text', text:lines.join('\n')||'(ไม่มีคู่)'}]);
  // DM
  for (const k of POOLS) for (const m of room.bracket.pools[k]) for (const uid of [m.a,m.b]) if (uid){
    userToGroup.set(uid,gid);
    await safePush(uid, [{type:'text', text:`📝 รอบสาย ${k} — เลือกหมัด (rock/paper/scissors)` , "quickReply": qr()}]);
  }
}
async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`).join('\n') || '(ไม่มีคู่)';
  await safePush(gid, [{type:'text', text:title}, {type:'text', text:lines}]);
  for (const m of room.bracket.cross) for (const uid of [m.a,m.b]) if (uid){
    userToGroup.set(uid,gid);
    await safePush(uid, [{type:'text', text:`📝 ${title} — เลือกหมัด`, "quickReply": qr()}]);
  }
}

/* ---- Menus ---- */
function flexMenu(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' },
        { type:'text', text:'เมนูด่วน', size:'sm', color:'#888' },
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary', action:{ type:'message', label:'Join', text:'janken join' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Close Reg', text:'janken close' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Status', text:'janken status' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Ranking', text:'janken ranking' } },
        { type:'button', style:'secondary', action:{ type:'message', label:'Reset', text:'janken reset' } },
      ]},
      footer:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'Tip: เลือกหมัดใน DM ได้จาก Quick Reply', size:'xs', color:'#999' }
      ]}
    }
  };
}

/* ===================== EVENT ===================== */
async function handleEvent(e){
  /* ---------- DM: เลือกหมัด ---------- */
  if (e.type==='message' && e.message.type==='text' && e.source.type==='user') {
    const choice = (e.message.text||'').trim().toLowerCase();
    if (!HANDS.includes(choice)) {
      await safeReply(e.replyToken, [{type:'text', text:'พิมพ์: rock | paper | scissors', quickReply: qr()}]);
      return;
    }
    const gid = userToGroup.get(e.source.userId);
    if (!gid || !rooms.has(gid)) { await safeReply(e.replyToken, {type:'text', text:'ยังไม่มีแมตช์รออยู่'}); return; }
    const room = rooms.get(gid);

    // หา match ที่ pending อยู่และมี user นี้
    const markMove = (m, uid) => { m.moves[uid] = choice; };
    let found = false;

    // 1) ใน pools
    if (room.stage==='pools') {
      for (const k of POOLS) {
        for (let i=0;i<room.bracket.pools[k].length;i++){
          const m = room.bracket.pools[k][i];
          if (m.state!=='pending') continue;
          if (m.a===e.source.userId || m.b===e.source.userId) {
            markMove(m, e.source.userId); found = true;
            await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
            await tryCloseMatch_Pools(gid, room, k, i);
            break;
          }
        }
        if (found) break;
      }
      if (found) return;
    }

    // 2) cross (semis/final)
    if (room.stage==='semis' || room.stage==='final') {
      for (let i=0;i<room.bracket.cross.length;i++){
        const m = room.bracket.cross[i];
        if (m.state!=='pending') continue;
        if (m.a===e.source.userId || m.b===e.source.userId) {
          markMove(m, e.source.userId); found = true;
          await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
          await tryCloseMatch_Cross(gid, room, i);
          break;
        }
      }
      if (found) return;
    }

    // 3) third-place
    if (room.stage==='third' && room.placing.third && room.placing.third.state==='pending'){
      const m = room.placing.third;
      if (m.a===e.source.userId || m.b===e.source.userId) {
        markMove(m, e.source.userId);
        await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
        await tryCloseThird(gid, room);
        return;
      }
    }

    await safeReply(e.replyToken, {type:'text', text:'ไม่พบคู่นัดหมายของคุณในรอบนี้'});
    return;
  }

  /* ---------- GROUP: คำสั่งจัดงาน ---------- */
  if (e.type!=='message' || e.message.type!=='text') return;
  if (e.source.type!=='group' && e.source.type!=='supergroup') return;

  const gid = e.source.groupId;
  const txt = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = txt.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  if (c0!=='janken' && c0!=='rps' && c0!=='menu') return;

  // quick menu
  if (c0==='menu'){ await safeReply(e.replyToken, flexMenu()); return; }

  const room = ensureRoom(gid);

  let displayName = 'Player';
  try {
    const prof = await client.getGroupMemberProfile(gid, e.source.userId);
    if (prof?.displayName) displayName = prof.displayName;
  } catch {}

  const action = (sub||'').toLowerCase();

  switch(action){
    case 'open': {
      room.admin = room.admin || e.source.userId;
      room.phase='register'; room.stage='pools';
      room.players = new Map(); room.eliminated = new Set();
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, champions:[], cross:[], finalists:null };
      room.placing = { third:null, ranking:[] };
      await safeReply(e.replyToken, [
        {type:'text', text:`🟢 เปิดรับสมัครแล้ว — แอดมิน: ${displayName}`},
        flexMenu()
      ]);
      break;
    }
    case 'join': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่เปิดรับสมัคร'}); break; }
      const name = (rest.join(' ') || displayName).slice(0,40);
      room.players.set(e.source.userId, {name});
      await safeReply(e.replyToken, [{type:'text', text:`✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size})`}]);
      break;
    }
    case 'close': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size<2) { await safeReply(e.replyToken, {type:'text', text:'ต้องมีอย่างน้อย 2 คน'}); break; }
      // ตัด odd
      const allIds = [...room.players.keys()];
      if (allIds.length % 2 === 1) room.bracket.waitingOdd = allIds.pop();
      // seed pools
      room.bracket.pools = seedPoolsFrom(room, allIds);
      room.bracket.round = 1; room.phase='playing'; room.stage='pools';
      await announcePoolsRound(gid, room, `📣 Match 1 เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      break;
    }
    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      const list = [...room.players.values()].map(p=>`• ${p.name}`).join('\n') || '-';
      await safeReply(e.replyToken, [{type:'text', text:head}, {type:'text', text:list}]);
      break;
    }
    case 'ranking': {
      await showRanking(gid, room, e.replyToken);
      break;
    }
    case 'reset': {
      rooms.delete(gid);
      await safeReply(e.replyToken, {type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่'});
      break;
    }
    case 'menu': {
      await safeReply(e.replyToken, flexMenu());
      break;
    }
    default: {
      await safeReply(e.replyToken, flexMenu());
    }
  }
}

/* ===================== MATCH CLOSERS ===================== */
async function tryCloseMatch_Pools(gid, room, k, idx){
  const m = room.bracket.pools[k][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { // bye
    m.winner=m.a; m.loser=null; m.state='done';
    await safePush(gid, {type:'text', text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.a)} ได้สิทธิ์บาย`});
  } else if (m.b && !m.a) {
    m.winner=m.b; m.loser=null; m.state='done';
    await safePush(gid, {type:'text', text:`✅ สาย ${k} — Match ${idx+1}: ${pretty(room,m.b)} ได้สิทธิ์บาย`});
  } else if (aH && bH) {
    const r = judge(aH,bH);
    if (r==='DRAW') {
      m.moves={};
      for (const uid of [m.a,m.b]) if (uid) await safePush(uid, [{type:'text', text:'เสมอ — เลือกใหม่', quickReply: qr()}]);
      return;
    }
    m.winner = r==='A'? m.a : m.b;
    m.loser  = r==='A'? m.b : m.a;
    m.state='done';
    if (m.loser) room.eliminated.add(m.loser);
    await safePush(gid, {type:'text', text:`✅ สาย ${k} — Match ${idx+1}\n${pretty(room,m.a)} ${EMOJI[aH]}  vs  ${pretty(room,m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room,m.winner)}`});
  } else {
    return; // ยังไม่ครบ
  }

  // รอบ pools เสร็จทั้งสายหรือยัง?
  if (!allDone(room.bracket.pools)) return;

  // สรุปรอบ
  const winners = winnersOf(room.bracket.pools);
  const lines = ['สรุปผลรอบนี้'];
  for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u=>pretty(room,u)).join(', ')}`);
  await safePush(gid, {type:'text', text:lines.join('\n')});

  // ถ้ารอบแรกมี waitingOdd → สร้าง play-in ต้นรอบถัดไป
  if (room.bracket.round===1 && room.bracket.waitingOdd) {
    // รวม winners ของทุกสาย -> flat
    const flat = Object.values(winners).flat();
    // จับคู่รอบถัดไป “ภายในสายเดิม”
    const nextPools = {A:[],B:[],C:[],D:[]};
    for (const kk of POOLS) {
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) nextPools[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending',moves:{},winner:null,loser:null});
    }
    // สร้าง extra play-in: waitingOdd เจอกับผู้ชนะสุ่ม 1 รายจาก flat
    if (flat.length) {
      const picked = flat[Math.floor(Math.random()*flat.length)];
      nextPools.A.unshift({ a: room.bracket.waitingOdd, b: picked, state:'pending', moves:{}, winner:null, loser:null });
      room.bracket.waitingOdd = null;
    }
    room.bracket.pools = nextPools;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // ตรวจว่าภายในสายเหลือผู้ชนะสายละ 1 แล้วหรือยัง
  const eachPoolSingle = POOLS.every(kk => {
    const ws = winners[kk]; return ws.length<=1;
  });

  if (!eachPoolSingle) {
    // ยังต้องแข่งภายในสายต่อ
    const nextPools = {A:[],B:[],C:[],D:[]};
    for (const kk of POOLS) {
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) nextPools[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending',moves:{},winner:null,loser:null});
    }
    room.bracket.pools = nextPools;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // ได้ผู้ชนะประจำสายแล้ว -> ไป cross bracket (Semis) ถ้ามากกว่า 2
  room.bracket.champions = Object.values(winners).flat();
  const champs = room.bracket.champions;
  if (champs.length === 1) {
    // แชมป์ทันที (กรณีพิเศษมาก)
    room.phase='finished'; room.stage='finished';
    const champ = champs[0];
    await safePush(gid, [{type:'text', text:`🏆 แชมป์: ${pretty(room,champ)}`}]);
    await finalizeRanking(gid, room, champ, null, null);
    return;
  }
  if (champs.length === 2) {
    // เข้ารอบชิงทันที
    room.stage='final'; room.bracket.cross = [{ a:champs[0], b:champs[1], state:'pending', moves:{}, winner:null, loser:null }];
    room.bracket.round += 1;
    await announceCrossRound(gid, room, '🏁 นัดชิงชนะเลิศ');
    return;
  }
  // >=3 -> สร้าง Semifinals จาก champions แบบสุ่ม
  const ids = shuffle(champs);
  const semis = [];
  for (let i=0;i<ids.length;i+=2) semis.push({ a:ids[i]||null, b:ids[i+1]||null, state:'pending', moves:{}, winner:null, loser:null });
  room.stage='semis';
  room.bracket.cross = semis;
  room.bracket.round += 1;
  await announceCrossRound(gid, room, '🏁 รอบรองชนะเลิศ');
}

async function tryCloseMatch_Cross(gid, room, idx){
  const m = room.bracket.cross[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { m.winner=m.a; m.loser=null; m.state='done'; await safePush(gid,{type:'text',text:`✅ ${pretty(room,m.a)} ได้สิทธิ์บาย`}); }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; await safePush(gid,{type:'text',text:`✅ ${pretty(room,m.b)} ได้สิทธิ์บาย`}); }
  else if (aH && bH){
    const r = judge(aH,bH);
    if (r==='DRAW'){ m.moves={}; for (const uid of [m.a,m.b]) if (uid) await safePush(uid,[{type:'text',text:'เสมอ — เลือกใหม่',quickReply:qr()}]); return; }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
    if (m.loser) room.eliminated.add(m.loser);
    await safePush(gid,{type:'text', text:`✅ ผลรอบรวม\n${pretty(room,m.a)} ${EMOJI[aH]}  vs  ${pretty(room,m.b)} ${EMOJI[bH]}\nผู้ชนะ: ${pretty(room,m.winner)}`});
  } else return;

  // เช็คว่า semis/final ครบหรือยัง
  const allDoneCross = room.bracket.cross.every(x=>x.state==='done');

  if (room.stage==='semis' && allDoneCross){
    // สร้าง Final + Third
    const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
    const losers  = room.bracket.cross.map(x=>x.loser).filter(Boolean);
    // Final
    room.stage='final';
    room.bracket.cross = [{ a:winners[0]||null, b:winners[1]||null, state:'pending', moves:{}, winner:null, loser:null }];
    // Third place
    if (losers.length>=2){
      room.placing.third = { a:losers[0], b:losers[1], state:'pending', moves:{}, winner:null, loser:null };
      await safePush(gid, [{type:'text', text:'🏁 นัดชิงชนะเลิศเริ่มแล้ว (มีแมตช์ชิงที่ 3 ด้วย)'}]);
    } else {
      await safePush(gid, [{type:'text', text:'🏁 นัดชิงชนะเลิศเริ่มแล้ว'}]);
    }
    // DM
    for (const uid of [room.bracket.cross[0].a, room.bracket.cross[0].b]) if (uid){ userToGroup.set(uid,gid); await safePush(uid,[{type:'text', text:'นัดชิง — เลือกหมัด', quickReply:qr()}]); }
    if (room.placing.third) for (const uid of [room.placing.third.a, room.placing.third.b]) if (uid){ userToGroup.set(uid,gid); await safePush(uid,[{type:'text', text:'ชิงที่ 3 — เลือกหมัด', quickReply:qr()}]); }
  }

  if (room.stage==='final' && allDoneCross){
    // Final เสร็จ 1 แมตช์ (ตัวเดียวใน cross)
    const f = room.bracket.cross[0];
    const champ = f.winner, runner = f.loser;
    await safePush(gid, [{type:'text', text:`🏆 แชมป์: ${pretty(room,champ)}\n🥈 รองแชมป์: ${pretty(room,runner)}` }]);
    // ถ้ามี third ยัง pending -> รอ third ก่อนค่อยสรุปอันดับ
    if (room.placing.third && room.placing.third.state!=='done'){
      room.stage='third';
      await safePush(gid, [{type:'text', text:'ยังเหลือชิงที่ 3 — ขอให้ผู้เล่นเลือกหมัดทาง DM'}]);
      return;
    }
    // ไม่มีชิงที่ 3 -> จบเลย
    room.phase='finished'; room.stage='finished';
    await finalizeRanking(gid, room, champ, runner, null);
  }
}

async function tryCloseThird(gid, room){
  const m = room.placing.third;
  const aH = m.moves[m.a], bH = m.moves[m.b];
  if (!aH || !bH) return;
  const r = judge(aH,bH);
  if (r==='DRAW'){ m.moves={}; for (const uid of [m.a,m.b]) if(uid) await safePush(uid,[{type:'text',text:'เสมอ — เลือกใหม่',quickReply:qr()}]); return; }
  m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  await safePush(gid, [{type:'text', text:`🥉 ที่ 3: ${pretty(room,m.winner)}`}]);

  // ถ้า Final จบแล้วด้วย -> ปิดงานสรุปอันดับ
  const f = room.bracket.cross[0];
  if (f && f.state==='done'){
    room.phase='finished'; room.stage='finished';
    await finalizeRanking(gid, room, f.winner, f.loser, m.winner);
  }
}

/* ===================== RANKING ===================== */
async function finalizeRanking(gid, room, champion, runner, third){
  const ranking = [];
  if (champion) ranking.push({userId: champion, place:1});
  if (runner)   ranking.push({userId: runner,   place:2});
  if (third)    ranking.push({userId: third,    place:3});

  // อื่น ๆ ที่ถูกตัดออกก่อนหน้า: รวมจาก eliminated (ไม่ซ้ำ champion/runner/third)
  const excluded = new Set([champion, runner, third].filter(Boolean));
  const others = [...room.players.keys()].filter(id => !excluded.has(id));
  // จัดเป็นกลุ่มตำแหน่ง (Top-N) ตามจำนวนที่เหลือแบบคร่าว ๆ
  // (ถ้าต้องการ 1..N เป๊ะทุกราย สามารถต่อยอดเพิ่ม Consolation brackets ได้)
  const tail = others.map(id => ({userId:id, place:null}));
  room.placing.ranking = [...ranking, ...tail];

  await showRanking(gid, room, null);
}

async function showRanking(gid, room, replyToken){
  const r = room.placing.ranking;
  if (!r || r.length===0){
    const msg = {type:'text', text:'ยังไม่มีผลอันดับ — แข่งขันให้จบก่อน แล้วสั่ง janken ranking ใหม่'};
    replyToken ? await safeReply(replyToken, msg) : await safePush(gid, msg);
    return;
  }
  const topLines = r
    .filter(x=>x.place)
    .sort((a,b)=>a.place-b.place)
    .map(x=>`${x.place===1?'🏆':x.place===2?'🥈':x.place===3?'🥉':`#${x.place}`} ${pretty(room,x.userId)}`);
  const others = r.filter(x=>!x.place).map(x=>`• ${pretty(room,x.userId)}`);
  const texts = [];
  if (topLines.length) texts.push(topLines.join('\n'));
  if (others.length) texts.push('ผู้เข้าแข่งขันอื่น ๆ:\n' + others.join('\n'));
  const msg = {type:'text', text: texts.join('\n\n') || '—'};
  replyToken ? await safeReply(replyToken, msg) : await safePush(gid, msg);
}
