import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Where a held or booked seat actually lives.
 *
 * The two categories next door keep their orders in memory, and that is
 * correct for what they hold: a confirmed specimen ticket is a settled fact
 * whose loss costs nothing, because the rider's own device holds the wallet
 * and two devices disagreeing about whether a ticket exists costs nothing when
 * neither can invalidate the other. A held or booked seat is the opposite. It
 * is a shared, finite resource; a process restart that forgot every hold would
 * release seats somebody is mid-checkout on, orphan bookings a buyer app still
 * displays, and make "how many seats are left" a function of this provider's
 * uptime. For the window between held and confirmed-or-released, the row here
 * is the fact rather than a copy of one.
 *
 * ## Why the engine that ships with the runtime
 *
 * `docs/reserved-intercity.md` section 15 names libSQL, one file, no extra
 * service, and every property it asks that engine for is a property of SQLite
 * rather than of that particular client: one file or one in-memory database,
 * a partial unique index, and a transaction with no scheduler and no worker
 * anywhere near it. The runtime this repository already pins ships SQLite in
 * the standard library, so it is used directly and nothing is installed. Two
 * consequences worth stating rather than discovering:
 *
 *   - The API is synchronous, which is a strictly stronger guarantee than the
 *     one section 8.5 asks for. It says the acquire path must perform its
 *     sweep, its availability check and its insert with no `await` between
 *     them; here there is no `await` available to write, so no interleaving is
 *     expressible rather than merely avoided.
 *   - Running behind more than one replica needs a real server rather than a
 *     file, which is a swap of this module and nothing above it. Everything
 *     above talks to `ReservedStore`, and the unique index remains the
 *     guarantee either way.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * The migrations on disk, in order.
 *
 * Numbered, forward-only, plain SQL. There are no down migrations: rolling a
 * schema change back off a table holding live holds is a data-loss operation
 * dressed as a convenience, and the honest recovery is a forward migration.
 */
export function migrationsUnder(root: string): Migration[] {
  const migrations = readdirSync(root)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter(
      (entry): entry is { file: string; match: RegExpExecArray } =>
        entry.match !== null,
    )
    .map(({ file, match }) => ({
      version: Number(match[1]),
      name: match[2],
      sql: readFileSync(join(root, file), "utf8"),
    }))
    .sort((left, right) => left.version - right.version);

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      // A gap is nearly always a file that failed to land in a build rather
      // than a deliberate hole, and applying the ones either side of it would
      // produce a schema nobody has ever tested.
      throw new Error(
        `Reserved migration ${expected} is missing: the tree jumps from ${
          migrations[index - 1]?.version ?? 0
        } to ${migration.version}`,
      );
    }
  });
  return migrations;
}

/**
 * `:memory:`, a bare path, or a `file:` URL. The default deployment is one
 * file beside the process and the tests are in memory, which is what keeps a
 * stranger's first clone running with nothing else up.
 */
export function resolveDatabasePath(url: string): string {
  if (url === ":memory:") return ":memory:";
  if (url.startsWith("file:")) return url.slice("file:".length);
  return url;
}

export interface OpenOptions {
  url: string;
  migrationRoot: string;
  /**
   * An already-open handle to migrate in place. Only a test needs this, and
   * only because an in-memory database cannot be reopened by name: without it
   * there is no way to point a second open at a database a first one already
   * wrote.
   */
  handle?: DatabaseSync;
}

/**
 * Open the database and bring it up to the schema this build knows.
 *
 * Each migration runs inside its own transaction and is recorded in
 * `schema_migrations` in the same transaction, so a failure half way through
 * one leaves neither the change nor the record of it.
 */
export function openReservedDatabase(options: OpenOptions): DatabaseSync {
  const database =
    options.handle ?? new DatabaseSync(resolveDatabasePath(options.url));
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    )
  `);

  const migrations = migrationsUnder(options.migrationRoot);
  const knownVersion = migrations.at(-1)?.version ?? 0;
  const applied = new Set(
    (
      database
        .prepare("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>
    ).map((row) => row.version),
  );
  const ahead = [...applied].filter((version) => version > knownVersion);
  if (ahead.length > 0) {
    // A newer schema read by older code is how a hold quietly stops being
    // honoured: the older code writes rows the newer columns do not constrain,
    // and nothing complains until a seat is sold twice.
    throw new Error(
      `Reserved database is at schema version ${Math.max(
        ...ahead,
      )} and this build knows ${knownVersion}; a newer schema read by older code is refused rather than tolerated`,
    );
  }

  migrations
    .filter((migration) => !applied.has(migration.version))
    .forEach((migration) => {
      database.exec("BEGIN");
      try {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, Date.now());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw new Error(
          `Reserved migration ${migration.version} (${migration.name}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });

  return database;
}
