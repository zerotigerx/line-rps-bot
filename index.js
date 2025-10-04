// LINE RPS Tournament Bot — Ready for Render/Replit
// --------------------------------------------------
// Commands:
// rps start | rps join <name?> | rps leave | rps list
// rps begin | rps move rock|paper|scissors | rps status | rps reset
// --------------------------------------------------

import 'dotenv/config'
import express from 'express'
import { middleware, Client } from '@line/bot-sdk'

// ----- LINE config -----
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
}
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('❌ Missing LINE envs: LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN')
}

// ----- App -----
const app = express()
// ❗️สำคัญ: อย่าใส่ app.use(express.json()) ที่นี่ เพื่อให้ LINE middleware อ่าน raw body ได้ถูกต้อง

const client = new Client(config)

// ----- In-memory state (per group) -----
const rooms = new Map()
/*
room = {
  phase: 'lobby' | 'in_progress' | 'finished',
  players: Map<userId, { name, moved?, alive }>,
  round: number,
  currentPairs: Array<[string|null, string|null]>,
  winnersQueue: string[],
}
*/

const handEmoji = { rock: '✊', paper: '✋', scissors: '✌️' }
const now = () => new Date().toLocaleString('th-TH', { hour12: false })

function ensureRoom(groupId) {
  if (!rooms.has(groupId)) {
    rooms.set(groupId, {
      phase: 'lobby',
      players: new Map(),
      round: 0,
      currentPairs: [],
      winnersQueue: [],
    })
  }
  return rooms.get(groupId)
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]} return a }
function seedBracket(userIds){ const ids=shuffle([...userIds]); const pairs=[]; for(let i=0;i<ids.length;i+=2){ pairs.push([ids[i], ids[i+1] ?? null]) } return pairs }
function judge(a,b){ if(!a||!b) return a||b; if(a===b) return null; const beats={rock:'scissors', paper:'rock', scissors:'paper'}; return beats[a]===b ? 'A':'B' }
function resetMoves(room,pair){ pair.forEach(uid=>{ if(uid && room.players.has(uid)) room.players.get(uid).moved = undefined }) }
function aliveCount(room){ let c=0; for(const p of room.players.values()) if(p.alive) c++; return c }
function nameOrBye(room, uid){ if(!uid) return '— Bye —'; return room.players.get(uid)?.name || 'Unknown' }

// ----- Flex UI -----
function flexLobby(room, title='RPS Tournament — Lobby'){
  const list = [...room.players.values()].map(p=>`• ${p.name}`).join('\n') || 'ยังไม่มีผู้เล่นเข้าร่วม'
  return { type:'flex', altText:'RPS Lobby', contents:{
    type:'bubble', size:'giga', body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:title, weight:'bold', size:'xl' },
      { type:'text', text:`ผู้เล่น: ${room.players.size} คน`, color:'#aaaaaa', size:'sm' },
      { type:'separator', margin:'md' },
      { type:'box', layout:'vertical', contents:[ { type:'text', text:list, wrap:true } ]},
      { type:'separator', margin:'md' },
      { type:'text', text:'พิมพ์: rps join <ชื่อ> เพื่อเข้าร่วม', size:'sm', color:'#666' },
      { type:'text', text:'เริ่มแข่ง: rps begin', size:'sm', color:'#666' },
      { type:'text', text:`อัปเดต: ${now()}`, size:'xs', color:'#999' },
    ]}}
  }}
}
function flexBracket(room){
  const cols = room.currentPairs.map(([a,b],i)=>({
    type:'box', layout:'vertical', spacing:'xs', contents:[
      { type:'text', text:`Match ${i+1}`, size:'sm', color:'#999' },
      { type:'text', text:nameOrBye(room,a), weight:'bold', wrap:true },
      { type:'text', text:'vs', size:'xs', color:'#aaa' },
      { type:'text', text:nameOrBye(room,b), weight:'bold', wrap:true },
    ]
  }))
  return { type:'flex', altText:'RPS Bracket', contents:{
    type:'bubble', size:'giga',
    header:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'RPS Tournament', weight:'bold', size:'lg' },
      { type:'text', text:`รอบ ${room.round}`, size:'sm', color:'#aaa' },
    ]},
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:`ผู้เล่นคงเหลือ: ${aliveCount(room)} คน`, size:'sm', color:'#666' },
      { type:'separator' },
      { type:'box', layout:'vertical', spacing:'md', contents: cols },
      { type:'separator' },
      { type:'text', text:'ส่งหมัด: rps move rock|paper|scissors', size:'sm', color:'#666' },
    ]}
  }}
}
function flexMatchCard(room, a, b){
  const pa = a && room.players.get(a)
  const pb = b && room.players.get(b)
  const aHand = pa?.moved ? `${handEmoji[pa.moved]} ${pa.moved}` : 'ยังไม่ส่ง'
  const bHand = pb?.moved ? `${handEmoji[pb.moved]} ${pb.moved}` : 'ยังไม่ส่ง'
  return { type:'flex', altText:'Match', contents:{
    type:'bubble', body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'รอบการแข่ง', size:'sm', color:'#aaa' },
      { type:'text', text:`${pa?.name || '— Bye —'}  vs  ${pb?.name || '— Bye —'}`, weight:'bold', size:'lg', wrap:true },
      { type:'separator' },
      { type:'box', layout:'horizontal', contents:[
        { type:'box', layout:'vertical', contents:[
          { type:'text', text: pa?.name || '— Bye —', weight:'bold', wrap:true },
          { type:'text', text:aHand, color:'#666' }
        ]},
        { type:'box', layout:'vertical', contents:[
          { type:'text', text: pb?.name || '— Bye —', weight:'bold', wrap:true, align:'end' },
          { type:'text', text:bHand, color:'#666', align:'end' }
        ]}
      ]},
      { type:'separator' },
      { type:'text', text:'พิมพ์: rps move rock | paper | scissors', size:'sm', color:'#666' },
    ]}
  }}
}
function flexChampion(name){
  return { type:'flex', altText:'🏆 แชมป์!', contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'🏆 Champion', size:'xl', weight:'bold' },
      { type:'text', text:name, size:'lg', weight:'bold', wrap:true },
      { type:'text', text:'เก่งที่สุดในกลุ่มนี้!', size:'sm', color:'#666' }
    ]}
  }}
}

