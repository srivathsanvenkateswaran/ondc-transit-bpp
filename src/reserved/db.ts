import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "libsql";

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
 * ## Why libSQL for both the file and the server
 *
 * `docs/reserved-intercity.md` section 15 names libSQL, one file, no extra
 * service, and every property it asks that engine for is a property of SQLite
 * rather than of any particular client: one file or one in-memory database, a
 * partial unique index, and a transaction with no scheduler and no worker
 * anywhere near it.
 *
 * This module used to open that file with `node:sqlite`, the runtime's own
 * driver. That stopped being tenable once this process moved onto a
 * filesystem that does not survive a restart (Heroku's Eco dyno, which
 * recycles at least daily): `node:sqlite` only ever opens a local file, so
 * the database had nowhere durable to be. The `libsql` package opens the
 * same local file - it is a better-sqlite3-shaped, synchronous fork of
 * SQLite - and it *also* opens a `libsql:` or `https:` URL against a
 * hosted Turso database, with the same driver and the same call shape. Using
 * it everywhere, rather than only for the remote case, means:
 *
 *   - Local and production run the identical engine. A bug that only
 *     reproduces on one driver and not the other is a bug this deployment
 *     will never get to find in CI and then hit for the first time in
 *     production.
 *   - There is exactly one code path here instead of a branch that picks a
 *     driver by URL scheme, so `resolveDatabasePath` only has to decide what
 *     string to hand the one constructor, not which constructor to call.
 *
 * The one incompatibility this swap actually surfaced: `node:sqlite` reports
 * a constraint violation's extended SQLite code on `error.errcode`, and
 * `libsql` reports the same number on `error.rawCode` instead. `ReservedStore`
 * ("the live-lock index is the guarantee, not the availability check") reads
 * that field to translate a unique-constraint failure into a seat-unavailable
 * refusal, so it now reads `rawCode`. Nothing else in this module or in
 * `store.ts` touched a driver-specific error shape, a raw row's key set, or a
 * `better-sqlite3` method this fork does not also provide.
 *
 * Two consequences worth stating rather than discovering, both true before
 * this change and still true after it:
 *
 *   - The API is synchronous, which is a strictly stronger guarantee than the
 *     one section 8.5 asks for. It says the acquire path must perform its
 *     sweep, its availability check and its insert with no `await` between
 *     them; here there is no `await` available to write, so no interleaving is
 *     expressible rather than merely avoided.
 *   - Running behind more than one replica needs a real server rather than a
 *     file, which is a swap of this module's target and nothing above it.
 *     Everything above talks to `ReservedStore`, and the unique index remains
 *     the guarantee either way.
 */

/**
 * The subset of `libsql`'s `Database`/`Statement` surface this codebase
 * actually calls: `prepare`, `exec` and `close` on the handle, `run`, `get`
 * and `all` on a prepared statement. Narrowed deliberately rather than left
 * as `Database.Database` (the raw driver type), because the remote case below
 * hands back a reconnecting wrapper that cannot honestly implement the rest
 * of that interface - `sync`, `transaction`, `pragma`, `backup` and so on
 * assume one connection for the handle's whole life, which is exactly the
 * assumption this module exists to break. A raw `Database.Database` still
 * satisfies this narrower interface structurally, so nothing that only calls
 * these five methods needs to change.
 */
export interface ReservedStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface ReservedDatabase {
  prepare(sql: string): ReservedStatement;
  exec(sql: string): unknown;
  close(): unknown;
}

type EventLogger = (fields: Record<string, unknown>) => void;

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
 * A `libsql:` or `https:` URL names a hosted Turso database rather than a
 * local file. Nothing else this module accepts does: `:memory:` and every
 * plain path or `file:` URL stay local, which is what keeps every test and
 * every local run pointed at a throwaway or beside-the-process file with
 * nothing else up.
 */
export function isRemoteDatabaseUrl(url: string): boolean {
  return url.startsWith("libsql:") || url.startsWith("https:");
}

/**
 * `:memory:`, a bare path, a `file:` URL, or a remote `libsql:`/`https:` URL
 * passed straight through. The default deployment is one file beside the
 * process and the tests are in memory, which is what keeps a stranger's
 * first clone running with nothing else up.
 */
export function resolveDatabasePath(url: string): string {
  if (url === ":memory:") return ":memory:";
  if (isRemoteDatabaseUrl(url)) return url;
  if (url.startsWith("file:")) return url.slice("file:".length);
  return url;
}

