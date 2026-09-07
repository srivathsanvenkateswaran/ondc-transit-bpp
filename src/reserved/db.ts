import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "libsql/promise";

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
 * ## Why the promise client, and what replaced the guarantee it removed
 *
 * This module used the synchronous `libsql` entry point, and leaned on it:
 * section 8.5 asks that the acquire path perform its sweep, its availability
 * check and its insert with no `await` between them, and with a synchronous
 * driver there is no `await` to write, so no interleaving was expressible
 * rather than merely avoided.
 *
 * The cost of that was not stated anywhere, and it is the whole reason this
 * changed: a synchronous native call cannot yield to Node's event loop for
 * its entire duration. Measured locally on 2026-09-07, a single synchronous
 * libSQL call made to take 4.37 seconds let a concurrent 20ms timer fire
 * exactly zero times out of the ~218 ticks it was owed. On a local file that
 * duration is microseconds and nobody notices. Against the hosted database
 * this deployment actually points at - Turso in Mumbai, from a dyno in
 * Heroku's `us` region, about 230ms a statement - every single prepared
 * statement, and every `BEGIN IMMEDIATE` and `COMMIT`, froze the entire
 * process for that round trip: not merely the KSRTC request that issued it,
 * but every BMTC and BMRCL search behind it and `/healthz` too. Requests
 * queued behind whoever held a blocking call, which is why `/ksrtc/search`
 * ran a 7.4 second median against a round-trip count that should have cost
 * about 1.15 seconds uncontended, and why nine of them in one sample ran out
 * Heroku's 30 second router clock entirely.
 *
 * So `libsql/promise` - the same driver, the same call shape, the same
 * engine, with the I/O awaited instead of blocked on. What that removes is
 * the by-construction half of section 8.5's argument, and it is replaced
 * with the ordinary two:
 *
 *   - **One transaction at a time on this handle.** `withTransaction` below
 *     serialises every transaction it opens against every other transaction
 *     on the same database, so an acquire path's sweep, check and insert
 *     still run with nothing else's write between them. This is not only a
 *     correctness argument: one connection cannot hold two `BEGIN IMMEDIATE`s
 *     at once, so without the queue two overlapping selects would fail with
 *     "cannot start a transaction within a transaction" rather than race.
 *   - **The unique index is still the guarantee.** `seat_locks_live` is what
 *     actually stops one berth being held twice, exactly as section 8.5 says,
 *     and `ReservedStore` still translates its constraint violation into
 *     `SEAT-UNAVAILABLE` rather than surfacing it. The availability check
 *     produces a good message; the index decides.
 *
 * What is deliberately *not* claimed: a read issued outside a transaction can
 * now interleave with another request's open transaction on this one
 * connection, and would see that transaction's uncommitted rows. Every such
 * read in this codebase is advisory - it exists to produce an error message
 * or to render a seat map - and the index decides the case where it would
 * matter. Every write, without exception, is inside a transaction, which
 * `tests/reserved/no-bare-writes.test.ts` exists to keep true.
 *
 * ## What this version of libsql actually makes asynchronous
 *
 * `libsql/promise` is not uniformly async, and it is worth naming which half
 * is which rather than assuming. In 0.5.29, `prepare`, `exec` and a
 * statement's `all` go through the driver's `*Async` bindings and genuinely
 * yield; a statement's `run` and `get` still call the synchronous binding and
 * would still block. So `get` is served here by `all` and its first row -
 * every `get` in this codebase is a lookup by primary key, by a unique index,
 * or an aggregate that returns exactly one row, so the first row is the row -
 * and only `run`, the single-statement write, is left calling a blocking
 * binding. Writes are a small minority of this provider's statements and none
 * of them are on the search path that was timing out.
 *
 * Running behind more than one replica needs a real server rather than a
 * file, which is a swap of this module's target and nothing above it.
 * Everything above talks to `ReservedStore`, and the unique index remains the
 * guarantee either way.
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
  run(
    ...params: unknown[]
  ): Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}

export interface ReservedDatabase {
  /**
   * Synchronous, and returning a handle whose three methods are not.
   *
   * The driver's own `prepare` is asynchronous now, but hoisting that into
   * every call site would have turned `db.prepare(sql).run(x)` into two
   * awaits at roughly ninety places for no gain: the preparation and the
   * execution are one logical round trip to a caller, and nothing here ever
   * holds a prepared statement across anything. So the handle is lazy and
   * each of `run`, `get` and `all` awaits the preparation it needs.
   */
  prepare(sql: string): ReservedStatement;
  exec(sql: string): Promise<unknown>;
  close(): unknown;
}

