-- Bile Cutz — initial schema
-- All instants are stored as timestamptz (UTC). Local opening hours are stored as
-- local wall-clock `time` values and interpreted in business_settings.timezone.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users & authentication
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  phone          text,
  -- Role is only ever assigned server-side (registration always creates 'customer';
  -- admins are provisioned with the one-time `npm run admin:create` command).
  role           text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'staff')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_role_idx ON users (role);
CREATE INDEX users_created_idx ON users (created_at DESC);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,           -- sha256 of the opaque cookie value
  csrf_token    text NOT NULL,                  -- per-session CSRF token (sent in X-CSRF-Token)
  scope         text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'admin')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,             -- sha256; plaintext token is only ever emailed
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_expires_idx ON password_reset_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Business settings (single row) and schedule
-- ---------------------------------------------------------------------------
CREATE TABLE business_settings (
  id                          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name               text NOT NULL DEFAULT 'Bile Cutz',
  tagline                     text NOT NULL DEFAULT 'Premium Barbing Salon',
  description                 text NOT NULL DEFAULT 'Precision cuts, clean fades and a calm, premium grooming experience. (Placeholder text — edit in Admin → Settings.)',
  about_text                  text NOT NULL DEFAULT 'Tell your customers your story here. (Placeholder text — edit in Admin → Settings.)',
  logo_url                    text,
  hero_image_url              text,
  contact_phone               text NOT NULL DEFAULT '+234 000 000 0000',
  whatsapp_number             text NOT NULL DEFAULT '+234 000 000 0000',
  contact_email               text NOT NULL DEFAULT 'hello@example.com',
  address                     text NOT NULL DEFAULT 'Your shop address (placeholder — edit in Admin → Settings)',
  default_country_code        text NOT NULL DEFAULT '234' CHECK (default_country_code ~ '^[0-9]{1,4}$'),
  currency                    text NOT NULL DEFAULT 'NGN' CHECK (currency ~ '^[A-Z]{3}$'),
  timezone                    text NOT NULL DEFAULT 'Africa/Lagos',
  slot_interval_minutes       integer NOT NULL DEFAULT 30 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  default_service_minutes     integer NOT NULL DEFAULT 30 CHECK (default_service_minutes BETWEEN 5 AND 480),
  buffer_minutes              integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 120),
  max_simultaneous            integer NOT NULL DEFAULT 2 CHECK (max_simultaneous BETWEEN 1 AND 100),
  allow_same_day              boolean NOT NULL DEFAULT true,
  min_notice_minutes          integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 20160),
  max_advance_days            integer NOT NULL DEFAULT 30 CHECK (max_advance_days BETWEEN 1 AND 365),
  cancellation_deadline_hours integer NOT NULL DEFAULT 2 CHECK (cancellation_deadline_hours BETWEEN 0 AND 720),
  booking_policy_text         text NOT NULL DEFAULT 'Bookings are confirmed once approved by the shop. Payment is made at the shop.',
  cancellation_policy_text    text NOT NULL DEFAULT 'You can cancel online until the cancellation deadline shown on your booking. After that, please contact the shop.',
  notify_admin_new_booking    boolean NOT NULL DEFAULT true,
  notify_admin_chat           boolean NOT NULL DEFAULT true,
  notify_admin_review         boolean NOT NULL DEFAULT true,
  notify_admin_cancellation   boolean NOT NULL DEFAULT true,
  notification_retention_days integer NOT NULL DEFAULT 90 CHECK (notification_retention_days BETWEEN 7 AND 3650),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- day_of_week: 0 = Sunday ... 6 = Saturday (same as JS / Postgres EXTRACT(dow))
CREATE TABLE opening_hours (
  day_of_week  smallint PRIMARY KEY CHECK (day_of_week BETWEEN 0 AND 6),
  is_open      boolean NOT NULL DEFAULT true,
  open_time    time NOT NULL DEFAULT '09:00',
  close_time   time NOT NULL DEFAULT '19:00',
  CONSTRAINT opening_hours_order CHECK (NOT is_open OR close_time > open_time)
);

CREATE TABLE break_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_of_week  smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  label        text,
  CONSTRAINT break_order CHECK (end_time > start_time)
);
CREATE INDEX break_periods_day_idx ON break_periods (day_of_week);

