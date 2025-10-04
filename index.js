// LINE RPS Tournament Bot — Pretty Flex UI Tournament (Node.js)
// --------------------------------------------------------------
// Features
// - Group play only (uses groupId for room key)
// - Commands:
//   rps start          -> start a new tournament in this group
//   rps join <name?>   -> join (defaults to LINE displayName if omitted)
//   rps leave          -> leave tournament
//   rps list           -> show players
//   rps begin          -> lock sign‑ups and seed bracket
//   rps move <rock|paper|scissors>  -> submit move for your current match
//   rps status         -> show bracket
//   rps reset          -> abort tournament
// - Beautiful Flex bubbles for lobby, bracket, and match cards
// - Single‑elimination; auto‑advances winners; handles odd byes
// --------------------------------------------------------------

import "dotenv/config";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";

// ---------------------- Config ----------------------
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

if (!config.channelSecret || !config.channelAccessToken) {
  console.error(
    "❌ Please set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN in .env",
  );
  process.exit(1);
}

const app = express();
app.use(express.json()); // ใช้เฉพาะ parse JSON ทั่วไป
const client = new Client(config);

// ---------------------- State ----------------------
// In‑memory tournament state keyed by groupId
const rooms = new Map();

/** Room shape
{
  phase: 'lobby'|'in_progress'|'finished',
  players: Map<userId, { name: string, moved?: 'rock'|'paper'|'scissors', alive: boolean }>,
  bracket: Array<[string|null, string|null]>, // pairs of userIds (null = bye)
  round: number,
  currentPairs: Array<[string|null, string|null]>,
  winnersQueue: string[],
}
*/

// ---------------------- Helpers ----------------------
const handEmoji = { rock: "✊", paper: "✋", scissors: "✌️" };
const now = () => new Date().toLocaleString("th-TH", { hour12: false });

function ensureRoom(groupId) {
  if (!rooms.has(groupId)) {
    rooms.set(groupId, {
      phase: "lobby",
      players: new Map(),
      bracket: [],
      round: 0,
      currentPairs: [],
      winnersQueue: [],
    });
  }
  return rooms.get(groupId);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function seedBracket(userIds) {
  const ids = shuffle([...userIds]);
  const pairs = [];
  for (let i = 0; i < ids.length; i += 2) {
    const a = ids[i];
    const b = ids[i + 1] ?? null;
    pairs.push([a, b]);
  }
  return pairs;
}

function judge(a, b) {
  if (!a || !b) return a || b; // bye advances
  if (a === b) return null;
  const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
  return beats[a] === b ? "A" : "B";
}

function resetMoves(room, pair) {
  pair.forEach((uid) => {
    if (uid && room.players.has(uid)) room.players.get(uid).moved = undefined;
  });
}

// ---------------------- Flex UI ----------------------
function flexLobby(room, title = "RPS Tournament — Lobby") {
  const list =
    [...room.players.values()].map((p, i) => `• ${p.name}`).join("\n") ||
    "ยังไม่มีผู้เล่นเข้าร่วม";
  return {
    type: "flex",
    altText: "RPS Lobby",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", size: "xl" },
          {
            type: "text",
            text: `ผู้เล่น: ${room.players.size} คน`,
            color: "#aaaaaa",
            size: "sm",
          },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "vertical",
            contents: [{ type: "text", text: list, wrap: true }],
          },
          { type: "separator", margin: "md" },
          {
            type: "text",
            text: 'พิมพ์: "rps join <ชื่อ>" เพื่อเข้าร่วม',
            size: "sm",
            color: "#666",
          },
          {
            type: "text",
            text: 'เริ่มแข่ง: "rps begin"',
            size: "sm",
            color: "#666",
          },
          {
            type: "text",
            text: `อัปเดตล่าสุด: ${now()}`,
            size: "xs",
            color: "#999",
          },
        ],
      },
    },
  };
}

