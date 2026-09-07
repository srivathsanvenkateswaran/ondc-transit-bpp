import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RESERVED_DOMAIN,
  RESERVED_VERSION,
} from "../../src/reserved/domain.js";
import { createProtocolValidator } from "../../src/protocol/validate.js";
import { createReservedValidator } from "../../src/reserved/schema.js";
import { reservedSearchRequest, searchRequest, testConfig } from "../helpers.js";

const schemaRoot = fileURLToPath(
  new URL("../../schemas/transit_local_intercity/0.1.0", import.meta.url),
);
const validator = createReservedValidator(schemaRoot);

test("the schema tree compiles for all seven actions and their callbacks", () => {
  assert.deepEqual(Object.keys(validator).sort(), [
    "cancel",
    "confirm",
    "init",
    "onCancel",
    "onConfirm",
    "onInit",
    "onSearch",
    "onSelect",
    "onStatus",
    "search",
    "select",
    "status",
  ]);
});

test("a reserved search naming two towns and a travel date validates", () => {
  const result = validator.search(reservedSearchRequest());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("a search carrying no travel date is refused by the schema itself", () => {
  // Defaulting to today is the silent discard the field exists to prevent, so
  // the absence has to be a validation failure rather than a fallback.
  const request = reservedSearchRequest();
  delete (request.message.intent.fulfillment as { travel_date?: string })
    .travel_date;
  assert.equal(validator.search(request).valid, false);
});

test("a travel date that is an instant rather than a calendar date is refused", () => {
  const request = reservedSearchRequest();
  (request.message.intent.fulfillment as { travel_date: string }).travel_date =
    "2026-09-25T22:59:00+05:30";
  assert.equal(validator.search(request).valid, false);
});

test("a request from the domain next door does not validate here", () => {
  // The two domains do not accept each other's payloads, which is what keeps
  // a reserved item out of a search that claims conformance elsewhere.
  const request = reservedSearchRequest();
  (request.context as { domain: string }).domain = "SOMEBODY_ELSE:TRANSIT";
  assert.equal(validator.search(request).valid, false);

  const wrongVersion = reservedSearchRequest();
  (wrongVersion.context as { version: string }).version = "2.0.1";
  assert.equal(validator.search(wrongVersion).valid, false);
});

test("the domain and version constants are the ones the schema pins", () => {
  const request = reservedSearchRequest();
  assert.equal(request.context.domain, RESERVED_DOMAIN);
  assert.equal(request.context.version, RESERVED_VERSION);
});

test("a callback carrying neither an order nor an error is refused", () => {
  const context = {
    ...reservedSearchRequest().context,
    action: "on_select",
    bpp_id: "ksrtc.bpp.transit.localhost",
    bpp_uri: "http://ksrtc-bpp-network:6202",
  };
  assert.equal(validator.onSelect({ context }).valid, false);
  assert.equal(
    validator.onSelect({
      context,
      error: { code: "SEAT-UNAVAILABLE", message: "L2A is taken" },
    }).valid,
    true,
  );
});

test("neither domain's validator accepts the other domain's search", () => {
  // Layer D, both halves. A test that only checked one direction would pass an
  // implementation in which one tree had quietly widened to accept the other.
  const trv11 = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(trv11.search(reservedSearchRequest()).valid, false);
  assert.equal(validator.search(searchRequest("BUS")).valid, false);
});

test("the reserved schema tree does not change what the existing one accepts", () => {
  const trv11 = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(trv11.search(searchRequest("BUS")).valid, true);
  assert.equal(trv11.search(searchRequest("METRO")).valid, true);
});
