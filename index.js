import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// ---------- ทดสอบ webhook ----------
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const e of events) {
      await handleEvent(e);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err?.response?.data || err?.message || err);
    res.sendStatus(200);
  }
});

app.get('/', (_req, res) => res.send('✅ Janken Tournament Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));

/* ===================== JANKEN TOURNAMENT CORE ===================== */

const rooms = new Map(); // groupId -> room

function ensureRoom(groupId) {
  if (!rooms.has(groupId)) {
    rooms.set(groupId, {
      name: 'Janken Tournament',
      phase: 'lobby', // 'lobby' | 'in_progress' | 'finished'
      players: new Map(), // userId -> { name, move?, alive }
      round: 0,
      pairs: [],          // Array<[uidA|null, uidB|null]>
      winners: [],        // queue for next round
    });
  }
  return rooms.get(groupId);
}

const HANDS = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function seedPairs(ids) {
  const s = shuffle(ids);
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push([s[i], s[i + 1] ?? null]);
  return out;
}
function judge(a, b) {
  if (!a || !b) return a || b;               // bye
  if (a === b) return null;                  // เสมอ
  const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return beats[a] === b ? 'A' : 'B';
}
function textName(room, uid) {
  if (!uid) return '— Bye —';
  return room.players.get(uid)?.name || 'Unknown';
}
function aliveCount(room) {
  let c = 0; for (const p of room.players.values()) if (p.alive) c++; return c;
}
function clearMoves(room, pair) {
  for (const uid of pair) if (uid && room.players.has(uid)) room.players.get(uid).move = undefined;
}

/* --------------------- Handler หลัก --------------------- */
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = (event.message.text || '').trim();
  if (text.toLowerCase() === 'ping') {
    await client.replyMessage(event.replyToken, [{ type: 'text', text: 'pong ✅' }]);
    return;
  }

  // รองรับขึ้นต้นได้ทั้ง rps / janken
  const [cmd, sub, ...rest] = text.split(/\s+/);
  const c0 = (cmd || '').toLowerCase();
  if (c0 !== 'rps' && c0 !== 'janken') return;

  // ต้องอยู่ในกรุ๊ปเท่านั้น
  const src = event.source;
  if (src.type !== 'group' && src.type !== 'supergroup') {
    await client.replyMessage(event.replyToken, [{ type: 'text', text: 'โปรดเชิญบอทเข้ากลุ่ม แล้วพิมพ์: rps start' }]);
    return;
  }

  const groupId = src.groupId;
  const room = ensureRoom(groupId);

  // ดึงชื่อผู้ใช้ให้ถูก endpoint (กัน 400)
  let displayName = 'Player';
  try {
    const prof = await client.getGroupMemberProfile(groupId, src.userId);
    if (prof?.displayName) displayName = prof.displayName;
  } catch {}

  const action = (sub || '').toLowerCase();

  switch (action) {
    case 'start': {
      rooms.set(groupId, {
        name: 'Janken Tournament',
        phase: 'lobby',
        players: new Map(),
        round: 0,
        pairs: [],
        winners: [],
      });
      const r = ensureRoom(groupId);
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `🎌 ${r.name} เปิดล็อบบี้แล้ว` },
        { type: 'text', text: `เข้าร่วม: rps join <ชื่อ>\nเริ่มแข่ง: rps begin\nดูรายชื่อ: rps list` },
      ]);
      break;
    }

    case 'join': {
      const name = rest.join(' ') || displayName;
      room.players.set(src.userId, { name, alive: true });
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `✅ เข้าร่วมแล้ว: ${name}` },
        { type: 'text', text: `ผู้เล่นปัจจุบัน (${room.players.size}):\n${[...room.players.values()].map(p=>`• ${p.name}`).join('\n') || '-'}` },
      ]);
      break;
    }

    case 'leave': {
      room.players.delete(src.userId);
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `ออกจากการแข่งขันแล้ว` },
        { type: 'text', text: `คงเหลือ (${room.players.size}) คน` },
      ]);
      break;
    }

    case 'list': {
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `รายชื่อผู้เล่น (${room.players.size}):\n${[...room.players.values()].map(p=>`• ${p.name}`).join('\n') || '-'}` },
      ]);
      break;
    }

    case 'begin': {
      if (room.players.size < 2) {
        await client.replyMessage(event.replyToken, [{ type: 'text', text: 'ต้องมีอย่างน้อย 2 คนถึงจะเริ่มได้' }]);
        break;
      }
      room.phase = 'in_progress';
      room.round = 1;
      for (const p of room.players.values()) p.alive = true;
      const ids = [...room.players.keys()];
      room.pairs = seedPairs(ids);
      room.winners = [];
      for (const pair of room.pairs) clearMoves(room, pair);

      const matchesText = room.pairs.map(([a,b],i)=>`Match ${i+1}: ${textName(room,a)} vs ${textName(room,b)}`).join('\n');
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `🚩 เริ่มรอบที่ 1 ผู้เล่น ${aliveCount(room)} คน` },
        { type: 'text', text: matchesText || '-' },
        { type: 'text', text: `ส่งหมัดด้วยคำสั่ง: rps move rock|paper|scissors` },
      ]);
      break;
    }

    case 'move': {
      if (room.phase !== 'in_progress') {
        await client.replyMessage(event.replyToken, [{ type: 'text', text: 'ยังไม่ได้เริ่ม / จบไปแล้ว' }]);
        break;
      }
      const move = (rest[0] || '').toLowerCase();
      if (!HANDS.includes(move)) {
        await client.replyMessage(event.replyToken, [{ type: 'text', text: 'โปรดเลือก: rock / paper / scissors' }]);
        break;
      }

      const pair = room.pairs.find(([a,b]) => a === src.userId || b === src.userId);
      if (!pair) {
        await client.replyMessage(event.replyToken, [{ type: 'text', text: 'ยังไม่มีคู่ของคุณในรอบนี้' }]);
        break;
      }
      room.players.get(src.userId).move = move;

      // เช็กคู่นี้พร้อมตัดสินหรือยัง
      const [A, B] = pair;
      const mA = A ? room.players.get(A)?.move : undefined;
      const mB = B ? room.players.get(B)?.move : undefined;

      if ((A && !mA) || (B && !mB)) {
        await client.replyMessage(event.replyToken, [{ type: 'text', text: `บันทึกแล้ว: ${move.toUpperCase()} ${EMOJI[move]}` }]);
        break;
      }

      // ตัดสิน
      const res = judge(mA, mB);
      if (res === null) {
        clearMoves(room, pair);
        await client.replyMessage(event.replyToken, [
          { type: 'text', text: `ผลเสมอ! ทั้งสองฝ่ายส่งใหม่อีกครั้ง\n${textName(room,A)}: ${EMOJI[mA]}  vs  ${textName(room,B)}: ${EMOJI[mB]}` }
        ]);
        break;
      }
      const winner = res === 'A' ? A : B;
      const loser  = res === 'A' ? B : A;
      if (winner) room.winners.push(winner);
      if (loser && room.players.has(loser)) room.players.get(loser).alive = false;

      await client.replyMessage(event.replyToken, [
        { type: 'text', text: `ผลคู่ของคุณ: ${textName(room,A)} ${EMOJI[mA] || ''}  vs  ${textName(room,B)} ${EMOJI[mB] || ''}` },
        { type: 'text', text: `ผู้ชนะ: ${textName(room, winner)}` },
      ]);

      // รอบนี้ครบทุกคู่หรือยัง?
      const allDecided = room.pairs.every(([x,y])=>{
        const mx = x ? room.players.get(x)?.move : undefined;
        const my = y ? room.players.get(y)?.move : undefined;
        if (!x || !y) return true;           // bye
        if (!mx || !my) return false;        // ยังไม่ส่งครบ
        return judge(mx,my) !== null;        // ไม่เสมอ
      });

      if (!allDecided) break;

      // ไป next round / จบ
      if (room.winners.length === 1) {
        room.phase = 'finished';
        await client.pushMessage(groupId, [
          { type: 'text', text: `🏆 แชมป์ ${room.name}: ${textName(room, room.winners[0])}` }
        ]);
      } else {
        room.round += 1;
        room.pairs = seedPairs(room.winners);
        room.winners = [];
        for (const p of room.pairs) clearMoves(room,p);
        const matches = room.pairs.map(([a,b],i)=>`Match ${i+1}: ${textName(room,a)} vs ${textName(room,b)}`).join('\n');
        await client.pushMessage(groupId, [
          { type: 'text', text: `➡️ เข้าสู่รอบที่ ${room.round}` },
          { type: 'text', text: matches || '-' },
          { type: 'text', text: `ส่งหมัด: rps move rock|paper|scissors` },
        ]);
      }
      break;
    }

    case 'status': {
      const header =
        room.phase === 'lobby' ? `🎌 ${room.name} — Lobby`
        : room.phase === 'in_progress' ? `🔄 รอบที่ ${room.round} (คงเหลือ ${aliveCount(room)} คน)`
        : `🏁 จบการแข่งขันแล้ว`;
      const list = [...room.players.values()].map(p => `• ${p.name}${p.alive?'':' (ตกรอบ)'}`).join('\n') || '-';
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: header },
        { type: 'text', text: list }
      ]);
      break;
    }

    case 'reset': {
      rooms.delete(groupId);
      await client.replyMessage(event.replyToken, [{ type: 'text', text: 'รีเซ็ตแล้ว — rps start เพื่อเริ่มใหม่' }]);
      break;
    }

    default: {
      await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: [
          `🎌 ${room.name}`,
          'คำสั่ง:',
          '• rps start',
          '• rps join <ชื่อ?>',
          '• rps list',
          '• rps begin',
          '• rps move rock|paper|scissors',
          '• rps status',
          '• rps reset',
        ].join('\n')
      }]);
    }
  }
}
