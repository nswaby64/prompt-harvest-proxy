const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// In-memory usage store: { userId: { count: N, month: 'YYYY-MM' } }
const usageStore = new Map();
const FREE_LIMIT = 5;

function getCurrentMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function getUsage(userId) {
  const month = getCurrentMonth();
  const entry = usageStore.get(userId);
  if (!entry || entry.month !== month) return { count: 0, month };
  return entry;
}

function incrementUsage(userId) {
  const month = getCurrentMonth();
  const usage = getUsage(userId);
  const updated = { count: usage.count + 1, month };
  usageStore.set(userId, updated);
  return updated.count;
}

// GET /api/usage
app.get('/api/usage', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const usage = getUsage(userId);
  res.json({ used: usage.count, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - usage.count), month: usage.month });
});

// POST /api/extract
app.post('/api/extract', async (req, res) => {
  const { userId, transcriptLines } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!transcriptLines) return res.status(400).json({ error: 'transcriptLines required' });

  const usage = getUsage(userId);
  if (usage.count >= FREE_LIMIT) {
    return res.status(429).json({
      error: 'free_limit_reached',
      message: 'You have used all ' + FREE_LIMIT + ' free extractions for this month. Upgrade to Pro for unlimited access.',
      used: usage.count, limit: FREE_LIMIT, remaining: 0
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured.' });

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: 'You are an expert at identifying and rewriting AI prompts from YouTube transcripts. You find every prompt or prompt template mentioned, then rewrite each one to be clear, polished, and immediately usable — removing filler words, fixing grammar, and adding [placeholder] brackets where the user should customise the prompt.',
        messages: [{ role: 'user', content: 'Read this YouTube transcript and find every AI prompt or prompt template the speaker mentions, demonstrates, or recommends.\n\nFor each prompt:\n1. Rewrite it to be clean, complete, and ready to copy-paste into ChatGPT, Claude, etc.\n2. Add [brackets] for any parts the user should customise.\n3. Assign a category: "writing" | "coding" | "analysis" | "productivity" | "other"\n4. Write one short explanation (under 15 words).\n5. Note the timestamp from the transcript.\n\nReturn ONLY a valid JSON array — no markdown, no prose. Return [] if no prompts are found.\n\n[\n  {\n    "prompt": "Rewritten prompt with [customisable parts]",\n    "category": "writing",\n    "explanation": "One sentence describing what this prompt does.",\n    "timestamp": "2:34"\n  }\n]\n\nTranscript:\n' + transcriptLines }]
      })
    });

    if (!claudeRes.ok) {
      const errData = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json({ error: errData?.error?.message || 'Claude API error' });
    }

    const data = await claudeRes.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    let prompts = [];
    if (match) { try { prompts = JSON.parse(match[0]); } catch {} }
    if (!Array.isArray(prompts)) prompts = [];

    const newCount = incrementUsage(userId);
    res.json({ prompts, used: newCount, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - newCount) });
  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Prompt Harvest proxy running on port ' + PORT));
