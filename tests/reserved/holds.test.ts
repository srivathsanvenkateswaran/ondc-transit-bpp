import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReservedDatabase } from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { ReservedStore } from "../../src/reserved/store.js";

/**
 * The hold lifecycle.
 *
 * Holds are server-authoritative: this provider issues the hold, sets its TTL
 * and returns the absolute expiry instant, and the client never computes one
 * and never extends one. Everything below is a property of that decision.
 */

const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);

const SERVICE = "2259BNGHMP";
const DATE = "2026-09-30";
const TTL = 600;

function newStore(): ReservedStore {
  let counter = 0;
  return new ReservedStore(
    openReservedDatabase({ url: ":memory:", migrationRoot }),
    { idFactory: () => `ID${String((counter += 1)).padStart(4, "0")}` },
  );
}

/**
 * `assert.throws` returns nothing, and every refusal below is worth asserting
 * a code and a message on rather than only a type.
 */
function refusalFrom(work: () => unknown): ReservedLifecycleError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ReservedLifecycleError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

function identity(transactionId: string) {
  return {
    bapId: "bap.example.test",
    bapUri: "https://bap.example.test",
    transactionId,
  };
}

function acquire(
  store: ReservedStore,
  transactionId: string,
  seatIds: string[],
  nowMs: number,
) {
  return store.acquireHold({
    operator: "ksrtc",
    identity: identity(transactionId),
    serviceId: SERVICE,
    travelDate: DATE,
    seatIds,
    nowMs,
    ttlSeconds: TTL,
  });
}

test("a hold carries an absolute expiry this provider computed", () => {
  const store = newStore();
  const hold = acquire(store, "tx1", ["U3A", "U3B"], 1_000_000);
  assert.equal(hold.expiresAt, 1_000_000 + TTL * 1000);
  assert.deepEqual(hold.seatIds, ["U3A", "U3B"]);
  store.close();
});

test("the first select to reach the acquire step wins the seat", () => {
  const store = newStore();
  acquire(store, "tx1", ["U3A"], 1_000_000);
  const refusal = refusalFrom(() => acquire(store, "tx2", ["U3A", "U3B"], 1_000_001));
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  // The refusal names the seats that were taken and not the ones that were
  // free, so a client can re-render the difference rather than the request.
  assert.match(refusal.message, /U3A/);
  assert.doesNotMatch(refusal.message, /U3B/);
  store.close();
});

test("a losing racer that gets past the check still loses to the index", () => {
  // The constraint, not the check, is the guarantee. This drives the insert
  // with the availability check deliberately skipped, which is the only way to
  // prove which of the two is load bearing.
  const store = newStore();
  acquire(store, "tx1", ["U3A"], 1_000_000);
  const refusal = refusalFrom(() =>
    store.acquireHold({
      operator: "ksrtc",
      identity: identity("tx2"),
      serviceId: SERVICE,
      travelDate: DATE,
      seatIds: ["U3A"],
      nowMs: 1_000_001,
      ttlSeconds: TTL,
      skipAvailabilityCheckForTest: true,
    }),
  );
  assert.equal(refusal.code, "SEAT-UNAVAILABLE");
  store.close();
});

test("re-selecting the same seats returns the same hold, unextended", () => {
  // A hold that renewed itself every time a client repriced would have no TTL
  // at all.
  const store = newStore();
  const first = acquire(store, "tx1", ["U3A", "U3B"], 1_000_000);
  const second = acquire(store, "tx1", ["U3B", "U3A"], 1_400_000);
  assert.equal(second.holdId, first.holdId);
  assert.equal(second.expiresAt, first.expiresAt);
  store.close();
});

test("selecting different seats releases the previous hold in the same breath", () => {
  // Without this, a rider exploring the map would ratchet holds until the
  // coach was locked by one undecided rider.
  const store = newStore();
  const first = acquire(store, "tx1", ["U3A"], 1_000_000);
  const second = acquire(store, "tx1", ["U4A"], 1_000_500);
  assert.notEqual(second.holdId, first.holdId);
  assert.deepEqual(
    store.liveClaims(SERVICE, DATE).map((claim) => claim.seatId),
    ["U4A"],
  );
  // A third transaction can take the released seat immediately.
  const other = acquire(store, "tx2", ["U3A"], 1_000_600);
  assert.deepEqual(other.seatIds, ["U3A"]);
  store.close();
});

test("an expired hold is swept by whoever next touches that dated departure", () => {
  // Lazily, inside the transaction that next asks, rather than by a background
  // job: a hold past its expiry is functionally released the instant anybody
  // asks, which is the only moment the answer matters.
  const store = newStore();
  const first = acquire(store, "tx1", ["U3A"], 1_000_000);
  const later = first.expiresAt + 1;
  const second = acquire(store, "tx2", ["U3A"], later);
  assert.deepEqual(second.seatIds, ["U3A"]);
  const swept = store.findLatestHold("ksrtc", identity("tx1"));
  assert.ok(swept);
  // A swept hold leaves its row behind with the state changed rather than
  // being deleted, so a confirm arriving against it is refused with the reason
  // rather than with "unknown hold".
  assert.equal(swept.state, "EXPIRED");
  store.close();
});

test("a hold that has passed its expiry is not live even before anyone sweeps", () => {
  const store = newStore();
  const hold = acquire(store, "tx1", ["U3A"], 1_000_000);
  assert.equal(store.holdStatus(hold, hold.expiresAt - 1), "LIVE");
  assert.equal(store.holdStatus(hold, hold.expiresAt), "EXPIRED");
  assert.equal(store.holdStatus(hold, hold.expiresAt + 1), "EXPIRED");
  store.close();
});

test("one live hold per transaction, across services as well as seats", () => {
  const store = newStore();
  acquire(store, "tx1", ["U3A"], 1_000_000);
  store.acquireHold({
    operator: "ksrtc",
    identity: identity("tx1"),
    serviceId: "1000BNGMAA",
    travelDate: DATE,
    seatIds: ["1A"],
    nowMs: 1_000_100,
    ttlSeconds: TTL,
  });
  assert.deepEqual(store.liveClaims(SERVICE, DATE), []);
  assert.deepEqual(
    store.liveClaims("1000BNGMAA", DATE).map((claim) => claim.seatId),
    ["1A"],
  );
  store.close();
});

test("a live claim says whose it is, so a client can tell its own hold apart", () => {
  const store = newStore();
  acquire(store, "tx1", ["U3A"], 1_000_000);
  const [claim] = store.liveClaims(SERVICE, DATE);
  assert.equal(claim.state, "HELD");
  assert.equal(claim.identity.transactionId, "tx1");
  assert.equal(claim.gender, null);
  store.close();
});
