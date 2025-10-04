// ========== FLEX + FALLBACK ==========

// สร้าง Flex Bubble สำหรับประกาศรอบ
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

// ส่ง Flex แบบแบ่งหน้าอัตโนมัติ (≤10 บรรทัด/บับเบิล)
// ถ้า Flex ล้ม จะ fallback เป็นข้อความธรรมดา
async function tryPushFlexOrText(to, title, lines) {
  const MAX_LINES_PER_BUBBLE = 10;
  const chunks = [];
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_BUBBLE) {
    chunks.push(lines.slice(i, i + MAX_LINES_PER_BUBBLE));
  }
  try {
    for (let i = 0; i < chunks.length; i++) {
      const pageTitle = chunks.length > 1
        ? `${title} (หน้า ${i + 1}/${chunks.length})`
        : title;
      await client.pushMessage(to, [buildFlexRoundPairs(pageTitle, chunks[i])]);
    }
  } catch (err) {
    console.error('Flex ส่งไม่ผ่าน, fallback เป็นข้อความธรรมดา:', err?.response?.data || err);
    const text = [title, ...lines].join('\n');
    await safePush(to, { type: 'text', text });
  }
}

// ประกาศคู่รอบใหม่ (Pools)
async function announcePoolsRound(gid, room, headText) {
  const lines = [];
  for (const k of POOLS) {
    if (!room.bracket.pools[k].length) continue;
    lines.push(`สาย ${k}`);
    room.bracket.pools[k].forEach((m, i) =>
      lines.push(`  Match ${i + 1}: ${pretty(room, m.a)} vs ${pretty(room, m.b)}`));
  }

  await tryPushFlexOrText(gid, headText, lines.length ? lines : ['(ไม่มีคู่ในรอบนี้)']);

  // ส่ง DM ให้ผู้เล่นเลือกหมัด
  for (const k of POOLS) {
    for (const m of room.bracket.pools[k]) {
      for (const uid of [m.a, m.b]) {
        if (!uid) continue;
        userToGroup.set(uid, gid);
        await safePush(uid, [{
          type: 'text',
          text: `📝 รอบสาย ${k} — เลือกหมัด (rock/paper/scissors)`,
          quickReply: qr()
        }]);
      }
    }
  }
}


// ========== แก้เฉพาะใน switch(action): case 'close' ==========

case 'close': {
  if (room.phase !== 'register') {
    await safeReply(e.replyToken, { type: 'text', text: 'ยังไม่ได้เปิดรับสมัคร' });
    break;
  }
  if (room.players.size < 2) {
    await safeReply(e.replyToken, { type: 'text', text: 'ต้องมีอย่างน้อย 2 คน' });
    break;
  }

  // สุ่มและจับคู่
  const ids = [...room.players.keys()];
  if (ids.length % 2 === 1) room.bracket.waitingOdd = ids.pop();
  room.bracket.pools = seedPoolsFrom(room, ids);
  room.bracket.round = 1;
  room.phase = 'playing';
  room.stage = 'pools';

  // ✅ ส่งหัวข้อธรรมดาก่อน (กัน Flex ล้มแล้วเงียบ)
  await safePush(gid, {
    type: 'text',
    text: `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`
  });

  // ✅ ประกาศรอบด้วย Flex (มี fallback ในตัว)
  await announcePoolsRound(gid, room, `📣 Match ${room.bracket.round} เริ่มแล้ว (ผู้เล่น ${room.players.size})`);
  break;
}
