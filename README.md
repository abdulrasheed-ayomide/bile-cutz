# Bile Cutz — Premium Barbing Salon platform

Booking, customer accounts, private chat and a shop dashboard for a barbershop.

| Part | Tech |
|---|---|
| `frontend/` | React 18, Vite, TypeScript, React Router, hand-written CSS design system |
| `backend/` | Node.js, Express, TypeScript, Zod, Socket.IO, Argon2id |
| `database/` | PostgreSQL (Supabase) — versioned SQL migrations, seeds, storage-bucket SQL |
| `docs/` | API contract, architecture & security notes, deployment & recovery guide |
| `e2e/` | Playwright browser smoke script |

## Quick start (local development)

Prerequisites: Node.js 20+, PostgreSQL 14+ (local, or a Supabase project).

```bash
npm run install:all

# 1. Configure the backend
cp backend/.env.example backend/.env       # then edit DATABASE_URL and SESSION_SECRET
cp frontend/.env.example frontend/.env     # leave empty for local dev (Vite proxies /api to :4000)

# 2. Create the schema and starter data
createdb bilecutz                          # or use any empty database
npm run db:migrate
npm run db:seed                            # opening hours, settings row, FAQs
npm run db:seed:demo                       # OPTIONAL sample services (edit later in the admin)

# 3. Create the shop owner (one-time; there is no public admin sign-up)
npm run admin:create -- --email owner@yourshop.com --name "Shop Owner"
#   password is typed at a hidden prompt (min 12 chars) or read from ADMIN_PASSWORD

# 4. Run
npm run dev:backend      # http://localhost:4000
npm run dev:frontend     # http://localhost:5173
```

* Customer site: http://localhost:5173 · Shop sign-in: http://localhost:5173/admin/login (not linked from the public site).
* Password-reset emails in development are written to `backend/.dev-outbox/*.json` (the `dev-outbox` provider is refused in production).
* Use `localhost` (not `127.0.0.1`) in the browser, because `ALLOWED_ORIGINS` is matched exactly.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` / `lint` | TypeScript + ESLint for both apps |
| `npm test` | Backend tests (need PostgreSQL, see below) + frontend tests |
| `npm run build` | Production builds of backend (`backend/dist`) and frontend (`frontend/dist`) |
| `npm run db:migrate` | Apply pending SQL migrations from `database/migrations` |
| `npm --prefix backend run cleanup` | Run the safe cleanup once (also scheduled inside the server) |

### Backend tests

The backend suite talks to a real PostgreSQL (it tests locking and concurrency, which cannot be faked).
Point it at a throw-away database whose name contains `test` — **its `public` schema is wiped on each run**:

```bash
createdb bilecutz_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/bilecutz_test npm --prefix backend test
```

## What you can configure without touching code

Everything business-specific lives in the database and is edited in **Admin → Settings**: name, logo, hero image, contact
details, WhatsApp number, currency (default `NGN`), timezone (default `Africa/Lagos`), opening hours per day, breaks,
holidays/closures, slot interval, buffer time, simultaneous appointment capacity, same-day rule, minimum notice,
advance-booking window, cancellation deadline, policy texts and notification preferences. Services, gallery and FAQs have
their own pages. Changes apply immediately — no redeploy.

**Placeholders:** the seed uses obviously placeholder contact details (`+234 000 000 0000`, `hello@example.com`, "Your shop
address…") and no fake reviews. Replace them in Settings before launch. Demo services are optional and clearly sample data.

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how booking capacity, auth, chat and notifications work, and the security model
* [docs/API.md](docs/API.md) — REST + Socket.IO contract
* [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — step-by-step deployment, backups/recovery, production checklist
