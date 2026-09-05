import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { seededOccupancy } from "../../src/reserved/occupancy.js";
import {
  assertGenderLocks,
  seatStates,
} from "../../src/reserved/seatstate.js";
import type { LiveSeatClaim, ReservedIdentity } from "../../src/reserved/store.js";
import type { SeatMap } from "../../src/reserved/types.js";

/**
 * Seat state, and the gender lock that produces one of its five values.
 *
 * The rule: a seat adjacent to one occupied by a female passenger is sellable
 * only to a female passenger, unless both seats belong to the same booking.
 * Every clause in that sentence is doing work, and each is pinned below.
 *
 * What the lock is not is protection. The gender on a manifest is what the
 * buyer app asserts, this provider verifies nothing behind it and has no way
 * to, and no surface may describe the rule as safety. What it is: a refusal to
 * sell a specific seat to a specific declared gender.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
const services = await source.allServices();
const sleeperService = services.find(
  (service) => service.serviceId === "2259BNGHMP",
)!;
const sleeper = (await source.seatMap(sleeperService.seatMapId))!;
const seater = (await source.seatMap("AIRAVAT_CLUB-2P2-53"))!;

const SEED = 20_260_905;

function identity(transactionId: string): ReservedIdentity {
  return {
    bapId: "bap.example.test",
    bapUri: "https://bap.example.test",
    transactionId,
  };
}

function booked(
  seatId: string,
  gender: LiveSeatClaim["gender"],
  transactionId: string,
): LiveSeatClaim {
  return {
    seatId,
    state: "BOOKED",
    holdId: null,
    bookingId: `B-${transactionId}`,
    identity: identity(transactionId),
    gender,
  };
}

function held(seatId: string, transactionId: string): LiveSeatClaim {
  return {
    seatId,
    state: "HELD",
    holdId: `H-${transactionId}`,
    bookingId: null,
    identity: identity(transactionId),
    gender: null,
  };
}

function statesFor(options: {
  map?: SeatMap;
  seeded?: Map<string, "male" | "female">;
  claims?: LiveSeatClaim[];
  viewer?: ReservedIdentity;
}) {
  return seatStates({
    map: options.map ?? sleeper,
    seededSold: options.seeded ?? new Map(),
    claims: options.claims ?? [],
    viewer: options.viewer,
  });
}

test("the five published states are the five a client's legend must draw", () => {
  const states = statesFor({
    seeded: new Map([["L1A", "male"]]),
    claims: [held("L2A", "tx-other"), held("L2B", "mine"), booked("L3A", "male", "tx-other")],
    viewer: identity("mine"),
  });
  assert.equal(states.get("L1A"), "SOLD:simulated");
  assert.equal(states.get("L2A"), "HELD");
  assert.equal(states.get("L2B"), "HELD_BY_YOU");
  assert.equal(states.get("L3A"), "SOLD:booked");
  assert.equal(states.get("L5C"), "AVAILABLE");
});

test("a berth beside a simulated woman is female only", () => {
  // U3A is in the seeded sold set for this dated departure and its seeded
  // gender is female, so the empty half of that double berth is not sellable
  // to a man. The gender of a seat nobody booked is fabricated here precisely
  // so a real, rule-following lock has something to evaluate against.
  const seeded = seededOccupancy(sleeperService, sleeper, "2026-09-25", SEED);
  assert.equal(seeded.get("U3A"), "female");
  assert.equal(seeded.has("U3B"), false);
  const states = statesFor({ seeded });
  assert.equal(states.get("U3B"), "FEMALE_ONLY");
  // U4A is seeded male, so the other half of that berth is nobody's business.
  assert.equal(seeded.get("U4A"), "male");
  assert.equal(states.get("U4B"), "AVAILABLE");
});

test("the aisle breaks adjacency, so a woman in a B seat locks nothing across it", () => {
  // 1B and 1C are numerically consecutive and are not adjacent. Deriving
  // adjacency from seat numbering would lock the wrong seat on every 2+2 coach
  // in the fleet.
  const states = statesFor({
    map: seater,
    claims: [booked("1B", "female", "tx-other")],
  });
  assert.equal(states.get("1A"), "FEMALE_ONLY");
  assert.equal(states.get("1C"), "AVAILABLE");
});

test("a single berth is never locked, because it has no neighbour", () => {
  const seeded = new Map<string, "male" | "female">([
    ["L1A", "female"],
    ["L1B", "female"],
  ]);
  assert.equal(statesFor({ seeded }).get("L1C"), "AVAILABLE");
});

test("the lock is across bookings, not within one", () => {
  // A couple or a family taking one double berth is the ordinary case, and
  // refusing it would make the feature absurd.
  const mine = identity("mine");
  const states = statesFor({
    claims: [booked("U3A", "female", "mine")],
    viewer: mine,
  });
  assert.equal(states.get("U3B"), "AVAILABLE");
  const strangerStates = statesFor({
    claims: [booked("U3A", "female", "mine")],
    viewer: identity("someone-else"),
  });
  assert.equal(strangerStates.get("U3B"), "FEMALE_ONLY");
});

test("a held seat locks nothing, because nobody has said who is in it yet", () => {
  // The hold taken at select named seats and nothing else. The manifest is the
  // first point at which this provider learns which gender is going in which
  // seat, and inventing one for a held seat would be worse than waiting.
  const states = statesFor({ claims: [held("U3A", "tx-other")] });
  assert.equal(states.get("U3B"), "AVAILABLE");
});

test("a real booking overrides the fabricated gender rather than sitting beside it", () => {
  // The seeded gender exists only for seats nobody booked. Where a booking
  // exists it is a fact, and a fabrication must never outvote one: here the
  // simulation says the berth holds a man and the manifest says it holds a
  // woman, and the manifest wins.
  const seeded = new Map<string, "male" | "female">([["U3A", "male"]]);
  const states = statesFor({
    seeded,
    claims: [booked("U3A", "female", "tx-other")],
  });
  assert.equal(states.get("U3A"), "SOLD:booked");
  assert.equal(states.get("U3B"), "FEMALE_ONLY");

  const reversed = statesFor({
    seeded: new Map<string, "male" | "female">([["U3A", "female"]]),
    claims: [booked("U3A", "male", "tx-other")],
  });
  assert.equal(reversed.get("U3B"), "AVAILABLE");
});

/* ------------------------------------------------------------------ *
 * The refusal
 * ------------------------------------------------------------------ */

