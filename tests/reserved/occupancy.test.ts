import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import {
  MAX_FILL,
  MIN_FILL,
  fillFraction,
  seatDesirability,
  seededGender,
  seededOccupancy,
  selectSoldSeats,
  soldSeatIds,
} from "../../src/reserved/occupancy.js";
import type { ReservedService, SeatMap } from "../../src/reserved/types.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
const services = await source.allServices();

function serviceNamed(serviceId: string): ReservedService {
  const service = services.find((candidate) => candidate.serviceId === serviceId);
  assert.ok(service, `no service ${serviceId}`);
  return service;
}

async function mapFor(serviceId: string): Promise<SeatMap> {
  const map = await source.seatMap(serviceNamed(serviceId).seatMapId);
  assert.ok(map);
  return map;
}

const SEED = 20_260_905;
const sleeper = await mapFor("2259BNGHMP");
const seater = await mapFor("1000BNGMAA");

/* ------------------------------------------------------------------ *
 * The fill fraction
 * ------------------------------------------------------------------ */

test("the fill fraction is a consequence of the service and the date", () => {
  const service = serviceNamed("2259BNGHMP");
  const friday = fillFraction(service, "2026-09-25");
  assert.equal(fillFraction(service, "2026-09-25"), friday);
  // 2026-09-29 is a Tuesday, which is the trough of an ordinary intercity
  // demand week, and the same coach on the same corridor is emptier.
  assert.ok(fillFraction(service, "2026-09-29") < friday);
});

test("a cheaper class fills first at the same popularity", () => {
  const sleeperService = serviceNamed("2259BNGHMP");
  const clubService = { ...sleeperService, serviceClass: "AIRAVAT_CLUB" as const };
  assert.ok(
    fillFraction(clubService, "2026-09-25") <
      fillFraction(sleeperService, "2026-09-25"),
  );
});

test("the fill fraction is clamped rather than allowed to run off either end", () => {
  const service = serviceNamed("2259BNGHMP");
  assert.ok(fillFraction({ ...service, popularity: 0 }, "2026-09-25") >= MIN_FILL);
  assert.ok(fillFraction({ ...service, popularity: 1 }, "2026-09-25") <= MAX_FILL);
});

test("nothing in the fill fraction reads the wall clock", () => {
  // A booking curve that filled a coach as its departure approached would be
  // more lifelike, and would be indistinguishable on screen from real
  // inventory moving, which is a claim this provider cannot make. The static
  // map is visibly a simulation, and the answer to "why does berth L3B show
  // sold" does not depend on when you asked.
  const service = serviceNamed("2259BNGHMP");
  const expected = fillFraction(service, "2026-09-25");
  withoutAClock(() => {
    assert.equal(fillFraction(service, "2026-09-25"), expected);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

/** Runs a body with every reachable clock replaced by one that throws. */
function withoutAClock(body: () => void): void {
  const RealDate = globalThis.Date;
  const realNow = performance.now.bind(performance);
  class NoClock extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) throw new Error("read the wall clock");
      super(...(args as [number]));
    }
    static now(): number {
      throw new Error("read the wall clock");
    }
  }
  globalThis.Date = NoClock as unknown as DateConstructor;
  performance.now = () => {
    throw new Error("read the wall clock");
  };
  try {
    body();
  } finally {
    globalThis.Date = RealDate;
    performance.now = realNow;
  }
}

test("the same service on the same date sells the same seats, every call", () => {
  const service = serviceNamed("2259BNGHMP");
  const first = soldSeatIds(service, sleeper, "2026-09-25", SEED);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    assert.deepEqual(soldSeatIds(service, sleeper, "2026-09-25", SEED), first);
  }
});

test("the sold set does not move when the clock does", () => {
  // The invariant most likely to be broken by a well-meaning later edit, so
  // it is asserted as behaviour rather than described in a comment.
  const service = serviceNamed("2259BNGHMP");
  const expected = soldSeatIds(service, sleeper, "2026-09-25", SEED);
  withoutAClock(() => {
    assert.deepEqual(soldSeatIds(service, sleeper, "2026-09-25", SEED), expected);
  });
});

