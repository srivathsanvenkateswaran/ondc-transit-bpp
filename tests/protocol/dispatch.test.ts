import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchCallback } from "../../src/protocol/dispatch.js";

const callbackUrl = "https://bpp-client.example.test/on_search";

test("callback dispatch requires a protocol ACK, not only a 2xx status", async () => {
  const nackFetch = (async () =>
    new Response(JSON.stringify({ message: { ack: { status: "NACK" } } }), {
      status: 202,
    })) as typeof fetch;

  await assert.rejects(
    dispatchCallback(callbackUrl, { message: "callback" }, 1_000, nackFetch),
    /was not acknowledged \(status NACK\)/,
  );
});

test("callback dispatch accepts a 2xx protocol ACK", async () => {
  const ackFetch = (async () =>
    new Response(JSON.stringify({ message: { ack: { status: "ACK" } } }), {
      status: 202,
    })) as typeof fetch;

  await dispatchCallback(callbackUrl, { message: "callback" }, 1_000, ackFetch);
});
