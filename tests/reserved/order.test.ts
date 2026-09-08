import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { istIsoInstant } from "../../src/reserved/calendar.js";
import { reservedSearchQuery } from "../../src/reserved/catalog.js";
import { openReservedDatabase } from "../../src/reserved/db.js";
import { reservedItemId } from "../../src/reserved/domain.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { manifestTag, parseManifest } from "../../src/reserved/manifest.js";
import { seededOccupancy } from "../../src/reserved/occupancy.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { availableSeatCount } from "../../src/reserved/seatstate.js";
import { ReservedStore } from "../../src/reserved/store.js";
import type { ReservedService } from "../../src/reserved/types.js";
import {
  reservedOrderRequest,
  reservedSearchRequest,
  reservedStatusRequest,
} from "../helpers.js";

/**
 * The order flow, driven against the service rather than over http.
 *
 * The clock is injected, so a hold that expires between a select and a confirm
 * is a two-line test rather than a ten-minute wait, and the seeded seat map
 * makes every one of these runs answer the same way on any machine.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

const TRAVEL_DATE = "2026-09-30";
const ITEM = `RSV-2259BNGHMP-${TRAVEL_DATE}-PALLAKKI`;
/** Ten days before a 22:59 departure: inside the horizon, well before close. */
const NOW = Date.parse("2026-09-20T10:00:00.000Z");
const HOLD_TTL_SECONDS = 600;

interface Harness {
  orders: ReservedOrderService;
  store: ReservedStore;
  clock: { at: number };
}

function harness(): Harness {
  const clock = { at: NOW };
  let counter = 0;
  // Distinct in its first eight characters, because that is the slice a
  // rider-facing reference is cut from.
  const idFactory = () => `${String((counter += 1)).padStart(8, "0")}-fixed`;
  const store = new ReservedStore(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
    { idFactory },
  );
  const orders = new ReservedOrderService(
    "ksrtc",
    source,
    {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
    },
    store,
    {
      publicBaseUrl: "https://provider.example.test",
      reservation: {
        closeMinutes: 45,
        horizonDays: 30,
        occupancySeed: 20_260_905,
        holdTtlSeconds: HOLD_TTL_SECONDS,
        manifestRetentionDays: 30,
      },
      now: () => new Date(clock.at),
      idFactory,
    },
  );
  return { orders, store, clock };
}

async function refusalFrom(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof ReservedLifecycleError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

function tagOf(tags: unknown, code: string) {
  return (tags as Array<{ descriptor: { code: string }; list: Array<{ descriptor: { code: string }; value: string }> }>).find(
    (tag) => tag.descriptor.code === code,
  );
}

function entryOf(tags: unknown, groupCode: string, entryCode: string) {
  return tagOf(tags, groupCode)?.list.find(
    (entry) => entry.descriptor.code === entryCode,
  )?.value;
}

function orderOf(message: Record<string, unknown>) {
  return message.order as Record<string, unknown>;
}

function twoPassengers() {
  return [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
  ];
}

/* ------------------------------------------------------------------ *
 * search
 * ------------------------------------------------------------------ */

test("a search answers with dated items and a quiet seats-remaining count", async () => {
  const { orders } = harness();
  const message = await orders.search(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  const provider = (message.catalog as any).providers[0];
  assert.equal(provider.items.length, 1);
  const [item] = provider.items;
  assert.equal(item.id, ITEM);
  // Ten free berths on this dated departure, published as an integer and
  // nothing else: no flag, no threshold, no percentage.
  assert.equal(item.quantity.available.count, 10);
  assert.deepEqual(Object.keys(item.quantity).sort(), [
    "available",
    "maximum",
    "minimum",
  ]);
  assert.equal(item.time.timestamp, "2026-09-30T22:59:00.000+05:30");
});

test("the catalogue price names the pair it was computed for", async () => {
  // Without the basis, a buyer app cannot tell an internal inconsistency from
  // an ordinary consequence of the fare key, and a check that fired on every
  // rider boarding somewhere other than the terminus would train riders to
  // ignore a real alarm.
  const { orders } = harness();
  const message = await orders.search(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  const [item] = (message.catalog as any).providers[0].items;
  assert.equal(item.price.value, "550");
  assert.equal(
    entryOf(item.tags, "PRICED_FOR", "FROM_BOARDING_POINT_ID"),
    "BP-BLR-MAJESTIC",
  );
  assert.equal(
    entryOf(item.tags, "PRICED_FOR", "TO_BOARDING_POINT_ID"),
    "BP-HMP-HAMPI",
  );

  // A quote for that exact pair equals the catalogue price to the paise.
  const select = await orders.select(
    reservedOrderRequest("select", { itemId: ITEM }) as never,
  );
  assert.equal((orderOf(select).items as any)[0].price.value, "550");

  // A quote for any other pair is expected to differ and is not compared.
  const elsewhere = await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      fromBoardingPointId: "BP-BLR-ELECTRONIC-CITY",
      toBoardingPointId: "BP-HPT-HOSAPETE",
    }) as never,
  );
  assert.equal((orderOf(elsewhere).items as any)[0].price.value, "490");
});

