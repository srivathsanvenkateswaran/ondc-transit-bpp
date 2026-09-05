import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReservedDatabase } from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { ReservedStore } from "../../src/reserved/store.js";
import type { ReservedService } from "../../src/reserved/types.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
  reservedStatusRequest,
} from "../helpers.js";

/**
 * Cancellation, the relock it makes reachable, and the attribution it does not
 * reverse.
 *
 * Cancellation is two steps because the refund is a real figure rather than
 * "as per policy": the slab is evaluated against this provider's clock at the
 * moment of asking, the exact number goes back before anything changes state,
 * and the commitment re-evaluates rather than trusting what it was handed.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

const TRAVEL_DATE = "2026-09-30";
const ITEM = `RSV-2259BNGHMP-${TRAVEL_DATE}-PALLAKKI`;
const DEPARTURE = Date.parse("2026-09-30T17:29:00.000Z");
const NOW = Date.parse("2026-09-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function harness() {
  const clock = { at: NOW };
  let counter = 0;
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
        holdTtlSeconds: 600,
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
  return (
    tags as Array<{
      descriptor: { code: string };
      list: Array<{ descriptor: { code: string }; value: string }>;
    }>
  )?.find((tag) => tag.descriptor.code === code);
}

function entryOf(tags: unknown, groupCode: string, entryCode: string) {
  return tagOf(tags, groupCode)?.list.find(
    (item) => item.descriptor.code === entryCode,
  )?.value;
}

/** A woman in U3A and a man in U3B, one booking, one double berth. */
const MIXED_PAIR = [
  { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
  { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
];

async function bookedPair(clockAt = NOW) {
  const context = harness();
  context.clock.at = clockAt;
  await context.orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
    }) as never,
  );
  const confirmed = (
    await context.orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        manifest: MIXED_PAIR,
      }) as never,
    )
  ).order as Record<string, unknown>;
  return { ...context, orderId: confirmed.id as string, order: confirmed };
}

/* ------------------------------------------------------------------ *
 * The quote
 * ------------------------------------------------------------------ */

test("a soft cancel returns the exact figure and changes nothing", async () => {
  const { orders, orderId, store } = await bookedPair();
  const message = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  // Ten days out, so a tenth of the base fare is deducted. Two berths at 550,
  // less 10%, plus two tolls of 20. The reservation fee never enters the sum.
  assert.equal((message.refund as any).price.value, "1030");
  // `code` is what a client keys off and `title` is what a rider reads. They
  // were one field carrying the code, so a refund screen printed BASE_FARE.
  assert.deepEqual(
    (message.refund as any).breakup.map((line: any) => [
      line.code,
      line.title,
      line.price.value,
    ]),
    [
      ["BASE_FARE", "Base fare", "1100"],
      ["SLAB_DEDUCTION", "Cancellation deduction", "-110"],
      ["RESERVATION_FEE", "Reservation fee", "0"],
      ["TOLL_REFUND", "Toll refund", "40"],
    ],
  );
  assert.equal(entryOf(message.tags, "REFUND_SLAB", "SLAB_CODE"), "OVER_72H");
  assert.equal(entryOf(message.tags, "REFUND_SLAB", "PERCENT"), "10");
  assert.ok(entryOf(message.tags, "REFUND_SLAB", "REFUND_QUOTE_ID"));
  // Nothing changed state: the booking is still live and still says so.
  assert.equal((message.order as any).status, "ACTIVE");
  assert.equal(
    store.findBooking("ksrtc", { bapId: "bap.example.test", bapUri: "https://bap.example.test" }, orderId)!
      .status,
    "CONFIRMED",
  );
});

test("a commitment with no live quote is refused rather than priced on the spot", async () => {
  const { orders, orderId } = await bookedPair();
  const refusal = await refusalFrom(() =>
    orders.cancel(
      reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL" }) as never,
    ),
  );
  assert.equal(refusal.code, "REFUND-QUOTE-EXPIRED");
});

test("a quote lapses after two minutes", async () => {
  const { orders, orderId, clock } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;
  clock.at += 2 * 60 * 1000 + 1;
  const refusal = await refusalFrom(() =>
    orders.cancel(
      reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
    ),
  );
  assert.equal(refusal.code, "REFUND-QUOTE-EXPIRED");
});

