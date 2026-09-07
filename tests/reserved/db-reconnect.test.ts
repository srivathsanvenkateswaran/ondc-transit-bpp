import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "libsql";

import {
  ReconnectingDatabase,
  isDeadStreamError,
  openReservedDatabase,
} from "../../src/reserved/db.js";
import { ReservedLifecycleError } from "../../src/reserved/errors.js";
import { ReservedStore } from "../../src/reserved/store.js";

/**
 * `ReconnectingDatabase` exists for one reason: Turso drops an idle Hrana
 * stream out from under the one connection `src/app.ts` opens at boot, and
 * `libsql` never notices - every query after that fails identically, warm
 * process or not. These tests drive it with a "flaky" factory that throws a
 * scripted error on demand rather than an idle Turso stream, because the
 * failure this module recovers from is a shape of error, not a specific
 * cause: anything that produces the same message is the same bug.
 *
 * The real-Turso proof this class was actually built for lives outside the
 * test suite, in the verification report, because it needs a live token and
 * a network call neither CI nor a laptop offline should depend on.
 */

const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);

function temporaryDatabaseFile(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "reserved-reconnect-"));
  const path = join(directory, "reserved.db");
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** The exact shape production logged: a 404 body naming a stream libsql still thinks is open. */
function deadStreamError(): Error {
  return new Error(
    'Hrana(Api("status=404 Not Found, body={\\"error\\":\\"stream not found: 25196a1c:1858f69\\"}"))',
  );
}

/**
 * Wraps a real libsql connection and, on demand, throws a scripted error
 * instead of running the next call - the same interface `openReservedDatabase`
 * hands `ReconnectingDatabase`, with one seam added for tests to pull.
 */
function flakyFactory(
  path: string,
  queue: Array<() => never>,
): () => Database.Database {
  return () => {
    const real = new Database(path);
    const maybeThrow = (): void => {
      const next = queue.shift();
      if (next) next();
    };
    return {
      prepare(sql: string) {
        maybeThrow();
        const statement = real.prepare(sql);
        return {
          run: (...params: unknown[]) => {
            maybeThrow();
            return statement.run(...(params as []));
          },
          get: (...params: unknown[]) => {
            maybeThrow();
            return statement.get(...(params as []));
          },
          all: (...params: unknown[]) => {
            maybeThrow();
            return statement.all(...(params as []));
          },
        };
      },
      exec(sql: string) {
        // `ReconnectingDatabase.reconnect` re-applies this pragma on every
        // fresh connection, unprompted by anything a test scripts; scripted
        // failures below target the operation under test, not that plumbing.
        if (sql !== "PRAGMA foreign_keys = ON") maybeThrow();
        return real.exec(sql);
      },
      close() {
        return real.close();
      },
    } as unknown as Database.Database;
  };
}

function throwing(error: Error): () => never {
  return () => {
    throw error;
  };
}

test("isDeadStreamError matches the production log line and nothing coincidental", () => {
  assert.equal(
    isDeadStreamError(
      new Error(
        'Hrana(Api("status=404 Not Found, body={\\"error\\":\\"stream not found: 25196a1c:1858f69\\"}"))',
      ),
    ),
    true,
  );
  assert.equal(isDeadStreamError(new Error("stream expired")), true);
  assert.equal(isDeadStreamError(new Error("the stream was closed")), true);
  // A bare "Hrana" match would also swallow a genuine failure routed through
  // the same client; the predicate must not be that broad.
  assert.equal(
    isDeadStreamError(new Error('Hrana(Api("status=500 Internal Server Error"))')),
    false,
  );
  assert.equal(isDeadStreamError(new Error("UNIQUE constraint failed: t.id")), false);
  assert.equal(isDeadStreamError("stream not found"), false);
  assert.equal(isDeadStreamError(undefined), false);
});

