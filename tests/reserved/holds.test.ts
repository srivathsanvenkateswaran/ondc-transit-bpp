import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReservedDatabase, type ReservedDatabase } from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { ReservedStore } from "../../src/reserved/store.js";

/**
 * The hold lifecycle.
 *
 * Holds are server-authoritative: this provider issues the hold, sets its TTL
 * and returns the absolute expiry instant, and the client never computes one
 * and never extends one. Everything below is a property of that decision.
 */

const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);

const SERVICE = "2259BNGHMP";
const DATE = "2026-09-30";
const TTL = 600;

async function newStore(): Promise<ReservedStore> {
  let counter = 0;
  return new ReservedStore(
    await openReservedDatabase({ url: ":memory:", migrationRoot }),
    { idFactory: () => `ID${String((counter += 1)).padStart(4, "0")}` },
  );
}

/**
 * Wraps a real `ReservedDatabase` and counts every statement invocation
 * (`run`, `get`, `all`) as one round trip - the same accounting
 * `tests/reserved/order.test.ts` uses to pin the search loop's own batching,
 * because a synchronous local driver and a remote Turso connection make the
 * identical calls (`db.ts`'s own doc), so counting invocations here stands in
 * for counting network hops there.
 */
async function countingStore(): Promise<{
  store: ReservedStore;
  roundTrips: () => number;
}> {
  let counter = 0;
  let roundTrips = 0;
  const inner = await openReservedDatabase({ url: ":memory:", migrationRoot });
  const database: ReservedDatabase = {
    prepare(sql: string) {
      const statement = inner.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.run(...params);
        },
        get: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.get(...params);
        },
        all: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.all(...params);
        },
      };
    },
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
  };
  const store = new ReservedStore(database, {
    idFactory: () => `ID${String((counter += 1)).padStart(4, "0")}`,
  });
  return { store, roundTrips: () => roundTrips };
}

/**
 * `assert.throws` returns nothing, and every refusal below is worth asserting
 * a code and a message on rather than only a type.
 */
async function refusalFrom(
  work: () => unknown,
): Promise<ReservedLifecycleError> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof ReservedLifecycleError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

function identity(transactionId: string) {
  return {
    bapId: "bap.example.test",
    bapUri: "https://bap.example.test",
    transactionId,
  };
}

function acquire(
  store: ReservedStore,
  transactionId: string,
  seatIds: string[],
  nowMs: number,
) {
  return store.acquireHold({
    operator: "ksrtc",
    identity: identity(transactionId),
    serviceId: SERVICE,
    travelDate: DATE,
    seatIds,
    nowMs,
    ttlSeconds: TTL,
  });
}

/**
 * `acquireHold` used to insert one seat row per round trip, so a select
 * naming several seats held its transaction open for a multiple of one
 * seat's network latency. Against the real, remote Turso database that
 * matters: Turso ends an "interactive transaction" that sits open too long
 * even when the underlying stream is fine, well before the stream itself
 * would ever be judged dead - reproduced directly on 2026-09-07 by holding a
 * transaction open past roughly ten to twenty seconds, which a per-seat
 * round trip on a several-seat hold reached routinely and reliably. The
 * fix batches every seat's insert into one statement, so the round-trip
 * count a hold costs must not grow with how many seats it names.
 */
test("acquiring a hold costs the same handful of database round trips for one seat or six", async () => {
  const one = await countingStore();
  await acquire(one.store, "tx1", ["U3A"], 1_000_000);
  const oneSeatRoundTrips = one.roundTrips();
  one.store.close();

  const six = await countingStore();
  await acquire(
    six.store,
    "tx1",
    ["U3A", "U3B", "U3C", "U3D", "U3E", "U3F"],
    1_000_000,
  );
  const sixSeatRoundTrips = six.roundTrips();
  six.store.close();

  assert.equal(sixSeatRoundTrips, oneSeatRoundTrips);
  // Pinned to a concrete, small number so a future change that reintroduces
  // even one per-seat round trip is caught rather than silently tolerated by
  // the equality check above alone.
  assert.ok(
    sixSeatRoundTrips <= 5,
    `expected at most 5 round trips to acquire a hold, got ${sixSeatRoundTrips}`,
  );
});

test("a hold carries an absolute expiry this provider computed", async () => {
  const store = await newStore();
  const hold = await acquire(store, "tx1", ["U3A", "U3B"], 1_000_000);
  assert.equal(hold.expiresAt, 1_000_000 + TTL * 1000);
  assert.deepEqual(hold.seatIds, ["U3A", "U3B"]);
  store.close();
});

