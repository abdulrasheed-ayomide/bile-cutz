# Bile Cutz — API contract

This is the single source of truth for the REST + Socket.IO API. Backend and frontend are both built against it.

## Conventions

- Base path `/api`. JSON in, JSON out. Field names are **camelCase**; database columns are snake_case and mapped in services.
- Success: the resource object(s) directly, e.g. `{ "appointment": {...} }` or `{ "items": [...], "total": 42, "page": 1, "pageSize": 20 }`.
- Error: HTTP status + `{ "error": { "code": "VALIDATION_ERROR", "message": "Human readable", "details": {...optional} } }`.
  Codes: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `SLOT_UNAVAILABLE` 409, `RATE_LIMITED` 429, `INTERNAL` 500.
- Instants are ISO-8601 UTC strings. Appointments additionally carry `localDate` (`YYYY-MM-DD`) and `localTime` (`HH:mm`) in the **business timezone**, so the frontend needs no timezone maths for display. Dates sent *to* the API (`date`, `month`) are business-local dates.
- Money is a JSON number in major units (e.g. `3000` NGN); the currency code comes from settings / the appointment.
- Pagination: `?page=1&pageSize=20` (max pageSize 100).
- Auth: two **separate** opaque httpOnly cookies — `bc_session` (customers) and `bc_admin_session` (staff/admin). Both are sent by the browser with `credentials: "include"`.
- CSRF: every state-changing request (POST/PUT/PATCH/DELETE) that carries a session cookie must send header `X-CSRF-Token: <csrfToken>` (returned by login/register/me). The server also rejects mutating requests whose `Origin` header is not an allowed origin.
- Public GET endpoints send `Cache-Control: public, max-age=60`. Everything authenticated sends `Cache-Control: no-store`.

## Shared shapes

```ts
User        { id, fullName, email, phone|null, role: "customer"|"admin"|"staff", status, createdAt }
Appointment {
  id, reference, status: "pending"|"approved"|"rejected"|"cancelled"|"completed",
  source: "website"|"walk_in"|"phone"|"in_person"|"other",
  customer: { userId|null, name, email|null, phone|null },
  service: { id|null, name, price, durationMinutes },     // snapshot taken at booking time
  currency, startAt, endAt, localDate, localTime, localEndTime,
  notes|null, statusReason|null, cancelledAt|null, cancelledByRole|null, createdAt,
  history?: [{ fromStatus|null, toStatus, changedByRole, changedByName|null, reason|null, createdAt }],  // detail views only
  canCancel?: boolean,      // customer/guest views: policy allows cancellation right now
  canReview?: boolean, hasReview?: boolean,                // customer views
  whatsapp?: { chatLink|null, confirmationLink|null, cancellationLink|null, reminderLink|null }  // admin views only; null when no phone
}
Notification { id, type, title, body, entityType: "appointment"|"conversation"|"review"|null, entityId|null, read: boolean, createdAt }
Message      { id (number), conversationId, senderId, senderRole: "customer"|"staff", body, clientMessageId|null, createdAt, readAt|null }
Conversation { id, customer: { id, fullName, email }, lastMessageAt|null, lastMessagePreview|null, unreadCount }   // unreadCount is from the *viewer's* side
Service      { id, name, description, price, durationMinutes, imageUrl|null, isActive, isFeatured, sortOrder }
Review       { id, appointmentId, authorName, rating 1-5, comment, status, createdAt, moderatedAt|null }
GalleryImage { id, url, caption, sortOrder, isActive }
Faq          { id, question, answer, sortOrder, isActive }
```

## Public (no auth)

