import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../../src/app.js";
import { createReservedHandler } from "../../src/reserved/handler.js";
import { createReservedValidator } from "../../src/reserved/schema.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
  reservedSearchRequest,
  searchRequest,
  testConfig,
} from "../helpers.js";

/**
 * The third path over http, beside the two that were already there.
 *
 * What this asserts that the service-level tests cannot: that the routes only
 * exist when a deployment asked for them, that every callback this provider
 * generates passes its own schema before it is sent, that the acknowledgement
 * comes back on the open connection and the answer arrives separately, and
 * that a value a client should never have sent reaches no log line.
 *
 * The second of those was a claim this file made in prose and did not check.
 * It now checks it: the collector below validates every callback it receives
 * against the schema for that action, so a payload this provider cannot
 * express fails the test that received it rather than passing quietly. The
 * failure this closes is not cosmetic - a callback that fails its own schema
 * is not sent at all, so the client waits out its timeout against silence.
 */

const TRAVEL_DATE = "2026-09-30";
const ITEM = `RSV-2259BNGHMP-${TRAVEL_DATE}-PALLAKKI`;

const schemaRoot = fileURLToPath(
  new URL("../../schemas/transit_local_intercity/0.1.0", import.meta.url),
);
const validator = createReservedValidator(schemaRoot);

const CALLBACK_VALIDATORS: Record<string, (value: unknown) => { valid: boolean; errors: unknown[] }> =
  {
    on_search: validator.onSearch,
    on_select: validator.onSelect,
    on_init: validator.onInit,
    on_confirm: validator.onConfirm,
    on_status: validator.onStatus,
    on_cancel: validator.onCancel,
  };

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      resolve(address.port);
    });
  });
}

interface Collector {
  server: Server;
  port: number;
  callbacks: Array<{ action: string; body: any }>;
  /** Every callback that reached this sink but did not match its own schema. */
  invalid: Array<{ action: string; errors: unknown }>;
  waitFor(action: string, count?: number): Promise<any>;
  /** Fails the test if anything this sink received was unpublishable. */
  assertAllValid(): void;
}

async function collector(): Promise<Collector> {
  const callbacks: Array<{ action: string; body: any }> = [];
  const invalid: Array<{ action: string; errors: unknown }> = [];
  const waiters: Array<() => void> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const action = body.context.action as string;
    // Every reserved callback is checked here, so a shape this provider cannot
    // express is caught by whichever test happened to drive it rather than by
    // nobody. The two categories next door post to this sink too and have
    // their own schema tree; they are left alone.
    const validate = CALLBACK_VALIDATORS[action];
    if (validate && body.context.domain === "TRANSIT.LOCALHOST:INTERCITY") {
      const result = validate(body);
      if (!result.valid) invalid.push({ action, errors: result.errors });
    }
    callbacks.push({ action, body });
    waiters.splice(0).forEach((resolve) => resolve());
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  const port = await listen(server);
  return {
    server,
    port,
    callbacks,
    invalid,
    async waitFor(action: string, count = 1) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const matching = callbacks.filter(
          (callback) => callback.action === action,
        );
        if (matching.length >= count) return matching[count - 1].body;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 10);
        });
      }
      throw new Error(`No ${action} callback arrived`);
    },
    assertAllValid() {
      assert.deepEqual(
        invalid,
        [],
        "a callback reached the wire without matching its own schema",
      );
    },
  };
}

function reservedConfig(callbackPort: number, events: Array<Record<string, unknown>>) {
  const config = testConfig({
    reservedEnabled: true,
    reservedOperators: {
      ksrtc: {
        key: "ksrtc" as never,
        subscriberId: "ksrtc.provider.example.test",
        subscriberUri: "https://ksrtc-network.example.test",
        callbackUrl: `http://127.0.0.1:${callbackPort}/on_search`,
        callbackDelayMs: 0,
      },
    },
  });
  return { config, events };
}

