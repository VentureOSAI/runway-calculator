// netlify/functions/agent-proxy.js
//
// The hosted tier. Holds the VentureOS Claude key server-side and calls
// Claude on behalf of a paying subscriber. The key never reaches the browser.
//
// Requires env vars: ANTHROPIC_API_KEY, plus Netlify Blobs (automatic).

import { getStore } from '@netlify/blobs';

// COST CONTROL — read before changing.
//
// £29/mo against uncapped inference is an open tap. This is the tap washer.
//
// Sonnet 4.6 costs $3/M input, $15/M output. A heavy run of this agent
// (20+ invoices, output ceiling reached) is ~2k in + 3k out = ~$0.051 ≈ £0.040.
// £29 revenue − Stripe fees ≈ £28.37 net. Holding inference to ~35% of net
// gives a ~£10/month budget → 250 generations at worst-case cost.
//
// A real subscriber chasing invoices weekly runs 4–8 generations a month.
// 250 is ~30–60x normal use: it never touches a genuine customer, it only
// bites token-sharing and abuse.
//
// This cap is PORTFOLIO-WIDE. It must stay on the single runway site so all
// hosted agents share one counter — per-site stores would multiply the cap
// by the number of agents and destroy the margin.
const MONTHLY_CAP = 250;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_CEILING = 4000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: CORS });

const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'Hosted tier is not configured yet.' }, 500);

  let token, prompt, max_tokens;
  try {
    ({ token, prompt, max_tokens } = await req.json());
  } catch {
    return json({ error: 'Bad request body' }, 400);
  }
  if (!token) return json({ error: 'Missing access token' }, 401);
  if (!prompt || typeof prompt !== 'string') return json({ error: 'Missing prompt' }, 400);

  const store = getStore('vosai-hosted-access');
  const key = `tok:${token}`;

  let record;
  try {
    record = await store.get(key, { type: 'json' });
  } catch {
    record = null;
  }
  if (!record) return json({ error: 'That access token is not recognised.' }, 401);
  if (!record.active) {
    return json({ error: 'This subscription is no longer active. Renew to continue.' }, 403);
  }

  // Monthly cap
  const month = thisMonth();
  const used = record.usage?.[month] || 0;
  if (used >= MONTHLY_CAP) {
    return json({
      error: `Monthly limit reached (${MONTHLY_CAP} generations). It resets on the 1st. Your own-key tier has no limit if you need more now.`,
      capped: true,
      used,
      cap: MONTHLY_CAP,
    }, 429);
  }

  // Call Claude with the server-side key
  let out;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(Number(max_tokens) || 2000, MAX_TOKENS_CEILING),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return json({ error: data.error?.message || `Claude request failed (${res.status})` }, 502);
    }
    out = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  } catch (err) {
    return json({ error: `Upstream error: ${err.message}` }, 502);
  }

  // Count the call only after it succeeded — a failed call shouldn't
  // burn a subscriber's monthly allowance.
  try {
    record.usage = record.usage || {};
    record.usage[month] = used + 1;
    record.lastUsed = new Date().toISOString();
    await store.setJSON(key, record);
  } catch { /* usage tracking failure must not fail the user's request */ }

  return json({ text: out, used: used + 1, cap: MONTHLY_CAP });
};
