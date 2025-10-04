import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

/* ====== (Optional) Supabase for persistent stats ====== */
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('📦 Supabase enabled');
  } catch (e) {
    console.warn('Supabase not available:', e?.message || e);
  }
}

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

app.get('/', (_req, res) => res.send('✅ Janken Tournament — Consolation + Flex + Stats Ready'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server on ' + PORT));

/* =============== STATE & UTILS =============== */
const rooms = new Map();       // groupId -> room
const userToGroup = new Map(); // userId  -> groupId (DM routing while a match is pending)

const HANDS = ['rock','paper','scissors'];
const EMOJI = { rock:'✊', paper:'✋', scissors:'✌️' };
const POOLS = ['A','B','C','D'];
const nowTH = () => new Date().toLocaleString('th-TH', { hour12:false });

const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]];} return x; };
const pretty = (room,uid)=> uid ? (room.players.get(uid)?.name || '(?)') : '— Bye —';
const judge = (a,b)=>{ if(!a||!b) return a?'A':'B'; if(a===b) return 'DRAW'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[a]===b?'A':'B'; };
const qr = () => ({ items: HANDS.map(h=>({ type:'action', action:{ type:'message', label:h.toUpperCase(), text:h } })) });

async function safeReply(token,msgs){ try{ await client.replyMessage(token, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('reply fail', e?.response?.data||e?.message); } }
async function safePush(to,msgs){ try{ await client.pushMessage(to, Array.isArray(msgs)?msgs:[msgs]); }catch(e){ console.warn('push fail', e?.response?.data||e?.message); } }

function ensureRoom(gid){
  if (!rooms.has(gid)) {
    rooms.set(gid, {
      admin:null,
      phase:'idle',           // idle | register | playing | finished
      stage:'pools',          // pools | semis | final | third | placing | finished
      players:new Map(),      // userId -> {name}
      eliminatedByRound: {},  // roundKey -> Set<userId> (ใช้ทำ consolation)
      bracket:{
        round:0,
        pools:{A:[],B:[],C:[],D:[]}, // [{a,b,state,moves,winner,loser}]
        waitingOdd:null,
        champions:[],               // แชมป์จากสาย (ก่อน cross)
        cross:[],                   // รอบ semis/final (array of matches)
      },
      placing:{                 // สายจัดอันดับ (consolation) — สร้างหลัง Final
        groups: [],             // [{label:'5-8', matches:[{a,b,...}, ...]}, ...]
        finished:false
      },
      results:{ champion:null, runner:null, third:null, ranking:[] }
    });
  }
  return rooms.get(gid);
}

/* =============== FLEX UI =============== */
function flexMenu(){
  return {
    type:'flex', altText:'Janken Menu',
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'🎌 Janken Tournament', weight:'bold', size:'lg' },
        { type:'text', text:'เมนูลัด', size:'sm', color:'#888' },
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

function flexRoundPairs(title, pairsLines){
  return {
    type:'flex', altText:title,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:title, weight:'bold', size:'lg' },
        { type:'text', text: nowTH(), size:'xs', color:'#999' }
      ]},
      body:{ type:'box', layout:'vertical', spacing:'sm', contents: pairsLines.map(t=>({ type:'text', text:t, wrap:true })) }
    }
  };
}

function flexMatchResult(title, aName, aHand, bName, bHand, winnerName){
  return {
    type:'flex', altText:title,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:title, weight:'bold', size:'lg' }
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:`${aName}`, weight:'bold', wrap:true },
          { type:'text', text:`${bName}`, weight:'bold', align:'end', wrap:true }
        ]},
        { type:'box', layout:'horizontal', contents:[
          { type:'text', text:`${aHand?EMOJI[aHand]:''} ${aHand?.toUpperCase()||''}`, color:'#666' },
          { type:'text', text:`${bHand?EMOJI[bHand]:''} ${bHand?.toUpperCase()||''}`, color:'#666', align:'end' },
        ]},
        { type:'separator' },
        { type:'text', text:`ผู้ชนะ: ${winnerName}`, weight:'bold' }
      ]}
    }
  };
}

