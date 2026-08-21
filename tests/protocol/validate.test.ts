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

test("search with a malformed timestamp fails schema validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const body = structuredClone(searchRequest("BUS")) as any;
  body.context.timestamp = "not-a-timestamp";
  const result = validator.search(body);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.instancePath === "/context/timestamp",
    ),
  );
});

test("domain errors pass every order callback schema", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const config = testConfig();
  const baseContext = {
    ...searchRequest("BUS").context,
    bpp_id: config.operators.bmtc.subscriberId,
    bpp_uri: config.operators.bmtc.subscriberUri,
  };
  const callbacks = [
    ["on_select", validator.onSelect],
    ["on_init", validator.onInit],
    ["on_confirm", validator.onConfirm],
    ["on_status", validator.onStatus],
  ] as const;

  callbacks.forEach(([action, validate]) => {
    assert.deepEqual(
      validate({
        context: { ...baseContext, action },
        message: {},
        error: {
          code: "ITEM-NOT-FOUND",
          message: "Unknown item.id UNKNOWN",
        },
      }),
      { valid: true, errors: [] },
    );
  });
});

test("empty order callback without an error fails validation", () => {
  const validator = createProtocolValidator(testConfig().schemaRoot);
  const config = testConfig();
  const context = {
    ...searchRequest("BUS").context,
    action: "on_status",
    bpp_id: config.operators.bmtc.subscriberId,
    bpp_uri: config.operators.bmtc.subscriberUri,
  };

  assert.equal(validator.onStatus({ context, message: {} }).valid, false);
});