test("a rider asking about a date the coach does not run is told nothing runs", async () => {
  // No nearest-date fallback and no roll-forward: a rider asking about the
  // Saturday must not be sold the Sunday.
  const { orders } = harness();
  const message = await orders.search(
    reservedSearchRequest({
      fromTownCode: "BLR",
      toTownCode: "MAA",
      travelDate: "2026-09-26",
    }) as never,
  );
  assert.deepEqual((message.catalog as any).providers[0].items, []);
});

test("a search with no travel date is refused rather than answered for today", async () => {
  const { orders } = harness();
  const request = reservedSearchRequest({ travelDate: TRAVEL_DATE }) as any;
  delete request.message.intent.fulfillment.travel_date;
  const refusal = await refusalFrom(() => orders.search(request));
  assert.equal(refusal.code, "TRAVEL-DATE-REQUIRED");
});

test("a departure past its closing window is not published at all", async () => {
  const { orders, clock } = harness();
  // Thirty minutes before a 22:59 departure, inside the 45-minute close.
  clock.at = Date.parse("2026-09-30T16:59:00.000Z");
  const message = await orders.search(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  assert.deepEqual((message.catalog as any).providers[0].items, []);
});

/* ------------------------------------------------------------------ *
 * search: batched availability
 *
 * `snapshot` used to run per service inside the search loop, and each call
 * made two database round trips - sweep this service's expired holds, then
 * read its live claims. A corridor with dozens of running services paid for
 * dozens of round trips before it could answer at all, which is what made
 * Bengaluru to Mangaluru (82 services), Hassan (115) and Kunigal (114)
 * unanswerable in production. The tests below pin the fix: one search now
 * costs the same handful of round trips no matter how many services it
 * answers for, and answers with exactly the same items and the same
 * available counts a per-service read would have produced.
 * ------------------------------------------------------------------ */

/**
 * Wraps a real `ReservedDatabase` and counts every statement invocation
 * (`run`, `get`, `all`) as one round trip - the same call shape `db.ts`
 * documents as identical between a local file and a remote Turso connection,
 * so counting invocations here stands in for counting network hops there.
 */
function countingDatabase(inner: import("../../src/reserved/db.js").ReservedDatabase) {
  let roundTrips = 0;
  const database: import("../../src/reserved/db.js").ReservedDatabase = {
    prepare(sql: string) {
      const statement = inner.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.run(...params);
        },
        get: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.get(...params);
        },
        all: (...params: unknown[]) => {
          roundTrips += 1;
          return statement.all(...params);
        },
      };
    },
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
  };
  return { database, roundTrips: () => roundTrips };
}

function harnessWithCountingStore() {
  const clock = { at: NOW };
  const { database, roundTrips } = countingDatabase(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
  );
  const store = new ReservedStore(database);
  const orders = new ReservedOrderService(
    "ksrtc",
    source,
    {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
    },
    store,
    {
      publicBaseUrl: "https://provider.example.test",
      reservation: {
        closeMinutes: 45,
        horizonDays: 30,
        occupancySeed: 20_260_905,
        holdTtlSeconds: HOLD_TTL_SECONDS,
        manifestRetentionDays: 30,
      },
      now: () => new Date(clock.at),
    },
  );
  return { orders, store, clock, roundTrips };
}