function flexBracket(room) {
  const title = `รอบ ${room.round}`;
  const cols = room.currentPairs.map(([a, b], idx) => ({
    type: "box",
    layout: "vertical",
    spacing: "xs",
    contents: [
      { type: "text", text: `Match ${idx + 1}`, size: "sm", color: "#999" },
      { type: "text", text: nameOrBye(room, a), weight: "bold", wrap: true },
      { type: "text", text: "vs", size: "xs", color: "#aaaaaa" },
      { type: "text", text: nameOrBye(room, b), weight: "bold", wrap: true },
    ],
  }));
  return {
    type: "flex",
    altText: "RPS Bracket",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "RPS Tournament", weight: "bold", size: "lg" },
          { type: "text", text: title, size: "sm", color: "#aaaaaa" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "baseline",
            contents: [
              {
                type: "text",
                text: `ผู้เล่นคงเหลือ: ${aliveCount(room)} คน`,
                size: "sm",
                color: "#666",
              },
            ],
          },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "md", contents: cols },
          { type: "separator" },
          {
            type: "text",
            text: "ส่งหมัด: rps move rock|paper|scissors",
            size: "sm",
            color: "#666",
          },
        ],
      },
    },
  };
}

function nameOrBye(room, uid) {
  if (!uid) return "— Bye —";
  return room.players.get(uid)?.name || "Unknown";
}

function aliveCount(room) {
  let c = 0;
  for (const p of room.players.values()) if (p.alive) c++;
  return c;
}

function flexMatchCard(room, a, b) {
  const pa = a && room.players.get(a);
  const pb = b && room.players.get(b);
  const aHand = pa?.moved ? handEmoji[pa.moved] + " " + pa.moved : "ยังไม่ส่ง";
  const bHand = pb?.moved ? handEmoji[pb.moved] + " " + pb.moved : "ยังไม่ส่ง";
  return {
    type: "flex",
    altText: "Match Update",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "รอบการแข่ง", size: "sm", color: "#aaa" },
          {
            type: "text",
            text: `${pa?.name || "— Bye —"}  vs  ${pb?.name || "— Bye —"}`,
            weight: "bold",
            size: "lg",
            wrap: true,
          },
          { type: "separator" },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "box",
                layout: "vertical",
                contents: [
                  {
                    type: "text",
                    text: pa?.name || "— Bye —",
                    weight: "bold",
                    wrap: true,
                  },
                  { type: "text", text: aHand, color: "#666" },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                contents: [
                  {
                    type: "text",
                    text: pb?.name || "— Bye —",
                    weight: "bold",
                    wrap: true,
                    align: "end",
                  },
                  { type: "text", text: bHand, color: "#666", align: "end" },
                ],
              },
            ],
          },
          { type: "separator" },
          {
            type: "text",
            text: "พิมพ์: rps move rock | paper | scissors",
            size: "sm",
            color: "#666",
          },
        ],
      },
    },
  };
}

function flexChampion(name) {
  return {
    type: "flex",
    altText: "🏆 แชมป์!",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: "https://i.imgur.com/5B2xw9v.jpeg",
        size: "full",
        aspectMode: "cover",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🏆 Champion", size: "xl", weight: "bold" },
          { type: "text", text: name, size: "lg", weight: "bold", wrap: true },
          {
            type: "text",
            text: "เก่งที่สุดในกลุ่มนี้!",
            size: "sm",
            color: "#666",
          },
        ],
      },
    },
  };
}

// ---------------------- Tournament flow ----------------------
function beginTournament(room) {
  room.phase = "in_progress";
  room.round = 1;
  // mark all alive
  for (const p of room.players.values()) p.alive = true;
  // seed
  const userIds = [...room.players.keys()].filter(
    (uid) => room.players.get(uid).alive,
  );
  room.currentPairs = seedBracket(userIds);
  // reset moves
  room.currentPairs.forEach((pair) => resetMoves(room, pair));
}

function allMovesIn(room, [a, b]) {
  const pa = a && room.players.get(a);
  const pb = b && room.players.get(b);
  if (!a || !b) return true; // bye
  return Boolean(pa?.moved && pb?.moved);
}

function resolvePair(room, [a, b]) {
  if (!a || !b) return a || b;
  const pa = room.players.get(a);
  const pb = room.players.get(b);
  const res = judge(pa.moved, pb.moved);
  if (res === null) return null; // tie, replay required
  return res === "A" ? a : b;
}