test("a dead-stream error on a standalone operation reconnects once and the retry succeeds", () => {
  const { path, cleanup } = temporaryDatabaseFile();
  try {
    // Schema exists before the wrapper is ever built, matching how a Turso
    // database this module talks to is always already migrated.
    openReservedDatabase({ url: `file:${path}`, migrationRoot }).close();

    const queue: Array<() => never> = [throwing(deadStreamError())];
    const reconnects: Array<Record<string, unknown>> = [];
    const database = new ReconnectingDatabase(flakyFactory(path, queue), (fields) =>
      reconnects.push(fields),
    );

    database
      .prepare(
        `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
           hold_id, operator, bap_id, bap_uri, transaction_id, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("SL1", "S", "2026-09-30", "U3A", "HELD", "H1", "ksrtc", "bap", "uri", "tx1", 1, 0);

    const row = database
      .prepare("SELECT seat_id, state FROM seat_locks WHERE id = ?")
      .get("SL1") as { seat_id: string; state: string };
    assert.equal(row.seat_id, "U3A");
    assert.equal(row.state, "HELD");

    // Exactly one reconnect: the dead stream cost one retry, not a loop.
    assert.equal(reconnects.length, 1);
    assert.equal(reconnects[0]?.action, "reserved_db_reconnect");

    database.close();
  } finally {
    cleanup();
  }
});

test("a second consecutive dead-stream error propagates rather than retrying again", () => {
  const { path, cleanup } = temporaryDatabaseFile();
  try {
    openReservedDatabase({ url: `file:${path}`, migrationRoot }).close();

    const queue: Array<() => never> = [
      throwing(deadStreamError()),
      throwing(deadStreamError()),
    ];
    const reconnects: Array<Record<string, unknown>> = [];
    const database = new ReconnectingDatabase(flakyFactory(path, queue), (fields) =>
      reconnects.push(fields),
    );

    assert.throws(
      () => database.exec("SELECT 1"),
      /stream not found/,
    );
    // One reconnect was attempted; the retry that followed it failed too, and
    // that failure was not itself retried.
    assert.equal(reconnects.length, 1);
    assert.equal(queue.length, 0);

    database.close();
  } finally {
    cleanup();
  }
});

test("a real SQL error is not retried, and rawCode survives the wrapper for ReservedStore to read", () => {
  const { path, cleanup } = temporaryDatabaseFile();
  try {
    openReservedDatabase({ url: `file:${path}`, migrationRoot }).close();

    const queue: Array<() => never> = [];
    const reconnects: Array<Record<string, unknown>> = [];
    const database = new ReconnectingDatabase(flakyFactory(path, queue), (fields) =>
      reconnects.push(fields),
    );
    const store = new ReservedStore(database);

    const params = {
      operator: "ksrtc",
      identity: { bapId: "bap", bapUri: "uri", transactionId: "tx-one" },
      serviceId: "S",
      travelDate: "2026-09-30",
      seatIds: ["U3A"],
      nowMs: 0,
      ttlSeconds: 600,
    };
    store.acquireHold(params);

    // A second, distinct buyer racing for the same seat: the availability
    // check is skipped so the insert itself reaches the unique index, the
    // same race `tests/reserved/app.test.ts` exercises through two concurrent
    // requests. This is a genuine UNIQUE-constraint failure, not a dropped
    // stream, and must fail once rather than being retried into a spurious
    // success.
    assert.throws(
      () =>
        store.acquireHold({
          ...params,
          identity: { bapId: "bap", bapUri: "uri", transactionId: "tx-two" },
          skipAvailabilityCheckForTest: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReservedLifecycleError);
        assert.equal(error.code, "SEAT-UNAVAILABLE");
        return true;
      },
    );
    // No reconnect: a constraint violation is not a dead stream.
    assert.equal(reconnects.length, 0);

    database.close();
  } finally {
    cleanup();
  }
});

test("a dead-stream error mid-transaction is not retried, but heals the connection for what runs next", () => {
  const { path, cleanup } = temporaryDatabaseFile();
  try {
    openReservedDatabase({ url: `file:${path}`, migrationRoot }).close();

    const queue: Array<() => never> = [];
    const reconnects: Array<Record<string, unknown>> = [];
    const database = new ReconnectingDatabase(flakyFactory(path, queue), (fields) =>
      reconnects.push(fields),
    );

    database.exec("BEGIN IMMEDIATE");
    queue.push(throwing(deadStreamError()));
    // Retrying this insert on a fresh connection would run it outside the
    // transaction it was supposed to belong to, so it must propagate instead.
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
               hold_id, operator, bap_id, bap_uri, transaction_id, expires_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run("SL1", "S", "2026-09-30", "U3A", "HELD", "H1", "ksrtc", "bap", "uri", "tx1", 1, 0),
      /stream not found/,
    );
    assert.equal(reconnects.length, 1);

    // The caller's own catch block does exactly this next: issue a ROLLBACK
    // against what it still thinks is the same connection. There is no
    // transaction open on the fresh one, which is a real SQLite error, not a
    // dead stream, and it is not retried either.
    assert.throws(() => database.exec("ROLLBACK"), /transaction/i);
    assert.equal(reconnects.length, 1);

    // The connection itself is healthy again: an unrelated statement outside
    // any transaction succeeds with no further reconnect needed.
    const count = database
      .prepare("SELECT COUNT(*) AS n FROM seat_locks")
      .get() as { n: number };
    assert.equal(count.n, 0);
    assert.equal(reconnects.length, 1);

    database.close();
  } finally {
    cleanup();
  }
});
