import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ReservedLifecycleError } from "./errors.js";
import type { Corporation, ServiceProvenance } from "./types.js";

/**
 * Every read and write the reserved category makes against its own storage.
 *
 * Two things about this module are load bearing rather than stylistic.
 *
 * **It is synchronous.** The acquire path performs its sweep, its availability
 * check and its insert inside one transaction with nothing awaited between
 * them, so no interleaving is possible within a process. That is not care
 * taken by the author: with a synchronous driver there is no `await` to write,
 * so the discipline cannot be broken by a later edit that adds one.
 *
 * **The unique index, not the check, is the guarantee.** Every availability
 * check here exists to produce an error message a client can act on. If a
 * check and the index ever disagree, the index is right, and the constraint
 * violation is translated into the same refusal the check would have produced
 * rather than surfaced as an internal error.
 */

export interface ReservedIdentity {
  bapId: string;
  bapUri: string;
  transactionId: string;
}

export type SeatLockState = "HELD" | "BOOKED" | "EXPIRED" | "RELEASED";

export interface HoldRecord {
  holdId: string;
  operator: string;
  identity: ReservedIdentity;
  serviceId: string;
  travelDate: string;
  seatIds: string[];
  state: SeatLockState;
  /** Absolute, and this provider's own. The client never computes one. */
  expiresAt: number;
  createdAt: number;
}

export type ManifestGender = "male" | "female" | "other";

/** One seat somebody currently has a claim on, and how strong the claim is. */
export interface LiveSeatClaim {
  seatId: string;
  state: "HELD" | "BOOKED";
  holdId: string | null;
  bookingId: string | null;
  identity: ReservedIdentity;
  /**
   * The passenger's declared gender, on a booked seat only. A held seat has
   * none: the hold taken at select named seats and nothing else, and the
   * manifest is the first point at which this provider learns who is going in
   * which seat. Inventing one for a held seat would be worse than waiting.
   */
  gender: ManifestGender | null;
}

export interface BookingSeatRecord {
  seatId: string;
  name: string | null;
  age: number | null;
  gender: ManifestGender | null;
  basePaise: number;
  reservationFeePaise: number;
  tollPaise: number;
  status: "CONFIRMED" | "CANCELLED";
  cancelledAt: number | null;
  refundPaise: number | null;
  slabCode: string | null;
}

export interface BookingRecord {
  id: string;
  reference: string;
  operator: string;
  identity: ReservedIdentity;
  serviceId: string;
  travelDate: string;
  serviceClass: string;
  fromBoardingPointId: string;
  toBoardingPointId: string;
  departureAt: number;
  status: "CONFIRMED" | "CANCELLED";
  basePaise: number;
  reservationFeePaise: number;
  tollPaise: number;
  createdAt: number;
  cancelledAt: number | null;
  refundPaise: number | null;
  slabCode: string | null;
  order: Record<string, unknown>;
  seats: BookingSeatRecord[];
  /**
   * Which corporation this sale is owed to, and how well that is known. Never
   * serialized onto any payload this provider sends: it settles a ledger, not
   * a screen.
   */
  settlementCorporation: Corporation | null;
  settlementBasis: ServiceProvenance;
}

export interface RefundQuoteRecord {
  id: string;
  bookingId: string;
  seatIds: string[];
  slabCode: string;
  slabPercent: number;
  refundPaise: number;
  quotedAt: number;
  expiresAt: number;
}

interface StoreOptions {
  idFactory?: () => string;
}

interface LockRow {
  id: string;
  service_id: string;
  travel_date: string;
  seat_id: string;
  state: SeatLockState;
  hold_id: string | null;
  booking_id: string | null;
  operator: string;
  bap_id: string;
  bap_uri: string;
  transaction_id: string;
  expires_at: number | null;
  created_at: number;
}