/**
 * The driver's own statement, of which this module calls two methods.
 *
 * Exported for `db-reconnect.test.ts`, which hands `ReconnectingDatabase` a
 * scripted connection in place of a real one: without this the test would
 * have to describe the driver's shape itself and could drift from what this
 * module actually calls.
 */
export interface DriverStatement {
  /**
   * The one method `libsql/promise` 0.5.29 still answers synchronously. It is
   * declared as either, rather than as the driver's own synchronous shape,
   * so that the day it does return a promise nothing here has to change - and
   * so a test's scripted connection can be honestly asynchronous.
   */
  run(
    ...params: unknown[]
  ):
    | { changes: number | bigint; lastInsertRowid: number | bigint }
    | Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  all(...params: unknown[]): Promise<unknown[]>;
}

/**
 * The driver's `Database`, narrowed to what this module uses.
 *
 * `libsql/promise`'s shipped types declare `prepare` and `exec` as `any`,
 * so this is the honest description of the two calls rather than a cast at
 * every use.
 */
export interface DriverDatabase {
  prepare(sql: string): Promise<DriverStatement>;
  exec(sql: string): Promise<unknown>;
  close(): void;
}

function driverDatabase(database: Database): DriverDatabase {
  return database as unknown as DriverDatabase;
}

/**
 * A `ReservedStatement` over one `libsql/promise` connection.
 *
 * `get` is `all`'s first row rather than the driver's own `get`: see this
 * module's header for why - the driver's `get` is one of the two methods
 * `libsql/promise` left calling a blocking binding, and every `get` in this
 * codebase asks a question with at most one answer.
 */
function statementOver(
  database: DriverDatabase,
  sql: string,
): ReservedStatement {
  return {
    run: async (...params: unknown[]) =>
      await (await database.prepare(sql)).run(...params),
    get: async (...params: unknown[]) =>
      (await (await database.prepare(sql)).all(...params))[0],
    all: async (...params: unknown[]) =>
      (await database.prepare(sql)).all(...params),
  };
}

/**
 * The plain, non-reconnecting handle: a local file or `:memory:`.
 *
 * A thin adapter rather than the driver's own object, because the driver's
 * `prepare` returns a promise and this interface's does not - see
 * `ReservedDatabase.prepare` for why the laziness lives here.
 */
class PromiseDatabase implements ReservedDatabase {
  private readonly driver: DriverDatabase;

  constructor(database: Database) {
    this.driver = driverDatabase(database);
  }

  prepare(sql: string): ReservedStatement {
    return statementOver(this.driver, sql);
  }

  exec(sql: string): Promise<unknown> {
    return this.driver.exec(sql);
  }

  close(): unknown {
    return this.driver.close();
  }
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

/**
 * The server, not this client, ended the transaction.
 *
 * Turso enforces its own timeout on an "interactive transaction" - a BEGIN
 * held open across more than one Hrana round trip - shorter than the idle
 * window that kills the stream itself outright. Cross it and the *stream*
 * survives; only the transaction is discarded server-side. Whichever
 * statement asks next is told there is nothing there, in whichever of three
 * wordings that particular statement happens to trigger: a bare `COMMIT` or
 * `ROLLBACK` gets "cannot commit/rollback - no transaction is active", and a
 * statement mid-batch gets "interactive transaction was rolled back because
 * the stream was idle for too long; retry the transaction" (sometimes tagged
 * `SQLITE_BUSY`, sometimes not - both were reproduced directly against the
 * real Turso database on 2026-09-07 by holding a transaction open past
 * roughly ten to twenty seconds and letting the next statement, or `COMMIT`
 * itself, discover it).
 *
 * `isNothingToRollBack` already named the narrowest of these - a `ROLLBACK`
 * that got exactly what it wanted - and stays the one place that turns a
 * failure into success. This predicate is the general fact underneath all
 * three wordings: `ReconnectingDatabase` uses it to stop believing a
 * transaction is open once the server has already discarded it, on every
 * kind of statement, not only `ROLLBACK`. It never authorises treating a
 * `COMMIT` failure as anything but a failure - see `attempt` below.
 */
export function isTransactionAlreadyGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  if (message === undefined) return false;
  return (
    isNothingToRollBack(error) ||
    /cannot commit\s*-?\s*no transaction is active/i.test(message) ||
    /interactive transaction was rolled back/i.test(message)
  );
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
  private current: DriverDatabase;
  private generation = 0;
  private inTransaction = false;
  private readonly statementCache = new Map<
    string,
    { generation: number; statement: Promise<DriverStatement> }
  >();