export interface OpenOptions {
  url: string;
  migrationRoot: string;
  /**
   * The Turso auth token, required when `url` is a `libsql:` or `https:`
   * URL and ignored otherwise. `loadConfig` in `src/config.ts` already
   * refuses to start a process configured with a remote URL and no token;
   * this check exists so that a direct caller - a script, a test - fails at
   * the same open call rather than at the first query a token would have
   * been needed for.
   */
  authToken?: string;
  /**
   * An already-open handle to migrate in place. Only a test needs this, and
   * only because an in-memory database cannot be reopened by name: without it
   * there is no way to point a second open at a database a first one already
   * wrote.
   */
  handle?: ReservedDatabase;
  /**
   * Told about a recovered dead stream, nothing else. Defaults to a no-op;
   * `src/app.ts` wires in `logEvent` the same way every other event source in
   * this codebase does.
   */
  eventLogger?: EventLogger;
}

/**
 * Turso closes an idle Hrana stream out from under a connection that is still
 * holding it open, and `libsql` does not notice: the next call on that stream
 * fails, and so does every call after it, because the client keeps retrying
 * the same dead stream forever. A warm process with a dropped stream fails
 * identically to a cold one that never connected, which is why a dyno warmer
 * does not touch this bug.
 *
 * The messages this matches are the ones actually seen in production for
 * that failure - `Hrana(Api("status=404 Not Found,
 * body={\"error\":\"stream not found: ...\"}"))` - plus the two close
 * relatives Turso's own docs describe a stream entering (expired, closed).
 * Nothing broader: a bare "Hrana" match would also swallow a genuine
 * constraint violation or SQL error routed through the same client, and
 * retrying either of those is worse than the bug this module fixes - a write
 * that failed for a real reason must fail once, visibly, not get replayed
 * against a fresh connection as if the failure had never happened.
 */
const DEAD_STREAM_PATTERNS: RegExp[] = [
  /stream not found/i,
  /stream (?:has )?expired/i,
  /stream (?:has been |was )?closed/i,
];

export function isDeadStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && DEAD_STREAM_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * A ROLLBACK that failed because there is nothing to roll back.
 *
 * SQLite says this when no transaction is active. It reaches this module only
 * after a reconnect has already thrown the transaction away, so it means the
 * rollback's goal is met rather than that anything went wrong. Matched
 * narrowly: a rollback failing for any other reason is still a real failure.
 */
export function isNothingToRollBack(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && /cannot rollback\s*-?\s*no transaction is active/i.test(message);
}

type OperationKind = "begin" | "commit" | "rollback" | "other";

/**
 * Every transaction in this codebase opens and closes with a bare `exec`
 * call (`BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK` - see `store.ts` and the
 * migration loop below), never through a prepared statement. Recognising
 * those three is what lets `ReconnectingDatabase` tell "a dead stream between
 * requests, safe to retry" apart from "a dead stream between BEGIN and
 * COMMIT, where a reconnect already lost the transaction".
 */
function commandKind(sql: string): OperationKind {
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith("BEGIN")) return "begin";
  if (trimmed.startsWith("COMMIT")) return "commit";
  if (trimmed.startsWith("ROLLBACK")) return "rollback";
  return "other";
}

/**
 * A `ReservedDatabase` that survives its underlying connection dying once.
 *
 * Each operation runs against the live connection. An error that looks like
 * a dropped Hrana stream reconnects and retries the same operation exactly
 * once; anything else - a constraint violation, a genuine SQL error, or a
 * second failure right after reconnecting - propagates immediately. A second
 * failure is never retried again: two failures in a row are a real problem,
 * not a flaky stream, and looping on it would turn a dead database into a
 * process that spins instead of one that reports the outage.
 *
 * The one case a retry is deliberately refused even for a recognised
 * dead-stream error is mid-transaction: if the stream dies between `BEGIN`
 * and `COMMIT`/`ROLLBACK`, the fresh connection a reconnect produces has no
 * memory of that transaction. Retrying the failed statement on it would run
 * that statement alone, outside the atomic block the caller thought it was
 * part of - silently trading a visible outage for a corrupted write. So a
 * mid-transaction dead stream reconnects (healing the connection for
 * whatever runs next, including the caller's own `ROLLBACK`) but still
 * throws the original error rather than retrying.
 *
 * Prepared statements are bound to whichever connection prepared them, so
 * the cache below is invalidated by a generation counter bumped on every
 * reconnect, rather than re-preparing on every call.
 */
export class ReconnectingDatabase implements ReservedDatabase {
  private current: Database.Database;
  private generation = 0;
  private inTransaction = false;
  private readonly statementCache = new Map<
    string,
    { generation: number; statement: Database.Statement }
  >();

  constructor(
    private readonly factory: () => Database.Database,
    private readonly eventLogger: EventLogger,
  ) {
    this.current = this.factory();
  }

