# Deployment, backups and go-live checklist

> Nothing in this repository has been deployed by the author. These are the steps **you** perform; each item notes what
> needs your credentials. Do not paste secrets into source files or commit them — set them in each provider's dashboard.

## 0. Hosting choices (verified against provider docs when this was written)

| Piece | Choice | Why |
|---|---|---|
| Frontend | **Vercel** (static Vite build) | Free/cheap static hosting with SPA rewrites |
| API + chat | **A persistent Node host** — Render web service (blueprint included: `render.yaml`), or Railway/Fly.io | Socket.IO needs long-lived connections. [Vercel only offers beta WebSocket support tied to function lifecycles](https://render.com/docs/vercel); Render web services support WebSockets |
| Database | **Supabase PostgreSQL** | Independent of the frontend host |

Things to know before choosing plans (check the providers' current pricing pages — they change):

* [Render's free web services spin down when idle](https://render.com/docs/vercel). The first request after idling is slow and open chat
  connections are dropped, so use a paid, always-on instance for a real shop.
* Per [Supabase's pricing page](https://supabase.com/pricing.md), the Free plan has a **500 MB** database limit, pauses projects after
  **1 week of inactivity**, and does **not** include automatic backups or point-in-time recovery. For a live business use a paid
  plan that includes backups (confirm what the plan includes on that page), or schedule your own dumps (section 7).

## 1. Prerequisites

Node.js 20+, Git, a GitHub account, a Supabase account, a Vercel account, an account at your Node host, and an SMTP provider
(any: Resend SMTP, Brevo, Mailgun, SendGrid, your domain's mailbox…). Optional: a custom domain.

## 2. Get the code onto GitHub  *(needs your GitHub login)*

```bash
cd bile-cutz
git add -A && git commit -m "Initial import"        # .gitignore already excludes .env files and uploads
git remote add origin https://github.com/<you>/bile-cutz.git && git push -u origin main
```
Run `git status` and confirm no `.env` file is listed before pushing.

## 3. Create the Supabase project  *(needs your Supabase login)*

1. New project → choose a region near your customers → save the database password in a password manager.
2. **Project Settings → Database → Connection string.** You will need two strings:
   * *Direct / session* (port 5432) — for running migrations from your computer.
   * *Transaction pooler* (port 6543) — for the deployed API (`DATABASE_URL`). Keep `DATABASE_POOL_MAX` small (≈5–10); Supabase
     limits concurrent connections per plan.
   Append `?sslmode=require` if the string does not already include it, and set `DATABASE_SSL=true`.
3. Storage (for uploaded photos): open **SQL Editor**, paste `database/storage/001_media_bucket.sql`, run. It creates a public-read
   bucket with **no write policies**. Then **Project Settings → API**: copy the project URL and the **service_role key**.
   The service-role key is a master key: it goes **only** into the backend host's environment, never into the frontend, never into git.

## 4. Apply migrations and create the first admin  *(from your computer)*

```bash
cd backend && cp .env.example .env
# edit .env: DATABASE_URL=<Supabase direct 5432 string>, DATABASE_SSL=true, SESSION_SECRET=$(openssl rand -base64 48)
npm ci
npm run db:migrate          # applies database/migrations/*.sql, tracked in schema_migrations
npm run db:seed             # opening hours, default settings row, FAQs (idempotent)
npm run admin:create -- --email owner@yourshop.com --name "Shop Owner"    # hidden password prompt, min 12 chars
```
Skip `db:seed:demo` in production unless you want sample services (you can also delete them in the admin).
Delete your local `.env` afterwards, or keep it out of git (it is ignored).

## 5. Deploy the API  *(needs your host login)*

**Render:** New → Blueprint → select the repo (reads `render.yaml`), then fill the `sync: false` variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase **pooler (6543)** string; `DATABASE_SSL=true`; `DATABASE_POOL_MAX=5` |
| `SESSION_SECRET` | ≥ 32 random chars (`openssl rand -base64 48`). Changing it invalidates in-flight chat tickets only |
| `ALLOWED_ORIGINS` | your frontend origin(s), e.g. `https://bilecutz.com,https://www.bilecutz.com` (exact, no trailing slash) |
| `FRONTEND_URL` | `https://bilecutz.com` (used in reset/booking emails; must be https) |
| `PUBLIC_API_URL` | the API's public URL, e.g. `https://api.bilecutz.com` |
| `TRUST_PROXY` | `true` (so rate limiting sees real client IPs behind the host's proxy) |
| `EMAIL_PROVIDER` | `smtp` (the server **refuses to start** in production with `dev-outbox`) + `EMAIL_FROM`, `SMTP_HOST/PORT/USER/PASS` |
| `STORAGE_PROVIDER` | `supabase` + `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` (host disks are ephemeral; do not use `local`) |
| `COOKIE_SAMESITE` / `COOKIE_DOMAIN` | see section 6 |

Build command `npm ci && npm run build`, start command `node dist/server.js`, health check `/health`.
The server validates every variable at boot and prints which are missing/unsafe (never their values).
Other hosts: any platform that runs `node dist/server.js` as a long-lived process with WebSocket support works.

## 6. Deploy the frontend to Vercel and wire cookies/CORS  *(needs your Vercel login)*

1. Import the GitHub repo, **Root Directory = `frontend`**, framework preset *Vite* (build `npm run build`, output `dist`).
2. Edit `frontend/vercel.json`: replace both `YOUR-BACKEND-HOST` placeholders with your API host and commit. This makes the
   browser call **same-origin** `/api/...`, so session cookies are first-party and the strict `SameSite=Lax` default works.
3. Environment variables (Vercel dashboard): `VITE_SOCKET_URL=https://<your API origin>` (WebSockets cannot pass through Vercel
   rewrites). Leave `VITE_API_URL` empty. These are public values — **never** put secrets in `VITE_*` variables.
4. Deploy, then add your custom domain in Vercel and put that origin in the API's `ALLOWED_ORIGINS` / `FRONTEND_URL`.

Cookies: REST traffic is same-origin through the rewrite, so no cross-site cookie setup is needed. The socket handshake uses a
60-second signed ticket (not cookies), so it works cross-origin. If you instead call the API directly from the browser on
another site, set `COOKIE_SAMESITE=none` (requires HTTPS) — though browsers increasingly block third-party cookies, so the
rewrite (or putting API and site on sibling subdomains with `COOKIE_DOMAIN=.yourdomain.com`) is the recommended setup.

## 7. Backups and recovery

* Decide your tier: Supabase paid plans include backups (verify current terms); the Free plan does not. Either way, take your own
  logical dump on a schedule — e.g. a weekly GitHub Action or cron on any machine with `pg_dump`:
  ```bash
  pg_dump "$SUPABASE_DIRECT_URL" --format=custom --no-owner --file=bilecutz-$(date +%F).dump
  ```
  Store dumps encrypted in a location separate from Supabase, and keep several generations. Dumps contain customer data and
  password hashes — treat them as confidential.
* **Restore drill (do it once before launch):** create an empty Supabase/Postgres database, then
  `pg_restore --no-owner --dbname "$NEW_DATABASE_URL" bilecutz-YYYY-MM-DD.dump`, point `DATABASE_URL` at it, and check
  that `/health` is ok and you can sign in. Uploaded photos live in the Supabase Storage bucket and are not part of a database dump —
  download the bucket periodically too (the Supabase dashboard or its API), or keep the originals.
* Schema changes are always new numbered files in `database/migrations`; never edit an applied migration.
* **Connection limits:** the API holds at most `DATABASE_POOL_MAX` connections. Use the pooler string in production and run a
  single API instance unless you add the Socket.IO Redis adapter.
* **Growth:** Admin → System shows database and per-table size. Chat messages, appointments and audit logs are never auto-deleted.
  When approaching your plan's limit, upgrade the plan, or export-and-archive old chat history to cold storage yourself.

## 8. Update safely through GitHub

1. Work on a branch; run `npm run typecheck && npm run lint && npm test && npm run build` locally.
2. Open a pull request; Vercel builds a preview of the frontend automatically.
3. Merge to `main` → Vercel and your API host redeploy. Apply any new migration **before** (additive) or **with** the release:
   `DATABASE_URL=<direct string> npm --prefix backend run db:migrate`.
4. Roll back by redeploying the previous commit; migrations are forward-only, so write additive migrations.

## 9. Post-deploy verification (production smoke test)

Do these on the live site with a throw-away customer account and then clean up:

- [ ] `https://<api>/health` returns `{"status":"ok"}`.
- [ ] Home, Services, Gallery, FAQ, Contact load; no admin link anywhere in public navigation; `/admin/login` loads when typed.
- [ ] Register → you land on **your own name** in `/account`; sign out and sign in again.
- [ ] Book as a guest (check the email with the private link arrives) and as the customer; both show **Pending**.
- [ ] Admin sign-in: the new bookings appear with a notification; **Approve** one → the customer sees **Approved**, a notification, and a working printable confirmation.
- [ ] Try booking the same slot beyond capacity → the extra attempt is refused.
- [ ] Customer cancels inside/outside the deadline → refused/allowed as configured; admin gets a notification.
- [ ] Chat: customer sends a message, admin receives it live and replies; reload both pages, messages persist; a second customer cannot see the first conversation.
- [ ] Complete an appointment in admin, leave a review as the customer, approve it, see it on the home page.
- [ ] "Forgot password" email arrives; the link works once and then fails.
- [ ] Upload a gallery image (verifies Storage credentials).
- [ ] Change opening hours / capacity in Settings and watch the booking page change without redeploying.

## 10. Before you go live — owner checklist

- [ ] Replace placeholder contact details, address, WhatsApp number, about text, policies, hours (Admin → Settings).
- [ ] Add your real services/prices/durations (or edit the demo ones), upload a logo, a hero image and gallery photos you own or are licensed to use.
- [ ] Confirm currency (`NGN`) and timezone (`Africa/Lagos`) are right.
- [ ] Real SMTP configured and tested; `EMAIL_FROM` domain has SPF/DKIM set up with your provider so emails don't land in spam.
- [ ] Strong unique owner password; consider a second `staff` account for the front desk (`npm run admin:create -- --role staff`); never share the owner login.
- [ ] `SESSION_SECRET` is random and not the example; no secrets in git (`git log -p | grep -i secret` should find nothing real).
- [ ] Backups configured and the restore drill completed (section 7).
- [ ] Custom domain with HTTPS on both frontend and API.
- [ ] Decide privacy/terms wording for your jurisdiction (e.g. Nigeria's data-protection rules) — this app stores names, emails, phone numbers, booking history and chat; get legal advice and add a privacy notice if required.

## 11. Operations

* Daily: check Admin → Dashboard for pending approvals and unread chats.
* Monthly: Admin → System for database size; review the audit log.
* Customers who forget their email: look them up in Admin → Customers.
* Suspending a customer signs them out and blocks sign-in without deleting their history.
