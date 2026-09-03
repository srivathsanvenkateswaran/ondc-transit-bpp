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
  Payment,
  ProtocolOrder,
  SelectRequest,
  StatusRequest,
  Trv11Context,
} from "../../src/protocol/types.js";
import { createProtocolValidator } from "../../src/protocol/validate.js";
import type {
  OperatorKey,
  OperatorProfile,
  ServiceTier,
  TransitOffer,
} from "../../src/sources/types.js";
import { decodeBase32, totpCode } from "../../src/trv11/totp.js";
import { testConfig } from "../helpers.js";

const PASS_TRANSACTION = "aaaaaaaa-1111-2222-3333-444444444444";
const RIDE_TRANSACTION = "bbbbbbbb-5555-6666-7777-888888888888";
const ISSUED_AT = new Date("2026-09-03T06:00:00.000Z");

function profile(category: "BUS" | "METRO"): OperatorProfile {
  return {
    id: "P1",
    name: category === "BUS" ? "Test Bus Operator" : "Test Metro Operator",
    vehicleCategory: category,
    serviceWindow: { startHHMM: "05:00", endHHMM: "23:00" },
  };
}

function rideOffer(serviceTier?: ServiceTier): TransitOffer {
  return {
    offerId: "I1",
    productCode: "SJT",
    productName: "Single Journey Ticket",
    farePaise: 2_700,
    validity: "PT2H",
    routeId: "314",
    routeName: "Test route",
    ...(serviceTier ? { serviceTier } : {}),
    route: [
      { code: "START", name: "Start", lat: 12.97, lon: 77.64 },
      { code: "END", name: "End", lat: 12.98, lon: 77.57 },
    ],
  };
}

function context(
  operator: OperatorKey,
  action: "select" | "init" | "confirm" | "status",
  transactionId = PASS_TRANSACTION,
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
    transaction_id: transactionId,
    message_id: `${action}-message-id`,
    timestamp: "2026-09-03T06:00:00.000Z",
    ttl: "PT30S",
  };
}

function selected(items: Array<[string, number]>) {
  return items.map(([id, count]) => ({
    id,
    quantity: { selected: { count } },
  }));
}

/** Distinct per confirm, so a second order in one store does not collide. */
let orderSequence = 0;

function service(
  operator: OperatorKey,
  store: InMemoryOrderStore,
  category: "BUS" | "METRO" = operator === "bmtc" ? "BUS" : "METRO",
  now: () => Date = () => ISSUED_AT,
) {
  return new TransitOrderService(
    operator,
    profile(category),
    testConfig().operators[operator],
    store,
    {
      publicBaseUrl: testConfig().publicBaseUrl,
      now,
      idFactory: () => {
        orderSequence += 1;
        return `order-${operator}-${orderSequence}`;
      },
      qrEncoder: async (payload) => Buffer.from(payload, "utf8"),
    },
  );
}

function selectRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  tags?: Array<Record<string, unknown>>,
  transactionId = PASS_TRANSACTION,
): SelectRequest {
  return {
    context: context(operator, "select", transactionId) as SelectRequest["context"],
    message: {
      order: {
        items: selected(items),
        provider: { id: "P1" },
        ...(tags ? { tags } : {}),
      },
    },
  };
}

function initRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  tags?: Array<Record<string, unknown>>,
): InitRequest {
  return {
    context: context(operator, "init") as InitRequest["context"],
    message: {
      order: {
        items: selected(items),
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [{ collected_by: "BAP", status: "NOT_PAID", type: "PRE_ORDER" }],
        ...(tags ? { tags } : {}),
      },
    },
  };
}

function paidPayment(
  amount: string,
  tags?: Array<Record<string, unknown>>,
): Payment {
  return {
    id: "PAYMENT-SPECIMEN-1",
    collected_by: "BAP",
    status: "PAID",
    type: "PRE_ORDER",
    params: {
      transaction_id: "PAYMENT-SPECIMEN-TRANSACTION",
      currency: "INR",
      amount,
    },
    ...(tags ? { tags } : {}),
  };
}

