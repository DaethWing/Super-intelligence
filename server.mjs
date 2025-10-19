import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const limiter = new RateLimiterMemory({ points: 60, duration: 60 });
app.use(async (req, res, next) => {
  try {
    const key = req.headers['x-forwarded-for'] || req.ip || 'global';
    await limiter.consume(String(key));
    next();
  } catch {
    res.status(429).json({ error: "Too many requests. Please slow down." });
  }
});

const BLOCKED = [
  /child\s+sexual/i,
  /how\s+to\s+make\s+(?:a\s+)?bomb/i,
  /make\s+explosives?/i,
  /hire\s+hitman/i,
  /write\s+malware/i,
  /exploit\s+this\s+vulnerability/i,
  /bypass\s+(?:auth|2fa|drm|paywall)/i,
  /credit\s*card\s*number\s*generator/i,
  /make\s+fentanyl|illicit\s+drug\s+manufacture/i,
  /doxx?ing/i
];
const looksUnsafe = s => BLOCKED.some(rx => rx.test(s || ''));

const SYSTEM_PROMPT = `
You are a helpful, honest assistant for a personal website.
- Be accurate and clear; ask for missing context if needed.
- Be creative when asked to brainstorm or write.
- Refuse requests that could meaningfully enable illegal, dangerous, or privacy-invasive actions.
- If refusing, explain briefly and suggest a safer alternative.
`;

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "Expected { messages: [...] }" });
    }

    const lastUser = [...messages].reverse().find(m => m?.role === 'user')?.content || '';
    if (looksUnsafe(lastUser)) {
      return res.status(400).json({
        error: "This request appears unsafe. Please rephrase to a lawful, non-harmful question."
      });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: "Server missing OPENAI_API_KEY." });
    }

    const finalMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ];

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: finalMessages,
        temperature: 0.7,
        stream: true
      })
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      return res.status(502).json({ error: "Upstream error", detail });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Chat server listening on :${port}`));
