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
