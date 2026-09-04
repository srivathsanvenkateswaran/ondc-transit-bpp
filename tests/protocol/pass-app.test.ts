import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createApp } from "../../src/app.js";
import { passSearchRequest, searchRequest, testConfig } from "../helpers.js";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      resolve(address.port);
    });
  });
}

function callbackCollector() {
  let resolveCallback!: (value: any) => void;
  const body = new Promise<any>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    resolveCallback(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
  });
  return { server, body };
}

for (const [operatorKey, expectedCount] of [
  ["bmtc", 6],
  ["bmrcl", 3],
] as const) {
  test(`a stopless PASS search reaches ${operatorKey} and returns its catalogue`, async (t) => {
    const { server: callbackServer, body: callbackBody } = callbackCollector();
    t.after(() => callbackServer.close());
    const callbackPort = await listen(callbackServer);

    const config = testConfig();
    config.operators[operatorKey].callbackUrl =
      `http://127.0.0.1:${callbackPort}/on_search`;
    const app = await createApp(config);
    t.after(() => app.close());
    const appPort = await listen(app);

    const response = await fetch(
      `http://127.0.0.1:${appPort}/${operatorKey}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(passSearchRequest()),
      },
    );
    // The intent carries no fulfillment at all, and this is not a NACK.
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      message: { ack: { status: "ACK" } },
    });

    const callback = await callbackBody;
    assert.equal(callback.context.action, "on_search");
    assert.equal(
      callback.context.bpp_id,
      config.operators[operatorKey].subscriberId,
    );
    const provider = callback.message.catalog.providers[0];
    assert.equal(provider.items.length, expectedCount);
    provider.items.forEach((item: any) => {
      assert.deepEqual(item.category_ids, ["C2"]);
      assert.equal(item.descriptor.code, "PASS");
    });
  });
}

test("a stop-pair search still answers with TICKET-category items only", async (t) => {
  const { server: callbackServer, body: callbackBody } = callbackCollector();
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);

  await fetch(`http://127.0.0.1:${appPort}/bmtc/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(searchRequest("BUS")),
  });
  const provider = (await callbackBody).message.catalog.providers[0];
  assert.deepEqual(provider.categories, [
    { id: "C1", descriptor: { name: "Ticket", code: "TICKET" } },
  ]);
  provider.items.forEach((item: any) => {
    assert.deepEqual(item.category_ids, ["C1"]);
    assert.equal(item.descriptor.code, "SJT");
  });
  provider.fulfillments.forEach((fulfillment: any) => {
    assert.equal(fulfillment.type, "TRIP");
  });
});