function refusalFrom(work: () => unknown): ReservedLifecycleError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ReservedLifecycleError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

test("a man cannot take a locked berth, and the refusal names no neighbour", () => {
  const seeded = seededOccupancy(sleeperService, sleeper, "2026-09-25", SEED);
  const refusal = refusalFrom(() =>
    assertGenderLocks(
      { map: sleeper, seededSold: seeded, claims: [], viewer: identity("mine") },
      [{ seatId: "U3B", gender: "male" }],
    ),
  );
  assert.equal(refusal.code, "SEAT-GENDER-LOCKED");
  assert.match(refusal.message, /U3B/);
  assert.match(refusal.message, /female/);
  // Never the neighbouring passenger, and nothing about them.
  assert.doesNotMatch(refusal.message, /U3A/);
});

test("an undeclared gender cannot satisfy a female-only constraint", () => {
  // A consequence of the rule rather than a separate policy, and the right
  // one: inferring a gender from a name would be a far worse move.
  const seeded = seededOccupancy(sleeperService, sleeper, "2026-09-25", SEED);
  const refusal = refusalFrom(() =>
    assertGenderLocks(
      { map: sleeper, seededSold: seeded, claims: [], viewer: identity("mine") },
      [{ seatId: "U3B", gender: null }],
    ),
  );
  assert.equal(refusal.code, "SEAT-GENDER-LOCKED");
});

test("a woman takes the locked berth without argument", () => {
  const seeded = seededOccupancy(sleeperService, sleeper, "2026-09-25", SEED);
  assert.doesNotThrow(() =>
    assertGenderLocks(
      { map: sleeper, seededSold: seeded, claims: [], viewer: identity("mine") },
      [{ seatId: "U3B", gender: "female" }],
    ),
  );
});

test("two seats of one booking are evaluated against each other, not by it", () => {
  // Both halves of a double berth, one man and one woman, in one request. The
  // lock is evaluated against seats held by other bookings and against the
  // simulation, never against the other seats in the request being evaluated.
  const mine = identity("mine");
  assert.doesNotThrow(() =>
    assertGenderLocks(
      {
        map: sleeper,
        seededSold: new Map(),
        claims: [held("U3A", "mine"), held("U3B", "mine")],
        viewer: mine,
      },
      [
        { seatId: "U3A", gender: "male" },
        { seatId: "U3B", gender: "female" },
      ],
    ),
  );
});
