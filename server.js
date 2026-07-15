'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const EXTENSION_ID = process.env.EXTENSION_ID || 'hmegdmljjhbohphjhfogpgbhcfjkifbh';
const DODO_PAYMENT_LINK = process.env.DODO_PAYMENT_LINK || ''; // e.g. https://checkout.dodopayments.com/buy/xxxxx
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET || ''; // from Dodo dashboard, used to verify webhook signature

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      licensed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      licensed_at TIMESTAMPTZ
    );
  `);
}

const app = express();
app.use(express.json());

// Allow calls from the Chrome extension (and from Dodo's redirect page if it fetches CORS-lite endpoints).
app.use(cors({
  origin: [`chrome-extension://${EXTENSION_ID}`],
  methods: ['GET', 'POST']
}));

app.get('/', (req, res) => res.send('TXT to SRT license server is running.'));

// Create/update a user record. Called right before opening the paywall / checkout.
app.post('/api/auth', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  const { rows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO NOTHING
     RETURNING email, licensed`,
    [email]
  );
  if (rows.length) return res.json(rows[0]);

  const existing = await pool.query('SELECT email, licensed FROM users WHERE email = $1', [email]);
  res.json(existing.rows[0]);
});

// Check whether an email is licensed.
app.get('/api/license', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { rows } = await pool.query('SELECT licensed FROM users WHERE email = $1', [email]);
  res.json({ licensed: rows.length ? rows[0].licensed : false });
});

// Redirects the user to the Dodo Payments checkout, pre-filled with their email
// so the webhook can match the payment back to this user.
app.get('/api/checkout', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).send('email required');
  if (!DODO_PAYMENT_LINK) return res.status(500).send('DODO_PAYMENT_LINK is not configured on the server yet.');

  await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email]
  );

  // Dodo Payments checkout links accept a redirect/metadata query param for prefilling
  // customer email — adjust the param name to match what Dodo's docs specify for your link type.
  const url = `${DODO_PAYMENT_LINK}${DODO_PAYMENT_LINK.includes('?') ? '&' : '?'}email=${encodeURIComponent(email)}`;
  res.redirect(url);
});

// Dodo Payments webhook — call this URL from the Dodo dashboard for "payment succeeded".
// NOTE: verify the signature header per Dodo's docs before trusting the payload in production.
app.post('/api/webhook/dodo', express.json({ type: '*/*' }), async (req, res) => {
  try {
    // TODO: verify req.headers['dodo-signature'] (or whatever header Dodo uses) against
    // DODO_WEBHOOK_SECRET before trusting the body. Left as a placeholder until you have
    // Dodo's exact webhook payload/signature docs in front of you.

    const email = (req.body?.data?.customer?.email || req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'no email in payload' });

    await pool.query(
      `INSERT INTO users (email, licensed, licensed_at) VALUES ($1, TRUE, now())
       ON CONFLICT (email) DO UPDATE SET licensed = TRUE, licensed_at = now()`,
      [email]
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
