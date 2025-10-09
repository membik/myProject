// ===================== server.js =====================
// ВСЕГДА в самом начале
import 'dotenv/config';

console.log("YANDEX_API_KEY:", process.env.YANDEX_API_KEY);
console.log("YANDEX_FOLDER_ID:", process.env.YANDEX_FOLDER_ID);

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fetch from 'node-fetch';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const PORT = process.env.PORT || 8080;
const USER_CHATS_DIR = path.join(__dirname, 'UserChats');

if (!fs.existsSync(USER_CHATS_DIR)) fs.mkdirSync(USER_CHATS_DIR, { recursive: true });

// HTTPS агент для самоподписанных сертификатов
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ======== GigaChat: получение токена ========
async function getAccessToken() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const RqUID = crypto.randomUUID();

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'GIGACHAT_API_PERS');

  try {
    const res = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${authHeader}`,
        'RqUID': RqUID
      },
      body: params.toString(),
      agent: httpsAgent
    });

    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.error("Ошибка получения токена GigaChat:", err.message);
    return null;
  }
}

// ======== Работа с историей чатов ========
function getUserHistoryFile(userId) {
  return path.join(USER_CHATS_DIR, `${userId}.json`);
}

function readHistory(userId) {
  const file = getUserHistoryFile(userId);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeHistory(userId, history) {
  fs.writeFileSync(getUserHistoryFile(userId), JSON.stringify(history, null, 2));
}

// ======== Отправка сообщений в GigaChat ========
async function sendMessageToGigaChat(history) {
  const token = await getAccessToken();
  if (!token) return "Извини, ИИ сейчас недоступен.";

  try {
    const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        model: 'GigaChat',
        messages: history,
        stream: false,
        repetition_penalty: 1
      }),
      agent: httpsAgent
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "Извини, ИИ сейчас недоступен.";
  } catch (err) {
    console.error("Ошибка запроса к GigaChat:", err.message);
    return "Извини, ИИ сейчас недоступен.";
  }
}

// ======== Yandex TTS ========
async function synthesizeSpeech(text, voice = 'oksana') {
  if (!process.env.YANDEX_API_KEY) {
    console.error("YANDEX_API_KEY не задан!");
    return null;
  }

  try {
    const res = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${process.env.YANDEX_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ text, voice, format: 'mp3' })
    });

    if (!res.ok) {
      const error = await res.json();
      console.error("Ошибка синтеза речи:", error);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
  } catch (err) {
    console.error("Ошибка синтеза речи:", err.message);
    return null;
  }
}

// ======== Yandex STT ========
const upload = multer();
app.post('/api/speechToText', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет аудиофайла' });
  if (!process.env.YANDEX_API_KEY || !process.env.YANDEX_FOLDER_ID) {
    return res.status(500).json({ error: 'YANDEX_API_KEY или YANDEX_FOLDER_ID не заданы' });
  }

  try {
    const response = await fetch(
      `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${process.env.YANDEX_FOLDER_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Api-Key ${process.env.YANDEX_API_KEY}`,
          'Content-Type': 'application/octet-stream'
        },
        body: req.file.buffer
      }
    );

    const data = await response.json();
    if (data.error_code) {
      return res.status(500).json({ error: data.error_message || 'Ошибка распознавания' });
    }

    res.json({ text: data.result });
  } catch (err) {
    console.error("Ошибка SpeechKit STT:", err.message);
    res.status(500).json({ error: 'Ошибка распознавания' });
  }
});

// ======== API для чата ========
app.post('/api/sendMessage', async (req, res) => {
  const { userId, message, voice } = req.body;
  if (!message || !userId) return res.status(400).json({ reply: "Сообщение пустое или нет userId" });

  const history = readHistory(userId);
  history.push({ role: 'user', content: message });

  const replyText = await sendMessageToGigaChat(history);
  history.push({ role: 'assistant', content: replyText });
  writeHistory(userId, history);

  const audioBase64 = await synthesizeSpeech(replyText, voice || 'oksana');
  res.json({ reply: replyText, audio: audioBase64 });
});

// ======== API для уроков (TTS) ========
app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'Нет текста для синтеза' });

  const audioBase64 = await synthesizeSpeech(text, voice || 'oksana');
  if (!audioBase64) return res.status(500).json({ error: 'Ошибка синтеза речи' });

  res.json({ audio: audioBase64 });
});

// ======== Главная страница ========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// ======== Запуск сервера ========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