function advanceIfReady(room) {
  // resolve completed matches
  const next = [];
  let needRematch = false;
  for (const pair of room.currentPairs) {
    if (!allMovesIn(room, pair)) {
      next.push(pair);
      continue;
    }
    const winner = resolvePair(room, pair);
    if (winner === null) {
      // reset only these two and play again
      resetMoves(room, pair);
      needRematch = true;
      next.push(pair);
    } else {
      room.winnersQueue.push(winner);
    }
  }

  // all pairs judged and moved to winnersQueue?
  const allResolved = room.currentPairs.every(
    (p) => allMovesIn(room, p) && resolvePair(room, p) !== null,
  );

  if (allResolved) {
    // build next round pairs
    const w = [...room.winnersQueue];
    room.winnersQueue = [];
    if (w.length === 1) {
      // champion
      room.phase = "finished";
      return { champion: w[0] };
    }
    const pairs = [];
    for (let i = 0; i < w.length; i += 2) {
      pairs.push([w[i], w[i + 1] ?? null]);
    }
    room.currentPairs = pairs;
    room.round += 1;
    room.currentPairs.forEach((pair) => resetMoves(room, pair));
    return { nextRound: true };
  }

  return { needRematch };
}

// ---------------------- Webhook ----------------------
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length) {
      await Promise.all(events.map(handleEvent));
    }
    return res.sendStatus(200);    // สำคัญ: ตอบ 200 แม้ไม่มี event (ตอน Verify)
  } catch (e) {
    console.error('Webhook error:', e);
    return res.sendStatus(200);    // อย่าให้ Verify ล้ม
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const source = event.source;
  if (source.type !== "group" && source.type !== "supergroup") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "โปรดเชิญบอทเข้าในกลุ่ม แล้วพิมพ์: rps start",
    });
    return;
  }

  const groupId = source.groupId;
  const room = ensureRoom(groupId);

  const profile = await client
    .getProfile(event.source.userId)
    .catch(() => ({ displayName: "Player" }));
  const [cmd, sub, ...rest] = text.split(/\s+/);

  if (cmd?.toLowerCase() !== "rps") return;

  switch ((sub || "").toLowerCase()) {
    case "start": {
      rooms.set(groupId, {
        phase: "lobby",
        players: new Map(),
        bracket: [],
        round: 0,
        currentPairs: [],
        winnersQueue: [],
      });
      await client.replyMessage(
        event.replyToken,
        flexLobby(ensureRoom(groupId), "RPS Tournament — เปิดล็อบบี้"),
      );
      break;
    }
    case "join": {
      if (room.phase !== "lobby") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "เริ่มแข่งไปแล้ว / ปิดรับสมัคร",
        });
        break;
      }
      const name = rest.join(" ") || profile.displayName;
      room.players.set(event.source.userId, { name, alive: true });
      await client.replyMessage(
        event.replyToken,
        flexLobby(room, "เข้าร่วมสำเร็จ!"),
      );
      break;
    }
    case "leave": {
      room.players.delete(event.source.userId);
      await client.replyMessage(
        event.replyToken,
        flexLobby(room, "ออกจากการแข่งขันแล้ว"),
      );
      break;
    }
    case "list": {
      await client.replyMessage(
        event.replyToken,
        flexLobby(room, "รายชื่อผู้เล่น"),
      );
      break;
    }
    case "begin": {
      if (room.players.size < 2) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "ต้องมีอย่างน้อย 2 คน",
        });
        break;
      }
      beginTournament(room);
      await client.replyMessage(event.replyToken, [
        {
          type: "text",
          text: `เริ่มการแข่งขัน! ผู้เล่น ${aliveCount(room)} คน`,
        },
        flexBracket(room),
      ]);
      // send each match card
      for (const pair of room.currentPairs) {
        await client.pushMessage(
          groupId,
          flexMatchCard(room, pair[0], pair[1]),
        );
      }
      break;
    }
    case "move": {
      if (room.phase !== "in_progress") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "ยังไม่ได้เริ่ม / จบไปแล้ว",
        });
        break;
      }
      const choice = (rest[0] || "").toLowerCase();
      if (!["rock", "paper", "scissors"].includes(choice)) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "โปรดเลือก: rock / paper / scissors",
        });
        break;
      }
      // validate user is in current round
      const participating = room.currentPairs.some(
        ([a, b]) => a === event.source.userId || b === event.source.userId,
      );
      if (!participating) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "ยังไม่มีคู่ของคุณในรอบนี้",
        });
        break;
      }
      const player = room.players.get(event.source.userId);
      player.moved = choice;

      // show match card
      const pair = room.currentPairs.find(
        ([a, b]) => a === event.source.userId || b === event.source.userId,
      );
      await client.replyMessage(
        event.replyToken,
        flexMatchCard(room, pair[0], pair[1]),
      );

      const step = advanceIfReady(room);
      if (step?.champion) {
        const champName = room.players.get(step.champion)?.name || "Champion";
        await client.pushMessage(groupId, [
          flexBracket(room),
          flexChampion(champName),
        ]);
      } else if (step?.nextRound) {
        await client.pushMessage(groupId, [
          { type: "text", text: `เข้าสู่รอบ ${room.round}!` },
          flexBracket(room),
        ]);
        for (const p of room.currentPairs) {
          await client.pushMessage(groupId, flexMatchCard(room, p[0], p[1]));
        }
      }
      break;
    }
    case "status": {
      if (room.phase === "lobby") {
        await client.replyMessage(event.replyToken, flexLobby(room, "Lobby"));
      } else if (room.phase === "in_progress") {
        await client.replyMessage(event.replyToken, flexBracket(room));
      } else {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "การแข่งขันจบแล้ว (rps start เพื่อเริ่มใหม่)",
        });
      }
      break;
    }
    case "reset": {
      rooms.delete(groupId);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "รีเซ็ตแล้ว — พิมพ์ rps start เพื่อเริ่มใหม่",
      });
      break;
    }
    default: {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: [
          "คำสั่งใช้งาน:",
          "• rps start",
          "• rps join <ชื่อ?>",
          "• rps list",
          "• rps begin",
          "• rps move rock|paper|scissors",
          "• rps status",
          "• rps reset",
        ].join("\n"),
      });
    }
  }
}