test("a search costs the same handful of database round trips whether it answers one service or eighty-two", async () => {
  const one = harnessWithCountingStore();
  const oneServiceMessage = await one.orders.search(
    // The default route (BLR to HMP, Hampi) runs exactly one service on this
    // date - see "a search answers with dated items and a quiet
    // seats-remaining count" above.
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  assert.equal(
    (oneServiceMessage.catalog as any).providers[0].items.length,
    1,
  );
  const oneServiceRoundTrips = one.roundTrips();

  const many = harnessWithCountingStore();
  const manyServiceMessage = await many.orders.search(
    // Bengaluru to Mangaluru: 82 running services on this date, the corridor
    // named in the production measurement this fix responds to.
    reservedSearchRequest({
      fromTownCode: "BLR",
      toTownCode: "MNG",
      travelDate: TRAVEL_DATE,
    }) as never,
  );
  assert.equal(
    (manyServiceMessage.catalog as any).providers[0].items.length,
    82,
  );
  const manyServiceRoundTrips = many.roundTrips();

  // The number of round trips a search costs must not depend on how many
  // services it answers for. Before this fix each additional service added
  // two round trips (a sweep and a claims read); now the sweep and the read
  // are each one query for the whole search, so eighty-two services cost the
  // same as one.
  assert.equal(manyServiceRoundTrips, oneServiceRoundTrips);
  // Pinned to a concrete, small number so a future change that reintroduces
  // even a single per-service call is caught rather than silently
  // tolerated by the equality check above alone.
  assert.ok(
    manyServiceRoundTrips <= 3,
    `expected at most 3 round trips for a search with services, got ${manyServiceRoundTrips}`,
  );
});

test("search publishes the same items and available counts a per-service read would, and still skips a closed window and an unpriced pair", async () => {
  const query = reservedSearchQuery(
    reservedSearchRequest({
      fromTownCode: "BLR",
      toTownCode: "MNG",
      travelDate: TRAVEL_DATE,
    }) as never,
  );
  const realServices = await source.services(query);
  const [realA, realB, realC, cloneBase1, cloneBase2] = realServices;
  assert.ok(realA && realB && realC && cloneBase1 && cloneBase2);

  // A service whose departure has already closed for booking: cloned from a
  // real running service so its seat map and fare table are otherwise
  // ordinary, with only its identity and departure time changed.
  const closedService: ReservedService = {
    ...structuredClone(cloneBase1),
    serviceId: "TEST-CLOSED-WINDOW",
    departureMinute: 0,
  };
  // A service whose headline boarding pair this provider does not price:
  // same shape as a real service, but pointed at a fare table with nothing
  // in it, which is what "no cell matches the headline pair" looks like
  // regardless of what that pair actually is.
  const unpricedService: ReservedService = {
    ...structuredClone(cloneBase2),
    serviceId: "TEST-NO-HEADLINE-FARE",
    fareTableId: "TEST-FARETABLE-EMPTY",
  };

  const spySource: import("../../src/reserved/types.js").ReservedServiceSource = {
    operator: source.operator,
    services: async () => [
      realA,
      realB,
      realC,
      closedService,
      unpricedService,
    ],
    service: (serviceId: string) => source.service(serviceId),
    seatMap: (seatMapId: string) => source.seatMap(seatMapId),
    fareTable: async (fareTableId: string) =>
      fareTableId === "TEST-FARETABLE-EMPTY"
        ? { fareTableId, currency: "INR" as const, fares: [] }
        : source.fareTable(fareTableId),
  };

  const clock = { at: NOW };
  const store = new ReservedStore(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
  );
  const orders = new ReservedOrderService(
    "ksrtc",
    spySource,
    {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
    },
    store,
    {
      publicBaseUrl: "https://provider.example.test",
      reservation: {
        closeMinutes: 45,
        horizonDays: 30,
        occupancySeed: 20_260_905,
        holdTtlSeconds: HOLD_TTL_SECONDS,
        manifestRetentionDays: 30,
      },
      now: () => new Date(clock.at),
    },
  );

  // At this instant `closedService`'s midnight departure is thirty minutes
  // in the past - past the 45-minute close - while every real BLR-MNG
  // service (earliest departure 06:05) is still hours away and open.
  clock.at = Date.parse("2026-09-29T19:00:00.000Z");

  // Hold a seat on realA and a different seat on realC before searching, so
  // the test can catch a claim read up under the wrong service id - a bug
  // batching is exactly positioned to introduce.
  const seatMapA = await source.seatMap(realA.seatMapId);
  const seatMapC = await source.seatMap(realC.seatMapId);
  const heldSeatA = seatMapA!.seats[0].seatId;
  // Deliberately a different seat position from `heldSeatA`, not just a
  // different service: two seat maps can both label their first seat "1A",
  // and the point of this pair of holds is to prove a claim never crosses
  // service boundaries, not merely that two distinct id strings exist.
  const heldSeatC = seatMapC!.seats[1].seatId;
  assert.notEqual(
    heldSeatA,
    heldSeatC,
    "the test needs two distinct seat id strings to prove claims aren't mixed up by id alone",
  );
  store.acquireHold({
    operator: "ksrtc",
    identity: {
      bapId: "bap.example.test",
      bapUri: "https://bap.example.test",
      transactionId: "batching-test-a",
    },
    serviceId: realA.serviceId,
    travelDate: TRAVEL_DATE,
    seatIds: [heldSeatA],
    nowMs: clock.at,
    ttlSeconds: HOLD_TTL_SECONDS,
  });
  store.acquireHold({
    operator: "ksrtc",
    identity: {
      bapId: "bap.example.test",
      bapUri: "https://bap.example.test",
      transactionId: "batching-test-c",
    },
    serviceId: realC.serviceId,
    travelDate: TRAVEL_DATE,
    seatIds: [heldSeatC],
    nowMs: clock.at,
    ttlSeconds: HOLD_TTL_SECONDS,
  });

  const message = await orders.search(
    reservedSearchRequest({
      fromTownCode: "BLR",
      toTownCode: "MNG",
      travelDate: TRAVEL_DATE,
    }) as never,
  );
  const items = (message.catalog as any).providers[0].items as Array<{
    id: string;
    quantity: { available: { count: number } };
  }>;
  const itemIds = items.map((item) => item.id);

  assert.ok(
    !itemIds.includes(
      reservedItemId(
        closedService.serviceId,
        TRAVEL_DATE,
        closedService.serviceClass,
      ),
    ),
    "a service outside the booking window must not be published",
  );
  assert.ok(
    !itemIds.includes(
      reservedItemId(
        unpricedService.serviceId,
        TRAVEL_DATE,
        unpricedService.serviceClass,
      ),
    ),
    "a service with no published fare for its headline pair must not be published",
  );
  assert.equal(items.length, 3);

  for (const service of [realA, realB, realC]) {
    const itemId = reservedItemId(
      service.serviceId,
      TRAVEL_DATE,
      service.serviceClass,
    );
    const item = items.find((candidate) => candidate.id === itemId);
    assert.ok(item, `expected ${itemId} to be published`);

    // The independently-read ground truth: sweep and read this one
    // service's claims directly, the way the pre-batching code did it, and
    // recompute availability the same way `snapshot` does.
    const seatMap = await source.seatMap(service.seatMapId);
    const claims = store.liveClaims(service.serviceId, TRAVEL_DATE);
    const seeded = seededOccupancy(service, seatMap!, TRAVEL_DATE, 20_260_905);
    const expectedAvailable = availableSeatCount({
      map: seatMap!,
      seededSold: seeded,
      claims,
    });
    assert.equal(item!.quantity.available.count, expectedAvailable);
  }

  // The two holds actually landed on the services they were taken against,
  // not on each other - the failure mode a service-id mixup in the batched
  // claims read would produce.
  assert.ok(
    store
      .liveClaims(realA.serviceId, TRAVEL_DATE)
      .some((claim) => claim.seatId === heldSeatA),
  );
  assert.ok(
    !store
      .liveClaims(realC.serviceId, TRAVEL_DATE)
      .some((claim) => claim.seatId === heldSeatA),
  );
  assert.ok(
    store
      .liveClaims(realC.serviceId, TRAVEL_DATE)
      .some((claim) => claim.seatId === heldSeatC),
  );
});

/* ------------------------------------------------------------------ *
 * select
 * ------------------------------------------------------------------ */

test("browsing a seat map takes no hold", async () => {
  // Select is the one action a client may legitimately call repeatedly, and
  // browsing must not lock inventory.
  const { orders, store } = harness();
  const message = await orders.select(
    reservedOrderRequest("select", { itemId: ITEM }) as never,
  );
  const order = orderOf(message);
  assert.equal(tagOf(order.tags, "HOLD_INFO"), undefined);
  const seatMap = tagOf(order.tags, "SEAT_MAP")!;
  assert.equal(seatMap.list[0].value, "PALLAKKI-2P1-30");
  assert.equal(seatMap.list.length, 31);
  assert.deepEqual(store.liveClaims("2259BNGHMP", TRAVEL_DATE), []);
});

test("naming seats takes a hold and publishes its absolute expiry", async () => {
  const { orders } = harness();
  const message = await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
    }) as never,
  );
  const order = orderOf(message);
  // `+05:30`, like every other instant this category publishes inside a
  // message. It read `Z` while the stop times beside it read `+05:30`, on one
  // payload, against this category's own stated rule.
  assert.equal(
    entryOf(order.tags, "HOLD_INFO", "EXPIRES_AT"),
    istIsoInstant(NOW + HOLD_TTL_SECONDS * 1000),
  );
  assert.equal(entryOf(order.tags, "HOLD_INFO", "TTL_SECONDS"), "600");
  // The rider's own hold reads differently from a stranger's, so a client can
  // tell the two apart without inference.
  const seatMap = tagOf(order.tags, "SEAT_MAP")!;
  assert.equal(
    seatMap.list.find((item) => item.descriptor.code === "U3A")?.value,
    "HELD_BY_YOU",
  );
  // Two berths, the fare twice, plus the fee and the toll twice each.
  assert.equal((order.quote as any).price.value, "1180");
});