async function post(port: number, path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the reserved routes do not exist unless a deployment asked for them", async (t) => {
  // A second domain means a second registry subscription and a second gateway
  // routing entry, neither of which an existing deployment has.
  const app = await createApp(testConfig());
  t.after(() => app.close());
  const port = await listen(app);
  const response = await post(port, "/ksrtc/search", reservedSearchRequest());
  assert.equal(response.status, 404);
  const index = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  assert.equal((index as any).endpoints.ksrtc, undefined);
});

test("a search acknowledges at once and answers on a separate connection", async (t) => {
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const events: Array<Record<string, unknown>> = [];
  const { config } = reservedConfig(sink.port, events);
  const app = await createApp(config, {}, (event) => events.push(event));
  t.after(() => app.close());
  const port = await listen(app);

  const response = await post(
    port,
    "/ksrtc/search",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { message: { ack: { status: "ACK" } } });

  const callback = await sink.waitFor("on_search");
  assert.equal(callback.context.domain, "TRANSIT.LOCALHOST:INTERCITY");
  assert.equal(callback.context.version, "0.1.0");
  assert.equal(callback.context.bpp_id, "ksrtc.provider.example.test");
  assert.equal(callback.message.catalog.providers[0].items[0].id, ITEM);
  // The index lists the endpoints once they exist.
  const index = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  assert.ok((index as any).endpoints.ksrtc.includes("POST /ksrtc/cancel"));
});

test("a malformed reserved request is refused at the envelope and answers nothing", async (t) => {
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);

  const body = structuredClone(reservedSearchRequest()) as any;
  delete body.message.intent.fulfillment.travel_date;
  const response = await post(port, "/ksrtc/search", body);
  assert.equal(response.status, 400);
  const payload = (await response.json()) as any;
  assert.equal(payload.message.ack.status, "NACK");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sink.callbacks, []);
});

test("one transaction id runs byte-identical through every hop of a booking", async (t) => {
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const events: Array<Record<string, unknown>> = [];
  const { config } = reservedConfig(sink.port, events);
  const app = await createApp(config, {}, (event) => events.push(event), {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  const manifest = [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
  ];
  await post(
    port,
    "/ksrtc/search",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  );
  await sink.waitFor("on_search");
  await post(
    port,
    "/ksrtc/select",
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A", "U3B"] }),
  );
  const selected = await sink.waitFor("on_select");
  await post(
    port,
    "/ksrtc/init",
    reservedOrderRequest("init", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest,
    }),
  );
  await sink.waitFor("on_init");
  await post(
    port,
    "/ksrtc/confirm",
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["U3A", "U3B"],
      manifest,
    }),
  );
  const confirmed = await sink.waitFor("on_confirm");
  await post(
    port,
    "/ksrtc/cancel",
    reservedCancelRequest({
      orderId: confirmed.message.order.id,
      code: "SOFT_CANCEL",
    }),
  );
  const quoted = await sink.waitFor("on_cancel");

  const transactionIds = new Set(
    sink.callbacks.map((callback) => callback.body.context.transaction_id),
  );
  assert.deepEqual([...transactionIds], [
    "0b0e1f6a-5c47-4d19-9a2f-3c8b1d6e7f01",
  ]);
  assert.ok(selected.message.order.tags.some((tag: any) => tag.descriptor.code === "HOLD_INFO"));
  assert.equal(quoted.message.refund.price.value, "1030");
});