test("the first select to reach the acquire step wins the seat", async () => {
  const store = await newStore();
  await acquire(store, "tx1", ["U3A"], 1_000_000);
  const refusal = await refusalFrom(() =>
    acquire(store, "tx2", ["U3A", "U3B"], 1_000_001),
  );
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  // The refusal names the seats that were taken and not the ones that were
  // free, so a client can re-render the difference rather than the request.
  assert.match(refusal.message, /U3A/);
  assert.doesNotMatch(refusal.message, /U3B/);
  store.close();
});

test("a losing racer that gets past the check still loses to the index", async () => {
  // The constraint, not the check, is the guarantee. This drives the insert
  // with the availability check deliberately skipped, which is the only way to
  // prove which of the two is load bearing.
  const store = await newStore();
  await acquire(store, "tx1", ["U3A"], 1_000_000);
  const refusal = await refusalFrom(() =>
    store.acquireHold({
      operator: "ksrtc",
      identity: identity("tx2"),
      serviceId: SERVICE,
      travelDate: DATE,
      seatIds: ["U3A"],
      nowMs: 1_000_001,
      ttlSeconds: TTL,
      skipAvailabilityCheckForTest: true,
    }),
  );
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  store.close();
});

test("re-selecting the same seats returns the same hold, unextended", async () => {
  // A hold that renewed itself every time a client repriced would have no TTL
  // at all.
  const store = await newStore();
  const first = await acquire(store, "tx1", ["U3A", "U3B"], 1_000_000);
  const second = await acquire(store, "tx1", ["U3B", "U3A"], 1_400_000);
  assert.equal(second.holdId, first.holdId);
  assert.equal(second.expiresAt, first.expiresAt);
  store.close();
});

test("selecting different seats releases the previous hold in the same breath", async () => {
  // Without this, a rider exploring the map would ratchet holds until the
  // coach was locked by one undecided rider.
  const store = await newStore();
  const first = await acquire(store, "tx1", ["U3A"], 1_000_000);
  const second = await acquire(store, "tx1", ["U4A"], 1_000_500);
  assert.notEqual(second.holdId, first.holdId);
  assert.deepEqual(
    (await store.liveClaims(SERVICE, DATE)).map((claim) => claim.seatId),
    ["U4A"],
  );
  // A third transaction can take the released seat immediately.
  const other = await acquire(store, "tx2", ["U3A"], 1_000_600);
  assert.deepEqual(other.seatIds, ["U3A"]);
  store.close();
});

test("an expired hold is swept by whoever next touches that dated departure", async () => {
  // Lazily, inside the transaction that next asks, rather than by a background
  // job: a hold past its expiry is functionally released the instant anybody
  // asks, which is the only moment the answer matters.
  const store = await newStore();
  const first = await acquire(store, "tx1", ["U3A"], 1_000_000);
  const later = first.expiresAt + 1;
  const second = await acquire(store, "tx2", ["U3A"], later);
  assert.deepEqual(second.seatIds, ["U3A"]);
  const swept = await store.findLatestHold("ksrtc", identity("tx1"));
  assert.ok(swept);
  // A swept hold leaves its row behind with the state changed rather than
  // being deleted, so a confirm arriving against it is refused with the reason
  // rather than with "unknown hold".
  assert.equal(swept.state, "EXPIRED");
  store.close();
});

test("a hold that has passed its expiry is not live even before anyone sweeps", async () => {
  const store = await newStore();
  const hold = await acquire(store, "tx1", ["U3A"], 1_000_000);
  assert.equal(store.holdStatus(hold, hold.expiresAt - 1), "LIVE");
  assert.equal(store.holdStatus(hold, hold.expiresAt), "EXPIRED");
  assert.equal(store.holdStatus(hold, hold.expiresAt + 1), "EXPIRED");
  store.close();
});

test("one live hold per transaction, across services as well as seats", async () => {
  const store = await newStore();
  await acquire(store, "tx1", ["U3A"], 1_000_000);
  await store.acquireHold({
    operator: "ksrtc",
    identity: identity("tx1"),
    serviceId: "1000BNGMAA",
    travelDate: DATE,
    seatIds: ["1A"],
    nowMs: 1_000_100,
    ttlSeconds: TTL,
  });
  assert.deepEqual(await store.liveClaims(SERVICE, DATE), []);
  assert.deepEqual(
    (await store.liveClaims("1000BNGMAA", DATE)).map((claim) => claim.seatId),
    ["1A"],
  );
  store.close();
});

