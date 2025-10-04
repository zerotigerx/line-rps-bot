import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE credentials');
  process.exit(1);
}

const app = express();
const client = new Client(config);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

app.post('/webhook', middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) => res.json(result));
});

// =========================== GAME STATE ===============================
const rooms = new Map();
const userToGroup = new Map();
const HANDS = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

// =========================== UTILITIES ================================
async function safePush(to, message) {
  try { await client.pushMessage(to, message); }
  catch (err) { console.error('Push error:', err.originalError?.response?.data || err); }
}
async function safeReply(token, message) {
  try { await client.replyMessage(token, message); }
  catch (err) { console.error('Reply error:', err.originalError?.response?.data || err); }
}

// =========================== FLEX MENU ================================
function menuFlex() {
  return {
    type: 'flex',
    altText: 'Janken Tournament Menu',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: 'Janken Tournament Menu', weight: 'bold', size: 'lg' }]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', color: '#4CAF50', action: { type: 'message', label: 'เข้าร่วม', text: 'janken join' }},
          { type: 'button', style: 'secondary', color: '#FFB74D', action: { type: 'message', label: 'ปิดรับสมัคร', text: 'janken close' }},
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'รีเซ็ตเกม', text: 'janken reset' }}
        ]
      }
    }
  };
}

// =========================== FLEX OPEN BANNER ================================
function openBannerFlex() {
  return {
    type: 'flex',
    altText: 'JANKEN TOURNAMENT เปิดแล้ว!',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#111',
        contents: [
          { type: 'text', text: 'JANKEN', weight: 'bold', size: '3xl', color: '#FFD54F', align: 'center' },
          { type: 'text', text: 'TOURNAMENT', weight: 'bold', size: 'xl', color: '#FFFFFF', align: 'center' },
          { type: 'text', text: 'เปิดรับสมัครแล้ว!', size: 'sm', color: '#BDBDBD', align: 'center', margin: 'sm' }
        ],
        paddingAll: '24px',
        cornerRadius: 'md'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'ใครจะเป็นแชมป์สายเป่ายิงฉุบของกลุ่มนี้?', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: 'md',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: 'วิธีเข้าร่วม', weight: 'bold' },
              { type: 'text', text: 'พิมพ์  janken join  ในห้องแชทนี้', size: 'sm', color: '#666666' },
              { type: 'text', text: 'รับสมัครสูงสุด 20 คน เท่านั้น', size: 'sm', color: '#666666', margin: 'sm' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#FFB74D', action: { type: 'message', label: 'เข้าร่วมทันที', text: 'janken join' }},
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'ดูเมนู', text: 'menu' }}
        ]
      }
    }
  };
}

// =========================== HANDLE EVENT ================================
async function handleEvent(e) {
  if (e.type !== 'message' || e.message.type !== 'text') return;
  const msg = e.message.text.trim().toLowerCase();
  const gid = e.source.groupId || e.source.roomId;
  if (!gid) return;

  // ---------- DIRECT MESSAGE HAND (เลือกหมัดส่วนตัว) ----------
  if (e.source.type === 'user' && HANDS.includes(msg)) {
    const gid = userToGroup.get(e.source.userId);
    if (!gid || !rooms.has(gid)) {
      await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่มีแมตช์รออยู่' });
      return;
    }

    const pick = [
      (hand)=>`เยี่ยม! เลือกได้เฉียบมาก ${hand}  รอคู่แข่งเลือก แล้วลุ้นผลในห้องกลุ่มได้เลย!`,
      (hand)=>`เท่มาก! ${hand} คือหมัดที่มั่นใจสุดๆ 😎  เดี๋ยวดูผลพร้อมกันในกลุ่มนะ!`,
      (hand)=>`โอ้โห! ${hand} นี่ล่ะไม้ตายของนาย 💥  รอคู่ต่อสู้แล้วไปมันส์กันในกลุ่ม!`,
      (hand)=>`จัดมาเนียนๆ ${hand}  ขอดูหน่อยสิว่าใครจะเหนือกว่า รอลุ้นผลในกลุ่ม!`,
      (hand)=>`เลือกได้ดีนี่! ${hand}  สูดหายใจลึกๆ แล้วไปลุ้นพร้อมกันในกลุ่มเลย!`
    ];
    const handLabel = `${msg.toUpperCase()} ${EMOJI[msg]}`;
    const message = pick[Math.floor(Math.random() * pick.length)](handLabel);
    await safeReply(e.replyToken, { type: 'text', text: message });
    return;
  }

  // ---------- GROUP COMMAND ----------
  if (!rooms.has(gid)) rooms.set(gid, { phase: 'idle', players: new Map(), admin: e.source.userId });
  const room = rooms.get(gid);

  switch (msg) {
    case 'janken open': {
      room.admin = e.source.userId;
      room.phase = 'register';
      room.players = new Map();

      const announce = [
        '🎌✨  JANKEN TOURNAMENT เปิดฉากแล้ว!! ✨🎌',
        '',
        'ใครจะเป็นแชมป์สายเป่ายิงฉุบแห่งกลุ่มนี้ 🏆',
        '',
        'พิมพ์ 👉  janken join  เพื่อเข้าร่วมการแข่งขัน',
        'รับสมัครสูงสุด 20 คน เท่านั้น ‼️',
        '',
        '⏳ เมื่อครบแล้ว ผู้จัดสามารถพิมพ์  "janken close"  เพื่อเริ่มแข่งได้เลย!'
      ].join('\n');

      await safePush(gid, { type: 'text', text: announce });
      await safePush(gid, openBannerFlex());
      await safeReply(e.replyToken, [menuFlex(), { type: 'text', text: '🟢 เปิดรับสมัครแล้ว (พิมพ์ janken join เพื่อเข้าร่วม)' }]);
      break;
    }

    case 'janken join': {
      if (room.phase !== 'register') {
        await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่เปิดรับสมัคร' });
        break;
      }
      if (room.players.size >= 20) {
        await safeReply(e.replyToken, { type: 'text', text: 'ครบ 20 คนแล้ว!' });
        break;
      }

      const profile = await client.getProfile(e.source.userId);
      room.players.set(e.source.userId, profile.displayName);
      userToGroup.set(e.source.userId, gid);
      await safePush(gid, { type: 'text', text: `✅ เข้าร่วมแล้ว: ${profile.displayName} (รวม ${room.players.size}/20)` });
      break;
    }

    case 'janken close': {
      if (room.phase !== 'register' || room.players.size < 2) {
        await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีผู้เล่นอย่างน้อย 2 คน' });
        break;
      }
      room.phase = 'playing';
      const names = [...room.players.values()];
      const matches = names.map((n, i) => `Match ${i+1}: ${n} vs — Bye —`).join('\n');
      await safePush(gid, { type: 'text', text: `📣 Match เริ่มแล้ว (ผู้เล่น ${room.players.size})\n\n${matches}` });
      await safePush(gid, { type: 'text', text: '📩 กรุณาเช็คไลน์ส่วนตัวเพื่อเลือกหมัดดวลกับคู่ต่อสู้ของคุณ' });
      break;
    }

    case 'janken reset': {
      rooms.delete(gid);
      await safeReply(e.replyToken, { type: 'text', text: '♻️ รีเซ็ตแล้ว — พิมพ์ janken open เพื่อเริ่มใหม่' });
      break;
    }

    case 'menu': {
      await safeReply(e.replyToken, menuFlex());
      break;
    }

    default:
      break;
  }
}