test("a seat count that disagrees with the seat list is refused, and neither wins", async () => {
  const { orders } = harness();
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        count: 3,
      }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-COUNT-MISMATCH");
});

test("a seat this coach does not have is refused before anything is held", async () => {
  const { orders, store } = harness();
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", { itemId: ITEM, seatIds: ["Z9Z"] }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-NOT-ON-MAP");
  assert.deepEqual(store.liveClaims("2259BNGHMP", TRAVEL_DATE), []);
});

test("a berth the simulation sold is refused with the map beside the refusal", async () => {
  const { orders } = harness();
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", { itemId: ITEM, seatIds: ["L1A"] }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  const map = refusal.attachment?.seatMap as any;
  assert.equal(map.descriptor.code, "SEAT_MAP");
  assert.equal(
    map.list.find((item: any) => item.descriptor.code === "L1A").value,
    "SOLD:simulated",
  );
});

test("the loser of a race gets the map with the winner's hold already on it", async () => {
  const { orders } = harness();
  await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U3A"],
      transactionId: "tx-winner",
    }) as never,
  );
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", {
        itemId: ITEM,
        seatIds: ["U3A"],
        transactionId: "tx-loser",
      }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  const map = refusal.attachment?.seatMap as any;
  assert.equal(
    map.list.find((item: any) => item.descriptor.code === "U3A").value,
    "HELD",
  );
});