test("a slab that moved between the quote and the commitment refuses and requotes", async () => {
  // A rider who quotes at 72 hours and one minute and commits at 71 hours and
  // 59 has crossed from a tenth to a quarter. Honouring the stale quote would
  // pay a refund the slab does not support; honouring the new one silently
  // would mean committing to one number and receiving another.
  const { orders, orderId, clock } = await bookedPair(DEPARTURE - 72 * HOUR - 60_000);
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  assert.equal(entryOf(quoted.tags, "REFUND_SLAB", "SLAB_CODE"), "OVER_72H");
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;

  clock.at = DEPARTURE - 72 * HOUR + 1000;
  const refusal = await refusalFrom(() =>
    orders.cancel(
      reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
    ),
  );
  assert.equal(refusal.code, "REFUND-SLAB-MOVED");
  // The new figure travels with the refusal, so the rider sees the real number
  // before committing again.
  assert.equal((refusal.attachment?.refund as any).price.value, "865");
  const replacement = entryOf(
    refusal.attachment?.tags,
    "REFUND_SLAB",
    "REFUND_QUOTE_ID",
  )!;
  assert.notEqual(replacement, quoteId);
  const committed = await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      quoteId: replacement,
    }) as never,
  );
  assert.equal((committed.order as any).status, "CANCELLED");
  assert.equal((committed.refund as any).price.value, "865");
});

/* ------------------------------------------------------------------ *
 * The commitment
 * ------------------------------------------------------------------ */

test("committing cancels the booking and stores what it paid back", async () => {
  const { orders, orderId, store } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;
  const committed = await orders.cancel(
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
  );
  assert.equal((committed.order as any).status, "CANCELLED");
  const stored = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    orderId,
  )!;
  assert.equal(stored.status, "CANCELLED");
  assert.equal(stored.refundPaise, 103_000);
  assert.equal(stored.slabCode, "OVER_72H");
  // The berths go back into inventory.
  assert.deepEqual(store.liveClaims("2259BNGHMP", TRAVEL_DATE), []);
});

test("a repeated commitment returns the stored figure, never a fresh evaluation", async () => {
  // Re-evaluating the slab on a retry would return a smaller refund as time
  // passed for a cancellation that already completed, which makes a retry look
  // like a penalty.
  const { orders, orderId, clock } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;
  const first = await orders.cancel(
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
  );
  clock.at = DEPARTURE - HOUR;
  const second = await orders.cancel(
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
  );
  assert.equal(
    (second.refund as any).price.value,
    (first.refund as any).price.value,
  );
});

test("cancelling after departure is recorded rather than refused", async () => {
  // The rider is entitled to have the record say what happened, and refusing
  // would leave a booking that reads as live for a coach that has gone.
  const { orders, orderId, clock } = await bookedPair();
  clock.at = DEPARTURE + HOUR;
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  assert.equal(entryOf(quoted.tags, "REFUND_SLAB", "SLAB_CODE"), "UNDER_2H");
  // The fare is gone and the toll is not: it was never the corporation's
  // revenue in the first place.
  assert.equal((quoted.refund as any).price.value, "40");
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;
  const committed = await orders.cancel(
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
  );
  assert.equal((committed.order as any).status, "CANCELLED");
});