  private reconnect(cause: unknown): void {
    try {
      this.current.close();
    } catch {
      // The dying connection may already be unusable; closing it is a
      // courtesy on a best-effort basis, not a precondition for recovery.
    }
    this.current = this.factory();
    this.generation += 1;
    this.statementCache.clear();
    this.inTransaction = false;
    // Logged before the pragma below rather than after: the reconnect itself
    // already happened by this point, and if the fresh connection is
    // *also* dead - unlikely, but a silent second failure here would be
    // exactly the kind of unobserved outage this module exists to end -
    // there is still a log line naming what was attempted.
    this.eventLogger({
      action: "reserved_db_reconnect",
      outcome: "RECOVERED",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    // Foreign-key enforcement is a per-connection pragma, not a property of
    // the database file or server: a fresh connection starts without it, and
    // `openReservedDatabase` only turns it on for the first connection.
    this.current.exec("PRAGMA foreign_keys = ON");
  }

  private attempt<T>(kind: OperationKind, operation: (db: Database.Database) => T): T {
    const wasInTransaction = this.inTransaction;
    try {
      const result = operation(this.current);
      if (kind === "begin") this.inTransaction = true;
      else if (kind === "commit" || kind === "rollback") this.inTransaction = false;
      return result;
    } catch (error) {
      if (kind === "rollback" && isNothingToRollBack(error)) {
        // The rollback got what it wanted. A connection that has just been
        // replaced carries none of the work the lost one held, so there is
        // no open transaction to undo and saying so is not a failure. Before
        // this, a stream that died mid-transaction healed correctly and then
        // the caller's own ROLLBACK turned the recovery into an
        // INTERNAL-ERROR, which is what a rider saw as "the operator could
        // not answer that request in a form Tatak can read".
        this.inTransaction = false;
        return undefined as T;
      }
      if (!isDeadStreamError(error)) throw error;
      this.reconnect(error);
      if (wasInTransaction) {
        // See the class doc: retrying here would silently run the statement
        // outside the transaction it was supposed to belong to. The
        // transaction itself is gone either way - the connection that held it
        // is - so the flag has to be cleared here rather than waiting for a
        // COMMIT or ROLLBACK that can no longer reach it. Leaving it set made
        // every later operation on this handle believe it was inside a
        // transaction and refuse to retry.
        this.inTransaction = false;
        throw error;
      }
      const result = operation(this.current);
      if (kind === "begin") this.inTransaction = true;
      return result;
    }
  }

  private statementFor(db: Database.Database, sql: string): Database.Statement {
    const cached = this.statementCache.get(sql);
    if (cached && cached.generation === this.generation) return cached.statement;
    const statement = db.prepare(sql);
    this.statementCache.set(sql, { generation: this.generation, statement });
    return statement;
  }

  private withStatement<T>(sql: string, run: (statement: Database.Statement) => T): T {
    return this.attempt("other", (db) => run(this.statementFor(db, sql)));
  }

  prepare(sql: string): ReservedStatement {
    return {
      run: (...params: unknown[]) =>
        this.withStatement(sql, (statement) => statement.run(...params)),
      get: (...params: unknown[]) =>
        this.withStatement(sql, (statement) => statement.get(...params)),
      all: (...params: unknown[]) =>
        this.withStatement(sql, (statement) => statement.all(...params)),
    };
  }

  exec(sql: string): unknown {
    return this.attempt(commandKind(sql), (db) => db.exec(sql));
  }

  close(): unknown {
    return this.current.close();
  }
}

/**
 * Open the database and bring it up to the schema this build knows.
 *
 * Each migration runs inside its own transaction and is recorded in
 * `schema_migrations` in the same transaction, so a failure half way through
 * one leaves neither the change nor the record of it.
 */
export function openReservedDatabase(options: OpenOptions): ReservedDatabase {
  if (options.handle === undefined && isRemoteDatabaseUrl(options.url) && !options.authToken) {
    throw new Error(
      `Reserved database URL ${options.url} is remote and needs an auth token, but none was given`,
    );
  }
  // `libsql`'s shipped types are copied from better-sqlite3's and were never
  // extended for `authToken`, even though the runtime reads it (README,
  // "Connecting to a Remote libSQL server"; `index.js` does `opts?.authToken`).
  // The cast through `unknown` is for that gap, not for anything this
  // repository controls.
  const remoteOptions = { authToken: options.authToken } as unknown as Database.Options;
  const isRemote = isRemoteDatabaseUrl(options.url);
  const path = resolveDatabasePath(options.url);
  const openConnection = (): Database.Database =>
    new Database(path, isRemote ? remoteOptions : undefined);

  // Only a remote handle gets the reconnecting wrapper: it is the only case
  // an idle connection can be dropped out from under this process, and
  // wrapping a local `:memory:` or file connection for a failure mode it
  // cannot experience would only add a factory that, if ever invoked by
  // mistake, would silently hand back an empty database in place of the real
  // one. `options.handle` is a test's already-open handle and is used as-is
  // for the same reason `openReservedDatabase` always has: there is no URL to
  // reopen it from.
  const database: ReservedDatabase =
    options.handle ??
    (isRemote
      ? new ReconnectingDatabase(openConnection, options.eventLogger ?? (() => undefined))
      : openConnection());
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
