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

test("PORT is used when Heroku sets it alongside the image default", () => {
  const environment = validEnvironment();
  environment.PORT = "45678";
  assert.equal(loadConfig(environment).port, 45678);
});

test("PROVIDER_PORT is used when PORT is unset", () => {
  const environment = validEnvironment();
  delete environment.PORT;
  assert.equal(loadConfig(environment).port, 7001);
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

/* ------------------------------------------------------------------ *
 * The reserved intercity domain
 * ------------------------------------------------------------------ */

function reservedEnvironment(): NodeJS.ProcessEnv {
  return {
    ...validEnvironment(),
    RESERVED_ENABLED: "true",
    KSRTC_BPP_ID: "ksrtc.example.test",
    KSRTC_BPP_URI: "https://ksrtc-network.example.test",
    KSRTC_CALLBACK_URL: "https://ksrtc-client.example.test/on_search",
    KSRTC_CALLBACK_DELAY_MS: "0",
  };
}

test("the reserved category is off unless a deployment asks for it", () => {
  // A second domain means a second registry subscription and a second
  // gateway routing entry. A deployment that has neither must keep booting
  // exactly as it did, so the flag defaults to false and the KSRTC block is
  // not required while it is.
  const config = loadConfig(validEnvironment());
  assert.equal(config.reservedEnabled, false);
  assert.equal(config.reservedOperators, undefined);
});

test("enabling the reserved category requires its own operator identity", () => {
  const environment = reservedEnvironment();
  delete environment.KSRTC_BPP_ID;
  assert.throws(
    () => loadConfig(environment),
    /Missing required environment variable KSRTC_BPP_ID/,
  );
});

test("the third operator identity loads alongside the existing two", () => {
  const config = loadConfig(reservedEnvironment());
  assert.equal(config.reservedEnabled, true);
  assert.equal(config.reservedOperators?.ksrtc.subscriberId, "ksrtc.example.test");
  assert.equal(
    config.reservedOperators?.ksrtc.subscriberUri,
    "https://ksrtc-network.example.test",
  );
  // The two existing operators are untouched by any of this.
  assert.equal(config.operators.bmtc.subscriberId, "bmtc.example.test");
  assert.equal(config.operators.bmrcl.subscriberId, "bmrcl.example.test");
});

test("the reservation window defaults are the published ones", () => {
  const config = loadConfig(reservedEnvironment());
  // 45 is the conservative end of the operator's own published 30-to-45
  // minute closing range; 30 days is its published advance window.
  assert.equal(config.reservation.closeMinutes, 45);
  assert.equal(config.reservation.horizonDays, 30);
});

test("the occupancy seed is a fixed constant so every clone draws the same coach", () => {
  const config = loadConfig(reservedEnvironment());
  assert.equal(Number.isSafeInteger(config.reservation.occupancySeed), true);
  const overridden = loadConfig({
    ...reservedEnvironment(),
    SEAT_OCCUPANCY_SEED: "12345",
  });
  assert.equal(overridden.reservation.occupancySeed, 12_345);
});

test("a non-numeric occupancy seed fails at startup rather than at first search", () => {
  assert.throws(
    () =>
      loadConfig({ ...reservedEnvironment(), SEAT_OCCUPANCY_SEED: "lucky" }),
    /SEAT_OCCUPANCY_SEED must be/,
  );
});

test("the reserved source defaults to fixtures and refuses an unknown one", () => {
  const config = loadConfig(reservedEnvironment());
  assert.equal(config.reservedSource, "fixture");
  assert.equal(config.reservedSourceUrl, undefined);
  assert.throws(
    () => loadConfig({ ...reservedEnvironment(), RESERVED_SOURCE: "guesswork" }),
    /Unsupported RESERVED_SOURCE guesswork/,
  );
});

test("an http reserved source needs the address of the dataset it reads", () => {
  assert.throws(
    () => loadConfig({ ...reservedEnvironment(), RESERVED_SOURCE: "http" }),
    /Missing required environment variable RESERVED_SOURCE_URL/,
  );
  const config = loadConfig({
    ...reservedEnvironment(),
    RESERVED_SOURCE: "http",
    RESERVED_SOURCE_URL: "http://dataset.internal:9000/reserved",
  });
  assert.equal(config.reservedSourceUrl, "http://dataset.internal:9000/reserved");
});

test("the hold lasts ten minutes unless a deployment says otherwise", () => {
  // Twice the best-documented incumbent figure, and the departure is argued
  // rather than assumed: that five minutes covers a form and a payment, and
  // this window covers a name, an age and a gender per seat with no payment
  // step to end it early. The constant exists so revisiting the trade is one
  // line rather than a code change.
  assert.equal(loadConfig(reservedEnvironment()).reservation.holdTtlSeconds, 600);
  assert.equal(
    loadConfig({
      ...reservedEnvironment(),
      RESERVATION_HOLD_TTL_SECONDS: "300",
    }).reservation.holdTtlSeconds,
    300,
  );
  assert.throws(
    () =>
      loadConfig({ ...reservedEnvironment(), RESERVATION_HOLD_TTL_SECONDS: "5" }),
    /RESERVATION_HOLD_TTL_SECONDS must be an integer from 30/,
  );
});

test("a manifest outlives its journey by a configurable number of days", () => {
  assert.equal(
    loadConfig(reservedEnvironment()).reservation.manifestRetentionDays,
    30,
  );
  assert.equal(
    loadConfig({
      ...reservedEnvironment(),
      RESERVED_MANIFEST_RETENTION_DAYS: "7",
    }).reservation.manifestRetentionDays,
    7,
  );
});

test("held seats live in a file by default and in memory under test", () => {
  // A confirmed ticket next door is a settled fact whose loss costs nothing. A
  // held seat is a shared, finite resource, and a restart that forgot every
  // hold would release seats somebody is mid-checkout on.
  assert.match(loadConfig(reservedEnvironment()).reservedDatabaseUrl, /reserved\.db$/);
  assert.equal(
    loadConfig({ ...reservedEnvironment(), RESERVED_DB_URL: ":memory:" })
      .reservedDatabaseUrl,
    ":memory:",
  );
});
