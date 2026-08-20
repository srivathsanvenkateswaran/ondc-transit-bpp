import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createProtocolValidator } from "../../src/protocol/validate.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function text(path: string): string {
  return readFileSync(`${repositoryRoot}${path}`, "utf8");
}

function body(path: string): any {
  return JSON.parse(text(path));
}

function phase2(name: string): any {
  return body(`phase-2/evidence/${name}`);
}

function response(operator: "bmtc" | "bmrcl", action: string): any {
  return phase2(`${operator}-${action}-response.raw.json`).responses[0];
}

function request(operator: "bmtc" | "bmrcl", action: string): any {
  return phase2(`${operator}-${action}-request.json`);
}

function paise(value: string): number {
  const [rupees, fraction = ""] = value.split(".");
  return Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
}

test("captured registry lookup and provider health identify the live stack", () => {
  const health = phase2("provider-health.raw.json");
  assert.deepEqual(health, {
    status: "up",
    journeySource: "fixture",
    operators: ["bmtc", "bmrcl"],
  });

  const subscribers = phase2("registry-subscribers.raw.json");
  const subscribedIds = subscribers
    .filter((entry: any) => entry.status === "SUBSCRIBED")
    .map((entry: any) => entry.subscriber_id);
  for (const id of [
    "gateway",
    "bap.transit.localhost",
    "bmtc.bpp.transit.localhost",
    "bmrcl.bpp.transit.localhost",
  ]) {
    assert.ok(subscribedIds.includes(id), `missing registry subscriber ${id}`);
  }
});

test("broad search evidence has two distinct BPP callbacks", () => {
  const search = phase2("stack-smoke-search-response.raw.json");
  assert.equal(search.responses.length, 2);
  assert.deepEqual(
    new Set(search.responses.map((entry: any) => entry.context.bpp_id)),
    new Set([
      "bmtc.bpp.transit.localhost",
      "bmrcl.bpp.transit.localhost",
    ]),
  );
  assert.equal(
    new Set(search.responses.map((entry: any) => entry.context.transaction_id))
      .size,
    1,
  );
});

test("all captured Phase 2 callbacks pass the local TRV11 validators", () => {
  const validator = createProtocolValidator(
    `${repositoryRoot}schemas/ondc_trv11/2.0.1`,
  );
  const validations: Array<[string, { valid: boolean; errors: unknown[] }]> = [];
  for (const operator of ["bmtc", "bmrcl"] as const) {
    validations.push(["on_search", validator.onSearch(response(operator, "search"))]);
    validations.push(["on_select", validator.onSelect(response(operator, "select"))]);
    validations.push(["on_init", validator.onInit(response(operator, "init"))]);
    validations.push(["on_confirm", validator.onConfirm(response(operator, "confirm"))]);
    validations.push(["on_status", validator.onStatus(response(operator, "status"))]);
  }
  validations.push([
    "unknown item on_select",
    validator.onSelect(
      phase2("unknown-item-select-response.raw.json").responses[0],
    ),
  ]);

  for (const [name, result] of validations) {
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
  }
});

test("captured request and callback identities preserve correlation", () => {
  for (const operator of ["bmtc", "bmrcl"] as const) {
    const actions = ["search", "select", "init", "confirm", "status"];
    const requests = actions.map((action) => request(operator, action));
    const callbacks = actions.map((action) => response(operator, action));
    assert.equal(
      new Set(requests.map((entry) => entry.context.transaction_id)).size,
      1,
    );
    assert.equal(
      new Set(requests.map((entry) => entry.context.message_id)).size,
      actions.length,
    );
    requests.forEach((entry, index) => {
      assert.equal(
        callbacks[index].context.transaction_id,
        entry.context.transaction_id,
      );
      assert.equal(callbacks[index].context.message_id, entry.context.message_id);
    });
  }
});

test("captured quotes equal BASE_FARE sums with exact fixture paise", () => {
  const expected = { bmtc: 5_400, bmrcl: 3_000 };
  for (const operator of ["bmtc", "bmrcl"] as const) {
    const quote = response(operator, "select").message.order.quote;
    const total = paise(quote.price.value);
    const breakupTotal = quote.breakup.reduce(
      (sum: number, line: any) => sum + paise(line.price.value),
      0,
    );
    assert.ok(quote.breakup.every((line: any) => line.title === "BASE_FARE"));
    assert.equal(total, breakupTotal);
    assert.equal(total, expected[operator]);
  }
  assert.equal(
    paise(response("bmtc", "select").message.order.items[0].price.value),
    2_700,
  );
  assert.equal(
    paise(response("bmrcl", "select").message.order.items[0].price.value),
    3_000,
  );
});