test("a departure outside the booking window refuses the sale and names the edge", async () => {
  const { orders, clock } = harness();
  clock.at = Date.parse("2026-09-30T16:59:00.000Z");
  const refusal = await refusalFrom(() =>
    orders.select(reservedOrderRequest("select", { itemId: ITEM }) as never),
  );
  assert.equal(refusal.code, "OUTSIDE-BOOKING-WINDOW");
  // The boundary reads in IST, like every other instant this category
  // publishes. 16:44 UTC is 22:14 in Bengaluru, on the evening the rider is
  // actually being told about.
  assert.match(refusal.message, /closed at 2026-09-30T22:14/);
});

test("a boarding pair this provider does not price is refused, not interpolated", async () => {
  const { orders } = harness();
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", {
        itemId: ITEM,
        fromBoardingPointId: "BP-BLR-MADIWALA",
        toBoardingPointId: "BP-MAA-ADYAR",
      }) as never,
    ),
  );
  assert.equal(refusal.code, "FARE-NOT-PUBLISHED");
});

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */

async function heldHarness(seatIds = ["U3A", "U3B"]): Promise<Harness> {
  const context = harness();
  await context.orders.select(
    reservedOrderRequest("select", { itemId: ITEM, seatIds }) as never,
  );
  return context;
}

