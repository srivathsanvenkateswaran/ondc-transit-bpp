import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  concessionDiscountPaise,
  concessionRatePercent,
} from "../../src/reserved/concession.js";
import {
  openReservedDatabase,
  type ReservedDatabase,
  type ReservedStatement,
} from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { boardingPairFromStops, fareCell, headlinePair } from "../../src/reserved/fares.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import {
  assertManifestMatchesHold,
  manifestTagFrom,
  parseManifest,
} from "../../src/reserved/manifest.js";
import {
  MANIFEST_SWEEP_INTERVAL_MS,
  ReservedStore,
} from "../../src/reserved/store.js";

/**
 * The manifest, the fare lookup and the concessions: the three places this
 * provider refuses rather than invents.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
const services = await source.allServices();
const sleeper = services.find((service) => service.serviceId === "2259BNGHMP")!;
const table = (await source.fareTable(sleeper.fareTableId))!;

function refusalFrom(work: () => unknown): ReservedLifecycleError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ReservedLifecycleError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

function entry(code: string, value: string) {
  return { descriptor: { code }, value };
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

test("entries are read as records delimited by each seat", () => {
  const records = parseManifest([
    entry("SEAT_ID", "U3A"),
    entry("NAME", "A Passenger"),
    entry("AGE", "34"),
    entry("GENDER", "female"),
    entry("SEAT_ID", "U3B"),
    entry("NAME", "B Passenger"),
    entry("GENDER", "male"),
  ]);
  assert.deepEqual(records, [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    // An age that was not sent is null rather than zero, and is never inferred.
    { seatId: "U3B", name: "B Passenger", age: null, gender: "male" },
  ]);
});

test("an unexpected code is refused, and its value is not read", () => {
  // Error messages reach the event log, and an unexpected value is exactly
  // where an identity document number would arrive. So the refusal names the
  // codes and the values go nowhere at all.
  const refusal = refusalFrom(() =>
    parseManifest([
      entry("SEAT_ID", "U3A"),
      entry("NAME", "A Passenger"),
      entry("DOCUMENT_NUMBER", "S1234567"),
      entry("DOCUMENT_TYPE", "PASSPORT"),
    ]),
  );
  assert.equal(refusal.code, "MANIFEST-FIELD-NOT-ACCEPTED");
  assert.match(refusal.message, /DOCUMENT_NUMBER, DOCUMENT_TYPE/);
  assert.doesNotMatch(refusal.message, /S1234567/);
  assert.doesNotMatch(refusal.message, /PASSPORT/);
  assert.deepEqual(JSON.stringify(refusal.attachment).includes("S1234567"), false);
});

test("a record with no name is incomplete", () => {
  const refusal = refusalFrom(() => parseManifest([entry("SEAT_ID", "U3A")]));
  assert.equal(refusal.code, "MANIFEST-INCOMPLETE");
});

test("a placeholder age is refused rather than stored as a number", () => {
  const refusal = refusalFrom(() =>
    parseManifest([
      entry("SEAT_ID", "U3A"),
      entry("NAME", "A Passenger"),
      entry("AGE", "unknown"),
    ]),
  );
  assert.equal(refusal.code, "MANIFEST-INCOMPLETE");
  assert.match(refusal.message, /AGE/);
  assert.doesNotMatch(refusal.message, /unknown/);
});

test("a gender outside the three is refused rather than mapped onto one", () => {
  const refusal = refusalFrom(() =>
    parseManifest([
      entry("SEAT_ID", "U3A"),
      entry("NAME", "A Passenger"),
      entry("GENDER", "F"),
    ]),
  );
  assert.equal(refusal.code, "MANIFEST-INCOMPLETE");
});

test("the manifest's seats must be exactly the hold's", () => {
  const records = parseManifest([
    entry("SEAT_ID", "U3A"),
    entry("NAME", "A Passenger"),
  ]);
  assert.equal(
    refusalFrom(() => assertManifestMatchesHold(records, ["U3A", "U3B"])).code,
    "MANIFEST-INCOMPLETE",
  );
  // A client that wants to drop a passenger re-selects, which produces a hold
  // whose expiry it can show honestly, rather than sending a shorter list
  // against a hold that quoted something else.
  assert.equal(
    refusalFrom(() => assertManifestMatchesHold(records, [])).code,
    "HOLD-SEAT-MISMATCH",
  );
  assert.doesNotThrow(() => assertManifestMatchesHold(records, ["U3A"]));
});

test("what goes back out is what came in, and nothing added", () => {
  const records = [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" as const },
    { seatId: "U3B", name: "B Passenger", age: null, gender: null },
  ];
  const tag = manifestTagFrom(records);
  assert.deepEqual(tag.list.map((item) => item.descriptor.code), [
    "SEAT_ID",
    "NAME",
    "AGE",
    "GENDER",
    "SEAT_ID",
    "NAME",
  ]);
});

/* ------------------------------------------------------------------ *
 * The fare lookup
 * ------------------------------------------------------------------ */

