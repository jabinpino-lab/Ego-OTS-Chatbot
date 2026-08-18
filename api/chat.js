const GOOGLE_DOC_URL = 'https://docs.google.com/document/d/e/2PACX-1vQ1DmC2uLSCJNeF09RqfZ2Qxok-ksDUomACwpGcZE-mt6dqdyrOXvNzV2d1vNwUh8cpPsO5aGQZvisL/pub';
const DOC_PROXY_URL = `https://r.jina.ai/http://${GOOGLE_DOC_URL.replace(/^https?:\/\//, '')}`;

async function loadSource() {
  // Google Docs can return malformed redirect/header data to serverless fetch clients.
  // Jina Reader converts the public published document into clean text/Markdown.
  const response = await fetch(DOC_PROXY_URL, {
    method: 'GET',
    headers: { 'Accept': 'text/plain' },
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`Unable to read the published EGO OTS Google Doc through the document reader (${response.status}).`);
  }
  const text = await response.text();
  if (!text.trim()) throw new Error('The published EGO OTS Google Doc returned empty content.');
  return text.slice(0, 120000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Vercel.' });

  try {
    const source = await loadSource();
    const { messages = [] } = req.body || {};
    const safeMessages = Array.isArray(messages)
      ? messages.slice(-12).map(m => {
          const parts = [{ text: String(m.content || '').slice(0, 12000) }];
          if (m.image && typeof m.image === 'string') {
            const match = m.image.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
            if (match) parts.push({ inlineData: { mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1], data: match[2] } });
          }
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        })
      : [];

    const system = `You are the EGO OTS Chatbot and work assistant. Your single source of truth for EGO OTS questions is the published Google Doc content below. Follow it strictly. Do not invent, infer, or replace OTS rules with generic knowledge. If the source does not contain enough information, say so clearly. If a newer rule conflicts with an older rule, follow the newer rule. When reviewing a description, answer directly first, state whether it is Correct, Incorrect, or Needs Adjustment, explain the relevant OTS rule, and give a corrected version when needed. Preserve source terminology. If a screenshot is supplied, describe only what is visibly supported and separate visual observations from OTS requirements.\n\nEGO OTS SOURCE DOCUMENT:\n${source}`;

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: safeMessages, generationConfig: { maxOutputTokens: 1200, temperature: 0.15 } })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Gemini request failed.' });
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'No response was returned.';
    return res.status(200).json({ text });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
