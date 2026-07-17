// netlify/functions/activate.js
//
// Turns a Stripe checkout session into an access token for the hosted tier.
//
// The browser cannot be trusted to say "I paid" — anyone can type
// ?payment=success into the address bar. So the tool sends the session_id
// Stripe put in the redirect URL, and this function verifies it against
// Stripe server-side before minting anything.
//
// Requires env vars: STRIPE_SECRET_KEY, plus Netlify Blobs (automatic).

import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: CORS });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Hosted tier is not configured yet.' }, 500);

  let session_id;
  try {
    ({ session_id } = await req.json());
  } catch {
    return json({ error: 'Bad request body' }, 400);
  }
  if (!session_id) return json({ error: 'Missing session_id' }, 400);

  try {
    const stripe = new Stripe(stripeKey);
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    if (session.payment_status !== 'paid') {
      return json({ error: 'That checkout is not marked paid.' }, 402);
    }

    const sub = session.subscription;
    const subActive = sub && ['active', 'trialing'].includes(sub.status);
    if (!subActive) {
      return json({ error: 'No active subscription found on that checkout.' }, 402);
    }

    const store = getStore('vosai-hosted-access');

    // One token per subscription — re-activating returns the same token
    // rather than minting a new one each time the redirect is revisited.
    const subKey = `sub:${sub.id}`;
    const existing = await store.get(subKey, { type: 'json' });
    if (existing?.token) {
      return json({ token: existing.token, reused: true });
    }

    const token = randomBytes(24).toString('base64url');
    const record = {
      token,
      email: session.customer_details?.email || session.customer_email || '',
      customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
      subscriptionId: sub.id,
      active: true,
      createdAt: new Date().toISOString(),
      usage: {},
    };

    await store.setJSON(`tok:${token}`, record);
    await store.setJSON(subKey, { token });
    if (record.customerId) await store.setJSON(`cus:${record.customerId}`, { token });

    return json({ token, reused: false });
  } catch (err) {
    return json({ error: `Activation failed: ${err.message}` }, 500);
  }
};