test("captured confirmed orders contain distinct specimen PNG tickets", () => {
  const orders = [
    response("bmtc", "confirm").message.order,
    response("bmrcl", "confirm").message.order,
  ];
  assert.notEqual(orders[0].id, orders[1].id);
  assert.equal(orders[0].status, "ACTIVE");
  assert.equal(orders[1].status, "ACTIVE");

  const expectedTicketCounts = [2, 1];
  orders.forEach((order, orderIndex) => {
    assert.match(order.id, /^SPECIMEN-ORD-/);
    const tickets = order.fulfillments.filter(
      (fulfillment: any) => fulfillment.type === "TICKET",
    );
    assert.equal(tickets.length, expectedTicketCounts[orderIndex]);
    assert.equal(
      new Set(
        tickets.map((ticket: any) => ticket.stops[0].authorization.token),
      ).size,
      tickets.length,
    );
    tickets.forEach((ticket: any) => {
      const authorization = ticket.stops[0].authorization;
      assert.equal(authorization.type, "QR");
      assert.equal(authorization.status, "UNCLAIMED");
      assert.equal(Number.isNaN(Date.parse(authorization.valid_to)), false);
      assert.equal(
        Buffer.from(authorization.token, "base64").subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
      );
      const ticketInfo = ticket.tags.find(
        (tag: any) => tag.descriptor.code === "TICKET_INFO",
      );
      const number = ticketInfo.list.find(
        (entry: any) => entry.descriptor.code === "NUMBER",
      ).value;
      assert.match(number, /^SPECIMEN-/);
    });
    assert.ok(
      order.tags.some((tag: any) =>
        tag.list?.some((entry: any) =>
          String(entry.value).includes("SPECIMEN - NOT VALID FOR TRAVEL"),
        ),
      ),
    );
  });
});

test("captured status responses return the exact confirmed orders", () => {
  for (const operator of ["bmtc", "bmrcl"] as const) {
    assert.deepEqual(
      response(operator, "status").message.order,
      response(operator, "confirm").message.order,
    );
  }
});

test("malformed and unknown-item evidence are explicit errors", () => {
  const malformed = phase2("malformed-search-response.raw.json");
  assert.equal(malformed.message.ack.status, "NACK");
  assert.equal(malformed.error.type, "JSON-SCHEMA-ERROR");
  assert.equal(malformed.error.data[0].params.missingProperty, "domain");

  const unknown = phase2("unknown-item-select-response.raw.json").responses[0];
  assert.equal(unknown.error.code, "ITEM-NOT-FOUND");
  assert.deepEqual(unknown.message, {});
  assert.equal("quote" in unknown.message, false);
});

test("gateway and authentication artifacts prove routing and rejection", () => {
  const gateway = text("phase-2/evidence/gateway-stack-smoke.raw.txt");
  assert.match(gateway, /subscribers\/lookup/);
  assert.match(gateway, /bmtc\.bpp\.transit\.localhost/);
  assert.match(gateway, /bmrcl\.bpp\.transit\.localhost/);
  assert.match(gateway, /http:\/\/bmtc-bpp-network:6002\/search/);
  assert.match(gateway, /http:\/\/bmrcl-bpp-network:6102\/search/);

  const lifecycle = text("phase-2/evidence/gateway-phase2.raw.txt");
  assert.doesNotMatch(
    lifecycle,
    /bpp-network:\d+\/(select|init|confirm|status)/,
  );

  const wire = text("phase-1/evidence/auth-wire-request.txt");
  const tampered = text("phase-1/evidence/auth-tampered-response.raw.txt");
  assert.match(wire, /^Authorization: Signature /im);
  assert.match(tampered, /HTTP\/1\.1 401 Unauthorized/);
  assert.match(tampered, /"status":"NACK"/);
  assert.match(tampered, /Authentication failed/);
});

test("the two captured order totals sum without rounding drift", () => {
  const bus = paise(response("bmtc", "confirm").message.order.quote.price.value);
  const metro = paise(
    response("bmrcl", "confirm").message.order.quote.price.value,
  );
  assert.equal(bus + metro, 8_400);
});