function confirmRequest(
  operator: OperatorKey,
  items: Array<[string, number]>,
  options: {
    tags?: Array<Record<string, unknown>>;
    payment?: Payment;
    transactionId?: string;
  } = {},
): ConfirmRequest {
  return {
    context: context(
      operator,
      "confirm",
      options.transactionId ?? PASS_TRANSACTION,
    ) as ConfirmRequest["context"],
    message: {
      order: {
        items: selected(items),
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [options.payment ?? paidPayment("2700")],
        ...(options.tags ? { tags: options.tags } : {}),
      },
    },
  };
}

const STUDENT_TAG = {
  descriptor: { code: "CONCESSION" },
  display: false,
  list: [{ descriptor: { code: "CLASS" }, value: "STUDENT" }],
};

const SENIOR_TAG = {
  descriptor: { code: "CONCESSION" },
  display: false,
  list: [{ descriptor: { code: "CLASS" }, value: "SENIOR" }],
};

function credentialFulfillments(order: ProtocolOrder) {
  return order.fulfillments.filter(
    (fulfillment) =>
      (fulfillment as { stops?: Array<{ authorization?: { type?: string } }> })
        .stops?.[0]?.authorization?.type === "TOTP",
  ) as Array<Record<string, any>>;
}

function lifecycleError(run: () => unknown): OrderLifecycleError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof OrderLifecycleError, String(error));
    return error;
  }
  throw new Error("Expected the provider to refuse");
}

async function asyncLifecycleError(
  run: () => Promise<unknown>,
): Promise<OrderLifecycleError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof OrderLifecycleError, String(error));
    return error;
  }
  throw new Error("Expected the provider to refuse");
}

/* ------------------------------------------------------------------ *
 * Quoting
 * ------------------------------------------------------------------ */

test("a pass select needs no cached catalogue, unlike a stop-pair offer", () => {
  // The nine items are static constants, published identically to every
  // buyer. Nothing was searched for in this transaction.
  const order = service("bmtc", new InMemoryOrderStore()).select(
    selectRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]]),
  );
  assert.equal((order.quote as any).price.value, "2700");
});

test("the on_select quote matches the contract's worked example", () => {
  const order = service("bmtc", new InMemoryOrderStore()).select(
    selectRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]], [STUDENT_TAG]),
  );
  assert.equal((order.quote as any).price.value, "1809");
  assert.deepEqual((order.quote as any).breakup, [
    {
      title: "BASE_FARE",
      item: {
        id: "PASS-MONTHLY-AC_BUS",
        price: { currency: "INR", value: "2700" },
        quantity: { selected: { count: 1 } },
      },
      price: { currency: "INR", value: "2700" },
    },
    {
      title: "STUDENT_CONCESSION",
      price: { currency: "INR", value: "-891" },
    },
  ]);
});

test("a senior concession uses the rate published for that window", () => {
  const store = new InMemoryOrderStore();
  // 25% on a weekly item, 10% on a monthly one.
  const weekly = service("bmtc", store).select(
    selectRequest("bmtc", [["PASS-WEEKLY-AC_BUS", 1]], [SENIOR_TAG]),
  );
  assert.equal((weekly.quote as any).price.value, "562.50");
  assert.equal(
    (weekly.quote as any).breakup[1].price.value,
    "-187.50",
  );
  const monthly = service("bmtc", store).select(
    selectRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]], [SENIOR_TAG]),
  );
  assert.equal((monthly.quote as any).price.value, "2430");
});

test("an order with no concession carries no CONCESSION tag at all", () => {
  const order = service("bmtc", new InMemoryOrderStore()).select(
    selectRequest("bmtc", [["PASS-DAY-AC_BUS", 1]]),
  );
  const codes = (order.tags as Array<any>).map((tag) => tag.descriptor.code);
  assert.equal(codes.includes("CONCESSION"), false);
  assert.deepEqual(codes, ["SPECIMEN_INFO", "SYNTHETIC_PASS_INFO"]);
  assert.equal((order.quote as any).breakup.length, 1);
});

test("the concession class is echoed on the order, not only on the request", () => {
  const order = service("bmtc", new InMemoryOrderStore()).select(
    selectRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], [STUDENT_TAG]),
  );
  assert.deepEqual((order.tags as Array<any>)[1], STUDENT_TAG);
});