| Method & path | Notes |
|---|---|
| `GET /api/public/settings` | `{ business: { name, tagline, description, aboutText, logoUrl, heroImageUrl, phone, whatsappNumber, whatsappLink, email, address, currency, timezone, bookingPolicyText, cancellationPolicyText, cancellationDeadlineHours, slotIntervalMinutes, minNoticeMinutes, maxAdvanceDays, allowSameDay }, openingHours: [{ dayOfWeek 0-6 (0=Sun), isOpen, openTime "HH:mm", closeTime, breaks: [{ startTime, endTime, label|null }] }], closures: [{ id, startDate, endDate, kind, reason }] (upcoming only) }` |
| `GET /api/public/services?featured=1` | `{ items: Service[] }` — active, non-deleted, ordered by `sortOrder` |
| `GET /api/public/gallery?limit=` | `{ items: GalleryImage[] }` active only |
| `GET /api/public/reviews?limit=` | `{ items: [{ id, authorName, rating, comment, createdAt }], average: number\|null, count }` — **approved only** |
| `GET /api/public/faqs` | `{ items: Faq[] }` active only |
| `GET /api/public/availability/dates?serviceId=&month=YYYY-MM` | `{ month, timezone, dates: [{ date, available: boolean }] }` — one entry per day of the month |
| `GET /api/public/availability?serviceId=&date=YYYY-MM-DD` | `{ date, timezone, slots: [{ startAt, time "HH:mm", available: boolean }] }` — unavailable slots are included with `available:false` so the UI can show them disabled |
| `POST /api/public/bookings` | body `{ serviceId, startAt, name, email, phone?, notes? }`. If a customer session cookie is present the booking is attached to that account (name/email default from the account). Always `pending`, `source: "website"`. → `201 { appointment, managementToken?, managementPath? }` — `managementToken`/`managementPath` (`/booking/manage/<token>`) are returned **once**, only for guest bookings. `409 SLOT_UNAVAILABLE` if the slot was taken. Rate limited. |
| `GET /api/guest/bookings/:token` | `{ appointment (with history, canCancel), business: {name, phone, whatsappLink, address, cancellationPolicyText} }` |
| `POST /api/guest/bookings/:token/cancel` | body `{ reason? }` → `{ appointment }`. 403 if outside cancellation policy. |

## Customer auth (`bc_session`)

| Method & path | Notes |
|---|---|
| `POST /api/auth/register` | `{ fullName, email, phone?, password, confirmPassword }` → `201 { user, csrfToken }`, sets cookie. Role is always `customer`. `409 CONFLICT` for duplicate email (case-insensitive). Password ≥ 8 chars, must contain a letter and a digit. |
| `POST /api/auth/login` | `{ email, password }` → `{ user, csrfToken }`. Staff/admin accounts are **rejected** here with the same generic invalid-credentials error. |
| `POST /api/auth/logout` | clears the customer cookie |
| `GET /api/auth/me` | `{ user, csrfToken }` or 401 |
| `POST /api/auth/forgot-password` | `{ email }` → always `202 { ok: true }` |
| `POST /api/auth/reset-password` | `{ token, password, confirmPassword }` → `{ ok: true }`; single use, 1 hour expiry; revokes all sessions |
| `PATCH /api/me/profile` | `{ fullName, phone? }` → `{ user }` |
| `POST /api/me/password` | `{ currentPassword, newPassword, confirmPassword }` → `{ ok }`; revokes other sessions |

## Customer area (`bc_session`, role customer)

| Method & path | Notes |
|---|---|
| `GET /api/me/appointments?tab=upcoming\|past\|all&page&pageSize` | `{ items: Appointment[], total, page, pageSize }`. upcoming = future `pending/approved`; past = everything else or already-started. |
| `GET /api/me/appointments/:id` | `{ appointment }` incl. `history`, `canCancel`, `canReview`, `hasReview`. 404 if not the caller's. |
| `POST /api/me/appointments/:id/cancel` | `{ reason? }` → `{ appointment }`; 403 `FORBIDDEN` if deadline passed / status not cancellable |
| `GET /api/me/appointments/:id/confirmation` | `{ appointment, business: { name, phone, whatsappLink, email, address, bookingPolicyText, cancellationPolicyText } }`. **403 unless status is `approved`.** |
| `POST /api/me/claim-booking` | `{ token }` — attaches a guest booking (identified by its private management token) to the signed-in account. 409 if already owned. |
| `POST /api/me/appointments/:id/review` | `{ rating, comment }` → `201 { review }`; only for the caller's own `completed` appointment, once. Created `pending`. |
| `GET /api/me/reviews` | `{ items: Review[] }` |

### Notifications (customer)

`GET /api/notifications?unread=1&page&pageSize` → `{ items: Notification[], total, unreadCount, page, pageSize }`
`GET /api/notifications/unread-count` → `{ unreadCount }`
`POST /api/notifications/:id/read` · `POST /api/notifications/read-all` → `{ ok, unreadCount }`
`POST /api/notifications/delete` body `{ ids?: string[], olderThanDays?: number, onlyRead?: boolean }` → `{ deleted: n }` — only deletes the caller's own notification rows; never touches linked records.
Admin equivalents live under `/api/admin/notifications` with identical shapes.

