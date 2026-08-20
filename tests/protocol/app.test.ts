import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createApp } from "../../src/app.js";
import { searchRequest, testConfig } from "../helpers.js";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      resolve(address.port);
    });
  });
}

test("search ACKs immediately and dispatches a validated on_search callback", async (t) => {
  let resolveCallback!: (value: any) => void;
  const callbackBody = new Promise<any>((resolve) => {
    resolveCallback = resolve;
  });
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    resolveCallback(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);

  const response = await fetch(`http://127.0.0.1:${appPort}/bmtc/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(searchRequest("BUS")),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { message: { ack: { status: "ACK" } } });

  const callback = await callbackBody;
  assert.equal(callback.context.action, "on_search");
  assert.equal(callback.context.bpp_id, config.operators.bmtc.subscriberId);
  assert.equal(callback.message.catalog.providers[0].items[0].price.value, "27");
});

test("malformed search returns NACK and sends no callback", async (t) => {
  const config = testConfig();
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);
  const body = structuredClone(searchRequest("BUS")) as any;
  delete body.context.domain;

  const response = await fetch(`http://127.0.0.1:${appPort}/bmtc/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 400);
  const result = (await response.json()) as any;
  assert.equal(result.message.ack.status, "NACK");
  assert.equal(result.error.type, "JSON-SCHEMA-ERROR");
});

test("category mismatch logs SKIPPED and dispatches no callback", async (t) => {
  let callbackCount = 0;
  const callbackServer = createServer((_request, response) => {
    callbackCount += 1;
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const events: Record<string, unknown>[] = [];
  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config, {}, (event) => events.push(event));
  t.after(() => app.close());
  const appPort = await listen(app);

  const response = await fetch(`http://127.0.0.1:${appPort}/bmtc/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(searchRequest("METRO")),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { message: { ack: { status: "ACK" } } });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(callbackCount, 0);
  assert.deepEqual(events, [
    {
      transaction_id: searchRequest("METRO").context.transaction_id,
      message_id: searchRequest("METRO").context.message_id,
      action: "search",
      subscriber_id: config.operators.bmtc.subscriberId,
      operator: "bmtc",
      outcome: "SKIPPED",
      reason: "Requested vehicle category METRO; expected BUS",
      requested_category: "METRO",
      expected_category: "BUS",
    },
  ]);
});

test("provider serves the complete order lifecycle and stable status", async (t) => {
  let callbackResolver: ((value: { path: string; body: any }) => void) | undefined;
  const expectCallback = () =>
    new Promise<{ path: string; body: any }>((resolve) => {
      callbackResolver = resolve;
    });
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const callback = {
      path: request.url ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    callbackResolver?.(callback);
    callbackResolver = undefined;
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const events: Record<string, unknown>[] = [];
  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config, {}, (event) => events.push(event));
  t.after(() => app.close());
  const appPort = await listen(app);

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), ackBody);
  };
  const baseContext = searchRequest("BUS").context;
  const addressedContext = (action: string, messageId: string) => ({
    ...baseContext,
    action,
    message_id: messageId,
    bpp_id: config.operators.bmtc.subscriberId,
    bpp_uri: config.operators.bmtc.subscriberUri,
  });

  let callbackPromise = expectCallback();
  await post("/bmtc/search", searchRequest("BUS"));
  const onSearch = await callbackPromise;
  assert.equal(onSearch.path, "/on_search");
  assert.equal(onSearch.body.context.bpp_id, config.operators.bmtc.subscriberId);

  const unknownSelect = {
    context: addressedContext("select", "select-unknown-message"),
    message: {
      order: {
        items: [{ id: "UNKNOWN", quantity: { selected: { count: 1 } } }],
        provider: { id: "P1" },
      },
    },
  };
  callbackPromise = expectCallback();
  await post("/bmtc/inbound", unknownSelect);
  const unknownCallback = await callbackPromise;
  assert.equal(unknownCallback.path, "/on_select");
  assert.equal(unknownCallback.body.error.code, "ITEM-NOT-FOUND");
  assert.deepEqual(unknownCallback.body.message, {});

  const select = {
    context: addressedContext("select", "select-message"),
    message: {
      order: {
        items: [{ id: "I1", quantity: { selected: { count: 2 } } }],
        provider: { id: "P1" },
      },
    },
  };
  callbackPromise = expectCallback();
  await post("/bmtc/select", select);
  const onSelect = await callbackPromise;
  assert.equal(onSelect.path, "/on_select");
  assert.equal(onSelect.body.context.message_id, "select-message");
  assert.equal(onSelect.body.message.order.quote.price.value, "54");
  assert.equal(
    onSelect.body.message.order.quote.breakup.reduce(
      (sum: number, line: any) => sum + Number(line.price.value),
      0,
    ),
    Number(onSelect.body.message.order.quote.price.value),
  );

  const init = {
    context: addressedContext("init", "init-message"),
    message: {
      order: {
        ...select.message.order,
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [
          { collected_by: "BAP", status: "NOT_PAID", type: "PRE_ORDER" },
        ],
      },
    },
  };
  callbackPromise = expectCallback();
  await post("/bmtc/inbound", init);
  const onInit = await callbackPromise;
  assert.equal(onInit.path, "/on_init");
  assert.equal(onInit.body.context.message_id, "init-message");
  assert.notEqual(onInit.body.context.message_id, onSelect.body.context.message_id);
  assert.equal(onInit.body.message.order.quote.price.value, "54");

  const confirm = {
    context: addressedContext("confirm", "confirm-message"),
    message: {
      order: {
        ...select.message.order,
        billing: init.message.order.billing,
        payments: [
          {
            id: "SPECIMEN-PAYMENT",
            collected_by: "BAP",
            status: "PAID",
            type: "PRE_ORDER",
            params: {
              transaction_id: "SPECIMEN-PAYMENT-TRANSACTION",
              currency: "INR",
              amount: "54",
            },
          },
        ],
      },
    },
  };
  callbackPromise = expectCallback();
  await post("/bmtc/confirm", confirm);
  const onConfirm = await callbackPromise;
  const confirmed = onConfirm.body.message.order;
  assert.equal(onConfirm.path, "/on_confirm");
  assert.equal(confirmed.status, "ACTIVE");
  assert.match(confirmed.id, /^SPECIMEN-ORD-BMTC-/);
  const tickets = confirmed.fulfillments.filter(
    (fulfillment: any) => fulfillment.type === "TICKET",
  );
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].stops[0].authorization.type, "QR");
  assert.ok(tickets[0].stops[0].authorization.token);
  assert.equal(
    Number.isNaN(Date.parse(tickets[0].stops[0].authorization.valid_to)),
    false,
  );

  const status = {
    context: addressedContext("status", "status-message"),
    message: { order_id: confirmed.id },
  };
  callbackPromise = expectCallback();
  await post("/bmtc/inbound", status);
  const onStatus = await callbackPromise;
  assert.equal(onStatus.path, "/on_status");
  assert.deepEqual(onStatus.body.message.order, confirmed);

  const inspection = await fetch(
    `http://127.0.0.1:${appPort}/orders/${encodeURIComponent(confirmed.id)}`,
  );
  assert.equal(inspection.status, 200);
  assert.deepEqual(await inspection.json(), confirmed);
  assert.ok(
    events.every(
      (event) =>
        event.transaction_id === baseContext.transaction_id &&
        typeof event.message_id === "string" &&
        typeof event.action === "string" &&
        event.subscriber_id === config.operators.bmtc.subscriberId &&
        typeof event.outcome === "string",
    ),
  );
});

const ackBody = { message: { ack: { status: "ACK" } } };
