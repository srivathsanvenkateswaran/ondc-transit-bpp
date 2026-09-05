-- Which corporation a sale is owed to.
--
-- A rider is sold a brand; which of the three corporations actually ran the
-- coach is a separate fact, and it is the one somebody is owed money against.
-- It is copied from the service at the instant a confirm succeeds and frozen
-- there, and it never reaches any payload this provider sends.
--
-- `settlement_corporation` is NULL whenever the service's own
-- operating-corporation basis is not `confirmed`, which is nearly every
-- service this repository ships. An unattributed sale is not a failure state:
-- it is the accurate description of what this provider knows, recorded rather
-- than guessed from the territory a boarding point sits in.

ALTER TABLE bookings ADD COLUMN settlement_corporation TEXT
  CHECK (settlement_corporation IN ('KSRTC','NWKRTC','KKRTC'));

ALTER TABLE bookings ADD COLUMN settlement_basis TEXT NOT NULL DEFAULT 'none'
  CHECK (settlement_basis IN ('confirmed','inferred','none'));

CREATE INDEX bookings_unattributed
  ON bookings (service_id, travel_date)
  WHERE settlement_corporation IS NULL;
