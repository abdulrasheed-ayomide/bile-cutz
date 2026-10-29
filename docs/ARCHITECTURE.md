# Architecture and design decisions

```
Browser ──HTTPS──▶ Vercel (static React app, SPA rewrite)
   │                  │ /api/* and /uploads/* rewritten to ▼
   ├──HTTPS (REST)───▶ Node/Express API (Render / Railway / Fly / any persistent host)
   └──WSS (Socket.IO)─▶        └─ Socket.IO on the same HTTP server
                                  │ SQL (pg pool, parameterized)
                                  ▼
                           Supabase PostgreSQL  (+ Supabase Storage for images)
```

The browser **never** talks to Supabase directly. The Express API is the only data-access layer and holds the only database
credentials. Consequently every table has Row Level Security **enabled with no policies**, which locks out Supabase's public
`anon`/`authenticated` API roles entirely; the API connects with a privileged role that bypasses RLS. The Storage bucket is
public-read (shop photos) with no write policies; writes go through the API with the service-role key, which exists only in
the backend environment.

Vercel serverless functions are not used for the API, because chat needs long-lived connections (verified: Vercel's WebSocket
support is beta and tied to function lifecycles; see DEPLOYMENT.md). The frontend therefore connects Socket.IO directly to the
backend origin (`VITE_SOCKET_URL`) while REST goes through the same-origin `/api` rewrite.

## Booking and capacity

The shop has `max_simultaneous` seats. A booking occupies the half-open interval `[start_at, blocked_until)` where
`blocked_until = start + service duration + buffer`. A request fits only if, at **every instant** of its own interval, fewer than
`max_simultaneous` active (pending or approved) bookings cover that instant. This is computed with a sweep line over the
existing intervals (`maxConcurrency` in `backend/src/services/availability.ts`), not by counting overlapping rows — e.g. at
capacity 2, two sequential one-hour bookings do not block a two-hour booking spanning both. Adjacent bookings never collide.

* Pending bookings **hold** capacity so two customers cannot be promised the same chair; rejected, cancelled and completed
  bookings **release** it.
* Opening a booking form reserves nothing. A slot is consumed only when the insert commits.
* **Concurrency control:** every capacity-affecting write runs in a transaction that first takes
  `pg_advisory_xact_lock(90210)`. Requests are serialized, each re-validates hours/breaks/closures/notice/capacity against fresh
  data, then inserts. A test fires 12 simultaneous requests at one slot of capacity 2 and asserts exactly 2 succeed. The lock is
  global (single-shop system); at one shop's volume this is negligible, and it keeps the reasoning simple and provably safe.
* Slots are generated in the business timezone: local opening hours (`time` columns) are converted to UTC instants per date with
  Luxon, so DST and timezone changes are handled by the library. Stored instants are `timestamptz` (UTC).
* Appointments snapshot service name, price and duration, so editing/deactivating/deleting a service never alters history.
* Status workflow (enforced server-side): `pending → approved | rejected | cancelled`, `approved → completed | cancelled`.
  Every change appends to `appointment_status_history` (from, to, actor, role, reason, time). Customers/guests can only cancel,
  and only before the cancellation deadline; cancellations record time and actor and never delete rows.
* Staff-created bookings (walk-in/phone/in-person/other) use the same hours/break/closure/capacity checks and start `approved`.
  There is intentionally **no capacity override**. Staff may book inside the public notice window and up to one slot in the past
  (to record a walk-in who has just sat down).
* Changing hours, timezone, capacity or closures never edits existing bookings; the admin gets a warning with the number of
  upcoming bookings that exist so they can review them.

## Authentication and authorization

* Passwords: Argon2id. A dummy hash is verified for unknown emails to equalize timing; failures return one generic message.
* Sessions: opaque random token in an `HttpOnly`, `SameSite` cookie (`Secure` in production); only its SHA-256 is stored.
  Customer (`bc_session`) and admin (`bc_admin_session`) sessions are **separate cookies, separate scopes and separately checked
  against the user's role** — a customer account cannot hold an admin session, and an admin login rejects customers.
