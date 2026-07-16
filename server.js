'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const DodoPayments = require('dodopayments').default;

const PORT = process.env.PORT || 3000;
const EXTENSION_ID = process.env.EXTENSION_ID || 'hmegdmljjhbohphjhfogpgbhcfjkifbh';

// One Dodo Payments checkout link per plan.
const DODO_LINKS = {
  monthly: process.env.DODO_LINK_MONTHLY || '',
  yearly: process.env.DODO_LINK_YEARLY || '',
  lifetime: process.env.DODO_LINK_LIFETIME || ''
};
const PLAN_DURATION_DAYS = { monthly: 30, yearly: 365, lifetime: null };

const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET || '';
const DODO_API_KEY = process.env.DODO_API_KEY || '';
const DODO_ENVIRONMENT = process.env.DODO_ENVIRONMENT || 'live_mode'; // or 'test_mode'

// Used only to verify webhook signatures via the official SDK — not for making API calls.
const dodoClient = new DodoPayments({
  bearerToken: DODO_API_KEY || 'placeholder',
  environment: DODO_ENVIRONMENT,
  webhookKey: DODO_WEBHOOK_SECRET
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      licensed BOOLEAN NOT NULL DEFAULT FALSE,
      plan TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      licensed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    );
  `);
}

const path = require('path');

const app = express();
// Skip JSON body-parsing for the webhook route — it needs the raw, unparsed body
// to verify the signature (see express.raw() on that route below).
app.use((req, res, next) => {
  if (req.path === '/api/webhook/dodo') return next();
  express.json()(req, res, next);
});

app.use(cors({
  origin: [`chrome-extension://${EXTENSION_ID}`],
  methods: ['GET', 'POST']
}));

// Landing page + policy pages (public/index.html, privacy.html, terms.html, refund.html)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/refund', (req, res) => res.sendFile(path.join(__dirname, 'public', 'refund.html')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Verifies a Google OAuth access token directly with Google and returns the
// verified email, or null if the token is invalid/expired.
async function verifyGoogleToken(token) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info.email ? info.email.trim().toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// Verifies the OAuth token sent by the extension, then creates/looks up the user
// keyed by the EMAIL GOOGLE RETURNED — the client never gets to just assert an email.
app.post('/api/auth', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });

  const email = await verifyGoogleToken(token);
  if (!email) return res.status(401).json({ error: 'invalid or expired Google token' });

  await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email]
  );
  const licensed = await isCurrentlyLicensed(email);
  res.json({ email, licensed });
});

async function isCurrentlyLicensed(email) {
  const { rows } = await pool.query('SELECT licensed, expires_at FROM users WHERE email = $1', [email]);
  if (!rows.length) return false;
  const { licensed, expires_at } = rows[0];
  if (!licensed) return false;
  if (expires_at && new Date(expires_at) < new Date()) return false; // subscription lapsed
  return true;
}

// Check whether an email is licensed (accounts for monthly/yearly expiry).
app.get('/api/license', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  res.json({ licensed: await isCurrentlyLicensed(email) });
});

// Redirects the user to the correct Dodo Payments checkout link for the chosen plan.
app.get('/api/checkout', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  const plan = (req.query.plan || '').trim().toLowerCase();
  if (!email) return res.status(400).send('email required');
  if (!['monthly', 'yearly', 'lifetime'].includes(plan)) return res.status(400).send('plan must be monthly, yearly or lifetime');

  const link = DODO_LINKS[plan];
  if (!link) return res.status(500).send(`DODO_LINK_${plan.toUpperCase()} is not configured on the server yet.`);

  await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email]
  );

  // Adjust the param name to match what Dodo's docs specify for prefilling customer email on your link type.
  const url = `${link}${link.includes('?') ? '&' : '?'}email=${encodeURIComponent(email)}`;
  res.redirect(url);
});

// Dodo Payments webhook — set this URL in the Dodo dashboard for payment/subscription events.
// IMPORTANT: this route needs the RAW request body to verify the signature (not JSON-parsed).
app.post('/api/webhook/dodo', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await dodoClient.webhooks.unwrap(req.body.toString(), {
      headers: {
        'webhook-id': req.headers['webhook-id'],
        'webhook-signature': req.headers['webhook-signature'],
        'webhook-timestamp': req.headers['webhook-timestamp']
      }
    });
  } catch (e) {
    console.error('webhook signature verification failed', e.message);
    return res.status(401).json({ error: 'invalid signature' });
  }

  try {
    const type = event?.type || '';
    const d = event?.data || {};
    const email = (d?.customer?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'no email in payload' });

    // Only act on events that mean "this person now has an active paid plan".
    const RELEVANT = ['payment.succeeded', 'subscription.active', 'subscription.renewed'];
    if (!RELEVANT.includes(type)) return res.json({ ok: true, ignored: type });

    // Dodo's payment payload has no explicit "plan" field — infer it:
    // no subscription_id at all => one-time purchase => lifetime.
    // otherwise it's a subscription => tell monthly/yearly apart by amount charged.
    let plan = 'lifetime';
    if (d.subscription_id) {
      const amount = d.total_amount ?? d.settlement_amount ?? 0;
      // amounts are in cents. Adjust these if your live prices differ from $3/$10.
      plan = amount >= 1000 ? 'yearly' : 'monthly';
    }

    const days = PLAN_DURATION_DAYS[plan];
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

    await pool.query(
      `INSERT INTO users (email, licensed, plan, licensed_at, expires_at) VALUES ($1, TRUE, $2, now(), $3)
       ON CONFLICT (email) DO UPDATE SET licensed = TRUE, plan = $2, licensed_at = now(), expires_at = $3`,
      [email, plan, expiresAt]
    );

    res.json({ ok: true, email, plan });
  } catch (e) {
    console.error('webhook processing error', e);
    res.status(500).json({ error: 'internal error' });
  }
});


initDb()
  .then(() => app.listen(PORT, () => console.log(`License server listening on ${PORT}`)))
  .catch((e) => {
    console.error('Failed to init DB', e);
    process.exit(1);
  });
