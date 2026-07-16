'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

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

const app = express();
app.use(express.json());

app.use(cors({
  origin: [`chrome-extension://${EXTENSION_ID}`],
  methods: ['GET', 'POST']
}));

app.get('/', (req, res) => res.send('TXT to SRT license server is running.'));

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

// Dodo Payments webhook — set this URL in the Dodo dashboard for "payment succeeded".
// NOTE: verify the signature header per Dodo's docs before trusting the payload in production.
app.post('/api/webhook/dodo', express.json({ type: '*/*' }), async (req, res) => {
  try {
    // TODO: verify req.headers['dodo-signature'] (or whatever header Dodo uses) against
    // DODO_WEBHOOK_SECRET before trusting the body — placeholder until Dodo's exact docs are in hand.

    const email = (req.body?.data?.customer?.email || req.body?.email || '').trim().toLowerCase();
    // Which plan the customer bought — adjust this path once you see a real Dodo payload;
    // for now also accept it as an explicit query param so you can test manually.
    const plan = (req.body?.data?.plan || req.body?.plan || req.query.plan || 'lifetime').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'no email in payload' });

    const days = PLAN_DURATION_DAYS[plan];
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

    await pool.query(
      `INSERT INTO users (email, licensed, plan, licensed_at, expires_at) VALUES ($1, TRUE, $2, now(), $3)
       ON CONFLICT (email) DO UPDATE SET licensed = TRUE, plan = $2, licensed_at = now(), expires_at = $3`,
      [email, plan, expiresAt]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`License server listening on ${PORT}`)))
  .catch((e) => {
    console.error('Failed to init DB', e);
    process.exit(1);
  });