test("init prices the held seats and echoes the manifest", async () => {
  const { orders } = await heldHarness();
  const message = await orders.init(
    reservedOrderRequest("init", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest: twoPassengers(),
    }) as never,
  );
  const order = orderOf(message);
  const fulfillment = (order.fulfillments as any)[0];
  assert.equal(entryOf(fulfillment.tags, "MANIFEST", "NAME"), "A Passenger");
  assert.equal((order.billing as any).phone, "+919999999999");
  assert.equal((order.payments as any)[0].status, "NOT_PAID");
});

test("init without a hold says so rather than inventing one", async () => {
  const { orders } = harness();
  const refusal = await refusalFrom(() =>
    orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        manifest: twoPassengers(),
      }) as never,
    ),
  );
  assert.equal(refusal.code, "HOLD-REQUIRED");
});

test("a held seat with nobody in it is an incomplete manifest", async () => {
  const { orders } = await heldHarness();
  const refusal = await refusalFrom(() =>
    orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        manifest: [twoPassengers()[0]],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "MANIFEST-INCOMPLETE");
  assert.match(refusal.message, /U3B/);
});

test("a document number is refused at init and never appears in the refusal", async () => {
  const { orders } = await heldHarness();
  const refusal = await refusalFrom(() =>
    orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        manifest: [
          {
            ...twoPassengers()[0],
            extra: [{ code: "DOCUMENT_NUMBER", value: "S1234567" }],
          },
          twoPassengers()[1],
        ],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "MANIFEST-FIELD-NOT-ACCEPTED");
  assert.doesNotMatch(refusal.message, /S1234567/);
});

test("the gender lock fires at init, where a rider can still act on it", async () => {
  // U3A is beside U3B, and on this dated departure neither is in the seeded
  // sold set, so nothing is locked until somebody says who is in one of them.
  // A man in the berth beside a woman from another booking is the case, and
  // it needs a booking to exist first.
  const { orders } = await heldHarness(["U3A", "U3B"]);
  await orders.init(
    reservedOrderRequest("init", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest: twoPassengers(),
    }) as never,
  );
  await orders.confirm(
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest: twoPassengers(),
    }) as never,
  );

  // U4A is beside U4B. Book a woman into U4A from one transaction, then try to
  // put a man into U4B from another.
  await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U4A"],
      transactionId: "tx-woman",
    }) as never,
  );
  await orders.confirm(
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["U4A"],
      transactionId: "tx-woman",
      manifest: [{ seatId: "U4A", name: "C Passenger", gender: "female" }],
    }) as never,
  );
  await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U4B"],
      transactionId: "tx-man",
    }) as never,
  );
  const refusal = await refusalFrom(() =>
    orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        seatIds: ["U4B"],
        transactionId: "tx-man",
        manifest: [{ seatId: "U4B", name: "D Passenger", gender: "male" }],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-GENDER-LOCKED");
  assert.doesNotMatch(refusal.message, /U4A/);
});

/* ------------------------------------------------------------------ *
 * confirm
 * ------------------------------------------------------------------ */

test("confirm turns the hold into a booking with a reference of this provider's own", async () => {
  const { orders, store } = await heldHarness();
  const message = await orders.confirm(
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest: twoPassengers(),
    }) as never,
  );
  const order = orderOf(message);
  assert.match(order.id as string, /^SPECIMEN-RSV-KSRTC-/);
  assert.equal(order.status, "ACTIVE");
  const fulfillment = (order.fulfillments as any)[0];
  assert.match(
    entryOf(fulfillment.tags, "BOOKING_REF", "NUMBER")!,
    /^SPECIMEN-KSRTC-/,
  );
  // No authorization object anywhere: the boarding check is a conductor with a
  // manifest, not a gate with a reader.
  assert.equal(JSON.stringify(order).includes("authorization"), false);
  // The vehicle join carries two fields and no plate. Which coach runs this
  // service on this date is a question about a fleet, and this provider does
  // not answer it.
  assert.equal(
    entryOf(fulfillment.tags, "VEHICLE_LOOKUP", "SERVICE_ID"),
    "2259BNGHMP",
  );
  const claims = store.liveClaims("2259BNGHMP", TRAVEL_DATE);
  assert.deepEqual(
    claims.map((claim) => claim.state),
    ["BOOKED", "BOOKED"],
  );
});

