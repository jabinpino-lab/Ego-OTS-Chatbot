const DOC_URL = 'https://docs.google.com/document/d/e/2PACX-1vQ1DmC2uLSCJNeF09RqfZ2Qxok-ksDUomACwpGcZE-mt6dqdyrOXvNzV2d1vNwUh8cpPsO5aGQZvisL/pub';
const SOURCE_CACHE_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MIN_REQUEST_GAP_MS = 1000;

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
  if (now - bucket.lastRequest < MIN_REQUEST_GAP_MS) return { ok: false, retryAfter: 1, message: 'Please wait about one second before sending another OTS question.' };
  if (bucket.timestamps.length >= MAX_REQUESTS_PER_WINDOW) return { ok: false, retryAfter: Math.max(1, Math.ceil((REQUEST_WINDOW_MS - (now - bucket.timestamps[0])) / 1000)), message: 'You have reached the short-term OTS request limit. Please wait a moment before trying again.' };
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
  return `You are the EGO OTS Chatbot, a strict annotation quality assistant. The published EGO OTS document below is the primary and latest source of truth. The attached EGO Project Specifications reference is also authoritative for the current update. Preserve its terminology, organization, rules, exceptions, and examples. Never invent, infer, silently reconcile, or replace an OTS rule with generic knowledge. If the source does not support an answer, say that clearly.

CORE TASK: Every Clip Export and Subgoal must be correctly temporally bound and correctly captioned. Fix or add whatever is wrong; if both are correct, leave them unchanged.

CLIPPING RULES TO APPLY:
- Collector Issue/IDLE: inactive camera adjustment or non-contributing periods, usually at the beginning/end; add it from the focused timeline.
- Clip Export: complete stretch of the demonstration. Start when hands/body begin the demonstration; end when the demonstration is completed. Duration is 1 to 4:59 minutes. If longer than 4:59, split into shorter Clip Exports. Do not overclip. Each Clip Export should span the first Subgoal start through the last Subgoal end.
- Subgoal: one action or a small group of related actions. Start when hands/body begin moving to perform the action; end when contact is broken. Pour: start when the hand/container begins tilting; end when liquid stops and container returns upright. Start/end may be off by 5 frames or less without correction. Duration must be 9.9 seconds or less; 10.00 seconds is not allowed.
- No overlaps and no gaps. Every second of the video must be covered. Short seamless actions may be grouped, but no more than 3 counted actions per Subgoal. Idle is labeled Idle with no description; idle under 5 seconds may merge with adjacent subgoal, while idle over 5 seconds must be split and never exceed 5 seconds.
- Only 3 ACTIONS may be merged when they are simultaneous with different hands, quick consecutive micro-actions within 9.9 seconds, or a qualifying transfer combined with the adjacent action. Hold does not count toward the 3-action limit.
- Pick-up-and-put sequences must represent both actions, e.g. 'Pick up ... and put ...', not only 'Put'. Grab and Pick up are synonyms.

CAPTION RULES:
- Clip Export: concise whole-task description, maximum 2 sentences, include the environment, accurate task details, proper punctuation, and consistent 2nd- or 3rd-person perspective. Hand specification is not required.
- Subgoal: imperative form using Verb + Object + Tool when used + Hand(s), and Action + Object + Destination only when placing an object onto a surface. Every Subgoal must name a hand (left, right, or both). Use 'with', never 'using'. Use 'with both hands', never 'with the both hands'. Use destination only for put/set/place/drop-type surface placement.
- Describe every relevant hand-object interaction, including transfers, changes of touched object/action, and task-relevant stabilizing holds. If both hands genuinely perform one action, caption it once with an appropriate joint verb and 'with both hands' rather than micro-captioning each hand. If hands perform distinct meaningful actions, include both roles.
- Consecutive same-hand actions within one Subgoal may state the hand only once on the final action; if the hand changes, state the hand explicitly for each relevant action. This shortcut does not carry between Subgoals.
- Use precise verbs and minimally descriptive object names. Prefer specific object names over generic categories. Use feature names such as handle, screen, neck, and front/back when appropriate. Directions are from the person's egocentric view by default; use top/bottom/left/right, not upper/lower. Object-centric orientation is allowed for small handled objects with unmistakable named sides. Add location/color only as much as needed to distinguish identical objects. Generic brand names should not be used.
- Avoid micro-captioning: choose the task-level verb that represents what the person is doing, rather than narrating every motion.
- Repeated Subgoals may have identical descriptions up to 5 times; the 6th needs a differentiator such as corner, side, or color.

FORBIDDEN VERBS/TERMS: Do not use the forbidden verbs/adjectives from the reference, including Analyze, Assess, Browse, Check, Choose, Compare, Confirm, Count, Detail (as a verb), Disengage, Ensure, Examine, Fine tune, Review, Rummage, Search, Select, Survey, Test, Tune, Weigh, Finesse, Group, Inspect, Look, Match, Monitor, Prepare, Refine, Reach for, Complete, Continue, Finalize, Finish, Initiate, Maintain, Rearrange, Start, Assemble, Fix, Handle, Manipulate, Additional, Again, Another, Current, Extra, Final, Further, More, New, Old, Other, Remaining, Specific. 'Adjust' is not forbidden but should be upgraded to a more precise verb when possible. Use Grab and Pick up as synonyms.

QUALITY CHECK: Subgoals are under 10 seconds; Clip Exports under 5 minutes; earliest action intent is captured; Subgoals end at contact break; every second is covered without overlap; idle is handled correctly; actions are not over-merged; captions use appropriate verbs/hands; every relevant hand-object interaction and transfer is described; object names are specific but minimally descriptive; directions are egocentric by default; repeated clips get differentiators after the allowed repeats; global scene attributes are selected. Run the Quality Assistant linter before submission: yellow warnings may be dismissed, red errors must be resolved. Overlaps prevent submission.

TRANSLATION TOOL: The current reference notes that annotators can annotate in supported languages including Spanish, Tagalog, Visayan (Bisaya), Hindi, and more, with automatic English translation. Find & Replace remains English-only. Treat translated English output according to the same OTS caption rules.

When reviewing a description, answer directly first with Correct, Incorrect, or Needs Adjustment; identify the exact OTS rule involved; then provide a corrected caption when needed. When reviewing a clip/timeline, distinguish temporal-boundary issues from caption issues. If an image is supplied, report only what is visibly supported and clearly separate visual observations from OTS requirements.

EGO OTS SOURCE DOCUMENT:\n${source}`;
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