test("quantity multiplies both the base and the discount", () => {
  const order = service("bmtc", new InMemoryOrderStore()).select(
    selectRequest("bmtc", [["PASS-DAY-ORDINARY_BUS", 3]], [STUDENT_TAG]),
  );
  // 3 x Rs.75 = Rs.225, less 33% of each = 3 x Rs.24.75 = Rs.74.25.
  assert.equal((order.quote as any).breakup[0].price.value, "225");
  assert.equal((order.quote as any).breakup[1].price.value, "-74.25");
  assert.equal((order.quote as any).price.value, "150.75");
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

test("a class this provider published no rate for is refused, naming the rate", () => {
  const error = lifecycleError(() =>
    service("bmtc", new InMemoryOrderStore()).select(
      selectRequest(
        "bmtc",
        [["PASS-MONTHLY-AC_BUS", 1]],
        [
          {
            descriptor: { code: "CONCESSION" },
            display: false,
            list: [{ descriptor: { code: "CLASS" }, value: "CHILD" }],
          },
        ],
      ),
    ),
  );
  assert.equal(error.code, "CONCESSION-RATE-NOT-PUBLISHED");
  assert.match(error.message, /No CHILD_DISCOUNT_PERCENT rate is published/);
  assert.match(
    error.message,
    /SENIOR_DISCOUNT_PERCENT and STUDENT_DISCOUNT_PERCENT only/,
  );
});

test("an unrecognised class value is refused without being echoed", () => {
  const error = lifecycleError(() =>
    service("bmtc", new InMemoryOrderStore()).select(
      selectRequest(
        "bmtc",
        [["PASS-MONTHLY-AC_BUS", 1]],
        [
          {
            descriptor: { code: "CONCESSION" },
            display: false,
            list: [
              {
                descriptor: { code: "CLASS" },
                value: "Ramesh Kumar, DL-1420110012345",
              },
            ],
          },
        ],
      ),
    ),
  );
  assert.equal(error.code, "CONCESSION-RATE-NOT-PUBLISHED");
  // The refusal reaches the event log, so it must carry nothing identifying.
  assert.doesNotMatch(error.message, /Ramesh/);
  assert.doesNotMatch(error.message, /1420110012345/);
  assert.match(error.message, /never stored or logged/);
});

test("a concession tag carrying anything but a class is refused", () => {
  for (const list of [
    [
      { descriptor: { code: "CLASS" }, value: "STUDENT" },
      { descriptor: { code: "DOCUMENT_NUMBER" }, value: "KA-2026-99881" },
    ],
    [{ descriptor: { code: "DOCUMENT_TYPE" }, value: "STUDENT_ID" }],
    [
      { descriptor: { code: "CLASS" }, value: "STUDENT" },
      { descriptor: { code: "VERIFIED_AT" }, value: "2026-06-01" },
    ],
  ]) {
    const error = lifecycleError(() =>
      service("bmtc", new InMemoryOrderStore()).select(
        selectRequest(
          "bmtc",
          [["PASS-DAY-AC_BUS", 1]],
          [{ descriptor: { code: "CONCESSION" }, display: false, list }],
        ),
      ),
    );
    assert.equal(error.code, "CONCESSION-TAG-INVALID");
    assert.match(error.message, /accepts CLASS only/);
    // Codes are field names and safe to name; the values beside them are not.
    assert.doesNotMatch(error.message, /KA-2026-99881/);
    assert.doesNotMatch(error.message, /2026-06-01/);
  }
});

test("two concession tag groups are refused", () => {
  const error = lifecycleError(() =>
    service("bmtc", new InMemoryOrderStore()).select(
      selectRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], [STUDENT_TAG, SENIOR_TAG]),
    ),
  );
  assert.equal(error.code, "CONCESSION-TAG-INVALID");
  assert.match(error.message, /at most one CONCESSION tag group/);
});

test("an operator refuses a pass item the other operator sells", () => {
  const error = lifecycleError(() =>
    service("bmtc", new InMemoryOrderStore()).select(
      selectRequest("bmtc", [["PASS-DAY-METRO", 1]]),
    ),
  );
  assert.equal(error.code, "ITEM-NOT-FOUND");
  assert.match(error.message, /does not sell pass item PASS-DAY-METRO/);
});