### Chat (customer)

`GET /api/chat/conversation` → `{ conversation: Conversation }` (created on first use)
`GET /api/chat/conversations/:id/messages?before=<messageId>&after=<messageId>&limit=30` → `{ items: Message[] (ascending by id), hasMore: boolean }`. `before` pages backwards (older), `after` fetches messages missed during a disconnect. Neither → newest `limit`.
`POST /api/chat/conversations/:id/messages` `{ body, clientMessageId }` → `201 { message }` (idempotent on `clientMessageId`)
`POST /api/chat/conversations/:id/read` → `{ ok, unreadCount: 0 }` marks the *other side's* messages read
`POST /api/chat/socket-ticket` → `{ ticket, expiresInSeconds }`
Admin equivalents: `/api/admin/chat/...` (same shapes, but staff may use any conversation id).

## Admin auth (`bc_admin_session`)

| Method & path | Notes |
|---|---|
| `POST /api/admin/auth/login` | `{ email, password }` → `{ user, csrfToken }`. Only `admin`/`staff` roles; customers get the generic invalid-credentials error. Stricter rate limit. |
| `POST /api/admin/auth/logout` · `GET /api/admin/auth/me` | as above |
| `POST /api/admin/auth/forgot-password` · `POST /api/admin/auth/reset-password` | as above, but only for admin/staff accounts; email link points to `/admin/reset-password?token=` |
| `PATCH /api/admin/profile` · `POST /api/admin/password` | as customer equivalents |

## Admin API (`bc_admin_session`; `staff` or `admin` unless marked ADMIN)

| Method & path | Notes |
|---|---|
| `GET /api/admin/dashboard/summary` | `{ todayAppointments, pendingApprovals, approved, completed, cancelled, totalCustomers, pendingReviews, unreadConversations, upcoming: Appointment[] (next 8 active) }` — `approved/completed/cancelled` count all-time. |
| `GET /api/admin/appointments?q&status&date&from&to&serviceId&source&customerId&page&pageSize&sort=start_desc\|start_asc\|created_desc` | `{ items: Appointment[] (with whatsapp), total, page, pageSize }`. `q` matches reference, customer name/email/phone. `date` is a local date; `from`/`to` are local dates (inclusive). |
| `GET /api/admin/appointments/calendar?from=ISO&to=ISO&status&serviceId` | `{ items: Appointment[] }` (max 1000) overlapping the range; `localDate` fields in business tz. |
| `GET /api/admin/appointments/:id` | `{ appointment }` with `history`, `whatsapp` |
| `POST /api/admin/appointments` | manual booking `{ serviceId, startAt, name, email?, phone?, notes?, source: "walk_in"\|"phone"\|"in_person"\|"other", userId? }` → `201 { appointment }`, created **approved**. Same hours/break/closure/capacity checks as public booking (notice period and same-day/advance limits are waived for staff; start must not be in the past by more than one slot interval). `409 SLOT_UNAVAILABLE` otherwise. |
| `POST /api/admin/appointments/:id/approve` · `/complete` | `{ reason? }` → `{ appointment }` (`complete` only once start time has passed) |
| `POST /api/admin/appointments/:id/reject` · `/cancel` | `{ reason? }` |
| `GET /api/admin/availability?serviceId&date` | same as public availability but with staff rules (no notice/advance limits) — used by the manual booking form |
| `GET /api/admin/services` · `POST` · `PATCH /:id` · `POST /reorder {ids}` · `DELETE /:id` | **ADMIN** for writes. DELETE is a soft delete. Includes inactive services. |
| `POST /api/admin/uploads` | **ADMIN** multipart field `file` + `kind` (`gallery`\|`service`\|`logo`\|`hero`). JPEG/PNG/WebP, ≤ 5 MB, magic-byte checked → `{ url, storagePath }` |
| `GET /api/admin/customers?q&status&page&pageSize` | `{ items: [{ id, fullName, email, phone, status, createdAt, appointmentCount, lastAppointmentAt }], total, ... }` |
| `GET /api/admin/customers/:id` | `{ customer: User, stats: { total, pending, approved, completed, cancelled, rejected }, appointments: Appointment[] (latest 50), conversationId\|null, whatsappLink\|null }` |
| `PATCH /api/admin/customers/:id/status` | **ADMIN** `{ status }` — suspending revokes the customer's sessions |
| `GET /api/admin/reviews?status&page&pageSize` · `GET /:id` · `POST /:id/status {status}` | status ∈ `pending/approved/rejected/hidden`; **ADMIN only** for status changes (restore = back to `pending` or `approved`) |
| `GET /api/admin/gallery` · `POST` · `PATCH /:id` · `POST /reorder` · `DELETE /:id` | **ADMIN** for writes; delete also removes the stored file |
| `GET /api/admin/faqs` · `POST` · `PATCH /:id` · `DELETE /:id` | **ADMIN** for writes |
| `GET /api/admin/settings` | `{ business: {...all columns incl. notify*, retention}, openingHours: [...with breaks], closures: [...all] }` |
| `PUT /api/admin/settings` | **ADMIN** partial update of business fields (validated). → `{ business, warnings: { affectedAppointments } }` |
| `PUT /api/admin/settings/hours` | **ADMIN** `{ days: [{ dayOfWeek, isOpen, openTime, closeTime, breaks: [{ startTime, endTime, label? }] }] }` (all 7 days) → `{ openingHours, warnings }` |
| `POST /api/admin/settings/closures` · `DELETE /api/admin/settings/closures/:id` | **ADMIN** `{ startDate, endDate, kind, reason? }` → `{ closure, warnings }` |
| `GET /api/admin/system/usage` | **ADMIN** `{ databaseSizeBytes, tables: [{ name, rows, sizeBytes }], retention: {...} }` |
| `POST /api/admin/system/cleanup` | **ADMIN** runs the safe cleanup now → `{ expiredResetTokens, expiredSessions, oldNotifications }` |
| `GET /api/admin/audit?page` | **ADMIN** `{ items: [{ id, actorName, action, entityType, entityId, details, createdAt }], total }` |
| `GET /api/admin/chat/conversations?q&unread=1&page&pageSize` | `{ items: Conversation[], total }` ordered by last activity; only conversations with messages unless `all=1` |
| `POST /api/admin/chat/conversations` | `{ customerId }` → `{ conversation }` (get-or-create) |