/* =============== SEEDING & ANNOUNCE =============== */
const toPairs = ids => { const out=[]; for(let i=0;i<ids.length;i+=2) out.push([ids[i]||null, ids[i+1]||null]); return out; };

function seedPoolsFrom(ids){
  const pools = {A:[],B:[],C:[],D:[]};
  const shuffled = shuffle(ids);
  let i=0;
  for (const id of shuffled) { pools[POOLS[i%4]].push(id); i++; }
  for (const k of POOLS) {
    pools[k] = toPairs(pools[k]).map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
  }
  return pools;
}

const allDone = pools => POOLS.every(k => pools[k].every(m => m.state==='done'));
const winnersOf = pools => POOLS.reduce((acc,k)=> (acc[k]=pools[k].map(m=>m.winner).filter(Boolean), acc), {});

async function announcePoolsRound(gid, room, headText){
  const lines=[];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m,i)=> lines.push(`  Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`));
  }
  await safePush(gid, [ flexRoundPairs(headText, lines) ]);
  // DM
  for (const k of POOLS) for (const m of room.bracket.pools[k]) for (const uid of [m.a,m.b]) if (uid){
    userToGroup.set(uid,gid);
    await safePush(uid, [{type:'text', text:`📝 รอบสาย ${k} — เลือกหมัด (rock/paper/scissors)`, quickReply: qr()}]);
  }
}

async function announceCrossRound(gid, room, title){
  const lines = room.bracket.cross.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
  await safePush(gid, [ flexRoundPairs(title, lines) ]);
  for (const m of room.bracket.cross) for (const uid of [m.a,m.b]) if (uid){
    userToGroup.set(uid,gid);
    await safePush(uid, [{type:'text', text:`📝 ${title} — เลือกหมัด`, quickReply: qr()}]);
  }
}

/* =============== DB LOGGING (optional) =============== */
async function logMatch(gid, stage, a, aHand, b, bHand, winner, loser){
  if (!supabase) return;
  try {
    await supabase.from('janken_matches').insert({
      group_id: gid,
      stage,
      a_user: a, a_hand: aHand || null,
      b_user: b, b_hand: bHand || null,
      winner, loser,
      created_at: new Date().toISOString()
    });
  } catch (e) { console.warn('logMatch failed', e?.message || e); }
}
async function logFinalRanking(gid, ranking){
  if (!supabase) return;
  try {
    await supabase.from('janken_rankings').insert({
      group_id: gid,
      ranking_json: ranking,
      created_at: new Date().toISOString()
    });
  } catch (e) { console.warn('logRanking failed', e?.message || e); }
}