test("a live claim says whose it is, so a client can tell its own hold apart", async () => {
  const store = await newStore();
  await acquire(store, "tx1", ["U3A"], 1_000_000);
  const [claim] = await store.liveClaims(SERVICE, DATE);
  assert.equal(claim.state, "HELD");
  assert.equal(claim.identity.transactionId, "tx1");
  assert.equal(claim.gender, null);
  store.close();
});

/* ------------------------------------------------------------------ *
 * What replaced "no interleaving is expressible"
 * ------------------------------------------------------------------ */

/**
 * The race section 8.5 describes, now that it can actually be written down.
 *
 * Under the synchronous driver this test was not expressible: there was no
 * `await` to put between two calls, so two overlapping selects could only be
 * simulated by running them one after the other and calling that a race. The
 * store is asynchronous now, so this is a real `Promise.all` of two acquires
 * for the same berth started before either has finished, which is exactly the
 * shape the two guarantees in `db.ts` have to survive: transactions are
 * serialised on the handle, so the second one's sweep, check and insert do
 * not interleave with the first one's, and if a check ever did get past, the
 * unique index would still decide it.
 */
test("two overlapping holds for one berth: exactly one wins, the other is told the seat is gone", async () => {
  const store = await newStore();

  const outcomes = await Promise.all([
    acquire(store, "tx-one", ["U3A"], 1_000_000).then(
      (hold) => ({ ok: true as const, hold }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    acquire(store, "tx-two", ["U3A"], 1_000_000).then(
      (hold) => ({ ok: true as const, hold }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  const winners = outcomes.filter((outcome) => outcome.ok);
  const losers = outcomes.filter((outcome) => !outcome.ok);
  assert.equal(winners.length, 1, "exactly one of the two must win the berth");
  assert.equal(losers.length, 1);

  const refusal = losers[0].error;
  assert.ok(
    refusal instanceof ReservedLifecycleError,
    `the loser must be refused in this domain's own terms, got ${String(refusal)}`,
  );
  // Not "UNIQUE constraint failed", which tells a client nothing it can act
  // on, and not an internal error either.
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  assert.match(refusal.message, /U3A/);

  // And the database holds one claim, not two and not none: whichever
  // transaction won, it won completely.
  const claims = await store.liveClaims(SERVICE, DATE);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].seatId, "U3A");
  assert.equal(claims[0].holdId, winners[0].hold.holdId);

  store.close();
});

/**
 * The measurement from the audit, turned into a test.
 *
 * A synchronous native call cannot yield to Node's event loop for its whole
 * duration: measured on 2026-09-07, one made to take 4.37 seconds let a
 * concurrent 20ms timer fire zero times out of the ~218 ticks it was owed.
 * Against a database in Mumbai from a dyno in the United States, at roughly
 * 230ms a statement, that froze the entire provider - BMTC and BMRCL
 * included - once per statement.
 *
 * The delay here is artificial and in the wrapper rather than in the driver,
 * because a local libSQL statement is too fast to observe and this repository
 * does not test against the production database. What it proves is the
 * property that changed: a statement that takes a long time is now awaited,
 * so the loop keeps turning underneath it. The old interface could not even
 * express this test - a synchronous `ReservedStatement` had nowhere to put
 * the delay.
 */
test("a slow statement no longer starves everything else on the event loop", async () => {
  const inner = await openReservedDatabase({ url: ":memory:", migrationRoot });
  const STATEMENT_MS = 200;
  const TICK_MS = 20;
  const slow = async <T>(work: () => Promise<T>): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, STATEMENT_MS));
    return work();
  };
  const database: ReservedDatabase = {
    prepare(sql: string) {
      const statement = inner.prepare(sql);
      return {
        run: (...params: unknown[]) => slow(() => statement.run(...params)),
        get: (...params: unknown[]) => slow(() => statement.get(...params)),
        all: (...params: unknown[]) => slow(() => statement.all(...params)),
      };
    },
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
  };
  const store = new ReservedStore(database, { idFactory: () => "IDSLOW01" });

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, TICK_MS);
  try {
    const started = Date.now();
    await store.liveClaims(SERVICE, DATE);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= STATEMENT_MS,
      `the statement was supposed to be slow, and took ${elapsed}ms`,
    );
    // The old measurement's answer here was zero. Half the ticks the interval
    // was owed is a deliberately generous floor - this is asserting that the
    // loop kept turning at all, not that it kept perfect time.
    assert.ok(
      ticks >= Math.floor(elapsed / TICK_MS / 2),
      `expected the 20ms timer to keep firing during a ${elapsed}ms statement, got ${ticks} ticks`,
    );
  } finally {
    clearInterval(timer);
    store.close();
  }
});
