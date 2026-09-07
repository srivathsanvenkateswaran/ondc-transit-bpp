-- The four tables a reserved intercity seller needs, and the one index that
-- makes double-booking impossible.
--
-- Holds and bookings share `seat_locks` because they are the same claim on the
-- same resource at two strengths. One partial unique index over both is what
-- stops two riders holding one berth, and the constraint rather than the
-- application check is the guarantee: the check exists to produce a good error
-- message, and where the two ever disagree the constraint is right.

CREATE TABLE seat_locks (
  id             TEXT PRIMARY KEY,
  service_id     TEXT NOT NULL,
  travel_date    TEXT NOT NULL,          -- ISO YYYY-MM-DD, Asia/Kolkata
  seat_id        TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('HELD','BOOKED','EXPIRED','RELEASED')),
  hold_id        TEXT,                   -- non-null while HELD
  booking_id     TEXT,
  operator       TEXT NOT NULL,
  bap_id         TEXT NOT NULL,
  bap_uri        TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  expires_at     INTEGER,                -- HELD only; NULL once BOOKED
  created_at     INTEGER NOT NULL
);

-- A row that has been swept or replaced stays in the table with its state
-- changed rather than being deleted, so that a confirm arriving against it can
-- be refused with the reason rather than with "unknown hold".
CREATE UNIQUE INDEX seat_locks_live
  ON seat_locks (service_id, travel_date, seat_id)
  WHERE state IN ('HELD','BOOKED');

CREATE INDEX seat_locks_service_date ON seat_locks (service_id, travel_date);
CREATE INDEX seat_locks_hold ON seat_locks (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX seat_locks_transaction
  ON seat_locks (operator, bap_id, bap_uri, transaction_id);

CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,     -- SPECIMEN-RSV-<OP>-<HEX>
  reference      TEXT NOT NULL UNIQUE, -- SPECIMEN-<OP>-<HEX>, the rider-facing one
  operator       TEXT NOT NULL,
  bap_id         TEXT NOT NULL,
  bap_uri        TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  service_id     TEXT NOT NULL,
  travel_date    TEXT NOT NULL,
  service_class  TEXT NOT NULL,
  from_boarding_point_id TEXT NOT NULL,
  to_boarding_point_id   TEXT NOT NULL,
  departure_at   INTEGER NOT NULL,     -- absolute epoch ms; the slab keys on this
  status         TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED')),
  base_paise             INTEGER NOT NULL,
  reservation_fee_paise  INTEGER NOT NULL,
  toll_paise             INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  cancelled_at   INTEGER,
  -- Computed once, at the moment of cancellation, and never re-evaluated. A
  -- repeated confirm-cancel reads these back rather than re-running the slab,
  -- because re-running it would return a smaller refund as time passed for a
  -- cancellation that already completed, which makes a retry look like a
  -- penalty.
  refund_paise   INTEGER,
  slab_code      TEXT,
  order_json     TEXT NOT NULL         -- the on_confirm order, as sent
);

-- The idempotency key of section 13 expressed as a constraint, so a second
-- confirm on one transaction cannot create a second booking even if the
-- application-level check is bypassed or the process holding the in-flight
-- promise is not the process that answers.
CREATE UNIQUE INDEX bookings_transaction
  ON bookings (operator, bap_id, bap_uri, transaction_id);

CREATE INDEX bookings_service_date ON bookings (service_id, travel_date);

-- Personal data, and the only table in this schema that holds any. Nothing
-- identifying beyond a name is ever accepted here: no document type, no
-- document number, no per-passenger phone. `name`, `age` and `gender` are
-- nullable because the retention sweep drops them once the coach has gone,
-- leaving the seat and its status behind so a booking still reads as a
-- booking.
CREATE TABLE booking_seats (
  booking_id  TEXT NOT NULL REFERENCES bookings(id),
  seat_id     TEXT NOT NULL,
  name        TEXT,
  age         INTEGER,                 -- NULL means not supplied, never 0
  gender      TEXT CHECK (gender IN ('male','female','other')),
  -- The seat's own share of the fare, frozen at confirm. Held per seat rather
  -- than divided out of the booking total at cancellation time, so that a
  -- partial cancellation never has to reintroduce a rounding decision this
  -- provider already made once.
  base_paise             INTEGER NOT NULL,
  reservation_fee_paise  INTEGER NOT NULL,
  toll_paise             INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED')),
  cancelled_at INTEGER,
  -- The refund and the slab that produced it, per seat, because a booking
  -- cancelled in two goes crosses two slabs and one column on the booking
  -- cannot hold both. The booking-level pair is the roll-up of these.
  refund_paise INTEGER,
  slab_code    TEXT,
  PRIMARY KEY (booking_id, seat_id)
);

-- A cancellation quote. It exists because the two-step cancellation returns an
-- exact figure before anything is committed, and the commitment has to be able
-- to say whether the figure it was given is still the figure that applies.
CREATE TABLE refund_quotes (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  seat_ids     TEXT NOT NULL,          -- JSON array, the seats the quote covers
  slab_code    TEXT NOT NULL,
  slab_percent INTEGER NOT NULL,
  refund_paise INTEGER NOT NULL,
  quoted_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX refund_quotes_booking ON refund_quotes (booking_id);