/**
 * `confirmBooking`'s own batched insert - one `VALUES` tuple per seat, the
 * same shape `acquireHold`'s takes - is exactly what would misalign a
 * passenger onto the wrong seat if a later edit changed how many columns one
 * tuple carries without changing the other in step: two seats never caught
 * that, because a two-tuple insert reads the same whether the tuples are
 * matched to their seats or swapped with each other.
 *
 * The wire manifest is not a witness to this: `buildOrder` writes it straight
 * from the request's own parsed records (`order.ts`, `manifestTagFrom`), so
 * an insert that silently shuffled names in `booking_seats` would still echo
 * the request back correctly and this test would pass for the wrong reason.
 * Confirmed against `store.inspect`, which reads the row the batched insert
 * actually wrote - proved by re-running this with `name` deliberately rotated
 * one seat in the insert's own parameter list, which failed here and passed
 * everywhere else in this file.
 *
 * Four seats, confirmed in an order that is not already sorted, with a
 * fourth field (age) present on some passengers and omitted on others so a
 * shifted column lands on a type it cannot hold rather than quietly reusing
 * a neighbour's value.
 */
test("a four-seat confirm keeps every passenger on their own seat through the batched insert", async () => {
  const seatIds = ["U4B", "U3A", "U4A", "U3B"];
  const { orders, store } = await heldHarness(seatIds);
  const manifest = [
    { seatId: "U4B", name: "D Passenger", age: 22, gender: "female" },
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    { seatId: "U4A", name: "C Passenger", age: 40, gender: "male" },
    { seatId: "U3B", name: "B Passenger", gender: "male" },
  ];
  const message = await orders.confirm(
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds,
      manifest,
    }) as never,
  );
  const order = orderOf(message);

  // The row the batched insert actually wrote, read back independently of
  // whatever `buildOrder` echoed onto the wire.
  const booking = store.inspect(order.id as string);
  assert.ok(booking, "confirmed booking not found in the store");
  assert.deepEqual(
    booking!.seats
      .map((seat) => [seat.seatId, seat.name, seat.age, seat.gender])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    manifest
      .map((passenger) => [
        passenger.seatId,
        passenger.name,
        passenger.age ?? null,
        passenger.gender,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );

  // What the wire actually says matches the same records, seat for seat and
  // in request order - the confirm path's own promise, checked the way a
  // client reads it.
  const fulfillment = (order.fulfillments as any)[0];
  const parsed = parseManifest(manifestTag(fulfillment.tags as any) ?? []);
  assert.deepEqual(
    parsed.map((record) => [record.seatId, record.name, record.age, record.gender]),
    manifest.map((passenger) => [
      passenger.seatId,
      passenger.name,
      passenger.age ?? null,
      passenger.gender,
    ]),
  );

  // The store side of the same batched insert: one booked claim per seat,
  // none dropped, none doubled, none carrying somebody else's identity.
  const claims = store.liveClaims("2259BNGHMP", TRAVEL_DATE);
  assert.deepEqual(claims.map((claim) => claim.seatId).sort(), [...seatIds].sort());
  assert.ok(claims.every((claim) => claim.state === "BOOKED"));
});

test("two confirms on one transaction produce one booking with one reference", async () => {
  const { orders, store } = await heldHarness();
  const request = reservedOrderRequest("confirm", {
    itemId: ITEM,
    seatIds: ["U3A", "U3B"],
    manifest: twoPassengers(),
  });
  const [first, second] = await Promise.all([
    orders.confirm(request as never),
    orders.confirm(request as never),
  ]);
  assert.equal(orderOf(first).id, orderOf(second).id);
  const third = await orders.confirm(request as never);
  assert.equal(orderOf(third).id, orderOf(first).id);
  assert.equal(
    (store.handle.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number })
      .n,
    1,
  );
});

