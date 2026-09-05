import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureReservedSource } from "../../src/reserved/fixture.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));

test("the whole reserved catalogue loads from disk with nothing else up", async () => {
  // No harvester, no database of Karnataka, no cold start. A stranger clones
  // the repository and gets a working reserved intercity seller in under five
  // minutes with nothing else running.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  assert.equal(source.operator.vehicleCategory, "COACH");
  assert.equal(source.operator.id, "P1");
});

test("a corridor search returns the service running that pair on that date", async () => {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const services = await source.services({
    fromTownCode: "BLR",
    toTownCode: "HMP",
    travelDate: "2026-09-25",
    cityCode: "std:080",
  });
  assert.deepEqual(
    services.map((service) => service.serviceId),
    ["2259BNGHMP"],
  );
  const [service] = services;
  assert.equal(service.serviceNumber, "2259");
  assert.equal(service.serviceClass, "PALLAKKI");
  assert.equal(service.departureMinute, 1_379);
  assert.equal(service.runningMinutes, 451);
  assert.equal(service.seatMapId, "PALLAKKI-2P1-30");
});

test("boarding points arrive resolved, ordered, and with their own reporting times", async () => {
  // A boarding point is a choice with consequences rather than a label, and
  // the reporting offset is what makes it one.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const [service] = await source.services({
    fromTownCode: "BLR",
    toTownCode: "HMP",
    travelDate: "2026-09-25",
    cityCode: "std:080",
  });
  assert.deepEqual(
    service.boardingPoints.map((point) => [
      point.boardingPointId,
      point.reportingOffsetMinutes,
    ]),
    [
      ["BP-BLR-MAJESTIC", 0],
      ["BP-BLR-MADIWALA", 32],
      ["BP-BLR-ELECTRONIC-CITY", 52],
    ],
  );
  assert.equal(service.boardingPoints[0].name, "Majestic (Kempegowda Bus Station)");
  assert.deepEqual(
    service.droppingPoints.map((point) => point.boardingPointId),
    ["BP-HPT-HOSAPETE", "BP-HMP-HAMPI"],
  );
});

test("a boarding point with no surveyed coordinate publishes none", async () => {
  // Drawing nothing is the right degradation. A pin is only as trustworthy as
  // the operational data behind it, and a coordinate synthesised from a town
  // centroid is worse than an absence.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const [service] = await source.services({
    fromTownCode: "BLR",
    toTownCode: "MAA",
    travelDate: "2026-09-25",
    cityCode: "std:080",
  });
  const unsurveyed = service.droppingPoints.filter((point) => !point.gps);
  assert.ok(unsurveyed.length > 0, "at least one point ships without a coordinate");
  unsurveyed.forEach((point) => {
    assert.ok(!("gps" in point) || point.gps === undefined);
  });
});

test("the return leg of the corridor is a separate service, not a reversal", async () => {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const services = await source.services({
    fromTownCode: "HMP",
    toTownCode: "BLR",
    travelDate: "2026-09-25",
    cityCode: "std:080",
  });
  assert.deepEqual(
    services.map((service) => service.serviceId),
    ["2001HMPBNG"],
  );
});

test("a class filter narrows the corridor rather than the corridor narrowing itself", async () => {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const wrongClass = await source.services({
    fromTownCode: "BLR",
    toTownCode: "HMP",
    travelDate: "2026-09-25",
    serviceClass: "AIRAVAT_CLUB",
    cityCode: "std:080",
  });
  assert.deepEqual(wrongClass, []);
  const rightClass = await source.services({
    fromTownCode: "BLR",
    toTownCode: "HMP",
    travelDate: "2026-09-25",
    serviceClass: "PALLAKKI",
    cityCode: "std:080",
  });
  assert.equal(rightClass.length, 1);
});

test("a date the service does not run returns no item for it", async () => {
  // 2026-09-26 is a Saturday, and the Chennai service in the fixture set runs
  // Sunday to Friday. The Friday before it runs, and so does the Sunday after;
  // a rider asking about the Saturday is told nothing runs, not offered
  // either neighbour.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  assert.equal(
    (
      await source.services({
        fromTownCode: "BLR",
        toTownCode: "MAA",
        travelDate: "2026-09-25",
        cityCode: "std:080",
      })
    ).length,
    1,
  );
  assert.deepEqual(
    await source.services({
      fromTownCode: "BLR",
      toTownCode: "MAA",
      travelDate: "2026-09-26",
      cityCode: "std:080",
    }),
    [],
  );
  assert.equal(
    (
      await source.services({
        fromTownCode: "BLR",
        toTownCode: "MAA",
        travelDate: "2026-09-27",
        cityCode: "std:080",
      })
    ).length,
    1,
  );
});

test("an unknown town pair returns nothing rather than the nearest thing", async () => {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  assert.deepEqual(
    await source.services({
      fromTownCode: "BLR",
      toTownCode: "GOA",
      travelDate: "2026-09-25",
      cityCode: "std:080",
    }),
    [],
  );
});

test("seat maps and fare tables resolve by id, and an unknown id is undefined", async () => {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  assert.ok(await source.seatMap("PALLAKKI-2P1-30"));
  assert.equal(await source.seatMap("AMBAARI_UTSAV-2P1-30"), undefined);
  const table = await source.fareTable("FT-BNGHMP");
  assert.ok(table);
  assert.equal(table.currency, "INR");
  assert.equal(await source.fareTable("FT-MYSMDK"), undefined);
});

test("every fare cell carries its own sourcing label, because a table can be part-sourced", async () => {
  // A per-table label would launder an interpolated cell into a sourced one.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const table = await source.fareTable("FT-BNGHMP");
  assert.ok(table);
  assert.ok(table.fares.every((cell) => ["V", "S", "I"].includes(cell.sourcing)));
  const labels = new Set(table.fares.map((cell) => cell.sourcing));
  assert.ok(labels.size > 1, "the shipped table is genuinely part-sourced");
});

test("no shipped corridor claims to be confirmed", async () => {
  // The value exists so that a corridor built later from several agreeing
  // sources can claim it. Shipping everything at inferred is the accurate
  // reading of what the research actually found.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const all = await source.allServices();
  assert.ok(all.length > 0);
  assert.ok(all.every((service) => service.provenance === "inferred"));
  assert.ok(all.every((service) => service.provenanceSourceCount >= 1));
});

test("an unconfirmed operating corporation is absent rather than guessed", async () => {
  // Absence means unknown. Publishing an inferred corporation would defeat
  // the whole point of the disclosure, which is that it closes a gap every
  // other surface leaves open.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const all = await source.allServices();
  const hampi = all.find((service) => service.serviceId === "2259BNGHMP");
  assert.ok(hampi);
  assert.equal(hampi.brand, "KSRTC");
  assert.equal(hampi.operatingCorporation, null);
  assert.equal(hampi.operatingCorporationBasis, "none");
});

test("the source supplies what is sellable and never who has sold it", async () => {
  // Occupancy is seeded here and holds and bookings live here. A source that
  // could supply which seats are sold would be a source with live operator
  // inventory, which is exactly the thing nobody has.
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const all = await source.allServices();
  const serialised = JSON.stringify(all);
  assert.ok(!/sold|occupied|available|remaining|held/i.test(serialised));
});