test("an order mixing a pass and a single journey is refused", () => {
  const store = new InMemoryOrderStore();
  store.cacheCatalogue(
    "bmtc",
    {
      transactionId: PASS_TRANSACTION,
      bapId: "bap.example.test",
      bapUri: "https://bap.example.test",
    },
    [rideOffer()],
  );
  const error = lifecycleError(() =>
    service("bmtc", store).select(
      selectRequest("bmtc", [
        ["PASS-DAY-AC_BUS", 1],
        ["I1", 1],
      ]),
    ),
  );
  assert.equal(error.code, "MIXED-CATEGORY-ORDER");
});

test("an unrecognised class on a single-journey order refuses as not applicable", () => {
  // Not "no rate published": no rate would apply to a single journey either
  // way, so naming a missing rate would answer the wrong question.
  const store = new InMemoryOrderStore();
  store.cacheCatalogue(
    "bmtc",
    {
      transactionId: PASS_TRANSACTION,
      bapId: "bap.example.test",
      bapUri: "https://bap.example.test",
    },
    [rideOffer()],
  );
  const error = lifecycleError(() =>
    service("bmtc", store).select(
      selectRequest(
        "bmtc",
        [["I1", 1]],
        [
          {
            descriptor: { code: "CONCESSION" },
            display: false,
            list: [{ descriptor: { code: "CLASS" }, value: "CHILD" }],
          },
        ],
      ),
    ),
  );
  assert.equal(error.code, "CONCESSION-NOT-APPLICABLE");
});

test("a concession on a single-journey order is refused, not silently ignored", () => {
  const store = new InMemoryOrderStore();
  store.cacheCatalogue(
    "bmtc",
    {
      transactionId: PASS_TRANSACTION,
      bapId: "bap.example.test",
      bapUri: "https://bap.example.test",
    },
    [rideOffer()],
  );
  const error = lifecycleError(() =>
    service("bmtc", store).select(selectRequest("bmtc", [["I1", 1]], [STUDENT_TAG])),
  );
  assert.equal(error.code, "CONCESSION-NOT-APPLICABLE");
});

/* ------------------------------------------------------------------ *
 * The credential
 * ------------------------------------------------------------------ */

test("confirm mints a rotating credential in place of a static QR", async () => {
  const store = new InMemoryOrderStore();
  const order = await service("bmtc", store).confirm(
    confirmRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]], { tags: [STUDENT_TAG] }),
  );
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.deepEqual(
    validator.onConfirm({
      context: { ...context("bmtc", "confirm"), action: "on_confirm" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );

  const credentials = credentialFulfillments(order);
  assert.equal(credentials.length, 1);
  const [credential] = credentials;
  assert.equal(credential.id, "T-PASS-MONTHLY-AC_BUS-1");
  const authorization = credential.stops[0].authorization;
  assert.equal(authorization.type, "TOTP");
  assert.equal(authorization.status, "ISSUED");
  // A base32 secret, not a base64 PNG.
  assert.match(authorization.token, /^[A-Z2-7]{32}$/);
  assert.equal(decodeBase32(authorization.token).length, 20);
  // The window is the pass's own calendar month, not the algorithm's period.
  assert.equal(authorization.valid_from, "2026-09-03T00:00:00.000+05:30");
  assert.equal(authorization.valid_to, "2026-10-03T00:00:00.000+05:30");

  assert.deepEqual(
    credential.tags.map((tag: any) => tag.descriptor.code),
    ["INFO", "SPECIMEN_INFO", "TOTP_INFO", "TICKET_INFO"],
  );
  assert.deepEqual(
    credential.tags.find((tag: any) => tag.descriptor.code === "TOTP_INFO"),
    {
      descriptor: { code: "TOTP_INFO" },
      display: false,
      list: [
        { descriptor: { code: "ALGORITHM" }, value: "SHA1" },
        { descriptor: { code: "DIGITS" }, value: "6" },
        { descriptor: { code: "PERIOD_SECONDS" }, value: "30" },
      ],
    },
  );
  assert.deepEqual(
    credential.tags[0].list,
    [{ descriptor: { code: "PARENT_ID" }, value: "F-PASS-MONTHLY-AC_BUS" }],
  );
});

test("the credential is parented to a PASS fulfillment, which carries no stops", async () => {
  const order = await service("bmtc", new InMemoryOrderStore()).confirm(
    confirmRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]]),
  );
  const parent = order.fulfillments.find(
    (fulfillment) => (fulfillment as any).id === "F-PASS-MONTHLY-AC_BUS",
  ) as any;
  assert.equal(parent.type, "PASS");
  assert.equal("stops" in parent, false);
  assert.deepEqual(order.items[0].fulfillment_ids, [
    "F-PASS-MONTHLY-AC_BUS",
    "T-PASS-MONTHLY-AC_BUS-1",
  ]);
  assert.equal(order.status, "ACTIVE");
  assert.match(String(order.id), /^SPECIMEN-ORD-BMTC-/);
});