/** SQLite's own code for a unique-constraint violation. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return (
    code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY
  );
}

export class ReservedStore {
  private readonly idFactory: () => string;

  constructor(
    private readonly database: DatabaseSync,
    options: StoreOptions = {},
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  close(): void {
    this.database.close();
  }

  /** Exposed for the boot-time schema check and for tests, nothing else. */
  get handle(): DatabaseSync {
    return this.database;
  }

  private shortId(prefix: string): string {
    const component = this.idFactory()
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
    if (!component) {
      throw new Error("Reserved id generator returned no usable characters");
    }
    return `${prefix}-${component.slice(0, 8)}`;
  }

  /* ---------------------------------------------------------------- *
   * The lazy sweep
   * ---------------------------------------------------------------- */

  /**
   * Expire every hold on one dated departure whose instant has passed.
   *
   * Lazily, inside the transaction that next touches that departure, rather
   * than in a background job. This process has no scheduler and wants none: a
   * hold past its expiry is functionally released the instant anybody asks,
   * and that is the only moment the answer matters.
   */
  sweepExpiredHolds(serviceId: string, travelDate: string, nowMs: number): number {
    const result = this.database
      .prepare(
        `UPDATE seat_locks SET state = 'EXPIRED'
         WHERE state = 'HELD' AND service_id = ? AND travel_date = ?
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(serviceId, travelDate, nowMs);
    return Number(result.changes);
  }

  /* ---------------------------------------------------------------- *
   * Holds
   * ---------------------------------------------------------------- */

  liveClaims(serviceId: string, travelDate: string): LiveSeatClaim[] {
    const rows = this.database
      .prepare(
        `SELECT l.seat_id, l.state, l.hold_id, l.booking_id, l.bap_id, l.bap_uri,
                l.transaction_id, s.gender AS gender
         FROM seat_locks l
         LEFT JOIN booking_seats s
           ON s.booking_id = l.booking_id AND s.seat_id = l.seat_id
         WHERE l.service_id = ? AND l.travel_date = ?
           AND l.state IN ('HELD','BOOKED')
         ORDER BY l.seat_id`,
      )
      .all(serviceId, travelDate) as Array<
      Pick<
        LockRow,
        | "seat_id"
        | "state"
        | "hold_id"
        | "booking_id"
        | "bap_id"
        | "bap_uri"
        | "transaction_id"
      > & { gender: ManifestGender | null }
    >;
    return rows.map((row) => ({
      seatId: row.seat_id,
      state: row.state as "HELD" | "BOOKED",
      holdId: row.hold_id,
      bookingId: row.booking_id,
      identity: {
        bapId: row.bap_id,
        bapUri: row.bap_uri,
        transactionId: row.transaction_id,
      },
      gender: row.gender ?? null,
    }));
  }

  findLatestHold(
    operator: string,
    identity: ReservedIdentity,
  ): HoldRecord | undefined {
    // Ordered by insertion rather than by id, because two selects from one
    // transaction inside the same millisecond would otherwise be separated by
    // whatever the id generator happened to produce, and the newest hold is
    // the one that counts.
    const rows = this.database
      .prepare(
        `SELECT * FROM seat_locks
         WHERE operator = ? AND bap_id = ? AND bap_uri = ? AND transaction_id = ?
           AND hold_id IS NOT NULL
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(
        operator,
        identity.bapId,
        identity.bapUri,
        identity.transactionId,
      ) as unknown as LockRow[];
    const newest = rows[0];
    if (!newest) return undefined;
    const holdRows = rows.filter((row) => row.hold_id === newest.hold_id);
    return this.holdFromRows(holdRows);
  }

  findHoldById(holdId: string): HoldRecord | undefined {
    const rows = this.database
      .prepare("SELECT * FROM seat_locks WHERE hold_id = ? ORDER BY seat_id")
      .all(holdId) as unknown as LockRow[];
    return rows.length > 0 ? this.holdFromRows(rows) : undefined;
  }

  private holdFromRows(rows: LockRow[]): HoldRecord {
    const [first] = rows;
    return {
      holdId: first.hold_id!,
      operator: first.operator,
      identity: {
        bapId: first.bap_id,
        bapUri: first.bap_uri,
        transactionId: first.transaction_id,
      },
      serviceId: first.service_id,
      travelDate: first.travel_date,
      seatIds: rows.map((row) => row.seat_id).sort(),
      state: first.state,
      expiresAt: first.expires_at ?? 0,
      createdAt: first.created_at,
    };
  }

  /**
   * Whether a hold is still good, judged against this provider's own clock.
   *
   * A hold whose instant has passed is expired whether or not anybody has
   * swept it yet, so that the answer does not depend on who happened to look
   * at the same coach first.
   */
  holdStatus(hold: HoldRecord, nowMs: number): "LIVE" | "EXPIRED" | "SPENT" {
    if (hold.state === "BOOKED") return "SPENT";
    if (hold.state !== "HELD") return "EXPIRED";
    return hold.expiresAt <= nowMs ? "EXPIRED" : "LIVE";
  }

  acquireHold(params: {
    operator: string;
    identity: ReservedIdentity;
    serviceId: string;
    travelDate: string;
    seatIds: string[];
    nowMs: number;
    ttlSeconds: number;
    /**
     * Drives the insert with the availability check skipped, so that a test
     * can prove which of the check and the index is load bearing. Nothing in
     * the request path sets it.
     */
    skipAvailabilityCheckForTest?: boolean;
  }): HoldRecord {
    const seatIds = [...new Set(params.seatIds)].sort();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.sweepExpiredHolds(params.serviceId, params.travelDate, params.nowMs);

      const existing = this.findLatestHold(params.operator, params.identity);
      if (
        existing &&
        this.holdStatus(existing, params.nowMs) === "LIVE" &&
        existing.serviceId === params.serviceId &&
        existing.travelDate === params.travelDate &&
        existing.seatIds.length === seatIds.length &&
        existing.seatIds.every((seatId, index) => seatId === seatIds[index])
      ) {
        // Idempotent, and deliberately not extended. A select naming exactly
        // the seats already held returns the same hold and the same instant.
        this.database.exec("COMMIT");
        return existing;
      }
      if (existing && this.holdStatus(existing, params.nowMs) === "LIVE") {
        this.database
          .prepare(
            "UPDATE seat_locks SET state = 'RELEASED' WHERE hold_id = ? AND state = 'HELD'",
          )
          .run(existing.holdId);
      }

      if (!params.skipAvailabilityCheckForTest) {
        const taken = this.liveClaims(params.serviceId, params.travelDate)
          .filter((claim) => seatIds.includes(claim.seatId))
          .map((claim) => claim.seatId);
        if (taken.length > 0) {
          throw new ReservedLifecycleError(
            "SEAT-UNAVAILABLE",
            `Seats ${taken.join(", ")} on ${params.serviceId} for ${
              params.travelDate
            } are already held or sold`,
            { unavailableSeatIds: taken },
          );
        }
      }

      const holdId = this.shortId("HLD-KSRTC");
      if (this.findHoldById(holdId)) {
        // A hold id that already exists is an id generator that repeated
        // itself, not a contended seat. Saying so out loud matters: the insert
        // below would collide on the primary key and the collision would be
        // translated into a refusal that told a rider a free berth was taken.
        throw new Error(
          `Reserved id generator produced hold id ${holdId} twice`,
        );
      }
      const expiresAt = params.nowMs + params.ttlSeconds * 1000;
      const insert = this.database.prepare(
        `INSERT INTO seat_locks (id, service_id, travel_date, seat_id, state,
           hold_id, booking_id, operator, bap_id, bap_uri, transaction_id,
           expires_at, created_at)
         VALUES (?,?,?,?, 'HELD', ?, NULL, ?,?,?,?,?,?)`,
      );
      seatIds.forEach((seatId, index) => {
        insert.run(
          `${holdId}-${index + 1}`,
          params.serviceId,
          params.travelDate,
          seatId,
          holdId,
          params.operator,
          params.identity.bapId,
          params.identity.bapUri,
          params.identity.transactionId,
          expiresAt,
          params.nowMs,
        );
      });
      this.database.exec("COMMIT");
      return {
        holdId,
        operator: params.operator,
        identity: params.identity,
        serviceId: params.serviceId,
        travelDate: params.travelDate,
        seatIds,
        state: "HELD",
        expiresAt,
        createdAt: params.nowMs,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (isUniqueViolation(error)) {
        // The losing racer. Translated rather than surfaced, because a client
        // reading "UNIQUE constraint failed" learns nothing it can act on.
        throw new ReservedLifecycleError(
          "SEAT-UNAVAILABLE",
          `Seats ${seatIds.join(", ")} on ${params.serviceId} for ${
            params.travelDate
          } are already held or sold`,
          { unavailableSeatIds: seatIds },
        );
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------- *
   * Bookings
   * ---------------------------------------------------------------- */

  findBookingByTransaction(
    operator: string,
    identity: ReservedIdentity,
  ): BookingRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM bookings
         WHERE operator = ? AND bap_id = ? AND bap_uri = ? AND transaction_id = ?`,
      )
      .get(
        operator,
        identity.bapId,
        identity.bapUri,
        identity.transactionId,
      ) as Record<string, unknown> | undefined;
    return row ? this.bookingFromRow(row) : undefined;
  }

  /**
   * By order id or by the rider-facing reference, scoped to the buyer app that
   * bought it. A rider holding only a printed reference is the lookup path
   * `ref_id` exists for; one buyer app reading another's booking is not.
   */
  findBooking(
    operator: string,
    identity: Pick<ReservedIdentity, "bapId" | "bapUri">,
    idOrReference: string,
  ): BookingRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM bookings
         WHERE operator = ? AND bap_id = ? AND bap_uri = ?
           AND (id = ? OR reference = ?)`,
      )
      .get(
        operator,
        identity.bapId,
        identity.bapUri,
        idOrReference,
        idOrReference,
      ) as Record<string, unknown> | undefined;
    return row ? this.bookingFromRow(row) : undefined;
  }

  /**
   * A booking by id or reference, with no buyer app in the question.
   *
   * The one read on this store that is not scoped to the party that made the
   * booking, and it exists for the bearer-gated operator inspection endpoint
   * rather than for any protocol action. Nothing on a request path may call it.
   */
  inspect(idOrReference: string): BookingRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM bookings WHERE id = ? OR reference = ?")
      .get(idOrReference, idOrReference) as Record<string, unknown> | undefined;
    return row ? this.bookingFromRow(row) : undefined;
  }

  private bookingFromRow(row: Record<string, unknown>): BookingRecord {
    const id = row.id as string;
    const seats = this.database
      .prepare("SELECT * FROM booking_seats WHERE booking_id = ? ORDER BY seat_id")
      .all(id) as Array<Record<string, unknown>>;
    return {
      id,
      reference: row.reference as string,
      operator: row.operator as string,
      identity: {
        bapId: row.bap_id as string,
        bapUri: row.bap_uri as string,
        transactionId: row.transaction_id as string,
      },
      serviceId: row.service_id as string,
      travelDate: row.travel_date as string,
      serviceClass: row.service_class as string,
      fromBoardingPointId: row.from_boarding_point_id as string,
      toBoardingPointId: row.to_boarding_point_id as string,
      departureAt: Number(row.departure_at),
      status: row.status as "CONFIRMED" | "CANCELLED",
      basePaise: Number(row.base_paise),
      reservationFeePaise: Number(row.reservation_fee_paise),
      tollPaise: Number(row.toll_paise),
      createdAt: Number(row.created_at),
      cancelledAt: row.cancelled_at === null ? null : Number(row.cancelled_at),
      refundPaise: row.refund_paise === null ? null : Number(row.refund_paise),
      slabCode: (row.slab_code as string | null) ?? null,
      order: JSON.parse(row.order_json as string) as Record<string, unknown>,
      settlementCorporation:
        (row.settlement_corporation as Corporation | null) ?? null,
      settlementBasis: row.settlement_basis as ServiceProvenance,
      seats: seats.map((seat) => ({
        seatId: seat.seat_id as string,
        name: (seat.name as string | null) ?? null,
        age: seat.age === null ? null : Number(seat.age),
        gender: (seat.gender as ManifestGender | null) ?? null,
        basePaise: Number(seat.base_paise),
        reservationFeePaise: Number(seat.reservation_fee_paise),
        tollPaise: Number(seat.toll_paise),
        status: seat.status as "CONFIRMED" | "CANCELLED",
        cancelledAt:
          seat.cancelled_at === null ? null : Number(seat.cancelled_at),
        refundPaise:
          seat.refund_paise === null ? null : Number(seat.refund_paise),
        slabCode: (seat.slab_code as string | null) ?? null,
      })),
    };
  }

  /**
   * Turn a hold into a booking, in one transaction.
   *
   * The locks move from held to booked rather than being deleted and
   * reinserted, because they are the same claim on the same resource at a
   * higher strength and the index that stops a double sale is the same index.
   */
  confirmBooking(params: {
    holdId: string;
    operator: string;
    identity: ReservedIdentity;
    serviceId: string;
    travelDate: string;
    serviceClass: string;
    fromBoardingPointId: string;
    toBoardingPointId: string;
    departureAt: number;
    seats: Array<{
      seatId: string;
      name: string;
      age: number | null;
      gender: ManifestGender | null;
      basePaise: number;
      reservationFeePaise: number;
      tollPaise: number;
    }>;
    settlementCorporation: Corporation | null;
    settlementBasis: ServiceProvenance;
    nowMs: number;
    order: (ids: { orderId: string; reference: string }) => Record<string, unknown>;
  }): BookingRecord {
    const suffix = this.idFactory()
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 8);
    const operatorTag = params.operator.toUpperCase();
    const orderId = `SPECIMEN-RSV-${operatorTag}-${suffix}`;
    const reference = `SPECIMEN-${operatorTag}-${suffix}`;
    const order = params.order({ orderId, reference });
    const basePaise = params.seats.reduce((sum, seat) => sum + seat.basePaise, 0);
    const feePaise = params.seats.reduce(
      (sum, seat) => sum + seat.reservationFeePaise,
      0,
    );
    const tollPaise = params.seats.reduce((sum, seat) => sum + seat.tollPaise, 0);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const moved = this.database
        .prepare(
          `UPDATE seat_locks
           SET state = 'BOOKED', booking_id = ?, expires_at = NULL
           WHERE hold_id = ? AND state = 'HELD'`,
        )
        .run(orderId, params.holdId);
      if (Number(moved.changes) !== params.seats.length) {
        // The hold lapsed or was replaced between the check and here. Refusing
        // is the only safe answer: the seats may already belong to somebody
        // else, and half a booking is not a booking.
        throw new ReservedLifecycleError(
          "HOLD-EXPIRED",
          `Hold ${params.holdId} was no longer live at the moment of confirm`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO bookings (id, reference, operator, bap_id, bap_uri,
             transaction_id, service_id, travel_date, service_class,
             from_boarding_point_id, to_boarding_point_id, departure_at, status,
             base_paise, reservation_fee_paise, toll_paise, created_at,
             cancelled_at, refund_paise, slab_code, order_json,
             settlement_corporation, settlement_basis)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'CONFIRMED', ?,?,?,?, NULL, NULL, NULL, ?,?,?)`,
        )
        .run(
          orderId,
          reference,
          params.operator,
          params.identity.bapId,
          params.identity.bapUri,
          params.identity.transactionId,
          params.serviceId,
          params.travelDate,
          params.serviceClass,
          params.fromBoardingPointId,
          params.toBoardingPointId,
          params.departureAt,
          basePaise,
          feePaise,
          tollPaise,
          params.nowMs,
          JSON.stringify(order),
          params.settlementCorporation,
          params.settlementBasis,
        );
      const insertSeat = this.database.prepare(
        `INSERT INTO booking_seats (booking_id, seat_id, name, age, gender,
           base_paise, reservation_fee_paise, toll_paise, status)
         VALUES (?,?,?,?,?,?,?,?, 'CONFIRMED')`,
      );
      params.seats.forEach((seat) => {
        insertSeat.run(
          orderId,
          seat.seatId,
          seat.name,
          seat.age,
          seat.gender,
          seat.basePaise,
          seat.reservationFeePaise,
          seat.tollPaise,
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (isUniqueViolation(error)) {
        // Two confirms on one transaction, from two processes or from one that
        // bypassed the in-process check. The index caught it, and the honest
        // answer is the booking that already exists rather than an error.
        const existing = this.findBookingByTransaction(
          params.operator,
          params.identity,
        );
        if (existing) return existing;
      }
      throw error;
    }
    return this.findBooking(params.operator, params.identity, orderId)!;
  }

  /* ---------------------------------------------------------------- *
   * Cancellation
   * ---------------------------------------------------------------- */

  saveRefundQuote(quote: RefundQuoteRecord): RefundQuoteRecord {
    this.database
      .prepare(
        `INSERT INTO refund_quotes (id, booking_id, seat_ids, slab_code,
           slab_percent, refund_paise, quoted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        quote.id,
        quote.bookingId,
        JSON.stringify(quote.seatIds),
        quote.slabCode,
        quote.slabPercent,
        quote.refundPaise,
        quote.quotedAt,
        quote.expiresAt,
      );
    return quote;
  }

  newRefundQuoteId(): string {
    return this.shortId("RFQ-KSRTC");
  }

  findRefundQuote(id: string): RefundQuoteRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM refund_quotes WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      bookingId: row.booking_id as string,
      seatIds: JSON.parse(row.seat_ids as string) as string[],
      slabCode: row.slab_code as string,
      slabPercent: Number(row.slab_percent),
      refundPaise: Number(row.refund_paise),
      quotedAt: Number(row.quoted_at),
      expiresAt: Number(row.expires_at),
    };
  }

  /**
   * Cancel some or all of a booking's seats.
   *
   * The refund figure and the slab that produced it are written per seat and
   * never recomputed. Re-evaluating the slab on a repeated request would
   * return a smaller refund as time passed, for a cancellation that already
   * completed, which makes a retry look like a penalty.
   */
  applyCancellation(params: {
    bookingId: string;
    seatIds: string[];
    slabCode: string;
    refundBySeat: Map<string, number>;
    nowMs: number;
  }): BookingRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const cancelSeat = this.database.prepare(
        `UPDATE booking_seats
         SET status = 'CANCELLED', cancelled_at = ?, refund_paise = ?, slab_code = ?
         WHERE booking_id = ? AND seat_id = ? AND status = 'CONFIRMED'`,
      );
      const releaseLock = this.database.prepare(
        `UPDATE seat_locks SET state = 'RELEASED'
         WHERE booking_id = ? AND seat_id = ? AND state = 'BOOKED'`,
      );
      params.seatIds.forEach((seatId) => {
        cancelSeat.run(
          params.nowMs,
          params.refundBySeat.get(seatId) ?? 0,
          params.slabCode,
          params.bookingId,
          seatId,
        );
        // The seat goes back into inventory the moment it is cancelled, which
        // is what makes the adjacency rule re-evaluate for whoever remains.
        releaseLock.run(params.bookingId, seatId);
      });

      const remaining = Number(
        (
          this.database
            .prepare(
              "SELECT COUNT(*) AS remaining FROM booking_seats WHERE booking_id = ? AND status = 'CONFIRMED'",
            )
            .get(params.bookingId) as { remaining: number }
        ).remaining,
      );
      const refundTotal = Number(
        (
          this.database
            .prepare(
              "SELECT COALESCE(SUM(refund_paise), 0) AS total FROM booking_seats WHERE booking_id = ?",
            )
            .get(params.bookingId) as { total: number }
        ).total,
      );
      this.database
        .prepare(
          `UPDATE bookings
           SET status = ?, cancelled_at = ?, refund_paise = ?, slab_code = ?
           WHERE id = ?`,
        )
        .run(
          // A booking with no confirmed seats left is cancelled, not an empty
          // confirmed booking.
          remaining === 0 ? "CANCELLED" : "CONFIRMED",
          params.nowMs,
          refundTotal,
          params.slabCode,
          params.bookingId,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const row = this.database
      .prepare("SELECT * FROM bookings WHERE id = ?")
      .get(params.bookingId) as Record<string, unknown>;
    return this.bookingFromRow(row);
  }

  /** Replaces the stored order, which a cancellation rewrites. */
  updateStoredOrder(bookingId: string, order: Record<string, unknown>): void {
    this.database
      .prepare("UPDATE bookings SET order_json = ? WHERE id = ?")
      .run(JSON.stringify(order), bookingId);
  }

  /* ---------------------------------------------------------------- *
   * Retention
   * ---------------------------------------------------------------- */

  /**
   * Drop the manifest of every booking whose departure passed more than the
   * retention window ago, on the same lazy sweep as an expired hold.
   *
   * The booking row survives, because a rider needs to see that a journey
   * happened. The names do not, because nothing needs them once the coach has
   * gone. The stored order carries the manifest too, so the sweep rewrites it
   * rather than only nulling the columns: leaving the names in one copy while
   * deleting them from the other would be a retention policy that retains.
   */
  sweepManifests(nowMs: number, retentionDays: number): number {
    const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    const stale = this.database
      .prepare(
        `SELECT DISTINCT b.id AS id, b.order_json AS order_json
         FROM bookings b JOIN booking_seats s ON s.booking_id = b.id
         WHERE b.departure_at < ? AND s.name IS NOT NULL`,
      )
      .all(cutoff) as Array<{ id: string; order_json: string }>;
    if (stale.length === 0) return 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const clearSeats = this.database.prepare(
        "UPDATE booking_seats SET name = NULL, age = NULL, gender = NULL WHERE booking_id = ?",
      );
      const rewrite = this.database.prepare(
        "UPDATE bookings SET order_json = ? WHERE id = ?",
      );
      stale.forEach((booking) => {
        clearSeats.run(booking.id);
        rewrite.run(
          JSON.stringify(
            withoutManifestNames(JSON.parse(booking.order_json) as unknown),
          ),
          booking.id,
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return stale.length;
  }

  /* ---------------------------------------------------------------- *
   * The reconciliation backlog
   * ---------------------------------------------------------------- */

  /**
   * What is owed, and to nobody in particular yet.
   *
   * Grouped by dated departure rather than by booking, because whoever
   * eventually confirms which corporation ran a given service on a given night
   * resolves every unattributed booking against that one service instance in a
   * single stroke, which is the shape the real problem has. The amount is what
   * is still owed after any cancellation, not the gross fare: a cancelled
   * booking still owes the reservation fee and whatever share of the base fare
   * the slab retained.
   *
   * This is a read, not a process. Who runs it and how often is a decision for
   * a deployment with real money in it, and this provider has none.
   *
   * The specification writes the sum as
   * `base_paise + reservation_fee_paise - refund_paise`, and that is short by
   * the toll on every cancelled booking: the refund includes the toll, and the
   * two columns it is subtracted from never did. The toll was never the
   * corporation's revenue in the first place, so it is added back for the
   * cancelled seats rather than left to quietly reduce what is owed. The
   * result is the complement of the refund, seat by seat, which is what the
   * same document says the retained amount is everywhere else.
   */
  unattributedBookings(): Array<{
    serviceId: string;
    travelDate: string;
    bookings: number;
    owedPaise: number;
  }> {
    return (
      this.database
        .prepare(
          `SELECT b.service_id AS service_id, b.travel_date AS travel_date,
                  COUNT(*) AS bookings,
                  SUM(b.base_paise + b.reservation_fee_paise
                      - COALESCE(b.refund_paise, 0)
                      + COALESCE((SELECT SUM(s.toll_paise) FROM booking_seats s
                                  WHERE s.booking_id = b.id
                                    AND s.status = 'CANCELLED'), 0)) AS owed_paise
           FROM bookings b
           WHERE b.settlement_corporation IS NULL
             AND b.status IN ('CONFIRMED','CANCELLED')
           GROUP BY b.service_id, b.travel_date
           ORDER BY b.service_id, b.travel_date`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      serviceId: row.service_id as string,
      travelDate: row.travel_date as string,
      bookings: Number(row.bookings),
      owedPaise: Number(row.owed_paise),
    }));
  }
}

/**
 * The stored order with every passenger name, age and gender removed from its
 * manifest, and the seat ids left alone. A seat is not personal data; the
 * person in it is.
 */
export function withoutManifestNames(order: unknown): unknown {
  if (Array.isArray(order)) return order.map(withoutManifestNames);
  if (order === null || typeof order !== "object") return order;
  const record = order as Record<string, unknown>;
  const code = (record.descriptor as { code?: string } | undefined)?.code;
  if (code === "MANIFEST" && Array.isArray(record.list)) {
    return {
      ...record,
      list: (record.list as Array<Record<string, unknown>>).filter(
        (entry) =>
          (entry.descriptor as { code?: string } | undefined)?.code === "SEAT_ID",
      ),
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, withoutManifestNames(value)]),
  );
}
