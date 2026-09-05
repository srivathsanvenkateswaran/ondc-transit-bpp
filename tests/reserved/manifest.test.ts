import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  concessionDiscountPaise,
  concessionRatePercent,
} from "../../src/reserved/concession.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { boardingPairFromStops, fareCell, headlinePair } from "../../src/reserved/fares.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import {
  assertManifestMatchesHold,
  manifestTagFrom,
  parseManifest,
} from "../../src/reserved/manifest.js";

/**
 * The manifest, the fare lookup and the concessions: the three places this
 * provider refuses rather than invents.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
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

test("the senior rate is published for the one class the source names", () => {
  assert.equal(concessionRatePercent("SENIOR", "RAJAHAMSA"), 25);
  assert.equal(concessionDiscountPaise(55_000, 25), 13_750);
});

test("a senior claim on a class with no published rate is refused, not estimated", () => {
  const refusal = refusalFrom(() => concessionRatePercent("SENIOR", "PALLAKKI"));
  assert.equal(refusal.code, "CONCESSION-RATE-NOT-PUBLISHED");
  assert.match(refusal.message, /RAJAHAMSA only/);
});

test("the free-travel scheme never applies to a reserved seat", () => {
  // Its own published exclusion list names every class this category sells, so
  // this is a fact about the scheme rather than a gap in this provider.
  const refusal = refusalFrom(() => concessionRatePercent("SHAKTI", "AIRAVAT_CLUB"));
  assert.equal(refusal.code, "CONCESSION-NOT-APPLICABLE");
});

test("a range is not a rate, so the child concession is refused", () => {
  assert.equal(
    refusalFrom(() => concessionRatePercent("CHILD", "PALLAKKI")).code,
    "CONCESSION-RATE-NOT-PUBLISHED",
  );
});