test("the specimen posture survives a more convincing credential", async () => {
  const order = await service("bmrcl", new InMemoryOrderStore()).confirm(
    confirmRequest("bmrcl", [["PASS-MONTHLY-METRO", 1]]),
  );
  const orderNotice = (order.tags as Array<any>).find(
    (tag) => tag.descriptor.code === "SPECIMEN_INFO",
  );
  assert.match(orderNotice.list[0].value, /SPECIMEN - NOT VALID FOR TRAVEL/);
  assert.match(orderNotice.list[0].value, /not issued by BMTC or BMRCL/);
  const credentialNotice = credentialFulfillments(order)[0].tags.find(
    (tag: any) => tag.descriptor.code === "SPECIMEN_INFO",
  );
  assert.equal(
    credentialNotice.list[0].value,
    "SPECIMEN - NOT VALID FOR TRAVEL",
  );
});

test("every unit of quantity gets its own secret", async () => {
  const order = await service("bmtc", new InMemoryOrderStore()).confirm(
    confirmRequest("bmtc", [["PASS-DAY-AC_BUS", 3]]),
  );
  const credentials = credentialFulfillments(order);
  assert.equal(credentials.length, 3);
  const tokens = credentials.map(
    (credential) => credential.stops[0].authorization.token,
  );
  assert.equal(new Set(tokens).size, 3);
  assert.deepEqual(
    credentials.map((credential) => credential.id),
    ["T-PASS-DAY-AC_BUS-1", "T-PASS-DAY-AC_BUS-2", "T-PASS-DAY-AC_BUS-3"],
  );
});

test("two passes bought separately never share a secret", async () => {
  const store = new InMemoryOrderStore();
  const first = await service("bmtc", store).confirm(
    confirmRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], {
      transactionId: PASS_TRANSACTION,
    }),
  );
  const second = await service("bmtc", store).confirm(
    confirmRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], {
      transactionId: RIDE_TRANSACTION,
    }),
  );
  assert.notEqual(
    credentialFulfillments(first)[0].stops[0].authorization.token,
    credentialFulfillments(second)[0].stops[0].authorization.token,
  );
});

test("a confirmed pass is returned unchanged by status", async () => {
  const store = new InMemoryOrderStore();
  const confirmed = await service("bmtc", store).confirm(
    confirmRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], { tags: [SENIOR_TAG] }),
  );
  const request: StatusRequest = {
    context: context("bmtc", "status") as StatusRequest["context"],
    message: { order_id: String(confirmed.id) },
  };
  assert.deepEqual(service("bmtc", store).status(request), confirmed);
});

