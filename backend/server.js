import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fetch from 'node-fetch';
import https from 'https';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

// ======== Настройка окружения ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const upload = multer(); // для загрузки аудио
const PORT = process.env.PORT || 8080;
const USER_CHATS_DIR = path.join(__dirname, 'UserChats');

// ======== Проверка YANDEX_API_KEY ========
const YANDEX_KEY = process.env.YANDEX_API_KEY || null;
if (!YANDEX_KEY) {
  console.error('FATAL: YANDEX_API_KEY не задан. Установите переменную окружения YANDEX_API_KEY в .env');
  process.exit(1);
}
const maskedKey = YANDEX_KEY.length > 8 ? `${YANDEX_KEY.slice(0,4)}...${YANDEX_KEY.slice(-4)}` : '***';
console.log('YANDEX_API_KEY обнаружен (masked):', maskedKey);

// ======== Папка для истории чатов ========
if (!fs.existsSync(USER_CHATS_DIR)) fs.mkdirSync(USER_CHATS_DIR, { recursive: true });

// ======== HTTPS Agent для самоподписанных сертификатов ========
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

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

// ======== GigaChat ========
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

// ======== Синтез речи ========
async function synthesizeSpeech(text, voice = 'oksana') {
  try {
    const res = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${YANDEX_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ text, voice, format: 'mp3' }),
      agent: httpsAgent
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Ошибка синтеза речи:", res.status, errBody);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
  } catch (err) {
    console.error("Ошибка синтеза речи:", err.message);
    return null;
  }
}

// ======== Распознавание речи ========
async function convertToOgg(buffer) {
  const tempInput = path.join(USER_CHATS_DIR, `input-${crypto.randomUUID()}.webm`);
  const tempOutput = path.join(USER_CHATS_DIR, `output-${crypto.randomUUID()}.ogg`);
  fs.writeFileSync(tempInput, buffer);

  return new Promise((resolve, reject) => {
    ffmpeg(tempInput)
      .setFfmpegPath(ffmpegPath)
      .outputOptions(['-c:a libopus'])
      .save(tempOutput)
      .on('end', () => {
        const oggBuffer = fs.readFileSync(tempOutput);
        fs.unlinkSync(tempInput);
        fs.unlinkSync(tempOutput);
        resolve(oggBuffer);
      })
      .on('error', err => {
        fs.unlinkSync(tempInput);
        reject(err);
      });
  });
}

async function recognizeSpeech(audioBuffer) {
  try {
    const oggBuffer = await convertToOgg(audioBuffer);

    const res = await fetch('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${YANDEX_KEY}`,
        'Content-Type': 'audio/ogg;codecs=opus'
      },
      body: oggBuffer,
      agent: httpsAgent
    });

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (data.result) return data.result;
      console.error('STT вернул ошибку:', data);
      return null;
    } catch (e) {
      console.error('Неправильный ответ от STT (не JSON):', text);
      return null;
    }
  } catch (err) {
    console.error("Ошибка распознавания речи:", err.message);
    return null;
  }
}

// ======== API ========
app.post('/api/sendMessage', async (req, res) => {
  const { userId, message, voice } = req.body;
  if (!message || !userId)
    return res.status(400).json({ reply: "Сообщение пустое или нет userId" });

  const history = readHistory(userId);
  history.push({ role: 'user', content: message });

  const replyText = await sendMessageToGigaChat(history);
  history.push({ role: 'assistant', content: replyText });
  writeHistory(userId, history);

  const audioBase64 = await synthesizeSpeech(replyText, voice || 'oksana');
  res.json({ reply: replyText, audio: audioBase64 });
});

app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'Нет текста для синтеза' });

  const audioBase64 = await synthesizeSpeech(text, voice || 'oksana');
  if (!audioBase64) return res.status(500).json({ error: 'Ошибка синтеза речи' });

  res.json({ audio: audioBase64 });
});

app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет аудиофайла' });

  const text = await recognizeSpeech(req.file.buffer);
  if (!text) return res.status(500).json({ error: 'Ошибка распознавания речи' });

  res.json({ text });
});

// ======== Главная страница ========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// ======== Запуск ========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
