import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// simple reply test
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.toLowerCase();
        if (text === 'ping') {
          await client.replyMessage(event.replyToken, [{ type: 'text', text: 'pong ✅' }]);
        } else if (text.startsWith('rps start')) {
          await client.replyMessage(event.replyToken, [{ type: 'text', text: 'เริ่ม RPS แล้ว!' }]);
        } else {
          await client.replyMessage(event.replyToken, [{ type: 'text', text: 'ฉันยังไม่เข้าใจคำสั่งนี้ 🤖' }]);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => res.send('✅ LINE Bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