// ----- Tournament flow -----
function beginTournament(room){
  room.phase = 'in_progress'
  room.round = 1
  for (const p of room.players.values()) p.alive = true
  const userIds = [...room.players.keys()].filter(uid => room.players.get(uid).alive)
  room.currentPairs = seedBracket(userIds)
  room.currentPairs.forEach(pair => resetMoves(room, pair))
}
function allMovesIn(room,[a,b]){
  const pa = a && room.players.get(a)
  const pb = b && room.players.get(b)
  if(!a || !b) return true
  return Boolean(pa?.moved && pb?.moved)
}
function resolvePair(room,[a,b]){
  if(!a || !b) return (a||b)
  const pa = room.players.get(a)
  const pb = room.players.get(b)
  const r = judge(pa.moved, pb.moved)
  if(r===null) return null
  return r==='A'? a : b
}
function advanceIfReady(room){
  let changed=false
  for(const pair of room.currentPairs){
    if(!allMovesIn(room,pair)) continue
    const w = resolvePair(room,pair)
    if(w===null){ resetMoves(room,pair); continue }
    room.winnersQueue.push(w); changed=true
  }
  const done = room.currentPairs.every(p => allMovesIn(room,p) && resolvePair(room,p)!==null)
  if(done){
    const w = [...room.winnersQueue]; room.winnersQueue = []
    if(w.length===1){ room.phase='finished'; return { champion:w[0] } }
    const next=[]; for(let i=0;i<w.length;i+=2) next.push([w[i], w[i+1] ?? null])
    room.currentPairs = next; room.round += 1
    room.currentPairs.forEach(pair => resetMoves(room,pair))
    return { nextRound:true }
  }
  return { changed }
}

