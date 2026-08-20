import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpJourneySource } from "../../src/sources/http.js";
import type {
  JourneySource,
  OperatorProfile,
  SearchQuery,
  TransitOffer,
} from "../../src/sources/types.js";

const responseSchemaPath = new URL(
  "../../schemas/journey-source-response.json",
  import.meta.url,
).pathname;

const operator: OperatorProfile = {
  id: "P1",
  name: "Test Bus Operator",
  vehicleCategory: "BUS",
  serviceWindow: { startHHMM: "05:00", endHHMM: "23:00" },
};

const plannerOffer: TransitOffer = {
  offerId: "planner-500d",
  productCode: "SJT",
  productName: "Single Journey Ticket",
  farePaise: 1_350,
  validity: "PT90M",
  routeId: "500D",
  routeName: "Test Route",
  route: [
    { code: "FROM", name: "From", lat: 12.97, lon: 77.64 },
    { code: "TO", name: "To", lat: 12.98, lon: 77.59 },
  ],
};

function fallbackSource() {
  let calls = 0;
  const fallbackOffer: TransitOffer = {
    ...plannerOffer,
    offerId: "fixture-fallback",
    farePaise: 2_700,
  };
  const source: JourneySource = {
    operator,
    async search() {
      calls += 1;
      return [fallbackOffer];
    },
  };
  return { source, calls: () => calls, fallbackOffer };
}

const query: SearchQuery = {
  fromCode: "FROM",
  toCode: "TO",
  fromGps: { lat: 12.97, lon: 77.64 },
  toGps: { lat: 12.98, lon: 77.59 },
  departAt: "2026-08-27T09:00:00.000Z",
  cityCode: "std:080",
};

test("http source sends the published request and returns planner paise", async () => {
  const fallback = fallbackSource();
  let requestBody: unknown;
  const fetchImpl = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ offers: [plannerOffer] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const source = new HttpJourneySource({
    operatorKey: "bmtc",
    url: "https://planner.example.test/api/ondc/offers",
    fallback: fallback.source,
    responseSchemaPath,
    fetchImpl,
  });

  const offers = await source.search(query);

  assert.deepEqual(requestBody, {
    operator: "bmtc",
    from: { code: "FROM", lat: 12.97, lon: 77.64 },
    to: { code: "TO", lat: 12.98, lon: 77.59 },
    departAt: "2026-08-27T09:00:00.000Z",
  });
  assert.equal(offers[0].farePaise, 1_350);
  assert.equal(fallback.calls(), 0);
});

test("http source falls back to fixtures and logs a planner error", async () => {
  const fallback = fallbackSource();
  const events: Record<string, unknown>[] = [];
  const fetchImpl = (async () =>
    new Response("planner unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    })) as typeof fetch;
  const source = new HttpJourneySource({
    operatorKey: "bmtc",
    url: "https://planner.example.test/api/ondc/offers",
    fallback: fallback.source,
    responseSchemaPath,
    fetchImpl,
    eventLogger: (event) => events.push(event),
  });

  const offers = await source.search(query);

  assert.equal(offers[0].offerId, fallback.fallbackOffer.offerId);
  assert.equal(fallback.calls(), 1);
  assert.deepEqual(events[0], {
    action: "journey_source",
    operator: "bmtc",
    source: "http",
    fallback_source: "fixture",
    outcome: "FALLBACK",
    reason: "HTTP journey source returned 503 Service Unavailable",
  });
});

test("http source rejects non-integer planner fares before fallback", async () => {
  const fallback = fallbackSource();
  const events: Record<string, unknown>[] = [];
  const invalidOffer = { ...plannerOffer, farePaise: 13.5 };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ offers: [invalidOffer] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const source = new HttpJourneySource({
    operatorKey: "bmtc",
    url: "https://planner.example.test/api/ondc/offers",
    fallback: fallback.source,
    responseSchemaPath,
    fetchImpl,
    eventLogger: (event) => events.push(event),
  });

  const offers = await source.search(query);

  assert.equal(offers[0].offerId, fallback.fallbackOffer.offerId);
  assert.match(String(events[0].reason), /must be integer/);
});

test("http source times out after its deadline and falls back", async () => {
  const fallback = fallbackSource();
  const fetchImpl = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    })) as typeof fetch;
  const source = new HttpJourneySource({
    operatorKey: "bmtc",
    url: "https://planner.example.test/api/ondc/offers",
    fallback: fallback.source,
    responseSchemaPath,
    timeoutMs: 5,
    fetchImpl,
  });

  const offers = await source.search(query);

  assert.equal(offers[0].offerId, fallback.fallbackOffer.offerId);
  assert.equal(fallback.calls(), 1);
});
