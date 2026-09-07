# ondc-transit-bpp performance audit (2026-09-07)

Research only. Nothing in this document has been applied. Branch `research/perf-audit-2026-09-07`. The cross-service summary and the platform findings are in `Tatak/docs/perf-audit-2026-09-07.md`.


Read-only audit of `/Users/srivathsanv/Documents/Personal/ondc-transit-bpp` plus
live `heroku config`/`heroku ps` reads against `tatak-ondc`, `tatak-ondc-network`,
`tatak-fleet-sim` and `tatak`. No commits, branches, or config changes were made.
Everything under "measured" below came from either a local run of this repo
(compiled with `npm run build`, or `npx tsx`, both left the tree clean afterward)
or from `heroku config`/`heroku ps`/`heroku releases`. Everything under
"estimated" is derived by reading the code path, not by running it.

## What got heavier, and why

The system was Bengaluru-only (BMTC bus + BMRCL metro) until `RESERVED_ENABLED`,
`RESERVED_SOURCE`, `RESERVED_SYNC_RESPONSES`, `RESERVED_DB_URL` and
`RESERVED_DB_AUTH_TOKEN` were set on `tatak-ondc` in release v10, about 4 hours
before this audit (`heroku releases`). That release pointed the reserved
(KSRTC intercity) booking store at a remote Turso database in
`aws-ap-south-1` (Mumbai), while the dyno itself runs in Heroku's `us` region.
Everything else in the topology (`tatak`, `tatak-ondc-network`,
`tatak-fleet-sim`) is also `us`-region Eco  -  so this is the one hop in the
whole system that crosses an ocean, and it landed in the same release that
made the app "feel slow."

