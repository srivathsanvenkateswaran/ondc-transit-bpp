import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  openReservedDatabase,
  withTransaction,
  type ReservedDatabase,
  type ReservedStatement,
} from "../../src/reserved/db.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { ReservedStore } from "../../src/reserved/store.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
  reservedSearchRequest,
} from "../helpers.js";

/**
 * The actual cause of `on_select` failing in production on 2026-09-07,
 * reproduced directly against the real Turso database: a write statement
 * that runs outside any transaction on a `ReconnectingDatabase` connection -
 * even one ordinary autocommit `UPDATE` - leaves the *next* `BEGIN IMMEDIATE`
 * issued on that same connection unable to actually open a transaction
 * server-side, though it reports success. Every statement inside that
 * "transaction" then runs and durably persists on its own, in autocommit,
 * and the `COMMIT` at the end fails with "cannot commit - no transaction is
 * active" - not because anything timed out (a separate, also-real Turso
 * behaviour covered in `db-reconnect.test.ts`), but because the explicit
 * transaction never actually existed as far as the server was concerned.
 *
 * `ReservedOrderService.snapshot()` called `store.sweepExpiredHolds` as a
 * bare write immediately before `store.acquireHold`'s own `BEGIN IMMEDIATE`,
 * on the one connection this process holds for its entire life - so the very
 * next select after any earlier search or select corrupted itself this way.
 * `search`, `init`'s manifest read, and the cancellation flow's refund quote
 * and stored-order rewrite had the identical shape: a write with nothing
 * around it.
 *
 * This does not reproduce against the local, in-memory driver this test runs
 * against - `:memory:` and a local file have no Hrana stream to confuse, and
 * a plain multi-statement transaction was independently confirmed to work
 * fine against the real remote database (see the verification report). What
 * *is* verifiable locally, and is exactly the property the fix establishes,
 * is structural: nothing in `ReservedOrderService` may run a write against
 * the store's database except inside a transaction (`ReservedStore.acquireHold`,
 * `confirmBooking`, `applyCancellation`, `sweepManifests`, or a caller using
 * `ReservedStore.withTransaction` itself, as `search`, `snapshot`, and the
 * cancellation flow's refund quote and stored-order rewrite now do). This
 * test drives every one of this provider's actions - search, select, confirm,
 * soft cancel, confirm-cancel - through a database that fails loudly the
 * instant a write happens with no transaction open around it, which is
 * exactly the shape of bug this class of fix cannot silently regress on
 * without this test noticing.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

const TRAVEL_DATE = "2026-09-30";
const ITEM = `RSV-2259BNGHMP-${TRAVEL_DATE}-PALLAKKI`;
const NOW = Date.parse("2026-09-20T10:00:00.000Z");

function tagOf(tags: unknown, code: string) {
  return (
    tags as Array<{
      descriptor: { code: string };
      list: Array<{ descriptor: { code: string }; value: string }>;
    }>
  )?.find((tag) => tag.descriptor.code === code);
}

function entryOf(tags: unknown, groupCode: string, entryCode: string) {
  return tagOf(tags, groupCode)?.list.find(
    (item) => item.descriptor.code === entryCode,
  )?.value;
}

/**
 * Wraps a real `ReservedDatabase` and records every `run` (a write) that
 * happens while `exec("BEGIN...")` has not yet been matched by a `COMMIT` or
 * `ROLLBACK` on this same handle - a bare write, exactly the shape that
 * corrupts the next transaction on a real Turso connection. `get` and `all`
 * are reads and are not tracked: the production failure was never about
 * reads.
 */
function trackingDatabase(inner: ReservedDatabase): {
  database: ReservedDatabase;
  bareWrites: string[];
} {
  let inTransaction = false;
  const bareWrites: string[] = [];
  const database: ReservedDatabase = {
    prepare(sql: string): ReservedStatement {
      const statement = inner.prepare(sql);
      return {
        // Recorded when the write is *issued*, not when it settles. The
        // statement is asynchronous now, so a write started inside a
        // transaction and awaited across the COMMIT would look like a bare
        // write if this checked afterwards - and a write issued after the
        // COMMIT while an earlier one was still in flight would not look like
        // one at all. The question this test asks is which transaction a
        // write belongs to, and that is decided the moment it is issued.
        run: (...params: unknown[]) => {
          if (!inTransaction) bareWrites.push(sql.replace(/\s+/g, " ").trim());
          return statement.run(...params);
        },
        get: (...params: unknown[]) => statement.get(...params),
        all: (...params: unknown[]) => statement.all(...params),
      };
    },
    exec: (sql: string) => {
      // Set before `inner.exec` is awaited, for the same reason: everything
      // this process issues after asking for a BEGIN is meant to be inside
      // it, and everything issued after asking for a COMMIT is not.
      const trimmed = sql.trimStart().toUpperCase();
      if (trimmed.startsWith("BEGIN")) inTransaction = true;
      else if (trimmed.startsWith("COMMIT") || trimmed.startsWith("ROLLBACK")) {
        inTransaction = false;
      }
      return inner.exec(sql);
    },
    close: () => inner.close(),
  };
  return { database, bareWrites };
}