* Roles are only assigned server-side: registration hard-codes `customer`; admins are provisioned by the
  `npm run admin:create` CLI. There is no HTTP route that creates or promotes an admin, and the CLI refuses to take over an
  existing customer account. `staff` can run day-to-day operations; `admin` (owner) additionally controls settings, services,
  gallery, FAQs, review moderation, customer suspension and system tools.
* CSRF: each session has its own CSRF token (kept in memory in the browser, sent as `X-CSRF-Token`) required on every mutating
  request, plus an `Origin` allow-list check. CORS is restricted to `ALLOWED_ORIGINS`.
* Rate limits: sign-in, admin sign-in, registration, password recovery, booking, guest-token lookups, chat sending, global API.
* Password recovery: 256-bit single-use tokens, SHA-256 stored, 1-hour expiry, atomic consume, always `202` regardless of whether
  the account exists, scoped (customer links cannot reset admin passwords and vice versa), all sessions revoked after a reset.
  Tokens are never logged.
* Ownership: customer queries are always scoped by `user_id`; foreign ids return `404` (not `403`) so ids cannot be probed.
* Guest bookings: a 256-bit private token (only its hash is stored) is the sole credential for `/booking/manage/<token>`. The
  reference number alone grants nothing. A guest can later attach the booking to an account with the same token via
  “Add a guest booking”; once attached it cannot be claimed by anyone else.
* Uploads: admin-only, ≤ 5 MB, type decided by magic bytes (JPEG/PNG/WebP), stored under random names.
* Logging: structured JSON with automatic redaction of password/token/secret/cookie keys; request bodies are never logged.
* Environment is validated at startup with Zod; production refuses placeholder secrets, `dev-outbox` email and non-HTTPS URLs.

## Chat

One conversation per customer (`conversations.customer_id` is unique); `assigned_staff_id` is already in the schema for future
multi-staff routing. Messages are written to PostgreSQL **before** anything is broadcast or acknowledged. The browser sends via
REST (reliable, idempotent through `clientMessageId`) and receives live via Socket.IO; after a reconnect it fetches
`?after=<lastId>` to fill gaps, and long histories page backwards with `?before=<id>`. Sockets authenticate with a 60-second
HMAC-signed ticket obtained over the authenticated REST session; customers are joined only to their own `user:<id>` room.
Unread counts are derived from `messages.read_at`, per side.

## Notifications

`notifications` rows are created by one service (`services/notifications.ts`) with a `dedupe_key`, so retries never duplicate.
They reference appointments/conversations/reviews through plain `entity_type` + `entity_id` columns **without foreign keys**,
which is why deleting a notification can never delete — or be blocked by — a business record. Chat notifications reuse a single
row per conversation (re-marked unread) to avoid flooding.

## Data retention

Automatic cleanup (daily in-process, or `npm run cleanup`) removes only: expired/used password-reset tokens (1 day after expiry),
expired sessions, read notifications older than `notification_retention_days` (default 90, editable) and any notification older
than a year. Customers, appointments, history, reviews, chat messages and audit logs are **never** deleted automatically.
Cleanup does not by itself stop the database growing — watch Admin → System and see DEPLOYMENT.md for scaling guidance.

## WhatsApp

v1 uses click-to-chat (`https://wa.me/<digits>?text=<encoded>`). Numbers are normalized to international digits using a
configurable default country code. A link only opens WhatsApp with a prepared message; a person must press send, and the app
never claims delivery or read status. `lib/whatsapp.ts` builds messages in one place, so an approved WhatsApp Business Platform
provider can later replace the links with automated sending, templates, delivery reports and consent tracking.

## Known limitations (by design for v1)

* No online payments (pay at the shop), no email verification, no automated reminders or WhatsApp sending.
* Single global capacity (customers do not choose a barber); `assigned_staff_id` is reserved for later.
* Calendar shows day/week/month lists and badges (not a drag-and-drop time grid).
* Rate-limit counters and the capacity lock live in the single API instance / database. To run multiple API instances, the
  capacity lock already works (it is a database lock), Socket.IO would need the Redis adapter, and rate limiting a shared store.