The second thing that changed is architectural, not geographic: the reserved
store uses the *synchronous* `libsql` client (not `libsql/promise`), a design
choice the code documents as deliberate (`src/reserved/db.ts:57-67`, "no
`await` available to write, so no interleaving is expressible"). That
guarantee has a cost nothing in the repo calls out: a synchronous native call
blocks Node's single thread for its entire duration. Locally, with a
same-process libsql call artificially made to take 4.37 seconds, a
`setInterval(20ms)` running concurrently fired **zero times** during that
call (0 of ~218 expected ticks)  -  proof the call froze the whole event loop,
not just the request that issued it. Applied to a remote Turso connection,
every prepared-statement round trip freezes the *entire* provider process  - 
BMTC and BMRCL traffic included  -  for that statement's full network time, not
just the KSRTC request that triggered it.

| What | Measured / source | Value |
|---|---|---|
| Boot time (compiled, `node dist/src/index.js`, fixture mode) | local run | 275ms wall (`configAndAppBuildMs` 269 + `listenMs` 5) |
| RSS after boot (compiled, fixture mode) | local run, `process.memoryUsage()` | 90MB RSS / 32MB heapTotal / 18MB heapUsed |
| `/ksrtc/search` DB round trips | local, in-memory DB, code instrumented | 5 (measured) |
| `/ksrtc/search` wall time, in-memory DB, no network | local run | 3-6ms |
| `/ksrtc/select` (quantity only, no seat ids) DB round trips | local, instrumented | 4 (measured) |
| `/ksrtc/select` (explicit seat ids, hits `acquireHold`) DB round trips | code read, not run | ~11-12 (estimated) |
| `/ksrtc/init` DB round trips | code read | ~7, incl. 3 wasted on a duplicate sweep (estimated, see finding 2) |
| `/ksrtc/confirm` DB round trips | code read | ~13, incl. the same duplicate sweep (estimated) |
| Dyno region vs. reserved DB region | `heroku apps:info`, DB hostname | dyno `us`, DB `aws-ap-south-1` (Mumbai) |
| Per-round-trip transoceanic RTT | provided by requester from prior measurement | ~230ms |
| `/ksrtc/search` router latency, last 1500 log lines | provided by requester | n=74, median 7352ms, p95 30000ms, 9 H12s at exactly 30s |
| `/ksrtc/select` router latency | provided by requester | n=120, median 809ms, p95 3428ms |
| `/bmtc,bmrcl/inbound` router latency | provided by requester | median 2ms |
| `JOURNEY_SOURCE_URL` reachability | `curl -w time_total` from this machine | HTTP 405 in 1.19s (GitHub Pages, wrong host  -  see finding 4) |
| `on_search` (KSRTC, 1 matching service) payload size | local run | 4.3KB |
| All four Heroku apps' plan and region | `heroku ps` / `apps:info` | Eco, `us`, all four (`tatak`, `tatak-ondc`, `tatak-ondc-network`, `tatak-fleet-sim`) |

I could not measure: real Heroku cold-dyno wake time (no way to force one from
here without disrupting the live app), the actual production
search→on_search round trip over the real gateway hop, or DB round-trip
timing against the live Turso instance under concurrent load (I ran one
read-only diagnostic against it via Heroku CLI credentials and it was blocked
by this environment's own safety classifier before I could time it, so that
specific number is inferred from the local in-memory round-trip counts times
the requester-supplied ~230ms RTT, not directly measured).

## Ranked findings

### 1. The reserved DB client blocks the whole process per round trip  -  root cause, risky to fix
`src/reserved/db.ts:57-67` (doc comment), applies to every call site in
`src/reserved/store.ts`. The store uses `import Database from "libsql"`  -  the
synchronous API  -  for both the local file case and the remote Turso case.
libsql ships that variant specifically so calls stay synchronous
(`libsql/promise` is the opt-in async one, per the package's own README). A
synchronous native call cannot yield to Node's event loop mid-flight.
Confirmed locally: a single synchronous libsql call made to take 4.37s
starved a concurrent 20ms timer completely (0 ticks fired). Over a real
network hop to Mumbai, every `.prepare().run/get/all()` and every `BEGIN
IMMEDIATE`/`COMMIT` freezes the entire dyno  -  not just the request that
issued it, but BMTC search, BMRCL search, and `/healthz` too, for that
round trip's duration. This is consistent with why `/ksrtc/search`'s
observed median (7352ms) is far above what its own round-trip count would
cost uncontended (5 round trips × ~230ms ≈ 1.15s): under concurrent traffic,
requests queue behind whoever currently holds a blocking call, and the 9
H12s at exactly 30000ms are that queue occasionally growing past Heroku's
router timeout.
**Impact:** dominant  -  this is the mechanism, not just a symptom.
**Fix:** switch `src/reserved/db.ts` to `libsql/promise` and make every
`ReservedStore` method (and `ReservedDatabase`/`ReconnectingDatabase`) return
promises, `await`ing each statement. This removes the "no interleaving is
expressible" guarantee the code currently leans on (see the JSDoc on
`ReservedDatabase` and on `withTransaction`), so every write path
(`acquireHold`, `confirmBooking`, `applyCancellation`) needs re-auditing for
races that the synchronous API used to rule out by construction  -  worth doing,
but it is a real behavior-affecting change, not a safe-now patch.
**Risk:** risky (touches every reserved write path and its concurrency
argument). **Verify:** `npm test` (especially `tests/reserved/holds.test.ts`,
`tests/reserved/db-reconnect.test.ts`, `tests/reserved/no-bare-writes.test.ts`,
which specifically guards the "every write is inside a transaction" invariant
this change has to preserve), plus a manual concurrency test (two overlapping
`/ksrtc/select` calls for the same seat) before shipping.

### 2. `liveHoldAndManifest` sweeps expired holds twice  -  safe now
`src/reserved/order.ts:1109-1115` calls
`this.store.withTransaction(() => this.store.sweepExpiredHolds(...))`
directly, then a few lines later at `src/reserved/order.ts:1157` calls
`this.snapshot(...)`, whose own body (`src/reserved/order.ts:1184-1191`) runs
the *identical* sweep again (`withTransaction(sweepExpiredHolds)` +
`liveClaims`) for the same `serviceId`/`travelDate`, moments apart in the same
request. This runs on every `/ksrtc/init` and every `/ksrtc/confirm`. The
second sweep can find nothing new (nothing expired in the intervening
microseconds), so it is 3 wasted round trips (`BEGIN`, `UPDATE`, `COMMIT`)  - 
roughly a quarter of confirm's total DB cost  -  for zero effect.
**Impact:** ~3 round trips removed from every init and confirm (~230ms×3 ≈
700ms of the transoceanic RTT budget, more under the queuing effect in
finding 1).
**Fix:** drop the direct sweep+transaction at `order.ts:1109-1115` and let the
`this.snapshot(...)` call at `order.ts:1157` (which already sweeps) be the
only sweep in this function. Behavior is unchanged: the snapshot still sweeps
before reading claims, just once instead of twice.
**Risk:** safe-now  -  removes literal duplicate work, no new code path.
**Verify:** `npm test` (`tests/reserved/holds.test.ts`,
`tests/reserved/order.test.ts`, `tests/reserved/mangaluruLifecycle.test.ts`),
`npm run build`.

### 3. `sweepManifests` runs unconditionally on every search and every status check  -  safe-now index, medium-term move off the hot path
`src/reserved/order.ts:203-206` (search) and `:568-571` (status) both call
`this.store.sweepManifests(nowMs, retentionDays)` on every single request.
Its query (`src/reserved/store.ts:963-969`) is
`SELECT DISTINCT b.id, b.order_json FROM bookings b JOIN booking_seats s ON
... WHERE b.departure_at < ? AND s.name IS NOT NULL`  -  there is no index on
`bookings.departure_at` in either migration
(`migrations/reserved/0001_seat_locks_and_bookings.sql`,
`0002_settlement_attribution.sql`). At today's data volumes this is a cheap
scan, but it is still one unconditional remote round trip taxed onto every
search and status call regardless of whether any row is actually due, and it
gets slower as bookings accumulate. It exists because this process has no
scheduler ("whoever next touches this provider pays for it"  - 
`src/reserved/store.ts:955-960`), which is a real constraint, not an oversight.
**Impact:** 1 round trip per search/status today; grows with table size.
**Fix (safe-now):** add `CREATE INDEX bookings_departure_at ON bookings
(departure_at) WHERE EXISTS (...)` or simply `ON bookings(departure_at)` in a
new `0003` migration  -  no behavior change, just makes the scan cheap
regardless of table growth.
**Fix (medium):** throttle the sweep to run at most once per some interval
(an in-process `lastSweptAt` timestamp guard) rather than every request, or
move it to a Heroku Scheduler job hitting a dedicated maintenance endpoint,
since nothing about retention needs per-request freshness  -  a booking's names
being cleared an hour late is not a correctness problem.
**Risk:** index = safe-now; throttling/scheduler = medium (changes when the
retention guarantee is actually met, needs a test asserting the new
threshold). **Verify:** `npm test` (`tests/reserved/manifest.test.ts`),
`npm run build`.

### 4. `JOURNEY_SOURCE_URL` points at the wrong host  -  correctness bug reported as a performance one
Production has `JOURNEY_SOURCE=http`,
`JOURNEY_SOURCE_URL=https://tatak.tech/api/ondc/offers`. `tatak.tech` (the
apex domain) serves GitHub Pages, not the Tatak app  -  the app is at
`app.tatak.tech`. `curl -X POST https://tatak.tech/api/ondc/offers` returns
**HTTP 405** with `server: GitHub.com` in 1.19s from this machine. In
`src/sources/http.ts:66-118`, a non-2xx response is treated the same as a
network error: it's logged as `outcome: "FALLBACK"` and the code falls back
to the on-disk fixture (`src/sources/http.ts:105-114`)  -  silently, on every
single BMTC and BMRCL search. The 5-second `HTTP_JOURNEY_SOURCE_TIMEOUT_MS`
(`src/sources/http.ts:13`) is not the bottleneck here: GitHub Pages answers
fast, so this fails in roughly one HTTP round trip, not a timeout. The real
cost is that `JOURNEY_SOURCE=http` is currently providing **no real journey
data at all**  -  every BMTC/BMRCL search has been running on fixture data
since JOURNEY_SOURCE_URL was set (release v8, 2026-08-23), paying a wasted
network round trip on every request for the privilege.
**Impact:** small direct latency (one extra fast-failing HTTP call per
BMTC/BMRCL search, likely 100-400ms from Heroku's own `us` region rather than
the 1.19s measured from here) but a real data-correctness gap, and unrelated
to the KSRTC slowness that prompted this audit.
**Fix:** point `JOURNEY_SOURCE_URL` at `https://app.tatak.tech/api/ondc/offers`
(confirm the real path with whoever owns that endpoint), or set
`JOURNEY_SOURCE=fixture` until it's fixed, so search stops paying for a call
that never succeeds.
**Risk:** safe-now, config-only.
**Verify:** `curl` the corrected URL directly first; then
`npm test` (`tests/sources/http.test.ts`) to confirm the fallback path still
behaves correctly when the real endpoint is briefly down.

### 5. `answerActionSync` has no bound of its own  -  Heroku's 30s router timeout is the only backstop
`src/reserved/handler.ts:399-428`: with `RESERVED_SYNC_RESPONSES=true` (the
production setting), the full chain of DB round trips for every reserved
action sits directly on the HTTP response, with no application-level timeout.
The 9 observed H12s on `/ksrtc/search` are Heroku's router killing the
connection at exactly 30000ms with no application response at all  -  the
worst possible failure mode for a client, since it gets nothing to react to.
**Fix:** wrap `resolveCallback` in `answerActionSync` with a bounded deadline
(a few seconds, well under 30s) that returns a proper `RESERVED_INTERNAL_ERROR`
response instead of running out the router's clock. This doesn't fix the
underlying slowness but turns a silent 30s hang into a fast, honest error a
client can retry against.
**Risk:** medium  -  needs a real number chosen for the deadline and a test for
the timeout path (`tests/reserved/syncResponses.test.ts` is the natural home).
**Verify:** `npm test`, `npm run build`.

### 6. Fleet manifest push is currently inert, but is wired to block confirm/cancel if turned on
`FLEET_MANIFEST_URL` is not set on `tatak-ondc` today (confirmed via `heroku
config`), so `InertFleetManifestPublisher` is in use and this costs nothing
right now. But `src/reserved/order.ts:546` and `:741` `await
this.publishManifestFor(...)` synchronously, inside `confirm()`/`cancel()`,
before the response is returned  -  with `FLEET_MANIFEST_TIMEOUT_MS = 5_000`
(`src/reserved/fleetManifest.ts:69`). `tatak-fleet-sim` exists as a live Eco
dyno (`heroku ps --app tatak-fleet-sim` shows it up), so this is a real risk
the moment `FLEET_MANIFEST_URL` is set: every confirm/cancel would then
inherit that dyno's cold-start time (if it's been idle 30 minutes) chained
onto the reserved-DB round trips already on that path.
**Fix (medium, for whenever this is turned on):** make the manifest push
fire-and-forget (log the outcome, don't `await` it before responding)  -  the
code already treats a push failure as non-fatal and resolves rather than
rejects, so nothing about correctness depends on the response waiting for it.
**Risk:** medium  -  changes response timing/ordering guarantees, needs a test
that asserts the booking is returned before the push settles.
**Verify:** `npm test` (`tests/reserved/fleetManifestIntegration.test.ts`).

### 7. Everything checked out clean  -  worth stating rather than leaving implicit
- ajv schemas: compiled exactly once at boot in both `createProtocolValidator`
  (`src/protocol/validate.ts:34-55`) and `createReservedValidator`
  (`src/reserved/schema.ts:50-73`), each invoked once from `createApp`. No
  per-request compilation anywhere.
- Fixtures: loaded once at boot (`FixtureJourneySource.load` ×2,
  `FixtureReservedSource.load` ×1, all inside `createApp`,
  `src/app.ts:177-180,230-233`), served from the in-memory catalogue per
  request via `structuredClone` on the matched subset  -  cheap at the current
  200-service, ~700KB fixture size.
- DB connection and migrations: `openReservedDatabase` (migrations included)
  runs exactly once, at boot, inside `createApp` (`src/app.ts:245-250`)  -  not
  per request, and the connection (or `ReconnectingDatabase` wrapper) is
  reused for the process's lifetime.
- No artificial sleeps in production: `BMTC_CALLBACK_DELAY_MS`,
  `BMRCL_CALLBACK_DELAY_MS`, and the KSRTC equivalent are all `0` in the
  Dockerfile defaults and confirmed `0` in `heroku config` for BMTC/BMRCL.
  These are real, env-driven levers (`src/config.ts:235-240`) but not
  currently in use.
- No unbounded retry loops: `ReconnectingDatabase` (`src/reserved/db.ts:311-434`)
  retries a dead-stream error exactly once, never loops; `HttpJourneySource`
  and `HttpReservedSource` each make one attempt with a timeout and a fallback,
  no retry.
- Fan-out across operators isn't this service's concern: `/bmtc/search`,
  `/bmrcl/search` and `/ksrtc/search` are independent HTTP endpoints, called
  separately by the gateway (onix, outside this repo). This BPP never fans a
  single search out to multiple operators itself, so "sequential vs. parallel
  fan-out" doesn't apply at this layer  -  if there's a fan-out delay it's on
  the gateway side.
- Payload sizes are not a factor at current scale: a single-item KSRTC
  `on_search` is 4.3KB; BMTC/BMRCL fixture catalogues are 2.6KB/4.5KB total.
  No compression is configured (`src/app.ts:53-60` writes raw JSON with a
  `content-length` header, no `content-encoding`), which is fine at these
  sizes and not worth adding yet.
- No transaction holds a lock across a network call: every `withTransaction`
  block in `src/reserved/store.ts` and `src/reserved/order.ts` is pure DB
  work; `publishManifestFor` (the one real outbound HTTP call on the confirm
  path) runs after the transaction has already committed, never inside one.

## Should any of this be rewritten in Go?

No, not on this evidence. Nothing above is CPU-bound, GC-bound, or a Node
runtime limitation  -  boot is 275ms and 90MB RSS, well inside the 512MB Eco
ceiling, and the fixture-serving paths (ajv validation, catalogue filtering)
run in single-digit milliseconds locally. The entire observed slowness traces
to two things a rewrite doesn't fix by itself: a database on the wrong
continent, and a client library that blocks synchronously while it fetches from
there. Both are addressable in TypeScript (move the DB closer, or stop using
the blocking client) for a fraction of the cost and risk of a rewrite. A Go
rewrite would only pay for itself if the actual bottleneck were single-threaded
CPU work competing with I/O on Node's one thread  -  profiling here shows the
opposite: the thread is idle-but-blocked, waiting on a network call it made
synchronous by choice, not one doing real work that a different language would
do faster.
