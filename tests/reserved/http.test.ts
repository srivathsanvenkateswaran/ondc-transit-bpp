import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { HttpReservedSource } from "../../src/reserved/http.js";

/**
 * The optional source, and the fixtures that catch it when it falls.
 *
 * No network is reached here. The fetch is a function, and every case below
 * hands it a different answer.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const responseSchemaPath = fileURLToPath(
  new URL("../../schemas/reserved-source-response.json", import.meta.url),
);
const fixture = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

// Read straight off the same towns.json the fixture itself loaded, rather
// than a hand-copied list of the seven town codes the ksrtc fixture used to
// carry. That copy was already stale the day `generate-ksrtc-fixtures.ts`
// grew past the three original generated corridors: a synthetic catalogue
// naming a boarding point's town but not the town itself fails
// `validateReservedCatalogue`'s own "names unknown town" check before any
// test's own deliberate mutation is ever reached, which is what happened
// here once boarding points under HSN/KNG/CTD/HVR/HBL/MDK/MND/ANK/GKN
// existed and this list did not know about them. Reading the real file
// keeps this synthetic catalogue's town list unable to drift from the one
// `fixture.allServices()` actually stops at, the same way `boardingPoints`
// below is built from the real services rather than a hand list of those.
const towns = (
  JSON.parse(
    await readFile(new URL("../../fixtures/ksrtc/towns.json", import.meta.url), "utf8"),
  ) as { towns: Array<{ code: string; name: string }> }
).towns.map((town) => ({ code: town.code, name: town.name }));

const QUERY = {
  fromTownCode: "BLR",
  toTownCode: "HMP",
  travelDate: "2026-09-30",
  cityCode: "std:080",
};

async function catalogueBody() {
  const services = await fixture.allServices();
  return {
    catalogue: {
      operator: fixture.operator,
      towns,
      boardingPoints: services.flatMap((service) => [
        ...service.boardingPoints,
        ...service.droppingPoints,
      ]),
      services,
      seatMaps: await Promise.all(
        [...new Set(services.map((service) => service.seatMapId))].map(
          async (id) => (await fixture.seatMap(id))!,
        ),
      ),
      fareTables: await Promise.all(
        [...new Set(services.map((service) => service.fareTableId))].map(
          async (id) => (await fixture.fareTable(id))!,
        ),
      ),
    },
  };
}

function sourceWith(
  fetchImpl: typeof fetch,
  events: Array<Record<string, unknown>> = [],
) {
  return new HttpReservedSource({
    url: "http://dataset.invalid/reserved",
    fallback: fixture,
    responseSchemaPath,
    fetchImpl,
    eventLogger: (event) => events.push(event),
  });
}

function respondWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("a dataset that answers is the catalogue this provider sells", async () => {
  const body = await catalogueBody();
  body.catalogue.services[0].serviceNumber = "9999";
  const source = sourceWith(respondWith(body));
  const [service] = await source.services(QUERY);
  assert.equal(service.serviceNumber, "9999");
  assert.equal((await source.service("2259BNGHMP"))!.serviceNumber, "9999");
  assert.ok(await source.seatMap("PALLAKKI-2P1-30"));
  assert.ok(await source.fareTable("FT-BNGHMP"));
});

test("the catalogue is fetched once and held, so a select and its confirm agree", async () => {
  let calls = 0;
  const body = await catalogueBody();
  const source = sourceWith((async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch);
  await source.services(QUERY);
  await source.service("2259BNGHMP");
  await source.seatMap("PALLAKKI-2P1-30");
  assert.equal(calls, 1);
});

test("a dataset that is down falls back to the fixtures and says which happened", async () => {
  const events: Array<Record<string, unknown>> = [];
  const source = sourceWith(
    (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch,
    events,
  );
  const services = await source.services(QUERY);
  assert.equal(services[0].serviceId, "2259BNGHMP");
  assert.deepEqual(events, [
    {
      action: "reserved_source",
      operator: "ksrtc",
      source: "http",
      fallback_source: "fixture",
      outcome: "FALLBACK",
      reason: "connect ECONNREFUSED",
    },
  ]);
});

test("a dataset that answers with the wrong shape is refused, not half read", async () => {
  const events: Array<Record<string, unknown>> = [];
  const body = await catalogueBody();
  (body.catalogue.services[0] as unknown as { serviceClass: string }).serviceClass =
    "SARIGE";
  const source = sourceWith(respondWith(body), events);
  const services = await source.services(QUERY);
  // Fell back rather than publishing an unreserved walk-up class as a
  // numbered-seat product.
  assert.equal(services[0].serviceClass, "PALLAKKI");
  assert.equal(events[0].outcome, "FALLBACK");
  assert.match(String(events[0].reason), /schema validation/);
});

test("a dataset that is internally inconsistent is refused by the same check the fixtures pass", async () => {
  const events: Array<Record<string, unknown>> = [];
  const body = await catalogueBody();
  body.catalogue.services[0].seatMapId = "A-LAYOUT-NOBODY-AUTHORED";
  const source = sourceWith(respondWith(body), events);
  await source.services(QUERY);
  assert.equal(events[0].outcome, "FALLBACK");
  assert.match(String(events[0].reason), /which nobody authored/);
});

test("an http error is a fallback rather than an empty catalogue", async () => {
  const events: Array<Record<string, unknown>> = [];
  const source = sourceWith(respondWith({}, 503), events);
  assert.equal((await source.services(QUERY)).length, 1);
  assert.match(String(events[0].reason), /503/);
});
