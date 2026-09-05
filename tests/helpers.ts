import type { AppConfig } from "../src/config.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://provider.example.test",
    journeySource: "fixture",
    journeySourceResponseSchema: new URL(
      "../schemas/journey-source-response.json",
      import.meta.url,
    ).pathname,
    fixtureRoot: new URL("../fixtures", import.meta.url).pathname,
    schemaRoot: new URL("../schemas/ondc_trv11/2.0.1", import.meta.url).pathname,
    reservedEnabled: false,
    reservedSchemaRoot: new URL(
      "../schemas/transit_local_intercity/0.1.0",
      import.meta.url,
    ).pathname,
    reservation: { closeMinutes: 45, horizonDays: 30, occupancySeed: 20_260_905 },
    callbackTimeoutMs: 1000,
    contextTtl: "PT30S",
    orderInspectionToken: "test-inspection-token",
    operators: {
      bmtc: {
        key: "bmtc",
        subscriberId: "bmtc.provider.example.test",
        subscriberUri: "https://bmtc-network.example.test",
        callbackUrl: "https://bmtc-client.example.test/on_search",
        callbackDelayMs: 0,
      },
      bmrcl: {
        key: "bmrcl",
        subscriberId: "bmrcl.provider.example.test",
        subscriberUri: "https://bmrcl-network.example.test",
        callbackUrl: "https://bmrcl-client.example.test/on_search",
        callbackDelayMs: 0,
      },
    },
    ...overrides,
  };
}

export function searchRequest(category: "BUS" | "METRO") {
  return {
    context: {
      domain: "ONDC:TRV11",
      location: { country: { code: "IND" }, city: { code: "std:080" } },
      action: "search",
      version: "2.0.1",
      bap_id: "bap.example.test",
      bap_uri: "https://bap.example.test",
      transaction_id: "acf5aff7-3dde-4f31-8698-4cf6c18f1537",
      message_id: "70068ed7-cf0d-4555-a7a9-55510ba870ac",
      timestamp: "2026-08-20T04:05:35.000Z",
      ttl: "PT4S",
    },
    message: {
      intent: {
        fulfillment: {
          stops: [
            { type: "START", location: { gps: "12.9784, 77.6408" } },
            { type: "END", location: { gps: "12.9774, 77.5726" } },
          ],
          vehicle: { category },
        },
      },
    },
  } as const;
}

/**
 * A pass search: a category and no `fulfillment` block at all. A pass has
 * neither an origin nor a destination, so a stop pair cannot express the
 * question.
 */
export function passSearchRequest() {
  return {
    context: {
      domain: "ONDC:TRV11",
      location: { country: { code: "IND" }, city: { code: "std:080" } },
      action: "search",
      version: "2.0.1",
      bap_id: "bap.example.test",
      bap_uri: "https://bap.example.test",
      transaction_id: "6c0a9d5e-0f4f-4f9b-9c3a-7d1b5f8e2a44",
      message_id: "2f6b1a0c-8d4e-4a1b-9f77-3c2d5e6a8b90",
      timestamp: "2026-09-03T04:05:35.000Z",
      ttl: "PT4S",
    },
    message: {
      intent: { category: { descriptor: { code: "PASS" } } },
    },
  } as const;
}

/**
 * A reserved intercity search: a category, two towns and a travel date.
 *
 * The endpoints name towns rather than boarding points, because a rider
 * searching one town to another has not chosen a pickup yet - the
 * boarding-point choice is a consequence of the service they pick. The travel
 * date is a bare calendar date in `Asia/Kolkata` and is mandatory.
 */
export function reservedSearchRequest(
  overrides: {
    fromTownCode?: string;
    toTownCode?: string;
    travelDate?: string;
    serviceClass?: string;
  } = {},
) {
  const request = {
    context: {
      domain: "TRANSIT.LOCALHOST:INTERCITY",
      location: { country: { code: "IND" }, city: { code: "std:080" } },
      action: "search",
      version: "0.1.0",
      bap_id: "bap.example.test",
      bap_uri: "https://bap.example.test",
      transaction_id: "0b0e1f6a-5c47-4d19-9a2f-3c8b1d6e7f01",
      message_id: "7d3f2c81-4a6b-4f0e-8c15-2b9d7e4a6c33",
      timestamp: "2026-09-05T09:14:02.000Z",
      ttl: "PT15S",
    },
    message: {
      intent: {
        category: { descriptor: { code: "RESERVED" } },
        fulfillment: {
          stops: [
            {
              type: "START",
              location: {
                descriptor: { code: overrides.fromTownCode ?? "BLR" },
              },
            },
            {
              type: "END",
              location: { descriptor: { code: overrides.toTownCode ?? "HMP" } },
            },
          ],
          travel_date: overrides.travelDate ?? "2026-09-25",
          vehicle: { category: "COACH" },
        },
        ...(overrides.serviceClass
          ? { item: { descriptor: { code: overrides.serviceClass } } }
          : {}),
      },
    },
  };
  return request as typeof request & {
    context: Record<string, unknown>;
    message: { intent: { fulfillment: Record<string, unknown> } };
  };
}