test("cancelling the whole booking is answered, not left to time out", async (t) => {
  // The defect this test exists for. `CONFIRM_CANCEL` over every seat left the
  // rewritten order with an empty `SEATS` list and an empty `MANIFEST` list,
  // both of which this domain's schema forbids, so the generated `on_cancel`
  // was refused by the provider's own validator, never sent, and logged. The
  // client had no answer at all and waited out its timeout.
  //
  // Nothing in the suite could see it: `cancellation.test` calls
  // `orders.cancel` directly and validates no callback, and the http cancel
  // test above stops at `SOFT_CANCEL`, which leaves the booking untouched.
  // Partial cancellation always left a seat behind, so it always worked.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config, {}, () => {}, {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  const seatIds = ["U3A", "U3B"];
  const manifest = [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
  ];
  await post(
    port,
    "/ksrtc/select",
    reservedOrderRequest("select", { itemId: ITEM, seatIds }),
  );
  await sink.waitFor("on_select");
  await post(
    port,
    "/ksrtc/confirm",
    reservedOrderRequest("confirm", { itemId: ITEM, seatIds, manifest }),
  );
  const confirmed = await sink.waitFor("on_confirm");
  const orderId = confirmed.message.order.id;

  // No `SEATS` tag on the cancel, which means the whole booking.
  await post(
    port,
    "/ksrtc/cancel",
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }),
  );
  const quoted = await sink.waitFor("on_cancel");
  const quoteId = quoted.message.tags
    .find((tag: any) => tag.descriptor.code === "REFUND_SLAB")
    .list.find((entry: any) => entry.descriptor.code === "REFUND_QUOTE_ID").value;

  await post(
    port,
    "/ksrtc/cancel",
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }),
  );
  // The assertion is that this returns at all. It used to throw
  // `No on_cancel callback arrived`.
  const committed = await sink.waitFor("on_cancel", 2);
  assert.equal(committed.error, undefined);
  assert.equal(committed.message.order.status, "CANCELLED");
  const codes = committed.message.order.tags.map(
    (tag: any) => tag.descriptor.code,
  );
  assert.equal(codes.includes("SEATS"), false);
  assert.deepEqual(
    committed.message.order.tags
      .find((tag: any) => tag.descriptor.code === "CANCELLED_SEATS")
      .list.map((entry: any) => entry.value),
    seatIds,
  );

  // And the booking reads back the same way, because the answered order is
  // the stored one.
  await post(port, "/ksrtc/status", {
    ...reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }),
    context: {
      ...reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }).context,
      action: "status",
    },
    message: { order_id: orderId },
  });
  const read = await sink.waitFor("on_status");
  assert.equal(read.message.order.status, "CANCELLED");
});

test("a search this provider refuses is answered with the refusal", async (t) => {
  // The same defect as the whole-booking cancellation, on a different action,
  // and found by writing the test above. `on_search` was the one callback
  // document in this tree that required `message.catalog` unconditionally and
  // had no branch for an error, so a refused search produced a callback that
  // failed this provider's own schema and was never sent.
  //
  // The refusal is reachable: two stops of the same type satisfy the request
  // schema, which constrains the count and the enum but not the pairing, and
  // `reservedSearchQuery` then has no destination to look up.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);

  const body = structuredClone(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  ) as any;
  body.message.intent.fulfillment.stops[1].type = "START";
  const response = await post(port, "/ksrtc/search", body);
  assert.equal(response.status, 202);

  const refusal = await sink.waitFor("on_search");
  assert.equal(refusal.error.code, "SERVICE-NOT-FOUND");
  assert.equal(refusal.message.catalog, undefined);
});