test("a confirm one second late is refused, even though the berth is still free", async () => {
  // The rule that makes a hold a hold. Forgiving lateness when nobody else
  // wanted the seat would make the outcome depend on whether an unrelated
  // third party happened to be looking at the same coach in the same second,
  // which a client cannot observe, cannot reproduce and cannot test against.
  // Nothing else has touched this coach between the select and the confirm,
  // and the refusal is the same either way.
  const { orders, clock, store } = await heldHarness(["U5A", "U5B"]);
  clock.at = NOW + HOLD_TTL_SECONDS * 1000 + 1;
  const refusal = await refusalFrom(() =>
    orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U5A", "U5B"],
        manifest: [
          { seatId: "U5A", name: "A Passenger", gender: "female" },
          { seatId: "U5B", name: "B Passenger", gender: "male" },
        ],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "HOLD-EXPIRED");
  // Naming the instant that was already published on the select that took it.
  assert.match(
    refusal.message,
    new RegExp(istIsoInstant(NOW + HOLD_TTL_SECONDS * 1000).replace(/\+/, "\\+")),
  );
  assert.equal(store.liveClaims("2259BNGHMP", TRAVEL_DATE).length, 0);

  // And the rider re-selects the same berths, which usually succeeds at once.
  const again = await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U5A", "U5B"],
    }) as never,
  );
  assert.ok(entryOf(orderOf(again).tags, "HOLD_INFO", "HOLD_ID"));
});

test("a confirm naming seats the hold does not cover is refused", async () => {
  const { orders } = await heldHarness(["U3A", "U3B"]);
  const refusal = await refusalFrom(() =>
    orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A"],
        manifest: [{ seatId: "U4A", name: "A Passenger", gender: "female" }],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "HOLD-SEAT-MISMATCH");
});

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

test("a booking reads back by order id and by the printed reference", async () => {
  const { orders } = await heldHarness();
  const confirmed = orderOf(
    await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        manifest: twoPassengers(),
      }) as never,
    ),
  );
  const reference = entryOf(
    (confirmed.fulfillments as any)[0].tags,
    "BOOKING_REF",
    "NUMBER",
  )!;
  const byId = orders.status(
    reservedStatusRequest({ orderId: confirmed.id as string }) as never,
  );
  const byReference = orders.status(
    reservedStatusRequest({ refId: reference }) as never,
  );
  assert.deepEqual(orderOf(byId), orderOf(byReference));
});

test("one buyer app cannot read another's booking", async () => {
  const { orders } = await heldHarness();
  const confirmed = orderOf(
    await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        manifest: twoPassengers(),
      }) as never,
    ),
  );
  const refusal = await refusalFrom(async () =>
    orders.status(
      reservedStatusRequest({
        orderId: confirmed.id as string,
        bapId: "somebody.else.test",
      }) as never,
    ),
  );
  // An unknown reference and somebody else's reference are the same answer.
  assert.equal(refusal.code, "BOOKING-NOT-FOUND");
});

test("a manifest does not outlive its journey by more than the retention window", async () => {
  const { orders, clock } = await heldHarness();
  const confirmed = orderOf(
    await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        manifest: twoPassengers(),
      }) as never,
    ),
  );
  assert.equal(JSON.stringify(confirmed).includes("A Passenger"), true);

  // Thirty-one days after the coach went.
  clock.at = Date.parse("2026-10-31T18:00:00.000Z");
  const later = orders.status(
    reservedStatusRequest({ orderId: confirmed.id as string }) as never,
  );
  // The booking survives, because a rider needs to see that a journey
  // happened. The names do not, because nothing needs them once the coach has
  // gone, and the seat ids stay so the record still reads as a booking.
  assert.equal(JSON.stringify(later).includes("A Passenger"), false);
  assert.equal(JSON.stringify(later).includes("U3A"), true);
});

/* ------------------------------------------------------------------ *
 * Concessions
 * ------------------------------------------------------------------ */

test("a concession claim on a class with no published rate refuses the whole select", async () => {
  const { orders } = harness();
  const refusal = await refusalFrom(() =>
    orders.select(
      reservedOrderRequest("select", {
        itemId: ITEM,
        concession: "SENIOR",
      }) as never,
    ),
  );
  assert.equal(refusal.code, "CONCESSION-RATE-NOT-PUBLISHED");
});
