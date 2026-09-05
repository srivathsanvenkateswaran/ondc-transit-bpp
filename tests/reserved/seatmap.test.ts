import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import type { Seat, SeatMap } from "../../src/reserved/types.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

function seatOf(map: SeatMap, seatId: string): Seat {
  const seat = map.seats.find((candidate) => candidate.seatId === seatId);
  assert.ok(seat, `${map.seatMapId} has no seat ${seatId}`);
  return seat;
}

test("the 2+2 seater is twelve rows of four and one rear bench of five", async () => {
  // 53 seats is 12 full rows of four plus an aisle-free rear five. The
  // specification says 13 full rows plus a rear five, which totals 57; 12 is
  // the reading that matches the capacity the class is actually sourced at.
  const map = await source.seatMap("AIRAVAT_CLUB-2P2-53");
  assert.ok(map);
  assert.equal(map.seats.length, 53);
  assert.equal(map.kind, "SEATER");
  assert.equal(map.decks, 1);
  const rows = new Map<number, number>();
  map.seats.forEach((seat) => rows.set(seat.row, (rows.get(seat.row) ?? 0) + 1));
  assert.deepEqual([...rows.entries()].sort((a, b) => a[0] - b[0]), [
    ...Array.from({ length: 12 }, (_, index) => [index + 1, 4] as [number, number]),
    [13, 5],
  ]);
});

test("the aisle breaks adjacency on a 2+2 coach", () => {
  // 1B and 1C are numerically consecutive and are not adjacent. Nobody sits
  // shoulder to shoulder across an aisle, so a woman in 1B does not lock 1C.
  // Deriving adjacency from seat numbering would lock the wrong seat on every
  // 2+2 coach in the fleet.
  return source.seatMap("AIRAVAT_CLUB-2P2-53").then((map) => {
    assert.ok(map);
    assert.deepEqual(seatOf(map, "1A").adjacentSeatIds, ["1B"]);
    assert.deepEqual(seatOf(map, "1B").adjacentSeatIds, ["1A"]);
    assert.deepEqual(seatOf(map, "1C").adjacentSeatIds, ["1D"]);
    assert.deepEqual(seatOf(map, "1D").adjacentSeatIds, ["1C"]);
  });
});

test("the rear bench is aisle-free, so adjacency runs the length of it", async () => {
  const map = await source.seatMap("AIRAVAT_CLUB-2P2-53");
  assert.ok(map);
  assert.deepEqual(seatOf(map, "13A").adjacentSeatIds, ["13B"]);
  assert.deepEqual(seatOf(map, "13C").adjacentSeatIds, ["13B", "13D"]);
  assert.deepEqual(seatOf(map, "13E").adjacentSeatIds, ["13D"]);
});

test("a seater seat is one person's, so nothing on the map is paired", async () => {
  const map = await source.seatMap("AIRAVAT_CLUB-2P2-53");
  assert.ok(map);
  assert.ok(map.seats.every((seat) => seat.pairedSeatId === null));
  assert.ok(map.seats.every((seat) => seat.kind === "SEAT"));
});

test("windows are the outer columns, including both ends of the rear bench", async () => {
  const map = await source.seatMap("AIRAVAT_CLUB-2P2-53");
  assert.ok(map);
  const windows = map.seats.filter((seat) => seat.window).map((seat) => seat.seatId);
  assert.equal(windows.length, 26);
  assert.ok(windows.includes("1A") && windows.includes("1D"));
  assert.ok(windows.includes("13A") && windows.includes("13E"));
  assert.ok(!windows.includes("1B") && !windows.includes("13C"));
});

test("the 2+1 sleeper is thirty berths across two decks", async () => {
  const map = await source.seatMap("PALLAKKI-2P1-30");
  assert.ok(map);
  assert.equal(map.seats.length, 30);
  assert.equal(map.kind, "SLEEPER");
  assert.equal(map.decks, 2);
  assert.equal(map.seats.filter((seat) => seat.deck === 1).length, 15);
  assert.equal(map.seats.filter((seat) => seat.deck === 2).length, 15);
  assert.ok(map.seats.every((seat) => seat.kind === "BERTH"));
});

test("a double berth is two sellable places that know about each other", async () => {
  const map = await source.seatMap("PALLAKKI-2P1-30");
  assert.ok(map);
  assert.equal(seatOf(map, "L1A").pairedSeatId, "L1B");
  assert.equal(seatOf(map, "L1B").pairedSeatId, "L1A");
  assert.deepEqual(seatOf(map, "L1A").adjacentSeatIds, ["L1B"]);
});

test("a single berth has neither a pair nor a neighbour", async () => {
  // Which is precisely why it is the berth a lone traveller wants, and why
  // the gender adjacency rule never touches it.
  const map = await source.seatMap("PALLAKKI-2P1-30");
  assert.ok(map);
  assert.equal(seatOf(map, "L1C").pairedSeatId, null);
  assert.deepEqual(seatOf(map, "L1C").adjacentSeatIds, []);
  assert.equal(seatOf(map, "U5C").pairedSeatId, null);
  assert.deepEqual(seatOf(map, "U5C").adjacentSeatIds, []);
});

test("deck is a first-class axis rather than something parsed out of a seat id", async () => {
  const map = await source.seatMap("PALLAKKI-2P1-30");
  assert.ok(map);
  assert.ok(
    map.seats
      .filter((seat) => seat.seatId.startsWith("U"))
      .every((seat) => seat.deck === 2),
  );
  // Both decks come back in one payload. A wire shape that returned one deck
  // per call would force the tab-per-deck pattern the research names as the
  // lowest-converting step in the entire booking funnel.
  assert.equal(new Set(map.seats.map((seat) => seat.deck)).size, 2);
});

test("adjacency and pairing are symmetric on every shipped map", async () => {
  for (const seatMapId of ["AIRAVAT_CLUB-2P2-53", "PALLAKKI-2P1-30"]) {
    const map = await source.seatMap(seatMapId);
    assert.ok(map);
    const byId = new Map(map.seats.map((seat) => [seat.seatId, seat]));
    map.seats.forEach((seat) => {
      assert.ok(!seat.adjacentSeatIds.includes(seat.seatId));
      seat.adjacentSeatIds.forEach((neighbourId) => {
        const neighbour = byId.get(neighbourId);
        assert.ok(neighbour, `${seatMapId}: ${neighbourId} is not on the map`);
        assert.ok(
          neighbour.adjacentSeatIds.includes(seat.seatId),
          `${seatMapId}: ${neighbourId} does not name ${seat.seatId} back`,
        );
      });
      if (seat.pairedSeatId !== null) {
        const partner = byId.get(seat.pairedSeatId);
        assert.ok(partner, `${seatMapId}: ${seat.pairedSeatId} is not on the map`);
        assert.equal(partner.pairedSeatId, seat.seatId);
      }
    });
  }
});

test("a seat map carries no price and names no vehicle", async () => {
  // A window seat costs what an aisle seat costs, because no source
  // establishes a per-seat premium. Which physical coach turns up is a
  // question about a fleet, and this provider does not answer it.
  for (const seatMapId of ["AIRAVAT_CLUB-2P2-53", "PALLAKKI-2P1-30"]) {
    const map = await source.seatMap(seatMapId);
    assert.ok(map);
    const serialised = JSON.stringify(map);
    assert.ok(!/paise|price|fare/i.test(serialised));
    assert.ok(!/registration|plate|chassis|vehicle/i.test(serialised));
  }
});
