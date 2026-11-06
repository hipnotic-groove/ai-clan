// Сервер AI CLAN: отдаёт лендинг и пересылает вопросы из чата в OpenRouter.
// Запуск: npm start  (или node script.js), затем открыть http://localhost:3000
// Нужен Node.js 18+ и файл .env со строкой OPENROUTER_API_KEY=твой_ключ

require('dotenv').config(); // читает .env и кладёт значения в process.env

const http = require('node:http');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

// Настройки. Все значения приходят из переменных окружения (файл .env), кроме API_URL.
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free';
// Файл страницы лежит рядом со скриптом; сервер отдаёт только его
const INDEX_PATH = path.join(__dirname, 'index.html');
// Сколько прокси стоит перед сервером (0 — сервер доступен напрямую).
// Нужно, чтобы лимит запросов считался по реальному IP посетителя, а не по IP прокси.
const TRUST_PROXY = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY)) || 0);

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

// Без ключа сервер бесполезен — останавливаемся сразу, а не при первом вопросе в чате
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
// Хранилище лимита: IP посетителя -> массив времён его запросов за последнюю минуту.
// Лежит в памяти процесса: при перезапуске обнуляется и не общее между несколькими экземплярами сервера.
const hits = new Map(); // ip -> время последних запросов

// Записывает новый запрос и возвращает true, если за окно RATE_WINDOW_MS
// с этого IP пришло больше RATE_LIMIT запросов (включая текущий).
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
// IP посетителя. X-Forwarded-For можно подделать, поэтому берём запись, добавленную
// ближайшим доверенным прокси (считая с конца), а не первую из списка.
function getClientIp(req) {
  if (TRUST_PROXY > 0) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - TRUST_PROXY];
    if (ip) return ip;
  }
  return req.socket.remoteAddress;
}

// Заголовки безопасности для всех ответов
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// CSP для страницы: скрипты и стили только с одноразовым nonce, запросы только на свой сервер
function buildCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Отправляет JSON-ответ. Все ответы API (и успешные, и ошибки) идут через эту функцию.
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// Читает тело запроса по частям и разбирает его как JSON.
// Если тело больше MAX_BODY_BYTES — отклоняет запрос с кодом 413, при невалидном JSON — с кодом 400.
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
// Возвращает очищенный массив { role, content }: не больше MAX_HISTORY последних сообщений,
// только роль user, непустой текст не длиннее MAX_MESSAGE_CHARS.
// Тело запроса приходит из браузера, поэтому доверять ему нельзя — проверяем всё заново.
// Роль assistant от клиента не принимаем: иначе посетитель мог бы подделать «ответы ИИ»
// и увести модель из заданной роли. Ответы модели сервер в историю не возвращает.
function validateMessages(body) {
  const list = body?.messages;
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, 'Нужен непустой массив messages');
  }

  const messages = list.slice(-MAX_HISTORY).map((m) => {
    const validRole = m?.role === 'user';
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!validRole || !content) throw new HttpError(400, 'Некорректное сообщение в истории');
    return { role: m.role, content: content.slice(0, MAX_MESSAGE_CHARS) };
  });

  return messages;
}

/* ───────── Запрос к OpenRouter ───────── */
// Отправляет историю в OpenRouter и возвращает текст ответа модели.
// Системная инструкция (SYSTEM_PROMPT) добавляется только здесь, на сервере, браузер её не видит.
// Ключ API уходит только в заголовке Authorization и никогда не попадает в ответ посетителю.
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

  // Тело ответа может быть не JSON (например, страница ошибки прокси) — тогда data будет null
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    // Подробности пишем только в консоль сервера, посетителю — понятный текст
    console.error(`Ошибка OpenRouter (${response.status}):`, data?.error?.message || response.statusText);
    if (response.status === 429) {
      throw new HttpError(429, 'ИИ сейчас перегружен. Подожди немного и спроси снова.');
    }
    throw new HttpError(502, 'ИИ временно недоступен. Попробуй позже.');
  }

  // Формат ответа OpenRouter совпадает с OpenAI: текст лежит в choices[0].message.content
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new HttpError(502, 'ИИ вернул пустой ответ. Попробуй переформулировать вопрос.');
  return reply;
}

/* ───────── Сервер ───────── */
// Единая точка входа: все запросы проходят через этот обработчик.
// Ошибки, брошенные как HttpError, превращаются в JSON { error } с нужным кодом в блоке catch ниже.
const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  try {
    // Адрес разбираем внутри try: кривой путь (например, «//») бросает исключение,
    // а исключение вне try роняло весь сервер
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      throw new HttpError(400, 'Некорректный адрес запроса');
    }

    // Страница сайта. Отдаём только index.html, остальные файлы папки (включая .env) недоступны
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const nonce = crypto.randomBytes(16).toString('base64');
      const html = (await fs.readFile(INDEX_PATH, 'utf8'))
        .replace(/<(script|style)>/g, `<$1 nonce="${nonce}">`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': buildCsp(nonce),
      });
      res.end(html);
      return;
    }

    // Маршрут чата: проверка метода -> лимит запросов -> чтение тела -> валидация -> запрос к модели
    // Чат
    if (pathname === '/api/chat') {
      if (req.method !== 'POST') throw new HttpError(405, 'Используй метод POST');
      if (isRateLimited(getClientIp(req))) {
        throw new HttpError(429, 'Слишком много вопросов подряд. Передохни минутку.');
      }
      const body = await readJson(req);
      const reply = await askModel(validateMessages(body));
      sendJson(res, 200, { reply });
      return;
    }

    // Любой другой путь (включая /.env и другие файлы папки) — 404
    throw new HttpError(404, 'Страница не найдена');
  } catch (err) {
    // HttpError — ожидаемая ошибка с текстом для посетителя; всё остальное считаем сбоем сервера
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    // Если ответ уже начали отправлять, второй раз заголовки писать нельзя — просто закрываем
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, status, { error: status === 500 ? 'Ошибка сервера' : err.message });
  }
});

// Страховка на случай ошибки, которую не поймал ни один try/catch.
// Необработанный reject только логируем — сервер продолжает работать.
process.on('unhandledRejection', (reason) => {
  console.error('Необработанная ошибка (promise):', reason);
});
// После неожиданного исключения состояние процесса неизвестно: пишем в лог и перезапускаем
// (менеджер процессов — pm2, systemd, Docker — поднимет сервер заново).
process.on('uncaughtException', (err) => {
  console.error('Неожиданное исключение:', err);
  process.exit(1);
});

// Запуск: слушаем порт и выводим в консоль адрес и модель
server.listen(PORT, () => {
  console.log(`AI CLAN запущен: http://localhost:${PORT}`);
  console.log(`Модель: ${MODEL}`);
  if (TRUST_PROXY > 0) console.log(`Доверяем прокси: ${TRUST_PROXY} (IP берётся из X-Forwarded-For)`);
});
