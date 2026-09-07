-- An index for the retention sweep's own predicate.
--
-- `ReservedStore.sweepManifests` opens with
-- `SELECT DISTINCT b.id, b.order_json FROM bookings b JOIN booking_seats s
--  ON s.booking_id = b.id WHERE b.departure_at < ? AND s.name IS NOT NULL`,
-- and until now nothing indexed `departure_at`: every sweep was a full scan
-- of `bookings`, joined against every one of their seats, to answer a
-- question that is almost always "nothing is due". That is affordable at a
-- few hundred rows and stops being affordable at the volume a working
-- deployment reaches, and it is paid on a request a rider is waiting on
-- rather than by a job nobody is watching.
--
-- Plain rather than partial. The obvious partial form - restricted to rows
-- that still carry names - cannot be written here: whether a booking has a
-- name is a fact about `booking_seats`, and SQLite indexes one table. So the
-- index narrows the scan to the departures actually past the cutoff and the
-- join does the rest, which is the half that grows without bound.

CREATE INDEX bookings_departure_at ON bookings (departure_at);