/* =============== EVENT =============== */
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

    const markMove = (m, uid) => { m.moves[uid] = choice; };

    // Pools
    if (room.stage==='pools') {
      for (const k of POOLS) {
        for (let i=0;i<room.bracket.pools[k].length;i++){
          const m = room.bracket.pools[k][i];
          if (m.state!=='pending') continue;
          if (m.a===e.source.userId || m.b===e.source.userId) {
            markMove(m, e.source.userId);
            await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
            await tryCloseMatch_Pools(gid, room, k, i);
            return;
          }
        }
      }
    }

    // Cross (semis/final)
    if (room.stage==='semis' || room.stage==='final') {
      for (let i=0;i<room.bracket.cross.length;i++){
        const m = room.bracket.cross[i];
        if (m.state!=='pending') continue;
        if (m.a===e.source.userId || m.b===e.source.userId) {
          markMove(m, e.source.userId);
          await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
          await tryCloseMatch_Cross(gid, room, i);
          return;
        }
      }
    }

    // Placement / Third / etc.
    if (room.stage==='third' && room.placing.third?.state==='pending'){
      const m = room.placing.third;
      if (m.a===e.source.userId || m.b===e.source.userId) {
        markMove(m, e.source.userId);
        await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
        await tryCloseThird(gid, room);
        return;
      }
    }
    if (room.stage==='placing') {
      for (const g of room.placing.groups) {
        for (let i=0;i<g.matches.length;i++){
          const m = g.matches[i];
          if (m.state!=='pending') continue;
          if (m.a===e.source.userId || m.b===e.source.userId) {
            markMove(m, e.source.userId);
            await safeReply(e.replyToken, {type:'text', text:`บันทึกแล้ว: ${choice.toUpperCase()} ${EMOJI[choice]}\nรอผลในกลุ่ม...`});
            await tryClosePlacement(gid, room, g, i);
            return;
          }
        }
      }
    }

    await safeReply(e.replyToken, {type:'text', text:'ไม่พบคู่นัดหมายของคุณในรอบนี้'});
    return;
  }

  /* ---------- GROUP: คำสั่ง ---------- */
  if (e.type!=='message' || e.message.type!=='text') return;
  if (e.source.type!=='group' && e.source.type!=='supergroup') return;

  const gid = e.source.groupId;
  const txt = (e.message.text||'').trim();
  const [cmd, sub, ...rest] = txt.split(/\s+/);
  const c0 = (cmd||'').toLowerCase();
  if (c0!=='janken' && c0!=='rps' && c0!=='menu') return;

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
      room.players = new Map(); room.eliminatedByRound = {};
      room.bracket = { round:0, pools:{A:[],B:[],C:[],D:[]}, waitingOdd:null, champions:[], cross:[] };
      room.placing = { groups:[], finished:false };
      room.results = { champion:null, runner:null, third:null, ranking:[] };
      await safeReply(e.replyToken, [ flexMenu(), {type:'text', text:`🟢 เปิดรับสมัครแล้ว — แอดมิน: ${displayName}`} ]);
      break;
    }
      case 'join': {
        if (room.phase !== 'register') {
          await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่เปิดรับสมัคร' });
          break;
        }
      
        // จำกัดจำนวนผู้เล่นสูงสุด 20 คน
        const MAX_PLAYERS = 20;
        if (room.players.size >= MAX_PLAYERS) {
          await safeReply(e.replyToken, {
            type: 'text',
            text: `❌ ขอโทษครับ ทัวร์นาเมนต์นี้เต็มแล้ว (${MAX_PLAYERS} คน)`
          });
          break;
        }
      
        const name = (rest.join(' ') || displayName).slice(0, 40);
        room.players.set(e.source.userId, { name });
        await safeReply(e.replyToken, [{
          type: 'text',
          text: `✅ เข้าร่วมแล้ว: ${name} (รวม ${room.players.size}/${MAX_PLAYERS})`
        }]);
        break;
      }
    case 'close': {
      if (room.phase!=='register') { await safeReply(e.replyToken, {type:'text', text:'ยังไม่ได้เปิดรับสมัคร'}); break; }
      if (room.players.size<2) { await safeReply(e.replyToken, {type:'text', text:'ต้องมีอย่างน้อย 2 คน'}); break; }
      const ids = [...room.players.keys()];
      if (ids.length % 2 === 1) room.bracket.waitingOdd = ids.pop();
      room.bracket.pools = seedPoolsFrom(ids);
      room.bracket.round = 1; room.phase='playing'; room.stage='pools';
      await announcePoolsRound(gid, room, `📣 Match 1 เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
      break;
    }
    case 'status': {
      const head = room.phase==='register' ? `📝 เปิดรับสมัครอยู่: ${room.players.size} คน`
                : room.phase==='playing' ? `🎮 กำลังแข่ง — รอบที่ ${room.bracket.round} [${room.stage}]`
                : room.phase==='finished' ? `🏁 จบการแข่งขันแล้ว` : '—';
      await safeReply(e.replyToken, [{type:'text', text: head}]);
      break;
    }
    case 'ranking': {
      await showRanking(gid, room, e.replyToken);
      break;
    }
    case 'place': {  // เริ่มสายจัดอันดับ (ถ้ายัง)
      if (room.stage!=='finished' && room.stage!=='placing') { await safeReply(e.replyToken, {type:'text', text:'เริ่มจัดอันดับได้หลังรอบชิง หรือสั่งหลังบอทประกาศผล'}); break; }
      if (room.stage!=='placing') { await startPlacement(gid, room); }
      else { await safeReply(e.replyToken, {type:'text', text:'กำลังทำสายจัดอันดับอยู่แล้ว'}); }
      break;
    }
    case 'reset': {
      rooms.delete(gid);
      await safeReply(e.replyToken, {type:'text', text:'♻️ รีเซ็ตแล้ว — janken open เพื่อเริ่มใหม่'});
      break;
    }
    default: {
      await safeReply(e.replyToken, flexMenu());
    }
  }
}

/* =============== MATCH CLOSERS (Pools / Cross / Third) =============== */
async function tryCloseMatch_Pools(gid, room, k, idx){
  const m = room.bracket.pools[k][idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { m.winner=m.a; m.loser=null; m.state='done';
    await safePush(gid, [ flexMatchResult(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    await logMatch(gid, `pool-${k}`, m.a, aH, m.b, bH, m.winner, m.loser);
  } else if (m.b && !m.a) { m.winner=m.b; m.loser=null; m.state='done';
    await safePush(gid, [ flexMatchResult(`สาย ${k} — Match ${idx+1}`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    await logMatch(gid, `pool-${k}`, m.a, aH, m.b, bH, m.winner, m.loser);
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
    const title = `สาย ${k} — Match ${idx+1}`;
    await safePush(gid, [ flexMatchResult(title, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
    await logMatch(gid, `pool-${k}`, m.a, aH, m.b, bH, m.winner, m.loser);
  } else return;

  // เก็บผู้แพ้ตามรอบ (ไว้ทำ consolation)
  if (m.loser) {
    const key = `pools-${room.bracket.round}`;
    room.eliminatedByRound[key] ??= new Set();
    room.eliminatedByRound[key].add(m.loser);
  }

  if (!allDone(room.bracket.pools)) return;

  const winners = winnersOf(room.bracket.pools);
  const lines = [];
  for (const kk of POOLS) if (winners[kk].length) lines.push(`สาย ${kk}: ${winners[kk].map(u=>pretty(room,u)).join(', ')}`);
  await safePush(gid, [ flexRoundPairs('สรุปผลรอบนี้ (Pools)', lines) ]);

  // รอบแรกมี waitingOdd → ทำ play-in ต้นรอบถัดไป
  if (room.bracket.round===1 && room.bracket.waitingOdd) {
    const flat = Object.values(winners).flat();
    const nextPools = {A:[],B:[],C:[],D:[]};
    for (const kk of POOLS) {
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) nextPools[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending',moves:{},winner:null,loser:null});
    }
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

  // ยังเหลือมากกว่า 1 ในบางสาย → สู้ต่อภายในสาย
  const moreInPools = POOLS.some(kk => winners[kk].length>1);
  if (moreInPools) {
    const next = {A:[],B:[],C:[],D:[]};
    for (const kk of POOLS) {
      const ws = winners[kk];
      for (let i=0;i<ws.length;i+=2) next[kk].push({a:ws[i]||null, b:ws[i+1]||null, state:'pending',moves:{},winner:null,loser:null});
    }
    room.bracket.pools = next;
    room.bracket.round += 1;
    await announcePoolsRound(gid, room, `📣 รอบที่ ${room.bracket.round}`);
    return;
  }

  // ได้แชมป์สายแล้ว → เข้ารอบรวม (Semis หรือ Final)
  room.bracket.champions = Object.values(winners).flat();
  const champs = room.bracket.champions;
  if (champs.length === 1) { // แชมป์ทันที (เคสพิเศษ)
    room.results.champion = champs[0];
    room.phase='finished'; room.stage='finished';
    await safePush(gid, [{type:'text', text:`🏆 แชมป์: ${pretty(room, champs[0])}`}]);
    await finalizeAndShowRanking(gid, room);
    return;
  }
  if (champs.length === 2) {
    room.stage='final';
    room.bracket.cross = [{ a:champs[0], b:champs[1], state:'pending', moves:{}, winner:null, loser:null }];
    room.bracket.round += 1;
    await announceCrossRound(gid, room, '🏁 นัดชิงชนะเลิศ');
    return;
  }

  // >=3 → สร้าง Semifinals (สุ่ม)
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

  if (m.a && !m.b) { m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH){
    const r = judge(aH,bH);
    if (r==='DRAW'){ m.moves={}; for (const uid of [m.a,m.b]) if (uid) await safePush(uid,[{type:'text',text:'เสมอ — เลือกใหม่',quickReply:qr()}]); return; }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  await safePush(gid, [ flexMatchResult('ผลรอบรวม', pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
  await logMatch(gid, room.stage, m.a, aH, m.b, bH, m.winner, m.loser);

  const allDoneCross = room.bracket.cross.every(x=>x.state==='done');

  if (room.stage==='semis' && allDoneCross){
    const winners = room.bracket.cross.map(x=>x.winner).filter(Boolean);
    const losers  = room.bracket.cross.map(x=>x.loser).filter(Boolean);
    // Final
    room.stage='final';
    room.bracket.cross = [{ a:winners[0]||null, b:winners[1]||null, state:'pending', moves:{}, winner:null, loser:null }];
    await announceCrossRound(gid, room, '🏁 นัดชิงชนะเลิศ');
    // Third (ชิงที่ 3)
    if (losers.length>=2){
      room.placing.third = { a:losers[0], b:losers[1], state:'pending', moves:{}, winner:null, loser:null };
      for (const uid of [losers[0], losers[1]]) { userToGroup.set(uid,gid); await safePush(uid,[{type:'text', text:'ชิงที่ 3 — เลือกหมัด', quickReply:qr()}]); }
    }
  }

  if (room.stage==='final' && allDoneCross){
    const f = room.bracket.cross[0];
    room.results.champion = f.winner;
    room.results.runner   = f.loser;
    await safePush(gid, [{type:'text', text:`🏆 แชมป์: ${pretty(room,f.winner)}\n🥈 รองแชมป์: ${pretty(room,f.loser)}`}]);

    // ถ้ามี third ยังไม่เสร็จ → รอ
    if (room.placing.third && room.placing.third.state!=='done'){
      room.stage='third';
      await safePush(gid, [{type:'text', text:'ยังเหลือชิงที่ 3 — รอผล'}]);
      return;
    }
    // ไม่มีชิงที่ 3 → ไปทำอันดับเลย
    room.stage='finished'; room.phase='finished';
    await finalizeAndShowRanking(gid, room);
  }
}

async function tryCloseThird(gid, room){
  const m = room.placing.third;
  const aH = m.moves[m.a], bH = m.moves[m.b];
  if (!aH || !bH) return;
  const r = judge(aH,bH);
  if (r==='DRAW'){ m.moves={}; for (const uid of [m.a,m.b]) if(uid) await safePush(uid,[{type:'text',text:'เสมอ — เลือกใหม่',quickReply:qr()}]); return; }
  m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  room.results.third = m.winner;
  await safePush(gid, [{type:'text', text:`🥉 ที่ 3: ${pretty(room,m.winner)}`}]);
  if (room.stage!=='finished'){
    room.stage='finished'; room.phase='finished';
    await finalizeAndShowRanking(gid, room);
  }
}

/* =============== CONSOLATION (Placement Brackets) =============== */
/** หลักการ:
 *  - รวมผู้ที่ไม่ใช่ 1–3 ทั้งหมด → แบ่งเป็นกลุ่มตามรอบที่ตกรอบ (ลึกกว่าคะแนนดีกว่า)
 *  - ทุกกลุ่มจะ "เล่น mini-bracket" ในตัวเอง เพื่อเรียงลำดับละเอียด
 *  - กลุ่มเล็ก (2/4/8) จะจบไว; กลุ่มขนาดไม่พอดี 2^k จะมี BYE อัตโนมัติ
 */
function makeBracketFromList(ids){
  // เติม null ให้ขนาดเป็น power-of-two (สำหรับ BYE)
  let size = 1; while (size < ids.length) size <<= 1;
  const padded = [...ids, ...Array(size-ids.length).fill(null)];
  const pairs = toPairs(padded);
  return pairs.map(([a,b])=>({ a,b,state:'pending',moves:{},winner:null,loser:null }));
}

async function startPlacement(gid, room){
  const everyone = [...room.players.keys()];
  const top3 = new Set([room.results.champion, room.results.runner, room.results.third].filter(Boolean));
  const others = everyone.filter(id => !top3.has(id));

  // จัดกลุ่มตามความลึกของรอบที่แพ้ (key ยิ่งใหญ่ = ตกรอบช้ากว่า = อันดับดีกว่า)
  const keys = Object.keys(room.eliminatedByRound).sort((a,b)=>{
    const [pa,ra] = a.split('-'); const [pb,rb] = b.split('-');
    if (pa===pb) return parseInt(rb,10)-parseInt(ra,10); // รอบเลขมากกว่า = ดีกว่า
    // pools < semis < final (ตัวเลขใน cross log ใช้ stage เป็น 'semis'/'final')
    const order = {pools:1, semis:2, final:3};
    return order[pb]-order[pa];
  });

  const groups = [];
  for (const k of keys) {
    const list = [...(room.eliminatedByRound[k]||[])].filter(x=>!top3.has(x));
    if (!list.length) continue;
    groups.push({ label: `Placement (${k})`, matches: makeBracketFromList(list) });
  }
  // ถ้าไม่มีใครเลย (เช่นผู้เล่นน้อย) ก็ข้าม
  if (!groups.length) {
    await finalizeAndShowRanking(gid, room);
    return;
  }

  room.stage='placing';
  room.placing.groups = groups;
  // ประกาศและ DM
  for (const g of groups) {
    const lines = g.matches.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
    await safePush(gid, [ flexRoundPairs(`สายจัดอันดับ: ${g.label}`, lines) ]);
    for (const m of g.matches) for (const uid of [m.a,m.b]) if (uid){
      userToGroup.set(uid,gid);
      await safePush(uid, [{type:'text', text:`📝 ${g.label} — เลือกหมัด`, quickReply: qr()}]);
    }
  }
}

async function tryClosePlacement(gid, room, g, idx){
  const m = g.matches[idx];
  const aH = m.moves[m.a], bH = m.moves[m.b];

  if (m.a && !m.b) { m.winner=m.a; m.loser=null; m.state='done'; }
  else if (m.b && !m.a){ m.winner=m.b; m.loser=null; m.state='done'; }
  else if (aH && bH) {
    const r = judge(aH,bH);
    if (r==='DRAW'){ m.moves={}; for (const uid of [m.a,m.b]) if(uid) await safePush(uid,[{type:'text',text:'เสมอ — เลือกใหม่',quickReply:qr()}]); return; }
    m.winner = r==='A'? m.a : m.b; m.loser = r==='A'? m.b : m.a; m.state='done';
  } else return;

  await safePush(gid, [ flexMatchResult(`ผลสายจัดอันดับ`, pretty(room,m.a), aH, pretty(room,m.b), bH, pretty(room,m.winner)) ]);
  await logMatch(gid, `placing`, m.a, aH, m.b, bH, m.winner, m.loser);

  // เมื่อกลุ่มนี้เสร็จหมด → สร้างรอบถัดไปในกลุ่มนั้น (จาก winners)
  const allDoneInGroup = g.matches.every(x=>x.state==='done');
  if (!allDoneInGroup) return;

  const winners = g.matches.map(x=>x.winner).filter(Boolean);
  if (winners.length <= 1) {
    // กลุ่มนี้ได้ลำดับบนสุดของช่วงนั้นแล้ว (ที่เหลือถือว่าเท่ากันภายในช่วง)
    // ปล่อยให้ finalize รวมกับกลุ่มอื่น
  } else {
    // ทำรอบถัดไป
    g.matches = makeBracketFromList(winners);
    // ประกาศ + DM
    const lines = g.matches.map((m,i)=>`Match ${i+1}: ${pretty(room,m.a)} vs ${pretty(room,m.b)}`);
    await safePush(gid, [ flexRoundPairs(`สายจัดอันดับ: ${g.label} — รอบถัดไป`, lines) ]);
    for (const m2 of g.matches) for (const uid of [m2.a,m2.b]) if (uid){
      userToGroup.set(uid,gid);
      await safePush(uid, [{type:'text', text:`📝 ${g.label} — เลือกหมัด`, quickReply: qr()}]);
    }
    return;
  }

  // เช็คว่าทุกกลุ่มเสร็จหมดหรือยัง
  const allGroupsDone = room.placing.groups.every(gr => gr.matches.every(x=>x.state==='done'));
  if (allGroupsDone) {
    room.placing.finished = true;
    room.stage='finished'; room.phase='finished';
    await finalizeAndShowRanking(gid, room);
  }
}

/* =============== RANKING OUTPUT =============== */
async function finalizeAndShowRanking(gid, room){
  // 1–3 จากผลจริง
  const rank = [];
  if (room.results.champion) rank.push({ userId: room.results.champion, place:1 });
  if (room.results.runner)   rank.push({ userId: room.results.runner,   place:2 });
  if (room.results.third)    rank.push({ userId: room.results.third,    place:3 });

  const top3set = new Set(rank.map(x=>x.userId));
  const everyone = [...room.players.keys()];
  const others = everyone.filter(id => !top3set.has(id));

  // จากสายจัดอันดับ: ใครชนะถึงปลายสายมากกว่าจะได้อันดับดีกว่า
  const scored = new Map(); // userId -> score (สูงดีกว่า)
  let base = 1000;
  const scoreWin = 10, scoreRound = 1;

  // เติมคะแนนจาก eliminatedByRound (ลึกกว่า = ดีกว่า)
  for (const key of Object.keys(room.eliminatedByRound)) {
    const [stage, rtxt] = key.split('-');
    const depth = (stage==='pools'? 1 : stage==='semis'? 3 : stage==='final'? 4 : 2) + (parseInt(rtxt,10)||0);
    for (const uid of room.eliminatedByRound[key]) {
      if (!scored.has(uid)) scored.set(uid, base);
      scored.set(uid, scored.get(uid) + depth*scoreRound);
    }
  }

  // จากสายจัดอันดับ: ชนะมากกว่าได้เพิ่ม
  if (room.placing.groups?.length) {
    for (const g of room.placing.groups) {
      for (const m of g.matches) {
        if (m.winner) { scored.set(m.winner, (scored.get(m.winner)||base) + scoreWin); }
        if (m.loser)  { scored.set(m.loser,  (scored.get(m.loser)||base)); }
      }
    }
  }

  // สร้างลำดับสำหรับ others
  const orderedOthers = [...others].sort((a,b)=>{
    const sa = scored.get(a)||0, sb = scored.get(b)||0;
    if (sb!==sa) return sb-sa;
    // tie-break: ชื่อ
    const na = room.players.get(a)?.name || '';
    const nb = room.players.get(b)?.name || '';
    return na.localeCompare(nb, 'th');
  });

  let place = rank.length+1;
  for (const uid of orderedOthers) rank.push({ userId: uid, place: place++ });

  room.results.ranking = rank;

  await showRanking(gid, room, null);
  await logFinalRanking(gid, JSON.stringify(rank));
}

async function showRanking(gid, room, replyToken){
  if (!room.results?.ranking?.length) {
    const msg = {type:'text', text:'ยังไม่มีผลอันดับ — แข่งขันหรือจัดอันดับให้เสร็จก่อน แล้วสั่ง janken ranking ใหม่'};
    replyToken ? await safeReply(replyToken, msg) : await safePush(gid, msg);
    return;
  }
  const topLines = room.results.ranking
    .slice(0, 10) // แสดงท็อป 10 พอไม่ให้ยาวเกิน ถ้าอยากทั้งชุดค่อยแยก paging
    .map(x => `${x.place===1?'🏆':x.place===2?'🥈':x.place===3?'🥉':`#${x.place}`} ${pretty(room,x.userId)}`);
  const moreNote = room.results.ranking.length>10 ? `… และอีก ${room.results.ranking.length-10} คน` : '';
  const msg = { type:'text', text: topLines.join('\n') + (moreNote?`\n${moreNote}`:'') };
  replyToken ? await safeReply(replyToken, msg) : await safePush(gid, msg);
}