test("a cancellation naming a seat the booking does not hold is refused", async () => {
  const { orders, orderId } = await bookedPair();
  const refusal = await refusalFrom(() =>
    orders.cancel(
      reservedCancelRequest({
        orderId,
        code: "SOFT_CANCEL",
        seatIds: ["L1C"],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "CANCEL-SEAT-NOT-ON-BOOKING");
});

/* ------------------------------------------------------------------ *
 * Partial cancellation, and the relock it makes reachable
 * ------------------------------------------------------------------ */

test("one passenger of two leaves the rest of the booking live", async () => {
  const { orders, orderId, store } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "SOFT_CANCEL",
      seatIds: ["U3B"],
    }) as never,
  );
  // One berth's share of the base fare, one berth's toll, and the slab applied
  // to that share rather than to the booking total.
  assert.equal((quoted.refund as any).price.value, "515");
  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!;
  const committed = await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      seatIds: ["U3B"],
      quoteId,
    }) as never,
  );
  // A booking with a confirmed seat left is still a booking.
  assert.equal((committed.order as any).status, "ACTIVE");
  const stored = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    orderId,
  )!;
  assert.equal(stored.status, "CONFIRMED");
  assert.deepEqual(
    stored.seats.map((seat) => [seat.seatId, seat.status]),
    [
      ["U3A", "CONFIRMED"],
      ["U3B", "CANCELLED"],
    ],
  );
  // The cancelled berth goes back into inventory and the kept one does not.
  assert.deepEqual(
    store.liveClaims("2259BNGHMP", TRAVEL_DATE).map((claim) => claim.seatId),
    ["U3A"],
  );
  // The manifest on the stored order loses the passenger who left.
  const manifest = tagOf(
    (stored.order.fulfillments as any)[0].tags,
    "MANIFEST",
  )!;
  assert.deepEqual(
    manifest.list.filter((item) => item.descriptor.code === "SEAT_ID"),
    [{ descriptor: { code: "SEAT_ID" }, value: "U3A" }],
  );
});

test("cancelling one passenger of two relocks the berth beside the one who stays", async () => {
  // The case the whole adjacency rule exists for. A man and a woman share one
  // double berth in one booking, which is allowed because the exemption is the
  // shared booking. Cancel the man and the exemption is gone with him: the
  // freed berth is now beside a woman in a booking no prospective buyer
  // belongs to, and it is female-only to all of them.
  const { orders, orderId } = await bookedPair();

  // Before: nobody else can take either berth, because both are sold.
  const before = await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      transactionId: "tx-stranger",
    }) as never,
  );
  const beforeMap = tagOf((before.order as any).tags, "SEAT_MAP")!;
  assert.equal(
    beforeMap.list.find((item) => item.descriptor.code === "U3B")?.value,
    "SOLD:booked",
  );

  const quoted = await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "SOFT_CANCEL",
      seatIds: ["U3B"],
    }) as never,
  );
  await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      seatIds: ["U3B"],
      quoteId: entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!,
    }) as never,
  );

  // After: the freed berth is on the map, and it is not on offer to everybody.
  const after = await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      transactionId: "tx-stranger",
    }) as never,
  );
  const afterMap = tagOf((after.order as any).tags, "SEAT_MAP")!;
  assert.equal(
    afterMap.list.find((item) => item.descriptor.code === "U3B")?.value,
    "FEMALE_ONLY",
  );

  // And the rule bites rather than only rendering. A hold is genderless, so
  // the refusal lands at init, which is where a rider can still act on it.
  await orders.select(
    reservedOrderRequest("select", {
      itemId: ITEM,
      seatIds: ["U3B"],
      transactionId: "tx-stranger",
    }) as never,
  );
  const refusal = await refusalFrom(() =>
    orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        seatIds: ["U3B"],
        transactionId: "tx-stranger",
        manifest: [{ seatId: "U3B", name: "C Passenger", gender: "male" }],
      }) as never,
    ),
  );
  assert.equal(refusal.code, "SEAT-GENDER-LOCKED");
  assert.doesNotMatch(refusal.message, /U3A/);

  // A woman takes it without argument.
  const allowed = await orders.init(
    reservedOrderRequest("init", {
      itemId: ITEM,
      seatIds: ["U3B"],
      transactionId: "tx-stranger",
      manifest: [{ seatId: "U3B", name: "D Passenger", gender: "female" }],
    }) as never,
  );
  assert.ok(allowed.order);
});

test("cancelling the last confirmed seat cancels the booking", async () => {
  const { orders, orderId } = await bookedPair();
  for (const seatId of ["U3B", "U3A"]) {
    const quoted = await orders.cancel(
      reservedCancelRequest({ orderId, code: "SOFT_CANCEL", seatIds: [seatId] }) as never,
    );
    const committed = await orders.cancel(
      reservedCancelRequest({
        orderId,
        code: "CONFIRM_CANCEL",
        seatIds: [seatId],
        quoteId: entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!,
      }) as never,
    );
    assert.equal(
      (committed.order as any).status,
      seatId === "U3A" ? "CANCELLED" : "ACTIVE",
    );
  }
  // A booking with no confirmed seats left is cancelled, not an empty
  // confirmed booking.
  const read = orders.status(reservedStatusRequest({ orderId }) as never);
  assert.equal((read.order as any).status, "CANCELLED");
  assert.equal((read.refund as any).price.value, "1030");
});