test("a fare is a cell, and a missing cell is refused rather than interpolated", () => {
  const cell = fareCell(
    table,
    {
      fromBoardingPointId: "BP-BLR-MAJESTIC",
      toBoardingPointId: "BP-HMP-HAMPI",
    },
    "PALLAKKI",
  );
  assert.equal(cell.farePaise, 55_000);
  // Its per-cell sourcing survives the lookup, so the tag that publishes it
  // cannot silently promote an interpolated cell to a sourced one.
  assert.equal(cell.sourcing, "S");
  assert.equal(
    fareCell(
      table,
      {
        fromBoardingPointId: "BP-BLR-ELECTRONIC-CITY",
        toBoardingPointId: "BP-HPT-HOSAPETE",
      },
      "PALLAKKI",
    ).sourcing,
    "I",
  );

  const refusal = refusalFrom(() =>
    fareCell(
      table,
      {
        fromBoardingPointId: "BP-BLR-MADIWALA",
        toBoardingPointId: "BP-MAA-ADYAR",
      },
      "PALLAKKI",
    ),
  );
  assert.equal(refusal.code, "FARE-NOT-PUBLISHED");
  assert.match(refusal.message, /BP-BLR-MADIWALA to BP-MAA-ADYAR/);
});

test("the headline pair is the whole run, and it is published as the basis", () => {
  assert.deepEqual(headlinePair(sleeper), {
    fromBoardingPointId: "BP-BLR-MAJESTIC",
    toBoardingPointId: "BP-HMP-HAMPI",
  });
});

test("a stop pair the service does not run is refused", () => {
  const refusal = refusalFrom(() =>
    boardingPairFromStops(sleeper, [
      { type: "START", location: { descriptor: { code: "BP-MAA-ADYAR" } } },
      { type: "END", location: { descriptor: { code: "BP-HMP-HAMPI" } } },
    ]),
  );
  assert.equal(refusal.code, "FARE-NOT-PUBLISHED");
});

/* ------------------------------------------------------------------ *
 * Concessions
 * ------------------------------------------------------------------ */

test("the senior rate is published for the two classes the source names", () => {
  assert.equal(concessionRatePercent("SENIOR", "RAJAHAMSA_EXECUTIVE"), 25);
  assert.equal(concessionRatePercent("SENIOR", "ASHWAMEDHA"), 25);
  assert.equal(concessionDiscountPaise(55_000, 25), 13_750);
});

test("a senior claim on a class with no published rate is refused, not estimated", () => {
  const refusal = refusalFrom(() => concessionRatePercent("SENIOR", "PALLAKKI"));
  assert.equal(refusal.code, "CONCESSION-RATE-NOT-PUBLISHED");
  assert.match(refusal.message, /RAJAHAMSA_EXECUTIVE and ASHWAMEDHA only/);
});

test("the free-travel scheme never applies to a reserved seat", () => {
  // Its own published exclusion list names every class this category sells, so
  // this is a fact about the scheme rather than a gap in this provider.
  const refusal = refusalFrom(() => concessionRatePercent("SHAKTI", "AIRAVAT_CLUB_CLASS"));
  assert.equal(refusal.code, "CONCESSION-NOT-APPLICABLE");
});

test("a range is not a rate, so the child concession is refused", () => {
  assert.equal(
    refusalFrom(() => concessionRatePercent("CHILD", "PALLAKKI")).code,
    "CONCESSION-RATE-NOT-PUBLISHED",
  );
});

/* ------------------------------------------------------------------ *
 * The retention sweep's throttle
 * ------------------------------------------------------------------ */

/**
 * Counts every statement that actually reaches the database, so a claim that
 * the throttle removed a round trip can be made about round trips rather than
 * about a return value.
 */
