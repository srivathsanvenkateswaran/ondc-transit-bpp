import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  migrationsUnder,
  openReservedDatabase,
} from "../../src/reserved/db.js";

/**
 * The storage layer, and the one index the whole category rests on.
 *
 * Everything the two existing categories sell is a settled fact whose loss
 * costs nothing: a confirmed specimen ticket lives on the rider's own device,
 * and two devices disagreeing about whether it exists costs nothing because
 * neither can invalidate the other. A held or booked seat is the opposite. It
 * is shared and finite, and a process restart that forgot every hold would
 * release seats somebody is mid-checkout on and make "how many seats are left"
 * a function of this provider's uptime.
 */

const migrationRoot = fileURLToPath(
  new URL("../../migrations/reserved", import.meta.url),
);

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "reserved-db-"));
}

test("every migration in the tree is numbered, ordered and gapless", () => {
  const migrations = migrationsUnder(migrationRoot);
  assert.ok(migrations.length >= 2);
  migrations.forEach((migration, index) => {
    assert.equal(
      migration.version,
      index + 1,
      `migration ${migration.name} is out of sequence`,
    );
  });
});

test("migrations apply once and are recorded", () => {
  const database = openReservedDatabase({ url: ":memory:", migrationRoot });
  const applied = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  assert.deepEqual(
    applied.map((row) => row.version),
    migrationsUnder(migrationRoot).map((migration) => migration.version),
  );
  database.close();
});

test("reopening a migrated file applies nothing and loses nothing", () => {
  const directory = temporaryDirectory();
  const url = `file:${join(directory, "reserved.db")}`;
  const first = openReservedDatabase({ url, migrationRoot });
  first
    .prepare(
      `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
         hold_id, operator, bap_id, bap_uri, transaction_id, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("SL1", "2259BNGHMP", "2026-09-30", "U3A", "HELD", "HLD1", "ksrtc", "bap", "uri", "tx", 1, 0);
  first.close();

  // The whole reason this category cannot stay in memory: the row is the
  // fact, not a copy of one, and it has to outlive a release.
  const second = openReservedDatabase({ url, migrationRoot });
  const rows = second.prepare("SELECT seat_id FROM seat_locks").all();
  assert.equal(rows.length, 1);
  second.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a database written by a newer release refuses to start", () => {
  // A newer schema read by older code is how a hold quietly stops being
  // honoured, so the refusal is at boot rather than at the first select.
  const database = openReservedDatabase({ url: ":memory:", migrationRoot });
  database
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(9_999, 0);
  assert.throws(
    () => openReservedDatabase({ url: ":memory:", migrationRoot, handle: database }),
    /schema version 9999 .* this build knows/,
  );
  database.close();
});

test("a migration tree with a gap fails rather than skipping one", () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "0001_first.sql"), "CREATE TABLE a (x INTEGER);");
  writeFileSync(join(directory, "0003_third.sql"), "CREATE TABLE c (x INTEGER);");
  assert.throws(
    () => migrationsUnder(directory),
    /migration 2 is missing/,
  );
  rmSync(directory, { recursive: true, force: true });
});

test("the live-lock index is the guarantee, not the availability check", () => {
  // Two rows claiming one berth on one dated departure cannot both be live.
  // The application check exists to produce a good error message; if the two
  // ever disagree, this constraint is the one that is right.
  const database = openReservedDatabase({ url: ":memory:", migrationRoot });
  const insert = database.prepare(
    `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
       hold_id, operator, bap_id, bap_uri, transaction_id, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run("SL1", "S", "2026-09-30", "U3A", "HELD", "H1", "ksrtc", "bap", "uri", "tx1", 1, 0);
  assert.throws(
    () =>
      insert.run("SL2", "S", "2026-09-30", "U3A", "HELD", "H2", "ksrtc", "bap", "uri", "tx2", 1, 0),
    /UNIQUE constraint failed/,
  );
  // A booking is the same claim at a higher strength, so it collides too.
  assert.throws(
    () =>
      insert.run("SL3", "S", "2026-09-30", "U3A", "BOOKED", null, "ksrtc", "bap", "uri", "tx3", null, 0),
    /UNIQUE constraint failed/,
  );
  // A swept or released row stays in the table with its state changed, and
  // stops standing in the way of the next claim.
  database.prepare("UPDATE seat_locks SET state = 'EXPIRED' WHERE id = 'SL1'").run();
  insert.run("SL4", "S", "2026-09-30", "U3A", "HELD", "H4", "ksrtc", "bap", "uri", "tx4", 1, 0);
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS live FROM seat_locks WHERE state IN ('HELD','BOOKED')")
        .get() as { live: number }
    ).live,
    1,
  );
  database.close();
});