test("a callback this provider cannot express is answered, not swallowed", async (t) => {
  // The general form of the cancellation defect, driven directly rather than
  // through a bug. Whatever makes a generated callback unpublishable, the
  // client must still receive something: silence is indistinguishable from a
  // provider that has died, and the client's only recourse is its own timeout.
  //
  // The answer is `INTERNAL-ERROR`, which is now a declared code, and its
  // message deliberately does not say nothing happened. The cancellation this
  // replaced had already committed before it discovered it could not say so.
  const sink = await collector();
  t.after(() => sink.server.close());
  const events: Array<Record<string, unknown>> = [];
  // Refuses the answer this provider built, then behaves normally, which is
  // the real shape of the failure: something in a generated payload does not
  // match, and the minimal refusal that replaces it does.
  let refusalsLeft = 1;
  const refuseTheFirstAnswer = {
    ...validator,
    onSearch: (value: unknown) => {
      if (refusalsLeft > 0) {
        refusalsLeft -= 1;
        return { valid: false, errors: [{ message: "unpublishable" }] };
      }
      return validator.onSearch(value);
    },
  } as never;

  const handler = createReservedHandler({
    orders: {
      async search() {
        return { catalog: {} };
      },
    } as never,
    validator: refuseTheFirstAnswer,
    runtime: {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
      callbackUrl: `http://127.0.0.1:${sink.port}/on_search`,
      callbackDelayMs: 0,
    },
    contextTtl: "PT30S",
    callbackTimeoutMs: 2_000,
    logEvent: (event) => events.push(event),
  });
  await handler.handle(
    "search",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
    undefined as never,
    () => {},
  );
  const answer = await sink.waitFor("on_search");

  assert.equal(answer.error.code, "INTERNAL-ERROR");
  // Not a reassurance. The provider does not know whether the action took
  // effect, and a client told "nothing was charged" would be told something
  // this message cannot support.
  assert.equal(/nothing/i.test(answer.error.message), false);
  assert.match(answer.error.message, /status/);
  assert.equal(answer.message.order, undefined);
  // The schema failure is still logged, beside the answer rather than instead
  // of it.
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "SCHEMA_ERROR" &&
        String(event.error).includes("failed schema validation"),
    ),
  );
  // And the last resort validates against the real schema, which is what makes
  // it sendable at all.
  assert.equal(validator.onSearch(answer).valid, true);
});

test("the inbound endpoint dispatches on the action in the payload", async (t) => {
  // It exists for the same reason the two next door have one: the pinned
  // protocol server exposes one webhook per seller rather than one per action.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);

  const response = await post(
    port,
    "/ksrtc/inbound",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  );
  assert.equal(response.status, 202);
  assert.ok(await sink.waitFor("on_search"));
});

test("two selects racing for one berth, driven concurrently at one instance", async (t) => {
  // The layer the existing suite has no equivalent of, because nothing before
  // this could be contended. Exactly one wins, the other is told which seat
  // went, and the map the loser gets back already shows the winner's hold.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config, {}, () => {}, {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  await Promise.all([
    post(
      port,
      "/ksrtc/select",
      reservedOrderRequest("select", {
        itemId: ITEM,
        seatIds: ["U3A"],
        transactionId: "tx-one",
      }),
    ),
    post(
      port,
      "/ksrtc/select",
      reservedOrderRequest("select", {
        itemId: ITEM,
        seatIds: ["U3A"],
        transactionId: "tx-two",
      }),
    ),
  ]);
  await sink.waitFor("on_select", 2);
  const answers = sink.callbacks.filter(
    (callback) => callback.action === "on_select",
  );
  const winners = answers.filter((answer) => !answer.body.error);
  const losers = answers.filter((answer) => answer.body.error);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].body.error.code, "SEAT-UNAVAILABLE");
  assert.match(losers[0].body.error.message, /U3A/);
  const tagOf = (code: string) =>
    losers[0].body.message.tags.find((tag: any) => tag.descriptor.code === code);
  // The seat that went, as data. It was computed and then dropped on the way
  // out, so the only machine-readable trace of which seat the loser lost was
  // the difference between two seat maps it may never have held.
  assert.deepEqual(
    tagOf("UNAVAILABLE_SEATS").list.map((entry: any) => entry.value),
    ["U3A"],
  );
  const map = tagOf("SEAT_MAP");
  assert.equal(
    map.list.find((entry: any) => entry.descriptor.code === "U3A").value,
    "HELD",
  );
});

