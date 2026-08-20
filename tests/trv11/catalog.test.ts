import assert from "node:assert/strict";
import { test } from "node:test";

import { createProtocolValidator } from "../../src/protocol/validate.js";
import type { SearchRequest } from "../../src/protocol/types.js";
import { FixtureJourneySource } from "../../src/sources/fixture.js";
import { buildOnSearch, paiseToRupees } from "../../src/trv11/catalog.js";
import { searchRequest, testConfig } from "../helpers.js";

test("paise converts to a stable rupee string without floating point", () => {
  assert.equal(paiseToRupees(2700), "27");
  assert.equal(paiseToRupees(2750), "27.50");
  assert.equal(paiseToRupees(5), "0.05");
});

for (const [operatorKey, category, expectedFare] of [
  ["bmtc", "BUS", "27"],
  ["bmrcl", "METRO", "30"],
] as const) {
  test(`${operatorKey} maps a fixture offer into a valid TRV11 catalogue`, async () => {
    const config = testConfig();
    const source = await FixtureJourneySource.load(config.fixtureRoot, operatorKey);
    const response = await buildOnSearch(
      searchRequest(category) as unknown as SearchRequest,
      source,
      config.operators[operatorKey],
      {
        publicBaseUrl: config.publicBaseUrl,
        contextTtl: config.contextTtl,
        now: () => new Date("2026-08-20T05:00:00.000Z"),
      },
    );
    const validator = createProtocolValidator(config.schemaRoot);
    assert.deepEqual(validator.onSearch(response), { valid: true, errors: [] });

    const provider = response.message.catalog.providers[0] as any;
    assert.equal(provider.items[0].descriptor.code, "SJT");
    assert.equal(provider.items[0].price.currency, "INR");
    assert.equal(provider.items[0].price.value, expectedFare);
    assert.equal(provider.fulfillments[0].type, "TRIP");
    assert.equal(provider.fulfillments[0].vehicle.category, category);
    assert.equal(provider.fulfillments[0].stops[0].type, "START");
    assert.equal(provider.fulfillments[0].stops.at(-1).type, "END");
    provider.fulfillments[0].stops.slice(1).forEach((stop: any, index: number) => {
      assert.equal(stop.parent_stop_id, String(index + 1));
    });
    assert.equal("quote" in provider, false);
  });
}
