-- Barbershop booking: staff, services, opening hours, customers, bookings,
-- the WhatsApp conversation state and an idempotent reminder log.
-- All timestamps are UTC ISO-8601; the shop's local time zone lives in config.

CREATE TABLE barbers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL UNIQUE,          -- E.164 digits, no "+"
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE services (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240),
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  active       INTEGER NOT NULL DEFAULT 1
);

-- weekly opening hours per barber; weekday 0 = Sunday … 6 = Saturday (local time)
CREATE TABLE working_hours (
  barber_id  INTEGER NOT NULL REFERENCES barbers(id),
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens      TEXT NOT NULL CHECK (opens GLOB '[0-2][0-9]:[0-5][0-9]'),
  closes     TEXT NOT NULL CHECK (closes GLOB '[0-2][0-9]:[0-5][0-9]' AND closes > opens),
  PRIMARY KEY (barber_id, weekday, opens)
);

-- one-off blocks: lunch, day off, holiday
CREATE TABLE time_off (
  id         INTEGER PRIMARY KEY,
  barber_id  INTEGER NOT NULL REFERENCES barbers(id),
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL CHECK (ends_at > starts_at),
  reason     TEXT
);

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE bookings (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  barber_id     INTEGER NOT NULL REFERENCES barbers(id),
  service_id    INTEGER NOT NULL REFERENCES services(id),
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL CHECK (ends_at > starts_at),
  status        TEXT NOT NULL DEFAULT 'confirmed'
                CHECK (status IN ('confirmed', 'cancelled', 'done', 'no_show')),
  source        TEXT NOT NULL CHECK (source IN ('whatsapp', 'dashboard')),
  created_at    TEXT NOT NULL,
  cancelled_at  TEXT,
  cancelled_by  TEXT
);
CREATE INDEX bookings_barber_time ON bookings (barber_id, starts_at);
CREATE INDEX bookings_customer ON bookings (customer_id, starts_at);

-- where each WhatsApp number is in the booking flow
CREATE TABLE conversations (
  phone       TEXT PRIMARY KEY,
  step        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL
);

-- every message in and out; the simulator reads the outbox from here
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  phone       TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- text | buttons | list | template
  body        TEXT NOT NULL,              -- JSON
  wa_id       TEXT UNIQUE,                -- Meta message id: dedupes webhook retries
  status      TEXT NOT NULL DEFAULT 'ok', -- ok | failed
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX messages_phone ON messages (phone, id);

-- one row per reminder ever sent; the UNIQUE key makes sending idempotent
CREATE TABLE reminders (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,       -- customer_1h:<booking> | barber_30m:<booking> | barber_day:<barber>:<date>
  booking_id  INTEGER REFERENCES bookings(id),
  sent_at     TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  login          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  barber_id      INTEGER REFERENCES barbers(id)   -- NULL = owner, sees every barber
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
