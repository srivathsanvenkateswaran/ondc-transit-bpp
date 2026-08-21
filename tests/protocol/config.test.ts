import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../../src/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    PROVIDER_HOST: "0.0.0.0",
    PROVIDER_PORT: "7001",
    PROVIDER_PUBLIC_BASE_URL: "https://provider.example.test",
    CALLBACK_TIMEOUT_MS: "3000",
    CONTEXT_TTL: "PT30S",
    BMTC_BPP_ID: "bmtc.example.test",
    BMTC_BPP_URI: "https://bmtc-network.example.test",
    BMTC_CALLBACK_URL: "https://bmtc-client.example.test/on_search",
    BMTC_CALLBACK_DELAY_MS: "0",
    BMRCL_BPP_ID: "bmrcl.example.test",
    BMRCL_BPP_URI: "https://bmrcl-network.example.test",
    BMRCL_CALLBACK_URL: "https://bmrcl-client.example.test/on_search",
    BMRCL_CALLBACK_DELAY_MS: "0",
  };
}

test("deployment configuration is loaded from environment values", () => {
  const config = loadConfig(validEnvironment());
  assert.equal(config.port, 7001);
  assert.equal(config.publicBaseUrl, "https://provider.example.test");
  assert.equal(config.journeySource, "fixture");
  assert.equal(config.operators.bmtc.subscriberId, "bmtc.example.test");
  assert.equal(
    config.operators.bmrcl.callbackUrl,
    "https://bmrcl-client.example.test/on_search",
  );
});

test("unsupported journey source fails at startup", () => {
  const environment = validEnvironment();
  environment.JOURNEY_SOURCE = "tatak";
  assert.throws(() => loadConfig(environment), /Unsupported JOURNEY_SOURCE tatak/);
});

test("http journey source requires and loads its planner URL", () => {
  const environment = validEnvironment();
  environment.JOURNEY_SOURCE = "http";
  assert.throws(
    () => loadConfig(environment),
    /Missing required environment variable JOURNEY_SOURCE_URL/,
  );

  environment.JOURNEY_SOURCE_URL =
    "http://host.docker.internal:3000/api/ondc/offers";
  const config = loadConfig(environment);
  assert.equal(config.journeySource, "http");
  assert.equal(config.journeySourceUrl, environment.JOURNEY_SOURCE_URL);
});

test("invalid port fails at startup", () => {
  const environment = validEnvironment();
  environment.PROVIDER_PORT = "not-a-port";
  assert.throws(() => loadConfig(environment), /PROVIDER_PORT must be/);
});

test("invalid callback configuration fails at startup", () => {
  const invalidUrl = validEnvironment();
  invalidUrl.BMTC_CALLBACK_URL = "not-a-url";
  assert.throws(
    () => loadConfig(invalidUrl),
    /BMTC_CALLBACK_URL must be a valid absolute URL/,
  );

  const zeroTimeout = validEnvironment();
  zeroTimeout.CALLBACK_TIMEOUT_MS = "0";
  assert.throws(
    () => loadConfig(zeroTimeout),
    /CALLBACK_TIMEOUT_MS must be an integer from 1/,
  );
});

test("order inspection remains disabled when its token is empty", () => {
  const environment = validEnvironment();
  environment.ORDER_INSPECTION_TOKEN = "  ";
  assert.equal(loadConfig(environment).orderInspectionToken, undefined);

  environment.ORDER_INSPECTION_TOKEN = "inspection-secret";
  assert.equal(
    loadConfig(environment).orderInspectionToken,
    "inspection-secret",
  );
});
