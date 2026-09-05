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
    reservedDatabaseUrl: ":memory:",
    reservedSource: "fixture",
    reservedSourceResponseSchema: new URL(
      "../schemas/reserved-source-response.json",
      import.meta.url,
    ).pathname,
    reservedMigrationRoot: new URL("../migrations/reserved", import.meta.url)
      .pathname,
    fleetManifestTtlSeconds: 3600,
    reservation: {
      closeMinutes: 45,
      horizonDays: 30,
      occupancySeed: 20_260_905,
      holdTtlSeconds: 600,
      manifestRetentionDays: 30,
    },
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

/**
 * The context every reserved action after `search` carries.
 *
 * `bpp_id` and `bpp_uri` are required from `select` onward, because an action
 * against an order names the seller it is addressed to, and a request that
 * names somebody else is answered by nobody.
 */
export function reservedContext(
  action: string,
  overrides: { transactionId?: string; bapId?: string; bapUri?: string } = {},
) {
  return {
    domain: "TRANSIT.LOCALHOST:INTERCITY",
    location: { country: { code: "IND" }, city: { code: "std:080" } },
    action,
    version: "0.1.0",
    bap_id: overrides.bapId ?? "bap.example.test",
    bap_uri: overrides.bapUri ?? "https://bap.example.test",
    bpp_id: "ksrtc.provider.example.test",
    bpp_uri: "https://ksrtc-network.example.test",
    transaction_id: overrides.transactionId ?? "0b0e1f6a-5c47-4d19-9a2f-3c8b1d6e7f01",
    message_id: "7d3f2c81-4a6b-4f0e-8c15-2b9d7e4a6c33",
    timestamp: "2026-09-20T10:00:00.000Z",
    ttl: "PT15S",
  };
}

export interface ReservedOrderRequestOptions {
  itemId: string;
  seatIds?: string[];
  count?: number;
  fromBoardingPointId?: string;
  toBoardingPointId?: string;
  transactionId?: string;
  bapId?: string;
  manifest?: Array<{
    seatId: string;
    name: string;
    age?: number;
    gender?: string;
    extra?: Array<{ code: string; value: string }>;
  }>;
  concession?: string;
  paymentStatus?: "NOT_PAID" | "PAID";
}

function manifestEntries(options: ReservedOrderRequestOptions) {
  return (options.manifest ?? []).flatMap((passenger) => [
    { descriptor: { code: "SEAT_ID" }, value: passenger.seatId },
    { descriptor: { code: "NAME" }, value: passenger.name },
    ...(passenger.age === undefined
      ? []
      : [{ descriptor: { code: "AGE" }, value: String(passenger.age) }]),
    ...(passenger.gender === undefined
      ? []
      : [{ descriptor: { code: "GENDER" }, value: passenger.gender }]),
    ...(passenger.extra ?? []).map((entry) => ({
      descriptor: { code: entry.code },
      value: entry.value,
    })),
  ]);
}

export function reservedOrderRequest(
  action: "select" | "init" | "confirm",
  options: ReservedOrderRequestOptions,
) {
  const seatIds = options.seatIds ?? [];
  const paid = options.paymentStatus ?? (action === "confirm" ? "PAID" : "NOT_PAID");
  return {
    context: reservedContext(action, {
      ...(options.transactionId ? { transactionId: options.transactionId } : {}),
      ...(options.bapId ? { bapId: options.bapId } : {}),
    }),
    message: {
      order: {
        provider: { id: "P1" },
        items: [
          {
            id: options.itemId,
            quantity: {
              selected: { count: options.count ?? Math.max(seatIds.length, 1) },
            },
          },
        ],
        fulfillments: [
          {
            id: `F-${options.itemId}`,
            stops: [
              {
                type: "START",
                location: {
                  descriptor: {
                    code: options.fromBoardingPointId ?? "BP-BLR-MAJESTIC",
                  },
                },
              },
              {
                type: "END",
                location: {
                  descriptor: {
                    code: options.toBoardingPointId ?? "BP-HMP-HAMPI",
                  },
                },
              },
            ],
          },
        ],
        ...(action === "select"
          ? {}
          : {
              billing: { name: "A Booker", phone: "+919999999999" },
              payments: [
                { collected_by: "BPP", status: paid, type: "PRE_ORDER" },
              ],
            }),
        tags: [
          ...(seatIds.length > 0
            ? [
                {
                  descriptor: { code: "SEATS" },
                  list: seatIds.map((seatId) => ({
                    descriptor: { code: "SEAT_ID" },
                    value: seatId,
                  })),
                },
              ]
            : []),
          ...(options.manifest
            ? [
                {
                  descriptor: { code: "MANIFEST" },
                  display: false,
                  list: manifestEntries(options),
                },
              ]
            : []),
          ...(options.concession
            ? [
                {
                  descriptor: { code: "CONCESSION" },
                  list: [
                    { descriptor: { code: "CLASS" }, value: options.concession },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  };
}

export function reservedCancelRequest(options: {
  orderId: string;
  code: "SOFT_CANCEL" | "CONFIRM_CANCEL";
  seatIds?: string[];
  quoteId?: string;
  transactionId?: string;
  bapId?: string;
}) {
  return {
    context: reservedContext("cancel", {
      ...(options.transactionId ? { transactionId: options.transactionId } : {}),
      ...(options.bapId ? { bapId: options.bapId } : {}),
    }),
    message: {
      order_id: options.orderId,
      descriptor: { code: options.code },
      tags: [
        ...(options.seatIds
          ? [
              {
                descriptor: { code: "SEATS" },
                list: options.seatIds.map((seatId) => ({
                  descriptor: { code: "SEAT_ID" },
                  value: seatId,
                })),
              },
            ]
          : []),
        ...(options.quoteId
          ? [
              {
                descriptor: { code: "REFUND_SLAB" },
                list: [
                  {
                    descriptor: { code: "REFUND_QUOTE_ID" },
                    value: options.quoteId,
                  },
                ],
              },
            ]
          : []),
      ],
    },
  };
}

export function reservedStatusRequest(options: {
  orderId?: string;
  refId?: string;
  bapId?: string;
}) {
  return {
    context: reservedContext("status", {
      ...(options.bapId ? { bapId: options.bapId } : {}),
    }),
    message: {
      ...(options.orderId ? { order_id: options.orderId } : {}),
      ...(options.refId ? { ref_id: options.refId } : {}),
    },
  };
}
