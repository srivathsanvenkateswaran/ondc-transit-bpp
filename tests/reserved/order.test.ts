import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { istIsoInstant } from "../../src/reserved/calendar.js";
import { openReservedDatabase } from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { ReservedStore } from "../../src/reserved/store.js";
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
    store.handle.prepare("SELECT COUNT(*) AS n FROM bookings").get()!.n,
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
