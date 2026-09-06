import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";

import { createApp } from "../../src/app.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
  reservedSearchRequest,
  reservedStatusRequest,
  testConfig,
} from "../helpers.js";

/**
 * The synchronous twin of `app.test.ts`'s beckn-style suite.
 *
 * Every one of those tests drives a callback sink on a second port and reads
 * the answer off `on_<action>` posts. This suite turns `reservedSyncResponses`
 * on instead and reads the same answer off the HTTP response to the action
 * itself - no sink, no second port, and `callbackUrl` is left pointing at a
 * port nothing listens on, because a sync deployment must never depend on it
 * being reachable.
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

async function post(port: number, path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function syncConfig() {
  return testConfig({
    reservedEnabled: true,
    reservedSyncResponses: true,
    reservedOperators: {
      ksrtc: {
        key: "ksrtc" as never,
        subscriberId: "ksrtc.provider.example.test",
        subscriberUri: "https://ksrtc-network.example.test",
        // Nothing listens here. A sync deployment answers on the open
        // connection and never dials this URL, so a working suite proves
        // that by never bringing the port up.
        callbackUrl: "http://127.0.0.1:1/on_search",
        callbackDelayMs: 0,
      },
    },
  });
}

test("a sync search answers with the catalogue on the same connection", async (t) => {
  const app = await createApp(syncConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const response = await post(
    port,
    "/ksrtc/search",
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.context.domain, "TRANSIT.LOCALHOST:INTERCITY");
  assert.equal(body.context.action, "on_search");
  assert.equal(body.context.bpp_id, "ksrtc.provider.example.test");
  assert.equal(body.message.catalog.providers[0].items[0].id, ITEM);
});

test("a malformed sync request is still refused at the envelope, not the connection", async (t) => {
  const app = await createApp(syncConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const body = structuredClone(reservedSearchRequest()) as any;
  delete body.message.intent.fulfillment.travel_date;
  const response = await post(port, "/ksrtc/search", body);
  assert.equal(response.status, 400);
  const payload = (await response.json()) as any;
  assert.equal(payload.message.ack.status, "NACK");
});

test("a full booking runs search through cancel entirely on sync responses", async (t) => {
  const app = await createApp(syncConfig(), {}, undefined, {
    now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
  });
  t.after(() => app.close());
  const port = await listen(app);

  const manifest = [
    { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
    { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
  ];

  const searched = await (
    await post(port, "/ksrtc/search", reservedSearchRequest({ travelDate: TRAVEL_DATE }))
  ).json() as any;
  assert.equal(searched.context.action, "on_search");
  assert.ok(searched.message.catalog.providers[0].items.some((item: any) => item.id === ITEM));

  const selectResponse = await post(
    port,
    "/ksrtc/select",
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A", "U3B"] }),
  );
  assert.equal(selectResponse.status, 200);
  const selected = (await selectResponse.json()) as any;
  assert.equal(selected.context.action, "on_select");
  assert.ok(
    selected.message.order.tags.some((tag: any) => tag.descriptor.code === "HOLD_INFO"),
  );

  const initResponse = await post(
    port,
    "/ksrtc/init",
    reservedOrderRequest("init", { itemId: ITEM, seatIds: ["U3A", "U3B"], manifest }),
  );
  assert.equal(initResponse.status, 200);
  assert.equal(((await initResponse.json()) as any).context.action, "on_init");

  const confirmResponse = await post(
    port,
    "/ksrtc/confirm",
    reservedOrderRequest("confirm", { itemId: ITEM, seatIds: ["U3A", "U3B"], manifest }),
  );
  assert.equal(confirmResponse.status, 200);
  const confirmed = (await confirmResponse.json()) as any;
  assert.equal(confirmed.context.action, "on_confirm");
  const orderId = confirmed.message.order.id;
  assert.ok(orderId);

  const statusResponse = await post(
    port,
    "/ksrtc/status",
    reservedStatusRequest({ orderId }),
  );
  assert.equal(statusResponse.status, 200);
  const read = (await statusResponse.json()) as any;
  assert.equal(read.context.action, "on_status");
  assert.equal(read.message.order.id, orderId);
  assert.equal(read.message.order.status, "ACTIVE");

  const cancelResponse = await post(
    port,
    "/ksrtc/cancel",
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }),
  );
  assert.equal(cancelResponse.status, 200);
  const quoted = (await cancelResponse.json()) as any;
  assert.equal(quoted.context.action, "on_cancel");
  assert.ok(quoted.message.refund);

  const quoteId = quoted.message.tags
    .find((tag: any) => tag.descriptor.code === "REFUND_SLAB")
    .list.find((entry: any) => entry.descriptor.code === "REFUND_QUOTE_ID").value;
  const confirmCancelResponse = await post(
    port,
    "/ksrtc/cancel",
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }),
  );
  assert.equal(confirmCancelResponse.status, 200);
  const cancelled = (await confirmCancelResponse.json()) as any;
  assert.equal(cancelled.context.action, "on_cancel");
  assert.equal(cancelled.message.order.status, "CANCELLED");
});

test("a sync refusal is answered inline too", async (t) => {
  const app = await createApp(syncConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const body = structuredClone(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }),
  ) as any;
  body.message.intent.fulfillment.stops[1].type = "START";
  const response = await post(port, "/ksrtc/search", body);
  assert.equal(response.status, 200);
  const refusal = (await response.json()) as any;
  assert.equal(refusal.error.code, "SERVICE-NOT-FOUND");
  assert.equal(refusal.message.catalog, undefined);
});