test("a value a client should not have sent reaches no log line and no callback", async (t) => {
  // The test asserts on the log rather than only on the error, because the log
  // is where an identity document number would actually land.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const events: Array<Record<string, unknown>> = [];
  const { config } = reservedConfig(sink.port, events);
  const app = await createApp(config, {}, (event) => events.push(event), {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  await post(
    port,
    "/ksrtc/select",
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A"] }),
  );
  await sink.waitFor("on_select");
  await post(
    port,
    "/ksrtc/init",
    reservedOrderRequest("init", {
      itemId: ITEM,
      seatIds: ["U3A"],
      manifest: [
        {
          seatId: "U3A",
          name: "A Passenger",
          gender: "female",
          extra: [{ code: "DOCUMENT_NUMBER", value: "S1234567" }],
        },
      ],
    }),
  );
  const refused = await sink.waitFor("on_init");
  assert.equal(refused.error.code, "MANIFEST-FIELD-NOT-ACCEPTED");
  assert.match(refused.error.message, /DOCUMENT_NUMBER/);
  assert.equal(JSON.stringify(refused).includes("S1234567"), false);
  assert.equal(JSON.stringify(events).includes("S1234567"), false);
});

test("the terms page publishes the slabs a cancellation quote names", async (t) => {
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);
  const terms = (await (await fetch(`http://127.0.0.1:${port}/terms`)).json()) as any;
  assert.deepEqual(
    terms.reservedCancellation.slabs.map((slab: any) => slab.code),
    ["OVER_72H", "72H_TO_24H", "24H_TO_2H", "UNDER_2H"],
  );
  assert.match(terms.reservedCancellation.money, /No money moves/);
});

test("the inspection endpoint answers for a reserved booking, manifest and all", async (t) => {
  // Bearer gated and off unless a token is set, exactly as before. What
  // changes is what is behind it: no longer only credentials this stack
  // minted, but names people gave it.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config, {}, () => {}, {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  const manifest = [{ seatId: "U3A", name: "A Passenger", gender: "female" }];
  await post(
    port,
    "/ksrtc/select",
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A"] }),
  );
  await sink.waitFor("on_select");
  await post(
    port,
    "/ksrtc/confirm",
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["U3A"],
      manifest,
    }),
  );
  const confirmed = await sink.waitFor("on_confirm");
  const orderId = confirmed.message.order.id;

  const unauthorized = await fetch(
    `http://127.0.0.1:${port}/orders/${encodeURIComponent(orderId)}`,
  );
  assert.equal(unauthorized.status, 401);

  const response = await fetch(
    `http://127.0.0.1:${port}/orders/${encodeURIComponent(orderId)}`,
    { headers: { authorization: `Bearer ${config.orderInspectionToken}` } },
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes("A Passenger"), true);
});

test("neither domain's search can be answered by the other's seller", async (t) => {
  // The module-boundary guards are greps over source; this is the same
  // boundary asserted over the wire. A category leaking either way is the
  // failure, so both directions are driven.
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);

  const reservedAtBus = await post(
    port,
    "/bmtc/search",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  );
  assert.equal(reservedAtBus.status, 400);
  const busAtReserved = await post(port, "/ksrtc/search", searchRequest("BUS"));
  assert.equal(busAtReserved.status, 400);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sink.callbacks, []);
});

test("the two existing categories are unchanged by the third being on", async (t) => {
  const sink = await collector();
  t.after(() => {
    sink.server.close();
    sink.assertAllValid();
  });
  const { config } = reservedConfig(sink.port, []);
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${sink.port}/on_search`;
  const app = await createApp(config);
  t.after(() => app.close());
  const port = await listen(app);

  const response = await post(port, "/bmtc/search", searchRequest("BUS"));
  assert.equal(response.status, 202);
  const callback = await sink.waitFor("on_search");
  assert.equal(callback.context.domain, "ONDC:TRV11");
  assert.equal(callback.message.catalog.providers[0].items[0].price.value, "27");
  // No reserved item can reach a catalogue that claims conformance to a
  // published specification.
  assert.equal(JSON.stringify(callback).includes("RSV-"), false);
  assert.equal(JSON.stringify(callback).includes("RESERVATION"), false);
});