// ---------------------- Healthcheck ----------------------
app.get("/", (_req, res) => res.send("RPS Tournament Bot is running."));

// ---------------------- Start ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));

// ---------------------- How to run (Local) ----------------------
// 1) npm init -y
// 2) npm i express @line/bot-sdk dotenv
// 3) add "type":"module" in package.json
// 4) create .env
//    LINE_CHANNEL_SECRET=xxx
//    LINE_CHANNEL_ACCESS_TOKEN=xxx
// 5) node index.js
// 6) Expose with ngrok: ngrok http 3000 -> put HTTPS URL into LINE Messaging API Webhook
// 7) Invite the bot to your LINE group
// 8) In the group: type `rps start`, then `rps join`, `rps begin`, etc.

// ---------------------- How to run (Replit — Online) ----------------------
// A) Create a new Repl: Template = Node.js
// B) Files:
//    - index.js  -> paste this entire file content
//    - package.json -> include {
//        "name": "line-rps-bot",
//        "version": "1.0.0",
//        "type": "module",
//        "scripts": { "start": "node index.js" },
//        "dependencies": { "express": "^4", "@line/bot-sdk": "^7", "dotenv": "^16" }
//      }
// C) Secrets (Environment): add
//      LINE_CHANNEL_SECRET = your secret
//      LINE_CHANNEL_ACCESS_TOKEN = your access token
// D) Click Run -> Replit will host at an HTTPS URL like https://your-repl-name.your-user.repl.co
// E) In LINE Developers Console -> Messaging API -> set Webhook URL to
//      https://your-repl-name.your-user.repl.co/webhook
//    -> Verify (should show Success)
// F) Add the bot as a friend, invite to your LINE group.
// G) Commands: rps start / rps join / rps begin / rps move rock|paper|scissors

// Notes
// - This demo keeps state in memory. For persistence across restarts, store per-group state in Redis/DB.
// - Replit free instances may sleep; use UptimeRobot/Deployments or a paid plan to keep alive.
