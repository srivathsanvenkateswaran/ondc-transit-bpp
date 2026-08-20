import assert from "node:assert/strict";
import { test } from "node:test";

import { createProtocolValidator } from "../../src/protocol/validate.js";
import { searchRequest, testConfig } from "../helpers.js";

test("valid TRV11 search passes schema validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.deepEqual(validator.search(searchRequest("BUS")), {
    valid: true,
    errors: [],
  });
});

test("broad TRV11 search without vehicle category passes validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const request = structuredClone(searchRequest("BUS")) as any;
  delete request.message.intent.fulfillment.vehicle;
  assert.equal(validator.search(request).valid, true);
});

test("search without context domain fails schema validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const body = structuredClone(searchRequest("BUS")) as any;
  delete body.context.domain;
  const result = validator.search(body);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.instancePath === "/context"));
});

test("on_select domain error passes callback schema validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const config = testConfig();
  const context = {
    ...searchRequest("BUS").context,
    action: "on_select",
    bpp_id: config.operators.bmtc.subscriberId,
    bpp_uri: config.operators.bmtc.subscriberUri,
  };

  assert.deepEqual(
    validator.onSelect({
      context,
      error: {
        code: "ITEM-NOT-FOUND",
        type: "DOMAIN-ERROR",
        message: "Unknown item.id UNKNOWN",
      },
    }),
    { valid: true, errors: [] },
  );
});
