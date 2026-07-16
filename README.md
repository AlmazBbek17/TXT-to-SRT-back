# TXT to SRT — license server

Minimal Express + Postgres backend that:
- registers a user by email (`POST /api/auth`)
- checks whether an email has an active plan (`GET /api/license?email=`) — handles monthly/yearly expiry
- redirects to the right Dodo Payments checkout link per plan (`GET /api/checkout?email=&plan=monthly|yearly|lifetime`)
- receives Dodo's payment-succeeded webhook and marks the user as licensed (`POST /api/webhook/dodo`)

Plans: **$3/month**, **$10/year**, **$15 lifetime**.

## Deploy on Railway

1. Push this `backend/` folder to a GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → select the repo.
   Railway reads the `.env.example` file in this repo automatically and will show you empty fields for `EXTENSION_ID`, `DODO_LINK_MONTHLY`, `DODO_LINK_YEARLY`, `DODO_LINK_LIFETIME`, `DODO_WEBHOOK_SECRET`, and `DODO_API_KEY` — just type the values in, no need to create the variables yourself.
3. In the same Railway project: **Add a Postgres plugin** (New → Database → PostgreSQL). Railway injects `DATABASE_URL` into your service automatically — it's intentionally not in `.env.example` since you never fill it in by hand.
4. If you skipped filling in variables at deploy time, or need to change them later, they live in your Railway service → **Variables** tab.
5. Deploy. Railway gives you a public URL like `https://your-service.up.railway.app`.
6. In the **Dodo Payments dashboard** (not Railway), set the webhook URL to `https://your-service.up.railway.app/api/webhook/dodo`, event = payment succeeded.
7. Paste that same base URL into `licensing.js` in the extension (`LICENSE_API_BASE`).

## Notes / things left as placeholders

- **Webhook signature verification is now real** — it uses the official `dodopayments` SDK's `webhooks.unwrap()`, which checks the `webhook-signature`/`webhook-id`/`webhook-timestamp` headers against `DODO_WEBHOOK_SECRET`. Requests with a missing/invalid signature get a 401 and are never processed.
- **Plan detection** — Dodo's webhook payload has no explicit "plan" field. This code infers it: no `subscription_id` → lifetime (one-time purchase); has `subscription_id` → monthly if charged less than $10, yearly otherwise. If you change prices, update the threshold in `server.js`.
- **Checkout email prefill** uses `?email=` on each Dodo link — confirm the actual query param Dodo expects for prefilling/matching the customer email, and adjust `/api/checkout` if it differs.