  constructor(
    private readonly factory: () => DriverDatabase,
    private readonly eventLogger: EventLogger,
  ) {
    this.current = this.factory();
  }

  private async reconnect(cause: unknown): Promise<void> {
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
    await this.current.exec("PRAGMA foreign_keys = ON");
  }

  private async attempt<T>(
    kind: OperationKind,
    operation: (db: DriverDatabase) => T | Promise<T>,
  ): Promise<T> {
    const wasInTransaction = this.inTransaction;
    try {
      const result = await operation(this.current);
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
      if (wasInTransaction && isTransactionAlreadyGone(error)) {
        // Turso discarded this transaction on its own - the stream is still
        // fine, so there is nothing to reconnect, but this client's own
        // `inTransaction` must not go on believing a transaction is open
        // that the server has already thrown away, or the next `BEGIN`
        // inherits a lie. A `COMMIT` that hits this path is still rethrown
        // below exactly as any other real failure would be: the work it was
        // meant to durably record was never inside a transaction at all by
        // the time it ran, and that is not a success dressed up as one.
        this.inTransaction = false;
        throw error;
      }
      if (!isDeadStreamError(error)) throw error;
      await this.reconnect(error);
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
      const result = await operation(this.current);
      if (kind === "begin") this.inTransaction = true;
      return result;
    }
  }

  /**
   * The prepared statement for `sql` on the live connection.
   *
   * The *promise* is cached, not the statement, so two calls for the same SQL
   * that overlap share one preparation instead of racing to make two. A
   * preparation that fails is evicted, so the failure is not cached for the
   * life of the connection.
   */
  private statementFor(db: DriverDatabase, sql: string): Promise<DriverStatement> {
    const cached = this.statementCache.get(sql);
    if (cached && cached.generation === this.generation) return cached.statement;
    const generation = this.generation;
    const statement = db.prepare(sql).catch((error: unknown) => {
      const entry = this.statementCache.get(sql);
      if (entry && entry.generation === generation) this.statementCache.delete(sql);
      throw error;
    });
    this.statementCache.set(sql, { generation, statement });
    return statement;
  }

  private withStatement<T>(
    sql: string,
    run: (statement: DriverStatement) => T | Promise<T>,
  ): Promise<T> {
    return this.attempt("other", async (db) => run(await this.statementFor(db, sql)));
  }

  prepare(sql: string): ReservedStatement {
    return {
      run: async (...params: unknown[]) =>
        await this.withStatement(sql, (statement) => statement.run(...params)),
      get: (...params: unknown[]) =>
        this.withStatement(sql, async (statement) =>
          (await statement.all(...params))[0],
        ),
      all: (...params: unknown[]) =>
        this.withStatement(sql, (statement) => statement.all(...params)),
    };
  }

  exec(sql: string): Promise<unknown> {
    return this.attempt(commandKind(sql), (db) => db.exec(sql));
  }

