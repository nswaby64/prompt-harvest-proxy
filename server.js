const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');
const app     = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const stripe    = Stripe(process.env.STRIPE_SECRET_KEY);
const FREE_LIMIT = 5;

const usageStore = new Map();
const proCache = new Map();
const PRO_CACHE_TTL = 60 * 60 * 1000;

function getCurrentMonth() {
  const now = new Date();
  return String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function getUsage(userId) {
  const month = getCurrentMonth();
  const entry = usageStore.get(userId);
  if (!entry || entry.month !== month) return { count: 0, month };
  return entry;
}

function incrementUsage(userId) {
  const month  = getCurrentMonth();
  const usage  = getUsage(userId);
  const updated = { count: usage.count + 1, month };
  usageStore.set(userId, updated);
  return updated.count;
}

async function isProSubscriber(email) {
  if (!email) return false;
  const cached = proCache.get(email);
  if (cached && (Date.now() - cached.checkedAt) < PRO_CACHE_TTL) return cached.isPro;
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      proCache.set(email, { isPro: false, checkedAt: Date.now() });
      return false;
    }
    const customerId = customers.data[0].id;
    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    const isPro = subscriptions.data.length > 0;
    proCache.set(email, { isPro, checkedAt: Date.now() });
    return isPro;
  } catch (err) {
    console.error('Stripe check error:', err.message);
    return false;
  }
}

app.get('/api/usage', async (req, res) => {
  const { userId, email } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const isPro = await isProSubscriber(email);
  const usage = getUsage(userId);
  const limit = isPro ? null : FREE_LIMIT;
  const remaining = isPro ? null : Math.max(0, FREE_LIMIT - usage.count);
  res.json({ used: usage.count, limit, remaining, month: usage.month, isPro });
});

app.post('/api/verify-pro', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const isPro = await isProSubscriber(email);
  res.json({ isPro, email });
});

app.post('/api/extract', async (req, res) => {
  const { userId, transcriptLines, email } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!transcriptLines) return res.status(400).json({ error: 'transcriptLines required' });
  const isPro = await isProSubscriber(email);
  if (!isPro) {
    const usage = getUsage(userId);
    if (usage.count >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'free_limit_reached',
        message: 'Monthly free limit reached. Upgrade to Pro for unlimited access.',
        used: usage.count,
        limit: FREE_LIMIT,
        remaining: 0
      });
    }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured - API key missing.' });
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: 'You are an expert at identifying and rewriting AI prompts from YouTube transcripts. You find every prompt or prompt template mentioned, then rewrite each one to be clear, polished, and immediately usable - removing filler words, fixing grammar, and adding [placeholder] brackets where the user should customise the prompt.',
        messages: [{ role: 'user', content: 'Read this YouTube transcript and find every AI prompt or prompt template the speaker mentions, demonstrates, or recommends.\n\nFor each prompt:\n1. Rewrite it to be clean, complete, and ready to copy-paste into ChatGPT, Claude, etc.\n2. Add [brackets] for any parts the user should customise.\n3. Assign a category: "writing" | "coding" | "analysis" | "productivity" | "other"\n4. Write one short explanation (under 15 words).\n5. Note the timestamp from the transcript.\n\nReturn ONLY a valid JSON array - no markdown, no prose. Return [] if no prompts are found.\n\n[{\n  "prompt": "Rewritten, polished prompt with [customisable parts]",\n  "category": "writing",\n  "explanation": "One sentence describing what this prompt does.",\n  "timestamp": "2:34"\n}]\n\nTranscript:\n' + transcriptLines }]
      })
    });
    if (!claudeRes.ok) {
      const errData = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json({ error: errData && errData.error ? errData.error.message : 'Claude API error ' + claudeRes.status });
    }
    const data = await claudeRes.json();
    const content = data.content && data.content[0] ? data.content[0].text : '';
    const match = content.match(/\[[\s\S]*\]/);
    let prompts = [];
    if (match) { try { prompts = JSON.parse(match[0]); } catch(e) {} }
    if (!Array.isArray(prompts)) prompts = [];
    let newCount = getUsage(userId).count;
    let remaining = null;
    let limit = null;
    if (!isPro) {
      newCount = incrementUsage(userId);
      remaining = Math.max(0, FREE_LIMIT - newCount);
      limit = FREE_LIMIT;
    }
    res.json({ prompts, used: newCount, limit, remaining, isPro });
  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Prompt Harvest proxy running on port ' + PORT));
