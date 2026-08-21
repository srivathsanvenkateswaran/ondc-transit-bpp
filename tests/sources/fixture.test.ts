import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureJourneySource, haversineKm } from "../../src/sources/fixture.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));

test("haversine distance is zero for the same point", () => {
  assert.equal(
    haversineKm(
      { lat: 12.97839, lon: 77.63879 },
      { lat: 12.97839, lon: 77.63879 },
    ),
    0,
  );
});

test("fixture source matches and slices a metro offer by stop code", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmrcl");
  const offers = await source.search({
    cityCode: "std:080",
    fromCode: "TRINITY",
    toCode: "CUBBON_PARK",
  });

  assert.equal(offers.length, 1);
  assert.deepEqual(
    offers[0].route.map((stop) => stop.code),
    ["TRINITY", "MAHATMA_GANDHI_ROAD", "CUBBON_PARK"],
  );
  assert.equal(offers[0].farePaise, 3000);
});

test("fixture source matches a bus offer by nearest GPS stops", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmtc");
  const offers = await source.search({
    cityCode: "std:080",
    fromGps: { lat: 12.9784, lon: 77.6408 },
    toGps: { lat: 12.9774, lon: 77.5726 },
  });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].route[0].name, "Indiranagar 6th Main");
  assert.equal(offers[0].route.at(-1)?.name, "Kempegowda Bus Station");
});

test("fixture source handles mixed stop-code and GPS endpoints", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmtc");
  const offers = await source.search({
    cityCode: "std:080",
    fromCode: "BMTC_INDIRANAGAR_6TH_MAIN",
    toGps: { lat: 12.9774, lon: 77.5726 },
  });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].route[0].code, "BMTC_INDIRANAGAR_6TH_MAIN");
  assert.equal(offers[0].route.at(-1)?.code, "BMTC_KEMPEGOWDA_BUS_STATION");
});

test("metro fixture sells exactly one offer in each direction", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmrcl");
  const eastbound = await source.search({
    cityCode: "std:080",
    fromCode: "INDIRANAGAR",
    toCode: "NADAPRABHU_KEMPEGOWDA_STATION_MAJESTIC",
  });
  const westbound = await source.search({
    cityCode: "std:080",
    fromCode: "NADAPRABHU_KEMPEGOWDA_STATION_MAJESTIC",
    toCode: "INDIRANAGAR",
  });

  assert.equal(eastbound.length, 1);
  assert.deepEqual(
    [eastbound[0].route[0].code, eastbound[0].route.at(-1)?.code],
    ["INDIRANAGAR", "NADAPRABHU_KEMPEGOWDA_STATION_MAJESTIC"],
  );
  assert.equal(westbound.length, 1);
  assert.deepEqual(
    [westbound[0].route[0].code, westbound[0].route.at(-1)?.code],
    ["NADAPRABHU_KEMPEGOWDA_STATION_MAJESTIC", "INDIRANAGAR"],
  );
});

test("bus fixture sells exactly one offer in each direction", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmtc");
  const outbound = await source.search({
    cityCode: "std:080",
    fromCode: "BMTC_INDIRANAGAR_6TH_MAIN",
    toCode: "BMTC_KEMPEGOWDA_BUS_STATION",
  });
  const inbound = await source.search({
    cityCode: "std:080",
    fromCode: "BMTC_KEMPEGOWDA_BUS_STATION",
    toCode: "BMTC_INDIRANAGAR_6TH_MAIN",
  });

  assert.equal(outbound.length, 1);
  assert.deepEqual(
    [outbound[0].route[0].code, outbound[0].route.at(-1)?.code],
    ["BMTC_INDIRANAGAR_6TH_MAIN", "BMTC_KEMPEGOWDA_BUS_STATION"],
  );
  assert.equal(inbound.length, 1);
  assert.deepEqual(
    [inbound[0].route[0].code, inbound[0].route.at(-1)?.code],
    ["BMTC_KEMPEGOWDA_BUS_STATION", "BMTC_INDIRANAGAR_6TH_MAIN"],
  );
});
