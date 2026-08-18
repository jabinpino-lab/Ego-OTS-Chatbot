const DOC_URL = 'https://docs.google.com/document/d/e/2PACX-1vQ1DmC2uLSCJNeF09RqfZ2Qxok-ksDUomACwpGcZE-mt6dqdyrOXvNzV2d1vNwUh8cpPsO5aGQZvisL/pub';
const SOURCE_CACHE_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 3;
const MIN_REQUEST_GAP_MS = 8 * 1000;

let sourceCache = { text: '', expiresAt: 0 };
const requestBuckets = new Map();

async function loadSource() {
  const now = Date.now();
  if (sourceCache.text && sourceCache.expiresAt > now) return sourceCache.text;
  const response = await fetch(DOC_URL, { redirect: 'follow', cache: 'no-store' });
  if (!response.ok) throw new Error(`Unable to read the published EGO OTS Google Doc (${response.status}).`);
  const text = await response.text();
  if (!text.trim()) throw new Error('The published EGO OTS Google Doc returned empty content.');
  sourceCache = { text: text.slice(0, 100000), expiresAt: now + SOURCE_CACHE_MS };
  return sourceCache.text;
}

function getKey(name) {
  const raw = String(process.env[name] || '').trim();
  return raw.split(/\s+/)[0] || '';
}

function getGeminiKeys() {
  const many = String(process.env.GEMINI_API_KEYS || '').split(',').map(v => v.trim()).filter(Boolean);
  const one = getKey('GEMINI_API_KEY');
  return [...new Set([...many, one].filter(Boolean))];
}

function getClientId(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'anonymous').split(',')[0].trim().slice(0, 100);
}

function checkRateLimit(clientId) {
  const now = Date.now();
  const bucket = requestBuckets.get(clientId) || { timestamps: [], lastRequest: 0 };
  bucket.timestamps = bucket.timestamps.filter(t => now - t < REQUEST_WINDOW_MS);
  if (now - bucket.lastRequest < MIN_REQUEST_GAP_MS) return { ok: false, retryAfter: Math.ceil((MIN_REQUEST_GAP_MS - (now - bucket.lastRequest)) / 1000), message: 'Please wait a few seconds before sending another OTS question.' };
  if (bucket.timestamps.length >= MAX_REQUESTS_PER_WINDOW) return { ok: false, retryAfter: Math.ceil((REQUEST_WINDOW_MS - (now - bucket.timestamps[0])) / 1000), message: 'You have reached the short-term OTS request limit. Please wait a moment before trying again.' };
  bucket.timestamps.push(now); bucket.lastRequest = now; requestBuckets.set(clientId, bucket);
  return { ok: true };
}

function normalizeMessages(messages) {
  return Array.isArray(messages) ? messages.slice(-10).map(m => {
    const parts = [{ text: String(m.content || '').slice(0, 8000) }];
    if (m.image && typeof m.image === 'string') {
      const match = m.image.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
      if (match) parts.push({ inlineData: { mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1], data: match[2] } });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  }) : [];
}

function systemPrompt(source) {
  return `You are the EGO OTS Chatbot and work assistant. Your single source of truth for EGO OTS questions is the published Google Doc content below. Follow it strictly. Do not invent, infer, or replace OTS rules with generic knowledge. If the source does not contain enough information, say so clearly. If a newer rule conflicts with an older rule, follow the newer rule. When reviewing a description, answer directly first, state whether it is Correct, Incorrect, or Needs Adjustment, explain the relevant OTS rule, and give a corrected version when needed. Preserve source terminology. If a screenshot is supplied, describe only what is visibly supported and separate visual observations from OTS requirements.\n\nEGO OTS SOURCE DOCUMENT:\n${source}`;
}

async function callGemini(key, system, contents) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 900, temperature: 0.15 } })
  });
  const data = await response.json();
  if (response.ok) return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'No response was returned.';
  if (response.status === 429 || /quota|rate limit/i.test(data?.error?.message || '')) throw new Error('QUOTA');
  if (response.status === 401 || response.status === 403) throw new Error('AUTH');
  throw new Error(data?.error?.message || 'Gemini request failed.');
}

async function callOpenRouter(system, contents) {
  const key = getKey('OPENROUTER_API_KEY');
  if (!key) throw new Error('NO_FALLBACK');
  const messages = [{ role: 'system', content: system }, ...contents.map(m => ({ role: m.role, content: m.parts.filter(p => p.text).map(p => p.text).join('\n') }))];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'openrouter/free', messages, max_tokens: 900, temperature: 0.15 })
  });
  const data = await response.json();
  if (response.ok) return data?.choices?.[0]?.message?.content || 'No response was returned.';
  throw new Error(data?.error?.message || 'Fallback AI request failed.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const clientId = getClientId(req);
  const limit = checkRateLimit(clientId);
  if (!limit.ok) { res.setHeader('Retry-After', String(limit.retryAfter)); return res.status(429).json({ error: limit.message, retryAfter: limit.retryAfter }); }
  try {
    const source = await loadSource();
    const { messages = [] } = req.body || {};
    const contents = normalizeMessages(messages);
    const system = systemPrompt(source);
    let text = '';
    let usedFallback = false;
    for (const key of getGeminiKeys()) {
      try { text = await callGemini(key, system, contents); break; } catch (e) { if (e.message !== 'QUOTA') throw e; }
    }
    if (!text) {
      try { text = await callOpenRouter(system, contents); usedFallback = true; }
      catch (e) {
        if (e.message === 'NO_FALLBACK') return res.status(429).json({ error: 'The OTS assistant has temporarily reached its Gemini quota. Please try again later.' });
        return res.status(503).json({ error: 'The primary AI quota is temporarily unavailable and the fallback service is unavailable. Please try again later.' });
      }
    }
    return res.status(200).json({ text, provider: usedFallback ? 'fallback' : 'gemini' });
  } catch (error) {
    if (error.message === 'AUTH') return res.status(503).json({ error: 'The OTS assistant API key is unavailable or not authorized.' });
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