  close(): unknown {
    return this.current.close();
  }
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE` / `COMMIT` transaction against
 * `database`, `ROLLBACK` on any failure - `fn`'s own or `COMMIT`'s - and
 * always re-throw whatever `fn` or `COMMIT` actually threw, never whatever
 * the `ROLLBACK` attempt says.
 *
 * `store.ts` had this pattern by hand in four places (`acquireHold`,
 * `confirmBooking`, `applyCancellation`, `sweepManifests`), each its own
 * `BEGIN IMMEDIATE`, try block, `COMMIT`, and a catch that ran `ROLLBACK`
 * before re-throwing. One copy here rather than four means the one subtlety
 * that matters - a `ROLLBACK` that fails is never allowed to replace the
 * error that caused it - is written once and cannot drift between sites. A
 * `ROLLBACK` failing at all is already rare (`ReconnectingDatabase` turns the
 * ordinary case, nothing left to roll back, into a no-op), but a second,
 * unrelated failure right after the first is exactly the kind of situation
 * where losing the original error is worst: the caller needs to hear why the
 * transaction actually broke, not why the cleanup afterward also did.
 *
 * `libsql`'s own `Database.transaction()` was considered and set aside: it
 * is implemented as this same `BEGIN`/`fn`/`COMMIT`/`ROLLBACK` shape over the
 * same Hrana round trips, so adopting it would buy nothing here and cannot
 * be handed a `ReconnectingDatabase` in the first place, since that wrapper
 * deliberately only implements `prepare`, `exec` and `close` - see its class
 * doc for why a single persistent connection is not an assumption this
 * module can make.
 *
 * **One at a time per database, and that is load bearing.** Every call queues
 * behind whatever transaction is already open on the same handle. Two reasons,
 * and either one alone would be enough:
 *
 *   - One connection cannot hold two transactions. Overlapping selects for
 *     different seats on the same coach are an ordinary thing for this
 *     provider to be asked, and without the queue the second one's `BEGIN
 *     IMMEDIATE` would fail with "cannot start a transaction within a
 *     transaction" - an internal error where a rider should have got a seat.
 *   - It is what replaces the guarantee the synchronous driver used to give
 *     for free. Section 8.5 asks that the acquire path's sweep, availability
 *     check and insert run with nothing interleaved between them; with the
 *     queue they do, because nothing else's transaction can begin until this
 *     one has committed or rolled back.
 *
 * A queue is not a lock on the database, only on this process's use of this
 * handle, and it is not what makes double-booking impossible - the unique
 * index is, across processes as well as within one. See `store.ts`.
 */
const transactionQueue = new WeakMap<ReservedDatabase, Promise<unknown>>();

export function withTransaction<T>(
  database: ReservedDatabase,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Queued behind whatever transaction is already open on this database, and
  // on failure as well as on success: a transaction that threw has still
  // ended, and refusing to run the next one because the last one failed would
  // turn one bad request into an outage.
  const previous = transactionQueue.get(database) ?? Promise.resolve();
  const result = previous.then(
    () => runTransaction(database, fn),
    () => runTransaction(database, fn),
  );
  transactionQueue.set(
    database,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function runTransaction<T>(
  database: ReservedDatabase,
  fn: () => T | Promise<T>,
): Promise<T> {
  await database.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      await database.exec("ROLLBACK");
    } catch {
      // Best-effort cleanup. The transaction is already gone - most often
      // the ordinary case `ReconnectingDatabase` already turns into a no-op
      // - and if the rollback itself fails for some other reason, the error
      // that actually matters is the one caught above, not this one.
    }
    throw error;
  }
}

/**
 * Open the database and bring it up to the schema this build knows.
 *
 * Each migration runs inside its own transaction and is recorded in
 * `schema_migrations` in the same transaction, so a failure half way through
 * one leaves neither the change nor the record of it.
 */
export async function openReservedDatabase(
  options: OpenOptions,
): Promise<ReservedDatabase> {
  if (options.handle === undefined && isRemoteDatabaseUrl(options.url) && !options.authToken) {
    throw new Error(
      `Reserved database URL ${options.url} is remote and needs an auth token, but none was given`,
    );
  }
  const isRemote = isRemoteDatabaseUrl(options.url);
  const path = resolveDatabasePath(options.url);
  const openConnection = (): DriverDatabase =>
    driverDatabase(new Database(path, isRemote ? { authToken: options.authToken } : {}));

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
      : new PromiseDatabase(new Database(path, {})));
  await database.exec("PRAGMA foreign_keys = ON");
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    )
  `);

  const migrations = migrationsUnder(options.migrationRoot);
  const knownVersion = migrations.at(-1)?.version ?? 0;
  const applied = new Set(
    (
      (await database
        .prepare("SELECT version FROM schema_migrations")
        .all()) as Array<{ version: number }>
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

  for (const migration of migrations.filter(
    (candidate) => !applied.has(candidate.version),
  )) {
    await database.exec("BEGIN");
    try {
      await database.exec(migration.sql);
      await database
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, Date.now());
      await database.exec("COMMIT");
    } catch (error) {
      await database.exec("ROLLBACK");
      throw new Error(
        `Reserved migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return database;
}