/* ------------------------------------------------------------------ *
 * Settlement attribution
 * ------------------------------------------------------------------ */

test("an unattributable sale records a null rather than a guess", async () => {
  // No shipped corridor knows which corporation dispatches its coach, and the
  // territory a boarding point sits in is not evidence: a coach can be
  // dispatched from any corporation's depot to run through another's district,
  // which is precisely why this corridor is ambiguous. So the column is null
  // and the basis says how little is known.
  const { store, orderId } = await bookedPair();
  const booking = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    orderId,
  )!;
  assert.equal(booking.settlementCorporation, null);
  assert.equal(booking.settlementBasis, "none");
});

test("an unattributed sale joins a backlog somebody can query", async () => {
  const { store, orders, orderId } = await bookedPair();
  assert.deepEqual(store.unattributedBookings(), [
    {
      serviceId: "2259BNGHMP",
      travelDate: TRAVEL_DATE,
      bookings: 1,
      // Two fares and two reservation fees, nothing refunded yet.
      owedPaise: 114_000,
    },
  ]);

  // A cancellation reverses money, not history. What changes is how much of
  // the sale is still owed, and the reservation fee is never part of what
  // comes back so it is never part of what is reversed.
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      quoteId: entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!,
    }) as never,
  );
  assert.deepEqual(store.unattributedBookings(), [
    {
      serviceId: "2259BNGHMP",
      travelDate: TRAVEL_DATE,
      bookings: 1,
      // The retained tenth of the fare plus both reservation fees, which is
      // the exact complement of the 1030 that went back. The document writes
      // this sum as base plus fee less refund, which comes out 40 short:
      // the refund includes the toll and the two columns it is subtracted
      // from never did.
      owedPaise: 15_000,
    },
  ]);
});

test("a confirmed attribution is copied at the instant of confirm and frozen", async () => {
  // The one service in the fixture set carries no confirmed corporation, so
  // this drives a source whose service does, which is also the only way to see
  // that the copy happens at confirm rather than being read live afterwards.
  const services = await source.allServices();
  const service: ReservedService = {
    ...services.find((candidate) => candidate.serviceId === "2259BNGHMP")!,
    operatingCorporation: "KKRTC",
    operatingCorporationBasis: "confirmed",
  };
  const mutable = { current: service };
  const attributedSource = {
    operator: source.operator,
    services: async () => [mutable.current],
    service: async () => mutable.current,
    seatMap: (id: string) => source.seatMap(id),
    fareTable: (id: string) => source.fareTable(id),
  };
  let counter = 0;
  const idFactory = () => `${String((counter += 1)).padStart(8, "0")}-fixed`;
  const store = new ReservedStore(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
    { idFactory },
  );
  const orders = new ReservedOrderService(
    "ksrtc",
    attributedSource,
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
        holdTtlSeconds: 600,
        manifestRetentionDays: 30,
      },
      now: () => new Date(NOW),
      idFactory,
    },
  );
  await orders.select(
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A"] }) as never,
  );
  const confirmed = (
    await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A"],
        manifest: [{ seatId: "U3A", name: "A Passenger", gender: "female" }],
      }) as never,
    )
  ).order as Record<string, unknown>;
  const booking = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    confirmed.id as string,
  )!;
  assert.equal(booking.settlementCorporation, "KKRTC");
  assert.equal(booking.settlementBasis, "confirmed");
  assert.deepEqual(store.unattributedBookings(), []);

  // A later data refresh reclassifies the service. A settled sale must not be
  // quietly reassigned to somebody else's ledger after the fact.
  mutable.current = { ...service, operatingCorporation: "NWKRTC" };
  const reread = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    confirmed.id as string,
  )!;
  assert.equal(reread.settlementCorporation, "KKRTC");
});

