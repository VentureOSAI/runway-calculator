// netlify/functions/stripe-webhook.js
//
// Keeps hosted access honest. Without this, a cancelled subscriber keeps
// spending your inference budget forever, because the token in their browser
// never expires on its own.
//
// SETUP:
//  1. Stripe Dashboard → Developers → Webhooks → Add endpoint
//     URL: https://tools.ventureosai.com/.netlify/functions/stripe-webhook
//     (root of the runway site — these functions serve every hosted agent,
//      so the endpoint is NOT under any individual agent's path.)
//  2. Events: customer.subscription.deleted, customer.subscription.updated,
//             invoice.payment_failed
//  3. Copy the signing secret (whsec_...) into the STRIPE_WEBHOOK_SECRET env var.
//
// Requires env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !whSecret) {
    console.error('stripe-webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return new Response('Not configured', { status: 500 });
  }

  const stripe = new Stripe(stripeKey);
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (err) {
    return new Response(`Signature verification failed: ${err.message}`, { status: 400 });
  }

  const store = getStore('vosai-hosted-access');

  async function setActive(subId, active) {
    if (!subId) return;
    const ptr = await store.get(`sub:${subId}`, { type: 'json' });
    if (!ptr?.token) return;
    const rec = await store.get(`tok:${ptr.token}`, { type: 'json' });
    if (!rec) return;
    rec.active = active;
    rec.statusChangedAt = new Date().toISOString();
    await store.setJSON(`tok:${ptr.token}`, rec);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.deleted':
        await setActive(event.data.object.id, false);
        break;

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await setActive(sub.id, ['active', 'trialing'].includes(sub.status));
        break;
      }

      case 'invoice.payment_failed': {
        const subId = event.data.object.subscription;
        // Don't revoke on the first failure — Stripe retries, and a card
        // blip shouldn't lock out a paying customer mid-cycle. The
        // subscription.updated event handles it once Stripe gives up.
        console.log(`payment failed for subscription ${subId} — awaiting Stripe retries`);
        break;
      }
    }
  } catch (err) {
    console.error('stripe-webhook handler error:', err);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