## Realtime (Socket.IO, path `/socket.io`)

Connect with `io(API_ORIGIN, { auth: { ticket } })` where `ticket` comes from `POST /api/chat/socket-ticket` (customer) or `/api/admin/chat/socket-ticket` (staff). Tickets are HMAC-signed, expire in 60 s and only authenticate the handshake. Customers are auto-joined to `user:<id>` and `conv:<theirConversationId>`; staff to `staff`.

Server → client:
- `message:new` `{ message: Message }` (to the conversation participants + `staff`)
- `conversation:updated` `{ conversation: Conversation-for-staff }` → `staff` room (inbox refresh)
- `notification:new` `{ notification: Notification }` → `user:<recipientId>`
- `messages:read` `{ conversationId, by: "customer"|"staff" }`

Client → server (all use acks):
- `message:send` `{ conversationId, body, clientMessageId }` → ack `{ ok: true, message } | { ok: false, error }` — persisted before ack.
- `conversation:read` `{ conversationId }` → ack `{ ok, unreadCount }`

After a reconnect the client calls `GET .../messages?after=<lastSeenId>` to fill gaps.

## Notification types

`booking_submitted`, `booking_approved`, `booking_rejected`, `booking_cancelled`, `booking_completed`, `review_submitted`, `review_approved`, `chat_message`. Each has `entityType`/`entityId` pointing at the appointment, review or conversation. Duplicate suppression uses `dedupe_key` (`appt:<id>:<event>`, `review:<id>`, `chat:<conversationId>` — the chat one re-opens a single unread row).

## Frontend routes

Public: `/`, `/services`, `/gallery`, `/reviews`, `/about`, `/faq`, `/contact`, `/book`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/booking/manage/:token`.
Customer: `/account` (overview), `/account/appointments`, `/account/appointments/:id`, `/account/appointments/:id/confirmation` (print), `/account/messages`, `/account/notifications`, `/account/profile`.
Admin: `/admin/login`, `/admin/forgot-password`, `/admin/reset-password`, `/admin` (dashboard), `/admin/appointments`, `/admin/appointments/:id`, `/admin/calendar`, `/admin/bookings/new`, `/admin/services`, `/admin/customers`, `/admin/customers/:id`, `/admin/reviews`, `/admin/gallery`, `/admin/messages`, `/admin/notifications`, `/admin/settings`, `/admin/faqs`, `/admin/system`.
