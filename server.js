// Máy chủ nhỏ: nhận yêu cầu kiểu Anthropic từ tool, gọi Gemini, trả về đúng dạng tool đọc.
// Không cần cài thư viện nào. Biến môi trường: GEMINI_API_KEY (bắt buộc), GEMINI_MODEL (tùy chọn).
const http = require('http');
const PORT = process.env.PORT || 3000;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const hits = new Map(); // giới hạn 20 lần/phút/IP để khỏi bị xài lố hạn mức miễn phí

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}
function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}
function toGemini(body) {
  const parts = [];
  for (const m of body.messages || []) {
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    for (const p of c) {
      if (p.type === 'image' && p.source && p.source.data)
        parts.push({ inline_data: { mime_type: p.source.media_type || 'image/jpeg', data: p.source.data } });
      else if (p.type === 'text') parts.push({ text: p.text });
    }
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, maxOutputTokens: Math.min(body.max_tokens || 500, 1024), responseMimeType: 'application/json' }
  };
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (req.method === 'GET') return send(res, 200, { ok: true, model: MODEL, hasKey: !!KEY });
  if (req.method !== 'POST' || !/^\/(api\/ai)?\/?$/.test(req.url.split('?')[0])) return send(res, 404, { error: { message: 'Not found' } });
  if (!KEY) return send(res, 500, { error: { message: 'Máy chủ chưa có GEMINI_API_KEY' } });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, { error: { message: 'Quá nhiều yêu cầu, đợi một phút' } });
  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > 15e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      const r = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(toGemini(body))
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: { message: (d.error && d.error.message) || ('Gemini HTTP ' + r.status) } });
      const text = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map(p => p.text || '').join('\n');
      if (!text) return send(res, 502, { error: { message: 'Gemini không trả nội dung (có thể bị chặn)' } });
      send(res, 200, { content: [{ type: 'text', text }] });
    } catch (e) { send(res, 500, { error: { message: String(e.message || e) } }); }
  });
}).listen(PORT, () => console.log('AI backend chạy ở cổng', PORT));
