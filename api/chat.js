const DOC_ID = '1MhbcPoBJqW19qOm6dhZtRllDco8RdmhvfZAWfACHcIs';

// Use Google's legacy public export endpoint first. It avoids the redirect
// path that can produce malformed Google response headers in serverless fetch.
const DOC_URLS = [
  `https://docs.google.com/feeds/download/documents/export/Export?exportFormat=txt&id=${DOC_ID}`,
  `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`,
  `https://docs.google.com/document/d/${DOC_ID}/export?format=html`
];

async function loadSource() {
  let lastStatus = null;
  let lastError = null;

  for (const url of DOC_URLS) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'EGO-OTS-Chatbot/1.0' }
      });
      lastStatus = response.status;

      if (!response.ok) continue;

      const text = await response.text();
      if (text.trim()) return text.slice(0, 120000);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      'The EGO OTS Google Doc is not publicly readable by the deployed chatbot. Check Google Docs → Share → General access → Anyone with the link → Viewer.'
    );
  }

  if (lastError?.message?.includes('Headers.append')) {
    throw new Error(
      'Google returned an invalid response header while exporting the OTS document. The chatbot tried multiple public export methods but Google rejected the server request.'
    );
  }

  throw new Error(
    `Unable to read the EGO OTS Google Doc (${lastStatus || lastError?.message || 'network error'}).`
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Vercel.' });
  }

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

Your single source of truth for EGO OTS questions is the Google Doc content below. Follow it strictly. Do not invent, infer, or replace OTS rules with generic knowledge. If the source does not contain enough information, say so clearly. If a newer rule conflicts with an older rule, follow the newer rule.

When reviewing a description, answer directly first, state whether it is Correct, Incorrect, or Needs Adjustment, explain the relevant OTS rule, and give a corrected version when needed. Preserve source terminology.

If a screenshot is supplied, describe only what is visibly supported and separate visual observations from OTS requirements.

EGO OTS SOURCE DOCUMENT:
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