test("the same service on the same date sells the same seats in a second process", () => {
  // Determinism inside one process only proves an answer is memoised. The
  // property is that a screenshot, a golden file and a stranger's first clone
  // all show the same coach.
  const script = fileURLToPath(new URL("./occupancy-print.ts", import.meta.url));
  const run = () =>
    execFileSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const first = run();
  const second = run();
  assert.equal(first, second);
  const parsed = JSON.parse(first) as { sold: string[] };
  assert.ok(parsed.sold.length > 0);
  assert.deepEqual(
    parsed.sold,
    soldSeatIds(serviceNamed("2259BNGHMP"), sleeper, "2026-09-25", SEED),
  );
});

test("a different travel date is a different inventory", () => {
  const service = serviceNamed("2259BNGHMP");
  assert.notDeepEqual(
    soldSeatIds(service, sleeper, "2026-09-25", SEED),
    soldSeatIds(service, sleeper, "2026-09-26", SEED),
  );
});

test("a different service on the same date is a different inventory", () => {
  assert.notDeepEqual(
    soldSeatIds(serviceNamed("2259BNGHMP"), sleeper, "2026-09-25", SEED),
    soldSeatIds(serviceNamed("2001HMPBNG"), sleeper, "2026-09-25", SEED),
  );
});

test("the seed is really a seed", () => {
  const service = serviceNamed("2259BNGHMP");
  assert.notDeepEqual(
    selectSoldSeats(sleeper, 0.5, service.serviceId, "2026-09-25", SEED),
    selectSoldSeats(sleeper, 0.5, service.serviceId, "2026-09-25", SEED + 1),
  );
});

test("the sold set is a real subset of the map with no repeats", () => {
  const service = serviceNamed("2259BNGHMP");
  const sold = soldSeatIds(service, sleeper, "2026-09-25", SEED);
  const onMap = new Set(sleeper.seats.map((seat) => seat.seatId));
  assert.equal(new Set(sold).size, sold.length);
  assert.ok(sold.every((seatId) => onMap.has(seatId)));
  assert.equal(
    sold.length,
    Math.round(fillFraction(service, "2026-09-25") * sleeper.seats.length),
  );
});

/* ------------------------------------------------------------------ *
 * Shape: which seats, not just how many
 * ------------------------------------------------------------------ */

function share(sold: string[], map: SeatMap, of: (seatId: string) => boolean): number {
  return sold.filter(of).length / sold.length;
}

function mapShare(map: SeatMap, of: (seatId: string) => boolean): number {
  return map.seats.filter((seat) => of(seat.seatId)).length / map.seats.length;
}

test("a half-full coach shows its windows gone and its middles free", () => {
  // Seats do not sell in index order, and a map that filled 1A, 1B, 1C, 1D,
  // 2A would look wrong to anyone who has boarded a coach. A change that
  // flattened the desirability weighting into a plain hash fails here rather
  // than passing silently.
  const windows = new Set(
    seater.seats.filter((seat) => seat.window).map((seat) => seat.seatId),
  );
  const sold = selectSoldSeats(seater, 0.5, "1000BNGMAA", "2026-09-25", SEED);
  assert.ok(
    share(sold, seater, (seatId) => windows.has(seatId)) >
      mapShare(seater, (seatId) => windows.has(seatId)),
  );
});

test("lower berths go before upper ones", () => {
  const lower = new Set(
    sleeper.seats.filter((seat) => seat.deck === 1).map((seat) => seat.seatId),
  );
  const sold = selectSoldSeats(sleeper, 0.5, "2259BNGHMP", "2026-09-25", SEED);
  assert.ok(share(sold, sleeper, (seatId) => lower.has(seatId)) > 0.5);
});