test("an intent naming neither stops nor a category is still a NACK", async (t) => {
  const config = testConfig();
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);

  const body = structuredClone(passSearchRequest()) as any;
  delete body.message.intent.category;

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

test("a full pass purchase runs the ordinary lifecycle end to end", async (t) => {
  const callbacks: any[] = [];
  let expected = 0;
  let resolveAll!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    callbacks.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: { ack: { status: "ACK" } } }));
    if (callbacks.length >= expected) resolveAll();
  });
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);

  const search = passSearchRequest();
  const runtime = config.operators.bmtc;
  const orderContext = (action: string) => ({
    ...search.context,
    action,
    bpp_id: runtime.subscriberId,
    bpp_uri: runtime.subscriberUri,
    message_id: `${action}-message-id`,
    ttl: "PT30S",
  });
  const items = [
    { id: "PASS-MONTHLY-AC_BUS", quantity: { selected: { count: 1 } } },
  ];
  const tags = [
    {
      descriptor: { code: "CONCESSION" },
      display: false,
      list: [{ descriptor: { code: "CLASS" }, value: "STUDENT" }],
    },
  ];
  const billing = { name: "Specimen Rider", phone: "+910000000000" };

  const bodies: Array<[string, unknown]> = [
    ["search", search],
    [
      "select",
      {
        context: orderContext("select"),
        message: { order: { items, provider: { id: "P1" }, tags } },
      },
    ],
    [
      "init",
      {
        context: orderContext("init"),
        message: {
          order: {
            items,
            provider: { id: "P1" },
            billing,
            payments: [
              { collected_by: "BAP", status: "NOT_PAID", type: "PRE_ORDER" },
            ],
            tags,
          },
        },
      },
    ],
    [
      "confirm",
      {
        context: orderContext("confirm"),
        message: {
          order: {
            items,
            provider: { id: "P1" },
            billing,
            payments: [
              {
                id: "PAY-SPECIMEN-1",
                collected_by: "BAP",
                status: "PAID",
                type: "PRE_ORDER",
                params: {
                  transaction_id: "PAY-SPECIMEN-TXN",
                  currency: "INR",
                  amount: "1809",
                },
              },
            ],
            tags,
          },
        },
      },
    ],
  ];
  expected = bodies.length;

  for (const [action, body] of bodies) {
    const response = await fetch(`http://127.0.0.1:${appPort}/bmtc/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 202, `${action} was not ACKed`);
  }
  await allArrived;

  const byAction = new Map(
    callbacks.map((callback) => [callback.context.action, callback]),
  );
  assert.deepEqual(
    [...byAction.keys()].sort(),
    ["on_confirm", "on_init", "on_search", "on_select"],
  );
  for (const callback of callbacks) {
    assert.equal(callback.error, undefined, JSON.stringify(callback.error));
  }

  // The discounted quote is the same at every step.
  assert.equal(byAction.get("on_select").message.order.quote.price.value, "1809");
  assert.equal(byAction.get("on_init").message.order.quote.price.value, "1809");

  const order = byAction.get("on_confirm").message.order;
  assert.equal(order.status, "ACTIVE");
  const credential = order.fulfillments.find(
    (fulfillment: any) => fulfillment.stops?.[0]?.authorization?.type === "TOTP",
  );
  assert.ok(credential, "on_confirm carried no rotating credential");
  assert.match(credential.stops[0].authorization.token, /^[A-Z2-7]{32}$/);
  assert.equal(credential.stops[0].authorization.status, "ISSUED");
  assert.deepEqual(
    order.tags.map((tag: any) => tag.descriptor.code),
    ["SPECIMEN_INFO", "CONCESSION", "SYNTHETIC_PASS_INFO"],
  );
});

test("a refused concession class arrives as an on_select error, not a dropped callback", async (t) => {
  const { server: callbackServer, body: callbackBody } = callbackCollector();
  t.after(() => callbackServer.close());
  const callbackPort = await listen(callbackServer);

  const config = testConfig();
  config.operators.bmtc.callbackUrl = `http://127.0.0.1:${callbackPort}/on_search`;
  const app = await createApp(config);
  t.after(() => app.close());
  const appPort = await listen(app);

  const runtime = config.operators.bmtc;
  const response = await fetch(`http://127.0.0.1:${appPort}/bmtc/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: {
        ...passSearchRequest().context,
        action: "select",
        bpp_id: runtime.subscriberId,
        bpp_uri: runtime.subscriberUri,
        ttl: "PT30S",
      },
      message: {
        order: {
          items: [
            { id: "PASS-MONTHLY-AC_BUS", quantity: { selected: { count: 1 } } },
          ],
          provider: { id: "P1" },
          tags: [
            {
              descriptor: { code: "CONCESSION" },
              display: false,
              list: [{ descriptor: { code: "CLASS" }, value: "CHILD" }],
            },
          ],
        },
      },
    }),
  });
  assert.equal(response.status, 202);

  const callback = await callbackBody;
  assert.equal(callback.context.action, "on_select");
  assert.equal(callback.message.order, undefined);
  assert.equal(callback.error.code, "CONCESSION-RATE-NOT-PUBLISHED");
  assert.match(callback.error.message, /No CHILD_DISCOUNT_PERCENT rate is published/);
});
