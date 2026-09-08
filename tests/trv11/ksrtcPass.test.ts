import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createApp } from "../../src/app.js";
import { KSRTC_PASS_TEST_OPERATOR, passSearchRequest, testConfig } from "../helpers.js";

/**
 * Karnataka Sarige's own direct pass path, proved the same way
 * `tests/protocol/pass-app.test.ts` proves bmtc's and bmrcl's: a real
 * `createApp` server, real HTTP, no mocked transport. The one structural
 * difference from that file is that nothing here waits for a callback -
 * `/ksrtc/pass/*` answers on the same connection, so a `fetch` response *is*
 * the `on_<action>` payload.
 */

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      resolve(address.port);
    });
  });
}

function ksrtcConfig() {
  return testConfig({
    ksrtcPassEnabled: true,
    ksrtcPassOperator: KSRTC_PASS_TEST_OPERATOR,
  });
}

function post(port: number, path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function trv11Context(action: string, transactionId: string, messageId: string) {
  return {
    domain: "ONDC:TRV11",
    location: { country: { code: "IND" }, city: { code: "std:080" } },
    action,
    version: "2.0.1",
    bap_id: "bap.example.test",
    bap_uri: "https://bap.example.test",
    bpp_id: KSRTC_PASS_TEST_OPERATOR.subscriberId,
    bpp_uri: KSRTC_PASS_TEST_OPERATOR.subscriberUri,
    transaction_id: transactionId,
    message_id: messageId,
    timestamp: "2026-09-08T06:00:00.000Z",
    ttl: "PT30S",
  };
}

test("the route answers 404 while KSRTC_PASS_ENABLED is off, the default", async (t) => {
  const app = await createApp(testConfig());
  t.after(() => app.close());
  const port = await listen(app);
  const response = await post(port, "/ksrtc/pass/search", passSearchRequest());
  assert.equal(response.status, 404);
});

test("search answers synchronously with Karnataka Sarige's own two items", async (t) => {
  const app = await createApp(ksrtcConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const response = await post(port, "/ksrtc/pass/search", passSearchRequest());
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.context.action, "on_search");
  assert.equal(body.context.bpp_id, KSRTC_PASS_TEST_OPERATOR.subscriberId);

  const provider = body.message.catalog.providers[0];
  assert.equal(provider.descriptor.name, "Karnataka State Road Transport Corporation");
  const items = [...provider.items].sort((a: any, b: any) => a.id.localeCompare(b.id));
  assert.deepEqual(
    items.map((item: any) => item.id),
    ["PASS-DAY-KSRTC_SARIGE", "PASS-MONTHLY-KSRTC_SARIGE"],
  );
  assert.equal(items[0].price.value, "237.50");
  assert.equal(items[1].price.value, "4275");
  for (const item of items) {
    const scopeTag = item.tags
      .find((t: any) => t.descriptor.code === "PASS_INFO")
      .list.find((v: any) => v.descriptor.code === "SCOPE");
    assert.equal(scopeTag.value, "KSRTC_SARIGE");
  }
});

test("a search asking about anything but PASS is refused, not answered with a catalogue", async (t) => {
  const app = await createApp(ksrtcConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const body = structuredClone(passSearchRequest()) as any;
  delete body.message.intent.category;
  const response = await post(port, "/ksrtc/pass/search", body);
  assert.equal(response.status, 400);
  const payload = (await response.json()) as any;
  assert.equal(payload.message.ack.status, "NACK");
});

test("search, select, init and confirm complete on one connection and mint a real pass", async (t) => {
  const app = await createApp(ksrtcConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const selectContext = trv11Context("select", "tx-ksrtc-day-1", "msg-select-1");
  const selectResponse = await post(port, "/ksrtc/pass/select", {
    context: selectContext,
    message: {
      order: {
        items: [{ id: "PASS-DAY-KSRTC_SARIGE", quantity: { selected: { count: 1 } } }],
        provider: { id: "P1" },
      },
    },
  });
  assert.equal(selectResponse.status, 200);
  const selectBody = (await selectResponse.json()) as any;
  assert.equal(selectBody.context.action, "on_select");
  const quote = selectBody.message.order.quote;
  // Full fare, no concession: the published day price, unchanged.
  assert.equal(quote.price.value, "237.50");

  const initContext = trv11Context("init", "tx-ksrtc-day-1", "msg-init-1");
  const initResponse = await post(port, "/ksrtc/pass/init", {
    context: initContext,
    message: {
      order: {
        items: [{ id: "PASS-DAY-KSRTC_SARIGE", quantity: { selected: { count: 1 } } }],
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [{ collected_by: "BAP", status: "NOT_PAID", type: "PRE_ORDER" }],
      },
    },
  });
  assert.equal(initResponse.status, 200);

  const confirmContext = trv11Context("confirm", "tx-ksrtc-day-1", "msg-confirm-1");
  const confirmResponse = await post(port, "/ksrtc/pass/confirm", {
    context: confirmContext,
    message: {
      order: {
        items: [{ id: "PASS-DAY-KSRTC_SARIGE", quantity: { selected: { count: 1 } } }],
        provider: { id: "P1" },
        billing: { name: "Specimen Rider", phone: "+910000000000" },
        payments: [
          {
            id: "PAYMENT-1",
            collected_by: "BAP",
            status: "PAID",
            type: "PRE_ORDER",
            // The exact string `select` quoted, the same discipline
            // `src/ondc/passOrder.ts` holds a real buyer to.
            params: { transaction_id: "tx-ksrtc-day-1", currency: "INR", amount: quote.price.value },
          },
        ],
      },
    },
  });
  assert.equal(confirmResponse.status, 200);
  const confirmBody = (await confirmResponse.json()) as any;
  assert.equal(confirmBody.context.action, "on_confirm");
  const order = confirmBody.message.order;
  assert.equal(order.status, "ACTIVE");
  assert.ok(order.id, "a confirmed pass order carries an id");

  const passFulfillment = order.fulfillments.find(
    (f: any) => f.type === "PASS" || f.id === "F-PASS-DAY-KSRTC_SARIGE",
  );
  assert.ok(passFulfillment, "a PASS-typed fulfillment exists on the order");
  const credential = order.fulfillments.find(
    (f: any) => f.id === "T-PASS-DAY-KSRTC_SARIGE-1",
  );
  assert.ok(credential, "the minted credential fulfillment exists");
  const authorization = credential.stops[0].authorization;
  assert.equal(authorization.type, "TOTP");
  assert.equal(authorization.status, "ISSUED");
  assert.match(authorization.token, /^[A-Z2-7]{32}$/);
});

test("a verified senior buying the day pass is charged what Tatak's own formula computes, to the paisa", async (t) => {
  const app = await createApp(ksrtcConfig());
  t.after(() => app.close());
  const port = await listen(app);

  const seniorTag = {
    descriptor: { code: "CONCESSION" },
    display: false,
    list: [{ descriptor: { code: "CLASS" }, value: "SENIOR" }],
  };

  const selectResponse = await post(port, "/ksrtc/pass/select", {
    context: trv11Context("select", "tx-ksrtc-senior-1", "msg-select-2"),
    message: {
      order: {
        items: [{ id: "PASS-DAY-KSRTC_SARIGE", quantity: { selected: { count: 1 } } }],
        provider: { id: "P1" },
        tags: [seniorTag],
      },
    },
  });
  assert.equal(selectResponse.status, 200);
  const quote = ((await selectResponse.json()) as any).message.order.quote;

  // 23,750 paise at 25% off does not divide evenly (5,937.5 paise). Tatak's
  // own `expectedFinalPaise` in `src/ondc/passPurchase.ts` computes
  // `Math.round(23750 * 75 / 100)` = 17,813 paise = Rs.178.13. That is the
  // one number this provider may quote, or the two sides disagree by a
  // paisa and `reconcilePassFare` refuses a sale neither side did anything
  // wrong to deserve.
  assert.equal(quote.price.value, "178.13");
  const tatakOwnFormula = Math.round((23_750 * (100 - 25)) / 100);
  assert.equal(tatakOwnFormula, 17_813);
});