test("a single berth goes before half of a double", () => {
  const singles = new Set(
    sleeper.seats
      .filter((seat) => seat.pairedSeatId === null)
      .map((seat) => seat.seatId),
  );
  const sold = selectSoldSeats(sleeper, 0.5, "2259BNGHMP", "2026-09-25", SEED);
  assert.ok(
    share(sold, sleeper, (seatId) => singles.has(seatId)) >
      mapShare(sleeper, (seatId) => singles.has(seatId)),
  );
});

test("the rear bench is the last thing anybody takes", () => {
  const bench = new Set(
    seater.seats.filter((seat) => seat.row === 13).map((seat) => seat.seatId),
  );
  const sold = selectSoldSeats(seater, 0.5, "1000BNGMAA", "2026-09-25", SEED);
  assert.ok(
    share(sold, seater, (seatId) => bench.has(seatId)) <
      mapShare(seater, (seatId) => bench.has(seatId)),
  );
});

test("forward rows go before rear ones, all else equal", () => {
  const byId = new Map(seater.seats.map((seat) => [seat.seatId, seat]));
  const front = byId.get("1A")!;
  const back = byId.get("12A")!;
  assert.ok(seatDesirability(front, seater) > seatDesirability(back, seater));
});

test("the desirability weight carries no randomness of its own", () => {
  // Noise perturbs the shape rather than being the shape, so the weight is a
  // pure function of the seat and the layout and the draw is layered on top.
  const seat = seater.seats[0];
  const weight = seatDesirability(seat, seater);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(seatDesirability(seat, seater), weight);
  }
});

/* ------------------------------------------------------------------ *
 * The seeded gender
 * ------------------------------------------------------------------ */

test("a notionally occupied seat gets a deterministic gender", () => {
  // The adjacency rule cannot evaluate a lock without knowing who is
  // notionally beside the empty seat, so a gender is fabricated for seats
  // nobody booked. It never leaves this computation as an identity: what the
  // wire carries is the resulting lock, not a claim about a person.
  const first = seededGender(SEED, "2259BNGHMP", "2026-09-25", "L1A");
  assert.equal(seededGender(SEED, "2259BNGHMP", "2026-09-25", "L1A"), first);
  assert.ok(first === "male" || first === "female");
});

test("the seeded gender differs by seat, by date and by service", () => {
  const genders = new Set(
    sleeper.seats.map((seat) =>
      seededGender(SEED, "2259BNGHMP", "2026-09-25", seat.seatId),
    ),
  );
  assert.deepEqual([...genders].sort(), ["female", "male"]);
  const onOneDate = sleeper.seats.map((seat) =>
    seededGender(SEED, "2259BNGHMP", "2026-09-25", seat.seatId),
  );
  const onAnother = sleeper.seats.map((seat) =>
    seededGender(SEED, "2259BNGHMP", "2026-09-26", seat.seatId),
  );
  assert.notDeepEqual(onOneDate, onAnother);
});

test("seeded occupancy answers with a gender for every sold seat and nothing else", () => {
  const service = serviceNamed("2259BNGHMP");
  const occupancy = seededOccupancy(service, sleeper, "2026-09-25", SEED);
  const sold = soldSeatIds(service, sleeper, "2026-09-25", SEED);
  assert.deepEqual([...occupancy.keys()].sort(), [...sold].sort());
  occupancy.forEach((gender, seatId) => {
    assert.ok(sold.includes(seatId));
    assert.equal(gender, seededGender(SEED, service.serviceId, "2026-09-25", seatId));
  });
});

test("seeded occupancy reads no clock either", () => {
  const service = serviceNamed("2259BNGHMP");
  const expected = [...seededOccupancy(service, sleeper, "2026-09-25", SEED)].sort();
  withoutAClock(() => {
    assert.deepEqual(
      [...seededOccupancy(service, sleeper, "2026-09-25", SEED)].sort(),
      expected,
    );
  });
});
