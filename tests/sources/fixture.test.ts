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

test("fixture source does not sell a route in reverse", async () => {
  const source = await FixtureJourneySource.load(fixtureRoot, "bmrcl");
  const offers = await source.search({
    cityCode: "std:080",
    fromCode: "CUBBON_PARK",
    toCode: "TRINITY",
  });

  assert.deepEqual(offers, []);
});