// ----- Event handler -----
async function handleEvent(event){
  if(event.type !== 'message' || event.message.type !== 'text') return
  const text = (event.message.text || '').trim()
  const source = event.source
  if(source.type !== 'group' && source.type !== 'supergroup'){
    await client.replyMessage(event.replyToken, { type:'text', text:'โปรดเชิญบอทเข้ากลุ่ม แล้วพิมพ์: rps start' })
    return
  }

  const groupId = source.groupId
  const room = ensureRoom(groupId)
  let profileName = 'Player'
  try {
    const prof = await client.getProfile(event.source.userId)
    profileName = prof.displayName || profileName
  } catch {}

  const [cmd, sub, ...rest] = text.split(/\s+/)
  if((cmd||'').toLowerCase() !== 'rps') return

  switch((sub||'').toLowerCase()){
    case 'start': {
      rooms.set(groupId, { phase:'lobby', players:new Map(), round:0, currentPairs:[], winnersQueue:[] })
      await client.replyMessage(event.replyToken, flexLobby(ensureRoom(groupId), 'RPS Tournament — เปิดล็อบบี้'))
      break
    }
    case 'join': {
      const name = rest.join(' ') || profileName
      const r = ensureRoom(groupId)
      r.players.set(event.source.userId, { name, alive:true })
      await client.replyMessage(event.replyToken, flexLobby(r, 'เข้าร่วมสำเร็จ!'))
      break
    }
    case 'leave': {
      room.players.delete(event.source.userId)
      await client.replyMessage(event.replyToken, flexLobby(room, 'ออกจากการแข่งขันแล้ว'))
      break
    }
    case 'list': {
      await client.replyMessage(event.replyToken, flexLobby(room, 'รายชื่อผู้เล่น'))
      break
    }
    case 'begin': {
      if(room.players.size < 2){
        await client.replyMessage(event.replyToken, { type:'text', text:'ต้องมีอย่างน้อย 2 คน' })
        break
      }
      beginTournament(room)
      await client.replyMessage(event.replyToken, [
        { type:'text', text:`เริ่มการแข่งขัน! ผู้เล่น ${aliveCount(room)} คน` },
        flexBracket(room)
      ])
      for(const pair of room.currentPairs){
        await client.pushMessage(groupId, flexMatchCard(room, pair[0], pair[1]))
      }
      break
    }
    case 'move': {
      if(room.phase !== 'in_progress'){
        await client.replyMessage(event.replyToken, { type:'text', text:'ยังไม่ได้เริ่ม / จบไปแล้ว' })
        break
      }
      const choice = (rest[0]||'').toLowerCase()
      if(!['rock','paper','scissors'].includes(choice)){
        await client.replyMessage(event.replyToken, { type:'text', text:'โปรดเลือก: rock / paper / scissors' })
        break
      }
      const participating = room.currentPairs.some(([a,b]) => a===event.source.userId || b===event.source.userId)
      if(!participating){
        await client.replyMessage(event.replyToken, { type:'text', text:'ยังไม่มีคู่ของคุณในรอบนี้' })
        break
      }
      room.players.get(event.source.userId).moved = choice
      const pair = room.currentPairs.find(([a,b]) => a===event.source.userId || b===event.source.userId)
      await client.replyMessage(event.replyToken, flexMatchCard(room, pair[0], pair[1]))

      const step = advanceIfReady(room)
      if(step?.champion){
        const name = room.players.get(step.champion)?.name || 'Champion'
        await client.pushMessage(groupId, [ flexBracket(room), flexChampion(name) ])
      } else if(step?.nextRound){
        await client.pushMessage(groupId, [ { type:'text', text:`เข้าสู่รอบ ${room.round}!` }, flexBracket(room) ])
        for(const p of room.currentPairs){
          await client.pushMessage(groupId, flexMatchCard(room, p[0], p[1]))
        }
      }
      break
    }
    case 'status': {
      if(room.phase === 'lobby') await client.replyMessage(event.replyToken, flexLobby(room, 'Lobby'))
      else if(room.phase === 'in_progress') await client.replyMessage(event.replyToken, flexBracket(room))
      else await client.replyMessage(event.replyToken, { type:'text', text:'การแข่งขันจบแล้ว (rps start เพื่อเริ่มใหม่)' })
      break
    }
    case 'reset': {
      rooms.delete(groupId)
      await client.replyMessage(event.replyToken, { type:'text', text:'รีเซ็ตแล้ว — พิมพ์ rps start เพื่อเริ่มใหม่' })
      break
    }
    default: {
      await client.replyMessage(event.replyToken, {
        type:'text',
        text:[
          'คำสั่งใช้งาน:',
          '• rps start',
          '• rps join <ชื่อ?>',
          '• rps list',
          '• rps begin',
          '• rps move rock|paper|scissors',
          '• rps status',
          '• rps reset',
        ].join('\n')
      })
    }
  }
}

// ----- Webhook (use LINE middleware ONLY here) -----
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : []
    if (events.length) await Promise.all(events.map(handleEvent))
    return res.sendStatus(200)       // สำคัญ: ตอบ 200 เสมอ (Verify จะผ่าน)
  } catch (e) {
    console.error('Webhook error:', e)
    return res.sendStatus(200)
  }
})

// ----- Healthcheck -----
app.get('/', (_req, res) => res.send('RPS Tournament Bot is running.'))

// ----- Start server -----
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
