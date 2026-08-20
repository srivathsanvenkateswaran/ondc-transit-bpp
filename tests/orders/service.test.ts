import assert from "node:assert/strict";
import { test } from "node:test";

import { TransitOrderService } from "../../src/orders/service.js";
import {
  InMemoryOrderStore,
  OrderLifecycleError,
} from "../../src/orders/store.js";
import type {
  ConfirmRequest,
  InitRequest,
  SelectRequest,
  StatusRequest,
  Trv11Context,
} from "../../src/protocol/types.js";
import { createProtocolValidator } from "../../src/protocol/validate.js";
import type {
  OperatorKey,
  OperatorProfile,
  TransitOffer,
} from "../../src/sources/types.js";
import {
  durationMilliseconds,
  specimenTicketPayload,
  ticketAuthorization,
} from "../../src/trv11/ticket.js";
import { testConfig } from "../helpers.js";

const transactionId = "11111111-2222-3333-4444-555555555555";

function profile(category: "BUS" | "METRO"): OperatorProfile {
  return {
    id: "P1",
    name: category === "BUS" ? "Test Bus Operator" : "Test Metro Operator",
    vehicleCategory: category,
    serviceWindow: { startHHMM: "05:00", endHHMM: "23:00" },
  };
}

function offer(
  offerId: string,
  farePaise: number,
  routeId = `ROUTE-${offerId}`,
): TransitOffer {
  return {
    offerId,
    productCode: "SJT",
    productName: "Single Journey Ticket",
    farePaise,
    validity: "PT2H",
    routeId,
    routeName: routeId,
    route: [
      { code: "START", name: "Start", lat: 12.97, lon: 77.64 },
      { code: "END", name: "End", lat: 12.98, lon: 77.57 },
    ],
  };
}

function context(
  operator: OperatorKey,
  action: "select" | "init" | "confirm" | "status",
  id = transactionId,
): Trv11Context {
  const runtime = testConfig().operators[operator];
  return {
    domain: "ONDC:TRV11",
    location: { country: { code: "IND" }, city: { code: "std:080" } },
    action,
    version: "2.0.1",
    bap_id: "bap.example.test",
    bap_uri: "https://bap.example.test",
    bpp_id: runtime.subscriberId,
    bpp_uri: runtime.subscriberUri,
    transaction_id: id,
    message_id: `${action}-message-id`,
    timestamp: "2026-08-20T05:00:00.000Z",
    ttl: "PT30S",
  };
}

function selected(items: Array<[string, number]>) {
  return items.map(([id, count]) => ({
    id,
    quantity: { selected: { count } },
  }));
}

function selectRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  id = transactionId,
): SelectRequest {
  return {
    context: context(operator, "select", id) as SelectRequest["context"],
    message: { order: { items: selected(items), provider: { id: "P1" } } },
  };
}

function initRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  id = transactionId,
): InitRequest {
  return {
    context: context(operator, "init", id) as InitRequest["context"],
    message: {
      order: {
        items: selected(items),
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [
          { collected_by: "BAP", status: "NOT_PAID", type: "PRE_ORDER" },
        ],
      },
    },
  };
}

function confirmRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  id = transactionId,
): ConfirmRequest {
  return {
    context: context(operator, "confirm", id) as ConfirmRequest["context"],
    message: {
      order: {
        items: selected(items),
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [
          {
            id: "PAYMENT-SPECIMEN-1",
            collected_by: "BAP",
            status: "PAID",
            type: "PRE_ORDER",
            params: {
              transaction_id: "PAYMENT-SPECIMEN-TRANSACTION",
              currency: "INR",
              amount: "54",
            },
          },
        ],
      },
    },
  };
}

function service(
  operator: OperatorKey,
  store: InMemoryOrderStore,
  idFactory = () => `${operator}12345678`,
) {
  const config = testConfig();
  const category = operator === "bmtc" ? "BUS" : "METRO";
  return new TransitOrderService(
    operator,
    profile(category),
    config.operators[operator],
    store,
    {
      publicBaseUrl: config.publicBaseUrl,
      now: () => new Date("2026-08-20T05:00:00.000Z"),
      idFactory,
      qrEncoder: async (payload) => Buffer.from(`PNG:${payload}`),
    },
  );
}

function rupeesToPaise(value: string): number {
  const [rupees, paise = ""] = value.split(".");
  return Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
}