test("no attribution of any kind reaches a rider-facing response", async () => {
  // The grep guard of the module boundary, applied to a payload rather than to
  // a source file. The ruling is total: an unattributed sale is exactly as
  // invisible to a rider as an attributed one, and the honest null is an
  // accounting state rather than a gap on a screen.
  const { orders, orderId } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  const committed = await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      quoteId: entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!,
    }) as never,
  );
  const payloads = [
    await orders.select(reservedOrderRequest("select", { itemId: ITEM }) as never),
    orders.status(reservedStatusRequest({ orderId }) as never),
    quoted,
    committed,
  ];
  const forbiddenText = [
    "settlement_corporation",
    "settlement_basis",
    "SETTLEMENT_CORPORATION",
  ];
  const forbiddenCodes = new Set([
    "CORPORATION",
    "CORPORATION_BASIS",
    "SETTLEMENT_CORPORATION",
    "SETTLEMENT_BASIS",
  ]);
  const codesAndValues = (node: unknown): Array<[string, string]> => {
    if (Array.isArray(node)) return node.flatMap(codesAndValues);
    if (node === null || typeof node !== "object") return [];
    const record = node as Record<string, unknown>;
    const code = (record.descriptor as { code?: string } | undefined)?.code;
    const value = record.value;
    return [
      ...(code && typeof value === "string"
        ? ([[code, value]] as Array<[string, string]>)
        : []),
      ...Object.values(record).flatMap(codesAndValues),
    ];
  };
  payloads.forEach((payload) => {
    const text = JSON.stringify(payload);
    forbiddenText.forEach((token) => {
      assert.equal(
        text.includes(token),
        false,
        `${token} reached a rider-facing payload`,
      );
    });
    codesAndValues(payload).forEach(([code, value]) => {
      assert.equal(
        forbiddenCodes.has(code),
        false,
        `a ${code} entry reached a rider-facing payload`,
      );
      // A corporation name may appear inside the specimen disclaimer, which
      // names all three to say the ticket is none of theirs. What must never
      // appear is a tag entry whose whole value is a corporation, because that
      // is what an attribution would look like on a wire.
      assert.equal(
        value === "NWKRTC" || value === "KKRTC",
        false,
        `a corporation reached a rider-facing payload under ${code}`,
      );
    });
  });
});

test("the operator disclosure carries a brand and nothing behind it", async () => {
  const { orders } = await bookedPair();
  const message = await orders.select(
    reservedOrderRequest("select", { itemId: ITEM }) as never,
  );
  const item = (message.order as any).items[0];
  const disclosure = tagOf(item.tags, "OPERATOR_DISCLOSURE")!;
  assert.deepEqual(
    disclosure.list.map((line) => line.descriptor.code),
    ["BRAND"],
  );
  assert.equal(disclosure.list[0].value, "KSRTC");
});

test("what a corporation is owed is the complement of what the rider got back", async () => {
  // Stated as an identity rather than as two numbers that happen to agree: the
  // rider's refund and the corporation's retained share split the same base
  // fare, and the toll sits outside the split on both sides because it was
  // never the corporation's revenue.
  const { orders, store, orderId } = await bookedPair();
  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL", seatIds: ["U3B"] }) as never,
  );
  await orders.cancel(
    reservedCancelRequest({
      orderId,
      code: "CONFIRM_CANCEL",
      seatIds: ["U3B"],
      quoteId: entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID")!,
    }) as never,
  );
  const booking = store.findBooking(
    "ksrtc",
    { bapId: "bap.example.test", bapUri: "https://bap.example.test" },
    orderId,
  )!;
  const [backlog] = store.unattributedBookings();
  const paid =
    booking.basePaise + booking.reservationFeePaise + booking.tollPaise;
  assert.equal(backlog.owedPaise + (booking.refundPaise ?? 0), paid - 2_000);
  // The 20 that is missing from the identity is the uncancelled berth's toll,
  // which the rider has not been refunded and the corporation is not owed. It
  // is a pass-through to a toll authority and belongs to neither of them.
  assert.equal(booking.tollPaise, 4_000);
});