-- Holidays and temporary closures: whole local dates, inclusive range.
CREATE TABLE closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  kind        text NOT NULL DEFAULT 'closure' CHECK (kind IN ('holiday', 'closure')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closure_order CHECK (end_date >= start_date)
);
CREATE INDEX closures_dates_idx ON closures (start_date, end_date);

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------
CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '',
  price             numeric(12, 2) NOT NULL CHECK (price >= 0),
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  image_url         text,
  is_active         boolean NOT NULL DEFAULT true,
  is_featured       boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  deleted_at        timestamptz,                 -- soft delete; history keeps snapshots anyway
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_listing_idx ON services (is_active, sort_order) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------
CREATE SEQUENCE appointment_ref_seq START 1001;

CREATE TABLE appointments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                 text NOT NULL UNIQUE,
  user_id                   uuid REFERENCES users(id) ON DELETE SET NULL,
  guest_token_hash          text UNIQUE,         -- sha256 of private management token (guest bookings)
  customer_name             text NOT NULL,
  customer_email            text,
  customer_phone            text,
  notes                     text,
  service_id                uuid REFERENCES services(id) ON DELETE SET NULL,
  -- Snapshots: history survives later edits / deactivation of the service.
  service_name              text NOT NULL,
  service_price             numeric(12, 2) NOT NULL,
  service_duration_minutes  integer NOT NULL,
  currency                  text NOT NULL,
  start_at                  timestamptz NOT NULL,
  end_at                    timestamptz NOT NULL,   -- start + service duration
  blocked_until             timestamptz NOT NULL,   -- end + buffer; used for capacity calculation
  status                    text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  source                    text NOT NULL DEFAULT 'website'
                              CHECK (source IN ('website', 'walk_in', 'phone', 'in_person', 'other')),
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  status_reason             text,
  cancelled_at              timestamptz,
  cancelled_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_role         text CHECK (cancelled_by_role IN ('customer', 'guest', 'admin', 'staff')),
  claimed_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_interval CHECK (end_at > start_at AND blocked_until >= end_at)
);
CREATE INDEX appointments_start_idx ON appointments (start_at);
CREATE INDEX appointments_active_interval_idx ON appointments (start_at, blocked_until)
  WHERE status IN ('pending', 'approved');
CREATE INDEX appointments_user_idx ON appointments (user_id, start_at DESC);
CREATE INDEX appointments_status_idx ON appointments (status, start_at);
CREATE INDEX appointments_service_idx ON appointments (service_id);
CREATE INDEX appointments_email_idx ON appointments (lower(customer_email));

CREATE TABLE appointment_status_history (
  id              bigserial PRIMARY KEY,
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_status     text,
  to_status       text NOT NULL,
  changed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_by_role text NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_history_idx ON appointment_status_history (appointment_id, created_at);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type               text NOT NULL,
  title              text NOT NULL,
  body               text NOT NULL DEFAULT '',
  entity_type        text CHECK (entity_type IN ('appointment', 'conversation', 'review')),
  entity_id          text,                         -- soft link: deleting a notification never touches the record
  dedupe_key         text,
  read_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_user_id, dedupe_key)
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  assigned_staff_id     uuid REFERENCES users(id) ON DELETE SET NULL,   -- future multi-staff support
  last_message_at       timestamptz,
  last_message_preview  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_activity_idx ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE messages (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role       text NOT NULL CHECK (sender_role IN ('customer', 'staff')),   -- 'staff' covers admin/staff
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  client_message_id text,                       -- idempotency key supplied by the client
  created_at        timestamptz NOT NULL DEFAULT now(),
  read_at           timestamptz,
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id DESC);
CREATE INDEX messages_unread_idx ON messages (conversation_id, sender_role) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reviews, gallery, FAQs
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,  -- one review per appointment
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_name     text NOT NULL,
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text NOT NULL CHECK (char_length(comment) BETWEEN 1 AND 1500),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  moderated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  moderated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_status_idx ON reviews (status, created_at DESC);

CREATE TABLE gallery_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url           text NOT NULL,
  storage_path  text,                          -- set when the file lives in our storage bucket / upload dir
  caption       text NOT NULL DEFAULT '',
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gallery_order_idx ON gallery_images (sort_order, created_at);

CREATE TABLE faqs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  answer      text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Audit log (never auto-deleted)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: the Express backend is the only data-access layer and connects
-- with a privileged role. Browsers never talk to Supabase directly, so we enable RLS
-- with NO policies on every table: Supabase's public (anon/authenticated) API roles
-- then cannot read or write anything. The backend's postgres role bypasses RLS.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
