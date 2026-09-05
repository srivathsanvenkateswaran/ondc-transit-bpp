import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { createApp } from "../../src/app.js";
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
 */

const TRAVEL_DATE = "2026-09-30";
const ITEM = `RSV-2259BNGHMP-${TRAVEL_DATE}-PALLAKKI`;

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
  waitFor(action: string, count?: number): Promise<any>;
}

async function collector(): Promise<Collector> {
  const callbacks: Array<{ action: string; body: any }> = [];
  const waiters: Array<() => void> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    callbacks.push({ action: body.context.action, body });
    waiters.splice(0).forEach((resolve) => resolve());
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  const port = await listen(server);
  return {
    server,
    port,
    callbacks,
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
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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

test("the inbound endpoint dispatches on the action in the payload", async (t) => {
  // It exists for the same reason the two next door have one: the pinned
  // protocol server exposes one webhook per seller rather than one per action.
  const sink = await collector();
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
  const map = losers[0].body.message.tags[0];
  assert.equal(map.descriptor.code, "SEAT_MAP");
  assert.equal(
    map.list.find((entry: any) => entry.descriptor.code === "U3A").value,
    "HELD",
  );
});

test("a value a client should not have sent reaches no log line and no callback", async (t) => {
  // The test asserts on the log rather than only on the error, because the log
  // is where an identity document number would actually land.
  const sink = await collector();
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
  t.after(() => sink.server.close());
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
