// Сервер AI CLAN: отдаёт лендинг и пересылает вопросы из чата в OpenRouter.
// Запуск: npm start  (или node script.js), затем открыть http://localhost:3000
// Нужен Node.js 18+ и файл .env со строкой OPENROUTER_API_KEY=твой_ключ

require('dotenv').config(); // читает .env и кладёт значения в process.env

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free';
const INDEX_PATH = path.join(__dirname, 'index.html');

// Инструкция для модели: кто она и как отвечать
const SYSTEM_PROMPT = [
  'Ты — ИИ-помощник сообщества AI CLAN.',
  'AI CLAN помогает людям войти в IT и научиться управлять нейросетями: ставить им задачи,',
  'проверять результат и превращать идеи в работающие продукты.',
  'Отвечай на русском языке, дружелюбно и по делу, обычно не длиннее 5–6 предложений.',
  'Не придумывай факты о клане: цен, дат и обещаний, которых нет в этом описании.',
].join(' ');

// Ограничения, чтобы сервер нельзя было легко перегрузить
const MAX_BODY_BYTES = 32 * 1024;   // максимальный размер запроса
const MAX_HISTORY = 10;             // сколько последних сообщений отправляем модели
const MAX_MESSAGE_CHARS = 4000;     // обрезаем слишком длинные сообщения
const RATE_LIMIT = 15;              // запросов к чату...
const RATE_WINDOW_MS = 60_000;      // ...за минуту с одного IP
const UPSTREAM_TIMEOUT_MS = 30_000; // сколько ждём ответа от OpenRouter

if (!API_KEY) {
  console.error('Ключ не найден. Добавь в файл .env строку: OPENROUTER_API_KEY=твой_ключ');
  process.exit(1);
}

// Ошибка, которую можно безопасно показать посетителю
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ───────── Простое ограничение частоты запросов ───────── */
const hits = new Map(); // ip -> время последних запросов

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// Раз в минуту убираем старые записи, чтобы память не росла
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (now - times[times.length - 1] > RATE_WINDOW_MS) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

/* ───────── Помощники ───────── */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;

    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        reject(new HttpError(413, 'Слишком длинный запрос'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });

    req.on('error', reject);
  });
}

// Проверяем историю сообщений, которую прислал браузер
function validateMessages(body) {
  const list = body?.messages;
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, 'Нужен непустой массив messages');
  }

  const messages = list.slice(-MAX_HISTORY).map((m) => {
    const validRole = m?.role === 'user' || m?.role === 'assistant';
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!validRole || !content) throw new HttpError(400, 'Некорректное сообщение в истории');
    return { role: m.role, content: content.slice(0, MAX_MESSAGE_CHARS) };
  });

  if (messages[messages.length - 1].role !== 'user') {
    throw new HttpError(400, 'Последнее сообщение должно быть от пользователя');
  }
  return messages;
}

/* ───────── Запрос к OpenRouter ───────── */
async function askModel(messages) {
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'AI CLAN',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('OpenRouter не ответил:', err.message);
    throw new HttpError(504, 'ИИ не ответил вовремя. Попробуй ещё раз.');
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    // Подробности пишем только в консоль сервера, посетителю — понятный текст
    console.error(`Ошибка OpenRouter (${response.status}):`, data?.error?.message || response.statusText);
    if (response.status === 429) {
      throw new HttpError(429, 'ИИ сейчас перегружен. Подожди немного и спроси снова.');
    }
    throw new HttpError(502, 'ИИ временно недоступен. Попробуй позже.');
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new HttpError(502, 'ИИ вернул пустой ответ. Попробуй переформулировать вопрос.');
  return reply;
}

/* ───────── Сервер ───────── */
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    // Страница сайта. Отдаём только index.html, остальные файлы папки (включая .env) недоступны
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await fs.readFile(INDEX_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Чат
    if (pathname === '/api/chat') {
      if (req.method !== 'POST') throw new HttpError(405, 'Используй метод POST');
      if (isRateLimited(req.socket.remoteAddress)) {
        throw new HttpError(429, 'Слишком много вопросов подряд. Передохни минутку.');
      }
      const body = await readJson(req);
      const reply = await askModel(validateMessages(body));
      sendJson(res, 200, { reply });
      return;
    }

    throw new HttpError(404, 'Страница не найдена');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? 'Ошибка сервера' : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`AI CLAN запущен: http://localhost:${PORT}`);
  console.log(`Модель: ${MODEL}`);
});
