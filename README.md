# TXT to SRT — license server

Minimal Express + Postgres backend that:
- registers a user by email (`POST /api/auth`)
- checks whether an email has paid (`GET /api/license?email=`)
- redirects to your Dodo Payments checkout link (`GET /api/checkout?email=`)
- receives Dodo's payment-succeeded webhook and marks the user as licensed (`POST /api/webhook/dodo`)

## Deploy on Railway

1. Push this `backend/` folder to a GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → select the repo.
3. In the same Railway project: **Add a Postgres plugin** (New → Database → PostgreSQL). Railway will inject `DATABASE_URL` into your service automatically.
4. In your service's Variables tab, set:
   - `EXTENSION_ID` — your extension's ID
   - `DODO_PAYMENT_LINK` — your $5 lifetime checkout link from Dodo Payments
   - `DODO_WEBHOOK_SECRET` — once Dodo gives you one
5. Deploy. Railway gives you a public URL like `https://your-service.up.railway.app`.
6. In the Dodo Payments dashboard, set the webhook URL to `https://your-service.up.railway.app/api/webhook/dodo`, event = payment succeeded.
7. Paste that same base URL into `licensing.js` in the extension (`LICENSE_API_BASE`).

## Notes / things left as placeholders

- **Webhook signature verification** is stubbed out in `server.js` — Dodo's exact header name and signing scheme need to come from their docs; wire it in before going live so random POSTs can't mark accounts as paid.
- **Checkout email prefill** uses `?email=` on the Dodo link — confirm the actual query param Dodo expects for prefilling/matching the customer email on your specific link type, and adjust `/api/checkout` if it differs.
