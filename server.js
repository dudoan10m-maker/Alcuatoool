// V507 AI Vision backend — Node.js 20+, no API key in the browser.
// Configure ANTHROPIC_API_KEY, ALLOWED_ORIGIN, PORT in environment.
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_BODY = 8 * 1024 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const buckets = new Map();

if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

function send(res, status, body, origin) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(origin ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {})
  });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start >= WINDOW_MS) b = { start: now, count: 0 };
  b.count++; buckets.set(ip, b);
  return b.count <= MAX_REQUESTS_PER_WINDOW;
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (origin && ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { error: 'Origin not allowed' });
  const corsOrigin = origin && (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) ? origin : '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, 'vary': 'Origin' } : {}),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600'
    });
    return res.end();
  }
  if (path !== '/api/ai') return send(res, 404, { error: 'Not found' }, corsOrigin);
  if (req.method === 'GET') return send(res, 200, { ok: true, service: 'v507-ai-vision' }, corsOrigin);
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, corsOrigin);
  if (!rateLimit(req)) return send(res, 429, { error: 'Rate limit exceeded' }, corsOrigin);
  try {
    const body = await readJson(req);
    const messages = body && Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length < 1 || messages.length > 2) return send(res, 400, { error: 'Invalid messages' }, corsOrigin);
    const content = messages[0] && messages[0].content;
    if (!Array.isArray(content) || content.length > 5) return send(res, 400, { error: 'Invalid content' }, corsOrigin);
    let imageCount = 0;
    for (const item of content) {
      if (item && item.type === 'image' && item.source && item.source.type === 'base64') {
        imageCount++;
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(item.source.media_type) || typeof item.source.data !== 'string' || item.source.data.length > 3_500_000) {
          return send(res, 400, { error: 'Invalid image payload' }, corsOrigin);
        }
      } else if (!(item && item.type === 'text' && typeof item.text === 'string' && item.text.length <= 2000)) {
        return send(res, 400, { error: 'Unsupported content item' }, corsOrigin);
      }
    }
    if (imageCount < 1) return send(res, 400, { error: 'At least one image is required' }, corsOrigin);
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(Math.max(Number(body.max_tokens) || 32, 1), 64),
        temperature: 0,
        messages: [{ role: 'user', content }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await upstream.json().catch(() => ({}));
    return send(res, upstream.status, data, corsOrigin);
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
    return send(res, status, { error: status === 500 ? 'Backend request failed' : err.message }, corsOrigin);
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`V507 AI backend listening on ${PORT}`));
