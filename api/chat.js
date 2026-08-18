const DOC_ID = '1xh2tOI0oLdCnzeB37u2ESb3yiDPw1Ws2TFQlsHSr7sw';

// Google Docs has several public export endpoints. Try more than one so the
// chatbot is less sensitive to Google's response format.
const DOC_URLS = [
  `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`,
  `https://docs.google.com/document/d/${DOC_ID}/export?format=html`
];

async function loadSource() {
  let lastStatus = null;

  for (const url of DOC_URLS) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      lastStatus = response.status;

      if (!response.ok) continue;

      const text = await response.text();
      if (text.trim()) return text.slice(0, 120000);
    } catch (_) {
      // Try the next public export endpoint.
    }
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      'The OTS Google Doc is not publicly readable by the deployed chatbot. In Google Docs, open Share → General access → Anyone with the link → Viewer, then save. If your organization blocks public sharing, use File → Share → Publish to web and provide the published document URL to the chatbot developer.'
    );
  }

  throw new Error(`Unable to read the OTS Google Doc (${lastStatus || 'network error'}). Check that the document is accessible without signing in.`);
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
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1],
                  data: match[2]
                }
              });
            }
          }
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        })
      : [];

    const system = `You are the EGO OTS Chatbot and work assistant.

Your single source of truth for OTS questions is the Google Doc content below. Follow it strictly. Do not invent, infer, or replace OTS rules with generic knowledge. If the source does not contain enough information, say so clearly. If a newer rule in the supplied source conflicts with an older rule, follow the newer rule as written.

When reviewing a description, answer directly first, then state whether it is Correct, Incorrect, or Needs Adjustment, explain the relevant OTS rule in plain language, and give a corrected version when needed. Preserve the terminology used by the source.

If a screenshot is supplied, describe only what is visibly supported by the image and clearly separate visual observations from OTS requirements. Do not claim exact frame timing from a screenshot unless the source explicitly allows it.

OTS SOURCE DOCUMENT:
${source}`;

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: safeMessages,
          generationConfig: { maxOutputTokens: 1200, temperature: 0.15 }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini request failed.'
      });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ||
      'No response was returned.';

    return res.status(200).json({ text });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