function countingDatabase(inner: ReservedDatabase): {
  database: ReservedDatabase;
  statements: number;
} {
  const counter = { statements: 0 };
  const database: ReservedDatabase = {
    prepare(sql: string): ReservedStatement {
      const statement = inner.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          counter.statements += 1;
          return statement.run(...params);
        },
        get: (...params: unknown[]) => {
          counter.statements += 1;
          return statement.get(...params);
        },
        all: (...params: unknown[]) => {
          counter.statements += 1;
          return statement.all(...params);
        },
      };
    },
    exec: (sql: string) => {
      counter.statements += 1;
      return inner.exec(sql);
    },
    close: () => inner.close(),
  };
  return {
    database,
    get statements() {
      return counter.statements;
    },
  };
}

/** How many booked seats still carry a passenger name. */
function namesLeft(store: ReservedStore): number {
  return Number(
    (
      store.handle
        .prepare(
          "SELECT COUNT(*) AS n FROM booking_seats WHERE name IS NOT NULL",
        )
        .get() as { n: number }
    ).n,
  );
}

const SWEEP_NOW = Date.parse("2026-11-01T06:00:00.000Z");
const WENT_LONG_AGO = Date.parse("2026-09-01T18:00:00.000Z");

/** One confirmed booking on a coach that went two months ago, names and all. */
function bookOneStaleSeat(
  store: ReservedStore,
  seatId: string,
  transactionId: string,
  nowMs: number,
): void {
  const identity = {
    bapId: "buyer.example.test",
    bapUri: "https://buyer.example.test",
    transactionId,
  };
  const hold = store.acquireHold({
    operator: "ksrtc",
    identity,
    serviceId: "2259BNGHMP",
    travelDate: "2026-09-01",
    seatIds: [seatId],
    nowMs,
    ttlSeconds: 600,
  });
  store.confirmBooking({
    holdId: hold.holdId,
    operator: "ksrtc",
    identity,
    serviceId: "2259BNGHMP",
    travelDate: "2026-09-01",
    serviceClass: "PALLAKKI",
    fromBoardingPointId: "BP-BNG-SATELLITE",
    toBoardingPointId: "BP-HMP-BUSSTAND",
    departureAt: WENT_LONG_AGO,
    seats: [
      {
        seatId,
        name: "A Passenger",
        age: 34,
        gender: "female",
        basePaise: 55_000,
        reservationFeePaise: 2_000,
        tollPaise: 0,
      },
    ],
    settlementCorporation: null,
    settlementBasis: "none",
    nowMs,
    order: ({ orderId }) => ({ id: orderId }),
  });
}

test("the retention sweep runs at most once an interval, and says so by not touching the database", () => {
  // The sweep is called on every search and every status check, which against
  // a database on another continent made it an unconditional round trip on a
  // rider's request to ask a question whose answer is nearly always "nothing
  // is due". Throttling it is the whole point, so the assertion is about
  // statements reaching the database, not about the number it returns.
  const counting = countingDatabase(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
  );
  const store = new ReservedStore(counting.database);

  bookOneStaleSeat(store, "U3A", "txn-first", SWEEP_NOW);
  assert.equal(store.sweepManifests(SWEEP_NOW, 30), 1);

  // A second booking that is just as stale, and a second sweep well inside
  // the interval. It does not run, and nothing at all reaches the database.
  bookOneStaleSeat(store, "U3B", "txn-second", SWEEP_NOW);
  const before = counting.statements;
  assert.equal(store.sweepManifests(SWEEP_NOW + 1_000, 30), 0);
  assert.equal(
    counting.statements,
    before,
    "a throttled sweep must cost no round trip at all",
  );
  // Which is a real, stated lag rather than a free win: the second booking
  // still carries its passenger's name, and will until the interval is up.
  assert.equal(namesLeft(store), 1);

  // Once the interval has passed, the next caller pays for it and the second
  // booking's names go the way of the first's.
  assert.equal(
    store.sweepManifests(SWEEP_NOW + MANIFEST_SWEEP_INTERVAL_MS + 1, 30),
    1,
  );
  assert.equal(namesLeft(store), 0);
  // And the request behind that one is throttled in its turn.
  assert.equal(
    store.sweepManifests(SWEEP_NOW + MANIFEST_SWEEP_INTERVAL_MS + 2, 30),
    0,
  );
});

test("the sweep interval is a minute, far under the window it is allowed to lag", () => {
  // The guarantee this moves is "names are gone within `retentionDays`" to
  // "within `retentionDays` plus this". Days against a minute is why that is
  // not a retention policy anybody can tell the difference against.
  assert.equal(MANIFEST_SWEEP_INTERVAL_MS, 60_000);
});