test("init returns the draft pass order with billing and NOT_PAID payments", () => {
  const order = service("bmtc", new InMemoryOrderStore()).init(
    initRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], [STUDENT_TAG]),
  );
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.deepEqual(
    validator.onInit({
      context: { ...context("bmtc", "init"), action: "on_init" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );
  assert.equal((order.payments as Array<any>)[0].status, "NOT_PAID");
  // No credential exists before confirm.
  assert.equal(credentialFulfillments(order).length, 0);
});

/* ------------------------------------------------------------------ *
 * Paying for a ride with a pass
 * ------------------------------------------------------------------ */

interface RideFixture {
  store: InMemoryOrderStore;
  passOrderId: string;
  code: (atMs?: number) => string;
  ride: (
    tags: Array<Record<string, unknown>> | undefined,
    tier?: ServiceTier,
    now?: () => Date,
  ) => Promise<ProtocolOrder>;
}

async function boughtPass(
  operator: OperatorKey = "bmtc",
  passItemId = "PASS-MONTHLY-AC_BUS",
): Promise<RideFixture> {
  const store = new InMemoryOrderStore();
  const passOrder = await service(operator, store).confirm(
    confirmRequest(operator, [[passItemId, 1]], {
      transactionId: PASS_TRANSACTION,
    }),
  );
  const secret = credentialFulfillments(passOrder)[0].stops[0].authorization.token;
  const identity = {
    transactionId: RIDE_TRANSACTION,
    bapId: "bap.example.test",
    bapUri: "https://bap.example.test",
  };
  return {
    store,
    passOrderId: String(passOrder.id),
    code: (atMs = ISSUED_AT.getTime()) => totpCode(secret, atMs),
    ride: async (tags, tier, now = () => ISSUED_AT) => {
      store.cacheCatalogue(operator, identity, [rideOffer(tier)]);
      return service(
        operator,
        store,
        operator === "bmtc" ? "BUS" : "METRO",
        now,
      ).confirm(
        confirmRequest(operator, [["I1", 1]], {
          transactionId: RIDE_TRANSACTION,
          payment: paidPayment("27", tags),
        }),
      );
    },
  };
}

function settlementTag(passOrderId: string, passCode: string) {
  return {
    descriptor: { code: "PASS_SETTLEMENT" },
    display: false,
    list: [
      { descriptor: { code: "PASS_ORDER_ID" }, value: passOrderId },
      { descriptor: { code: "PASS_CODE" }, value: passCode },
    ],
  };
}

test("a pass-settled ride is the ordinary order plus one payment tag", async () => {
  const fixture = await boughtPass();
  const order = await fixture.ride([
    settlementTag(fixture.passOrderId, fixture.code()),
  ]);
  const validator = createProtocolValidator(testConfig().schemaRoot);
  assert.deepEqual(
    validator.onConfirm({
      context: { ...context("bmtc", "confirm"), action: "on_confirm" },
      message: { order },
    }),
    { valid: true, errors: [] },
  );
  // Same single-journey item, same TRIP fulfillment, same QR ticket.
  assert.equal(order.items[0].id, "I1");
  assert.equal((order.items[0] as any).descriptor.code, "SJT");
  assert.equal(
    order.fulfillments.some((fulfillment) => (fulfillment as any).type === "TRIP"),
    true,
  );
  assert.equal(credentialFulfillments(order).length, 0);
  // A pass ride is not a zero-rupee ride.
  assert.equal((order.payments as Array<any>)[0].params.amount, "27");
  assert.equal((order.quote as any).price.value, "27");
  // The claim echoes back on the confirmed order.
  assert.deepEqual(
    (order.payments as Array<any>)[0].tags,
    [settlementTag(fixture.passOrderId, fixture.code())],
  );
});

test("an AC pass settles an ordinary ride, an ordinary pass does not settle an AC one", async () => {
  const covered = await boughtPass("bmtc", "PASS-MONTHLY-AC_BUS");
  await covered.ride(
    [settlementTag(covered.passOrderId, covered.code())],
    "ORDINARY_BUS",
  );

  const uncovered = await boughtPass("bmtc", "PASS-MONTHLY-ORDINARY_BUS");
  const error = await asyncLifecycleError(() =>
    uncovered.ride(
      [settlementTag(uncovered.passOrderId, uncovered.code())],
      "AC_BUS",
    ),
  );
  assert.equal(error.code, "PASS-SCOPE-MISMATCH");
  assert.match(error.message, /does not cover AC_BUS/);
  assert.match(error.message, /full fare/);
});

test("a metro pass does not settle a bus ride", async () => {
  const fixture = await boughtPass("bmrcl", "PASS-MONTHLY-METRO");
  const error = await asyncLifecycleError(() =>
    fixture.ride(
      [settlementTag(fixture.passOrderId, fixture.code())],
      "ORDINARY_BUS",
    ),
  );
  assert.equal(error.code, "PASS-SCOPE-MISMATCH");
});

test("a wrong code is refused without the code reaching the message", async () => {
  const fixture = await boughtPass();
  const error = await asyncLifecycleError(() =>
    fixture.ride([settlementTag(fixture.passOrderId, "000000")]),
  );
  assert.equal(error.code, "PASS-CODE-INVALID");
  assert.doesNotMatch(error.message, /000000/);
});

test("a code from the wrong time window is refused", async () => {
  const fixture = await boughtPass();
  // A code computed ten minutes ago, presented now.
  const stale = fixture.code(ISSUED_AT.getTime() - 10 * 60 * 1000);
  const error = await asyncLifecycleError(() =>
    fixture.ride([settlementTag(fixture.passOrderId, stale)]),
  );
  assert.equal(error.code, "PASS-CODE-INVALID");
});

test("a pass presented outside its own window is refused before the code", async () => {
  const fixture = await boughtPass("bmtc", "PASS-DAY-AC_BUS");
  const nextWeek = new Date("2026-09-11T06:00:00.000Z");
  const error = await asyncLifecycleError(() =>
    fixture.ride(
      [settlementTag(fixture.passOrderId, fixture.code(nextWeek.getTime()))],
      undefined,
      () => nextWeek,
    ),
  );
  assert.equal(error.code, "PASS-WINDOW-EXPIRED");
  assert.match(error.message, /window first and the code second/);
});

test("an unknown pass order id is refused", async () => {
  const fixture = await boughtPass();
  const error = await asyncLifecycleError(() =>
    fixture.ride([settlementTag("SPECIMEN-ORD-BMTC-NOSUCHORDER", fixture.code())]),
  );
  assert.equal(error.code, "PASS-ORDER-NOT-FOUND");
  assert.match(error.message, /can only verify a pass it issued itself/);
});

test("one operator cannot verify another operator's pass", async () => {
  // The BMTC pass order id presented to BMRCL. Same process, same store, and
  // still not verifiable - a BPP holds no other operator's secret.
  const store = new InMemoryOrderStore();
  const passOrder = await service("bmtc", store).confirm(
    confirmRequest("bmtc", [["PASS-MONTHLY-AC_BUS", 1]], {
      transactionId: PASS_TRANSACTION,
    }),
  );
  const secret = credentialFulfillments(passOrder)[0].stops[0].authorization.token;
  const identity = {
    transactionId: RIDE_TRANSACTION,
    bapId: "bap.example.test",
    bapUri: "https://bap.example.test",
  };
  store.cacheCatalogue("bmrcl", identity, [rideOffer("METRO")]);
  const error = await asyncLifecycleError(() =>
    service("bmrcl", store).confirm(
      confirmRequest("bmrcl", [["I1", 1]], {
        transactionId: RIDE_TRANSACTION,
        payment: paidPayment(
          "30",
          [settlementTag(String(passOrder.id), totpCode(secret, ISSUED_AT.getTime()))],
        ),
      }),
    ),
  );
  assert.equal(error.code, "PASS-ORDER-NOT-FOUND");
});

test("a ride with no settlement tag is an ordinary full-fare sale", async () => {
  const fixture = await boughtPass();
  const order = await fixture.ride(undefined);
  assert.equal((order.payments as Array<any>)[0].params.amount, "27");
  assert.equal((order.payments as Array<any>)[0].tags, undefined);
});

test("a malformed settlement tag is refused", async () => {
  const fixture = await boughtPass();
  for (const list of [
    [{ descriptor: { code: "PASS_ORDER_ID" }, value: "SPECIMEN-ORD-BMTC-X" }],
    [{ descriptor: { code: "PASS_CODE" }, value: "123456" }],
    [],
  ]) {
    const error = await asyncLifecycleError(() =>
      fixture.ride([
        { descriptor: { code: "PASS_SETTLEMENT" }, display: false, list },
      ]),
    );
    assert.equal(error.code, "PASS-SETTLEMENT-INVALID");
  }
});

test("a pass purchase cannot itself be settled by a pass", async () => {
  const fixture = await boughtPass();
  const store = new InMemoryOrderStore();
  const error = await asyncLifecycleError(() =>
    service("bmtc", store).confirm(
      confirmRequest("bmtc", [["PASS-DAY-AC_BUS", 1]], {
        transactionId: RIDE_TRANSACTION,
        payment: paidPayment(
          "150",
          [settlementTag(fixture.passOrderId, fixture.code())],
        ),
      }),
    ),
  );
  assert.equal(error.code, "PASS-SETTLEMENT-INVALID");
  assert.match(error.message, /belongs on a single-journey order/);
});