async function harness() {
  const clock = { at: NOW };
  let counter = 0;
  const idFactory = () => `${String((counter += 1)).padStart(8, "0")}-fixed`;
  const { database, bareWrites } = trackingDatabase(
    await openReservedDatabase({ url: ":memory:", migrationRoot }),
  );
  const store = new ReservedStore(database, { idFactory });
  const orders = new ReservedOrderService(
    "ksrtc",
    source,
    {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
    },
    store,
    {
      publicBaseUrl: "https://provider.example.test",
      reservation: {
        closeMinutes: 45,
        horizonDays: 30,
        occupancySeed: 20_260_905,
        holdTtlSeconds: 600,
        manifestRetentionDays: 30,
      },
      now: () => new Date(clock.at),
      idFactory,
    },
  );
  return { orders, store, clock, bareWrites };
}

test("every write the full booking lifecycle makes runs inside a transaction, never bare", async () => {
  const { orders, clock, bareWrites } = await harness();

  await orders.search(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  assert.deepEqual(bareWrites, [], "search must not write outside a transaction");

  // A second search on the same handle: the exact sequence that corrupted
  // production - a prior action's bare write immediately followed by the
  // next action's `BEGIN IMMEDIATE`. Wrapping `search`'s own sweep fixes
  // this call's own write; asserting again here would also catch a
  // regression where only the *first* call in a process's life was fixed.
  await orders.search(
    reservedSearchRequest({ travelDate: TRAVEL_DATE }) as never,
  );
  assert.deepEqual(bareWrites, []);

  await orders.select(
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["U3A", "U3B"] }) as never,
  );
  assert.deepEqual(bareWrites, [], "select must not write outside a transaction");

  const confirmed = (
    await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["U3A", "U3B"],
        manifest: [
          { seatId: "U3A", name: "A Passenger", age: 34, gender: "female" },
          { seatId: "U3B", name: "B Passenger", age: 36, gender: "male" },
        ],
      }) as never,
    )
  ).order as Record<string, unknown>;
  assert.deepEqual(bareWrites, [], "confirm must not write outside a transaction");

  const orderId = confirmed.id as string;
  clock.at = NOW + 5 * 24 * 60 * 60 * 1000;

  const quoted = await orders.cancel(
    reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
  );
  assert.deepEqual(bareWrites, [], "a soft cancel's refund quote must not write outside a transaction");

  const quoteId = entryOf(quoted.tags, "REFUND_SLAB", "REFUND_QUOTE_ID");
  assert.ok(quoteId, "expected a refund quote id on the soft-cancel response");

  await orders.cancel(
    reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
  );
  assert.deepEqual(
    bareWrites,
    [],
    "a confirmed cancel's stored-order rewrite must not write outside a transaction",
  );
});

/**
 * The guard's own guard.
 *
 * `trackingDatabase` decides whether a write is bare by watching this handle's
 * `BEGIN`/`COMMIT` and the moment a write is issued. Under the synchronous
 * driver that was the only thing it could have watched; now that every one of
 * those is a promise, a detector that quietly stopped detecting would leave
 * the test above passing for the wrong reason - it asserts an empty list, and
 * an empty list is what a broken detector produces too. So: a write with
 * nothing around it is still recorded, and the same write inside a
 * transaction is still not.
 */
test("the bare-write detector still detects a bare write", async () => {
  const { database, bareWrites } = trackingDatabase(
    await openReservedDatabase({ url: ":memory:", migrationRoot }),
  );
  const insert = (id: string) =>
    database
      .prepare(
        `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
           hold_id, operator, bap_id, bap_uri, transaction_id, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "S", "2026-09-30", id, "RELEASED", null, "ksrtc", "bap", "uri", id, null, 0);

  await insert("BARE");
  assert.equal(bareWrites.length, 1, "a write outside any transaction must be recorded");
  assert.match(bareWrites[0], /INSERT INTO seat_locks/);

  await withTransaction(database, () => insert("INSIDE"));
  assert.equal(
    bareWrites.length,
    1,
    "a write inside a transaction must not be recorded",
  );

  database.close();
});