test("on_select quote equals BASE_FARE breakup with integer-paise pricing", () => {
  const store = new InMemoryOrderStore();
  const orders = service("bmtc", store);
  orders.cacheCatalogue(transactionId, [offer("I1", 2700), offer("I2", 1005)]);

  const request = selectRequest("bmtc", [
      ["I1", 2],
      ["I2", 3],
    ]);
  const order = orders.select(request) as any;
  assert.equal(order.items[0].descriptor.code, "SJT");
  assert.equal(order.items[0].price.value, "27");
  assert.equal(order.quote.price.value, "84.15");
  assert.deepEqual(
    order.quote.breakup.map((line: any) => line.title),
    ["BASE_FARE", "BASE_FARE"],
  );
  assert.equal(
    rupeesToPaise(order.quote.price.value),
    order.quote.breakup.reduce(
      (sum: number, line: any) => sum + rupeesToPaise(line.price.value),
      0,
    ),
  );
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(validator.select(request).valid, true);
  assert.deepEqual(
    validator.onSelect({
      context: { ...request.context, action: "on_select" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );
});

test("unknown selected item returns a domain error instead of a quote", () => {
  const store = new InMemoryOrderStore();
  const orders = service("bmtc", store);
  orders.cacheCatalogue(transactionId, [offer("I1", 2700)]);

  assert.throws(
    () => orders.select(selectRequest("bmtc", [["UNKNOWN", 1]])),
    (error: unknown) =>
      error instanceof OrderLifecycleError && error.code === "ITEM-NOT-FOUND",
  );
});

test("init carries the quote, billing and NOT_PAID payment forward", () => {
  const store = new InMemoryOrderStore();
  const orders = service("bmtc", store);
  orders.cacheCatalogue(transactionId, [offer("I1", 2700)]);

  const request = initRequest("bmtc", [["I1", 2]]);
  const order = orders.init(request) as any;
  assert.equal(order.quote.price.value, "54");
  assert.equal(order.billing.name, "Specimen Rider");
  assert.equal(order.payments[0].status, "NOT_PAID");
  assert.match(order.payments[0].id, /^PAY-BMTC-/);
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(validator.init(request).valid, true);
  assert.deepEqual(
    validator.onInit({
      context: { ...request.context, action: "on_init" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );
});

test("confirm mints one clearly marked QR ticket per selected unit", async () => {
  const store = new InMemoryOrderStore();
  const orders = service("bmtc", store);
  orders.cacheCatalogue(transactionId, [offer("I1", 2700)]);

  const request = confirmRequest("bmtc", [["I1", 2]]);
  const order = (await orders.confirm(request)) as any;
  assert.match(order.id, /^SPECIMEN-ORD-BMTC-/);
  assert.equal(order.status, "ACTIVE");
  const tickets = order.fulfillments.filter(
    (fulfillment: any) => fulfillment.type === "TICKET",
  );
  assert.equal(tickets.length, 2);
  assert.notEqual(
    tickets[0].stops[0].authorization.token,
    tickets[1].stops[0].authorization.token,
  );
  tickets.forEach((ticket: any) => {
    const authorization = ticket.stops[0].authorization;
    assert.equal(authorization.type, "QR");
    assert.equal(authorization.status, "UNCLAIMED");
    assert.equal(Number.isNaN(Date.parse(authorization.valid_to)), false);
    const ticketInfo = ticket.tags.find(
      (tag: any) => tag.descriptor.code === "TICKET_INFO",
    );
    const number = ticketInfo.list.find(
      (entry: any) => entry.descriptor.code === "NUMBER",
    ).value;
    assert.match(number, /^SPECIMEN-BMTC-/);
    const encoded = Buffer.from(authorization.token, "base64").toString("utf8");
    assert.equal(
      encoded,
      `PNG:${specimenTicketPayload(order.id, number)}`,
    );
    assert.match(encoded, /NOT VALID FOR TRAVEL/);
  });
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(validator.confirm(request).valid, true);
  assert.deepEqual(
    validator.onConfirm({
      context: { ...request.context, action: "on_confirm" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );
});

test("status returns the exact stored order", async () => {
  const store = new InMemoryOrderStore();
  const orders = service("bmtc", store);
  orders.cacheCatalogue(transactionId, [offer("I1", 2700)]);
  const confirmed = await orders.confirm(confirmRequest("bmtc", [["I1", 1]]));
  const orderId = confirmed.id as string;
  const request: StatusRequest = {
    context: context("bmtc", "status") as StatusRequest["context"],
    message: { order_id: orderId },
  };

  const statusOrder = orders.status(request);
  assert.deepEqual(statusOrder, confirmed);
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.equal(validator.status(request).valid, true);
  assert.deepEqual(
    validator.onStatus({
      context: { ...request.context, action: "on_status" },
      message: { order: statusOrder },
    }),
    { valid: true, errors: [] },
  );
});

test("shared store keeps bus and metro orders independent", async () => {
  const store = new InMemoryOrderStore();
  const busTransaction = "aaaaaaaa-2222-3333-4444-555555555555";
  const metroTransaction = "bbbbbbbb-2222-3333-4444-555555555555";
  const bus = service("bmtc", store, () => "bus12345678");
  const metro = service("bmrcl", store, () => "metro12345678");
  bus.cacheCatalogue(busTransaction, [offer("I1", 2700, "BUS-ROUTE")]);
  metro.cacheCatalogue(metroTransaction, [offer("I1", 3000, "METRO-LINE")]);

  const busOrder = await bus.confirm(
    confirmRequest("bmtc", [["I1", 1]], busTransaction),
  );
  const metroOrder = await metro.confirm(
    confirmRequest("bmrcl", [["I1", 1]], metroTransaction),
  );

  assert.notEqual(busOrder.id, metroOrder.id);
  assert.deepEqual(store.inspect(busOrder.id as string), busOrder);
  assert.deepEqual(store.inspect(metroOrder.id as string), metroOrder);
});

test("production QR encoder returns a PNG and parseable validity", async () => {
  const authorization = await ticketAuthorization(
    "SPECIMEN-ORDER",
    "SPECIMEN-TICKET-01",
    "PT2H",
    new Date("2026-08-20T05:00:00.000Z"),
  );
  const png = Buffer.from(authorization.token, "base64");

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(authorization.valid_to, "2026-08-20T07:00:00.000Z");
  assert.equal(durationMilliseconds("P1DT2H3M4S"), 93_784_000);
});
