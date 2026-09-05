import { randomUUID } from "node:crypto";

import {
  bookingWindowStatus,
  istIsoInstant,
  runsOn,
  stopInstantMilliseconds,
} from "./calendar.js";
import {
  RESERVED_CATEGORY,
  bookingRefTag,
  cancelledSeatsTag,
  catalogueFulfillment,
  holdInfoTag,
  orderFulfillment,
  refundSlabTag,
  reservedItem,
  reservedSearchQuery,
  seatMapLayoutTag,
  seatMapRefTag,
  seatMapTag,
  seatsTag,
  specimenTag,
  vehicleLookupTag,
  type Tag,
} from "./catalog.js";
import {
  concessionDiscountPaise,
  concessionFromOrderTags,
  concessionLabel,
  concessionRatePercent,
} from "./concession.js";
import {
  CONFIRMED_SPECIMEN_NOTICE,
  parseReservedItemId,
  type SeatState,
} from "./domain.js";
import { ReservedLifecycleError } from "./errors.js";
import {
  boardingPairFromStops,
  fareCell,
  headlinePair,
  type BoardingPair,
} from "./fares.js";
import {
  assertManifestMatchesHold,
  manifestTag,
  manifestTagFrom,
  parseManifest,
  type ManifestRecord,
} from "./manifest.js";
import { paiseToRupees, signedPaiseToRupees } from "./money.js";
import { seededOccupancy, type SeededGender } from "./occupancy.js";
import { computeRefund, type RefundComputation } from "./refund.js";
import { assertGenderLocks, availableSeatCount, seatStates } from "./seatstate.js";
import type {
  BookingRecord,
  HoldRecord,
  LiveSeatClaim,
  ReservedIdentity,
  ReservedStore,
} from "./store.js";
import type {
  FareTable,
  ReservedOperatorKey,
  ReservedService,
  ReservedServiceSource,
  SeatMap,
} from "./types.js";

/**
 * The order flow for a reserved intercity seat.
 *
 * The shape follows the single-journey path next door - a base order built
 * from the request, thickened at each action - and departs from it wherever
 * inventory makes the two genuinely different. Three departures are worth
 * naming here rather than finding in the code:
 *
 * **A select can fail.** The path next door has no inventory, so every select
 * succeeds and there is no out-of-stock branch. Here a seat is finite and
 * contended, and a select either takes a hold or is refused.
 *
 * **The clock is a decision, not a timestamp.** Whether a hold is live,
 * whether a departure is still sellable and which refund slab applies are all
 * answered against this provider's own clock and never against a figure a
 * client sent. The clock is injected, so none of it has to be waited out in a
 * test.
 *
 * **Nothing here mints a credential.** There is no authorization object on a
 * reserved fulfillment: no image, no rotating secret, no token. The boarding
 * check on an intercity coach is a conductor with a manifest rather than a
 * gate with a reader, and minting a credential would model a verification
 * nobody performs.
 */

export interface ReservationRuntime {
  closeMinutes: number;
  horizonDays: number;
  occupancySeed: number;
  holdTtlSeconds: number;
  manifestRetentionDays: number;
}

export interface ReservedOrderOptions {
  publicBaseUrl: string;
  reservation: ReservationRuntime;
  now?: () => Date;
  idFactory?: () => string;
}

interface ReservedContext {
  transaction_id: string;
  message_id: string;
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  location?: { city?: { code?: string } };
}

interface ReservedRequest {
  context: ReservedContext;
  message: Record<string, unknown>;
}

interface OrderInput {
  items?: Array<{ id: string; quantity?: { selected?: { count?: number } } }>;
  provider?: { id?: string };
  fulfillments?: Array<{
    id?: string;
    stops?: Array<{ type?: string; location?: { descriptor?: { code?: string } } }>;
  }>;
  billing?: Record<string, unknown>;
  payments?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
}

/** Everything one action needs about one dated departure, resolved once. */
interface Resolved {
  service: ReservedService;
  seatMap: SeatMap;
  fareTable: FareTable;
  travelDate: string;
  departureAt: number;
}

interface Snapshot {
  seeded: Map<string, SeededGender>;
  claims: LiveSeatClaim[];
  states: Map<string, SeatState>;
  availableCount: number;
}

export class ReservedOrderService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly confirmations = new Map<string, Promise<BookingRecord>>();

  constructor(
    private readonly operatorKey: ReservedOperatorKey,
    private readonly source: ReservedServiceSource,
    private readonly runtime: {
      subscriberId: string;
      subscriberUri: string;
    },
    private readonly store: ReservedStore,
    private readonly options: ReservedOrderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /* ---------------------------------------------------------------- *
   * search
   * ---------------------------------------------------------------- */

  async search(request: ReservedRequest): Promise<Record<string, unknown>> {
    const query = reservedSearchQuery(request as never);
    const nowMs = this.now().getTime();
    // The retention sweep rides the same lazy discipline as the hold sweep:
    // whoever next touches this provider pays for it, because a process with
    // no scheduler has no other moment to do it in.
    this.store.sweepManifests(
      nowMs,
      this.options.reservation.manifestRetentionDays,
    );
    const services = await this.source.services(query);
    const items: Array<Record<string, unknown>> = [];
    const fulfillments: Array<Record<string, unknown>> = [];

    for (const service of services) {
      const departureAt = stopInstantMilliseconds(
        query.travelDate,
        service.departureMinute,
        0,
      );
      // A departure that cannot be transacted is not published. An item a
      // rider can see and cannot buy is worse than one that is not there:
      // this provider knows the reservation is closed and the buyer app would
      // only find out by trying.
      if (this.windowStatus(departureAt, nowMs).status !== "OPEN") continue;

      const seatMap = await this.seatMapFor(service);
      const fareTable = await this.fareTableFor(service);
      const pair = headlinePair(service);
      const cell = fareTable.fares.find(
        (candidate) =>
          candidate.fromBoardingPointId === pair.fromBoardingPointId &&
          candidate.toBoardingPointId === pair.toBoardingPointId &&
          candidate.serviceClass === service.serviceClass,
      );
      // An item whose own headline pair has no published fare is left out
      // rather than published at a number nobody sourced. The schema requires
      // a price on an item, and there is no honest one to put there.
      if (!cell) continue;

      const snapshot = this.snapshot(service, seatMap, query.travelDate);
      items.push(
        reservedItem({
          service,
          travelDate: query.travelDate,
          pricePaise: cell.farePaise,
          pair,
          fareSourcing: cell.sourcing,
          availableCount: snapshot.availableCount,
        }),
      );
      fulfillments.push(catalogueFulfillment(service, query.travelDate));
    }

    return {
      catalog: {
        descriptor: {
          name: `${this.source.operator.name} Specimen Reserved Catalogue`,
        },
        providers: [
          {
            id: this.source.operator.id,
            descriptor: { name: this.source.operator.name },
            // One category, because this seller sells one thing. The
            // specification pictures a provider whose existing two categories
            // gain a third; this seller is a separate identity that sells
            // neither of the other two, and publishing empty categories for
            // them would advertise products that do not exist.
            categories: [RESERVED_CATEGORY],
            items,
            fulfillments,
          },
        ],
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * select
   * ---------------------------------------------------------------- */

  async select(request: ReservedRequest): Promise<Record<string, unknown>> {
    this.assertBppAddress(request.context);
    const input = (request.message as { order: OrderInput }).order;
    const resolved = await this.resolveSelection(request.context, input);
    const identity = this.identity(request.context);
    const seatIds = this.seatIdsFrom(input.tags);
    const selectedCount = input.items?.[0]?.quantity?.selected?.count ?? 1;
    if (seatIds.length > 0 && seatIds.length !== selectedCount) {
      throw new ReservedLifecycleError(
        "SEAT-COUNT-MISMATCH",
        `The selection names ${seatIds.length} seats and asks for ${selectedCount}; neither wins over the other`,
      );
    }
    const pair = boardingPairFromStops(
      resolved.service,
      input.fulfillments?.[0]?.stops ?? [],
    );
    const cell = fareCell(resolved.fareTable, pair, resolved.service.serviceClass);

    let hold: HoldRecord | undefined;
    if (seatIds.length > 0) {
      this.assertSeatsOnMap(resolved.seatMap, seatIds);
      const nowMs = this.now().getTime();
      const snapshot = this.snapshot(
        resolved.service,
        resolved.seatMap,
        resolved.travelDate,
        identity,
      );
      // A seat the simulation sold is refused before the database is asked,
      // because no row exists to collide with: the seeded sold set is not
      // inventory this provider holds, it is inventory it models.
      const simulated = seatIds.filter((seatId) => snapshot.seeded.has(seatId));
      if (simulated.length > 0) {
        throw new ReservedLifecycleError(
          "SEAT-UNAVAILABLE",
          `Seats ${simulated.join(", ")} on ${resolved.service.serviceId} for ${
            resolved.travelDate
          } are already held or sold`,
          {
            unavailableSeatIds: simulated,
            seatMap: seatMapTag(resolved.seatMap.seatMapId, snapshot.states),
            seatMapLayout: seatMapLayoutTag(resolved.seatMap),
          },
        );
      }
      try {
        hold = this.store.acquireHold({
          operator: this.operatorKey,
          identity,
          serviceId: resolved.service.serviceId,
          travelDate: resolved.travelDate,
          seatIds,
          nowMs,
          ttlSeconds: this.options.reservation.holdTtlSeconds,
        });
      } catch (error) {
        if (error instanceof ReservedLifecycleError && error.code === "SEAT-UNAVAILABLE") {
          // The seat map goes back with the refusal, already reflecting the
          // winner's hold, so the loser can re-render without a second round
          // trip.
          const after = this.snapshot(
            resolved.service,
            resolved.seatMap,
            resolved.travelDate,
            identity,
          );
          throw new ReservedLifecycleError(error.code, error.message, {
            ...error.attachment,
            seatMap: seatMapTag(resolved.seatMap.seatMapId, after.states),
            seatMapLayout: seatMapLayoutTag(resolved.seatMap),
          });
        }
        throw error;
      }
    }

    const order = this.buildOrder({
      resolved,
      pair,
      farePaise: cell.farePaise,
      fareSourcing: cell.sourcing,
      seatCount: seatIds.length > 0 ? seatIds.length : selectedCount,
      identity,
      hold,
      seatIds,
      concessionClaim: concessionFromOrderTags(input.tags),
      fulfillmentTags: [seatMapRefTag(resolved.seatMap.seatMapId)],
    });
    return { order };
  }

  /* ---------------------------------------------------------------- *
   * init
   * ---------------------------------------------------------------- */

  async init(request: ReservedRequest): Promise<Record<string, unknown>> {
    this.assertBppAddress(request.context);
    const input = (request.message as { order: OrderInput }).order;
    this.assertPaymentStatus(input.payments, "NOT_PAID");
    const identity = this.identity(request.context);
    const resolved = await this.resolveSelection(request.context, input);
    const { hold, records } = this.liveHoldAndManifest(resolved, identity, input);
    const pair = boardingPairFromStops(
      resolved.service,
      input.fulfillments?.[0]?.stops ?? [],
    );
    const cell = fareCell(resolved.fareTable, pair, resolved.service.serviceClass);

    const order = this.buildOrder({
      resolved,
      pair,
      farePaise: cell.farePaise,
      fareSourcing: cell.sourcing,
      seatCount: hold.seatIds.length,
      identity,
      hold,
      seatIds: hold.seatIds,
      concessionClaim: concessionFromOrderTags(input.tags),
      fulfillmentTags: [
        seatMapRefTag(resolved.seatMap.seatMapId),
        manifestTagFrom(records),
      ],
      billing: input.billing,
      payments: input.payments,
    });
    return { order };
  }

  /* ---------------------------------------------------------------- *
   * confirm
   * ---------------------------------------------------------------- */

  async confirm(request: ReservedRequest): Promise<Record<string, unknown>> {
    this.assertBppAddress(request.context);
    const input = (request.message as { order: OrderInput }).order;
    this.assertPaymentStatus(input.payments, "PAID");
    const identity = this.identity(request.context);

    // Idempotent on the transaction, which a Beckn transaction id is already
    // defined to be constant for across the whole life of one order.
    const existing = this.store.findBookingByTransaction(
      this.operatorKey,
      identity,
    );
    if (existing) return { order: existing.order };

    const key = JSON.stringify([this.operatorKey, identity]);
    const pending = this.confirmations.get(key);
    if (pending) return { order: (await pending).order };
    const confirmation = this.confirmNew(request.context, input, identity);
    this.confirmations.set(key, confirmation);
    try {
      return { order: (await confirmation).order };
    } finally {
      if (this.confirmations.get(key) === confirmation) {
        this.confirmations.delete(key);
      }
    }
  }

  private async confirmNew(
    context: ReservedContext,
    input: OrderInput,
    identity: ReservedIdentity,
  ): Promise<BookingRecord> {
    const resolved = await this.resolveSelection(context, input);
    const { hold, records } = this.liveHoldAndManifest(resolved, identity, input);
    const pair = boardingPairFromStops(
      resolved.service,
      input.fulfillments?.[0]?.stops ?? [],
    );
    const cell = fareCell(resolved.fareTable, pair, resolved.service.serviceClass);
    const nowMs = this.now().getTime();

    // The attribution is copied from the service as it stands at this instant
    // and frozen. No inference happens here: whatever inference there was
    // happened upstream, when the source decided what basis the service
    // carries. A later data refresh that reclassified the service must never
    // reach back into a transaction that already closed.
    const attributed = resolved.service.operatingCorporationBasis === "confirmed";

    const booking = this.store.confirmBooking({
      holdId: hold.holdId,
      operator: this.operatorKey,
      identity,
      serviceId: resolved.service.serviceId,
      travelDate: resolved.travelDate,
      serviceClass: resolved.service.serviceClass,
      fromBoardingPointId: pair.fromBoardingPointId,
      toBoardingPointId: pair.toBoardingPointId,
      departureAt: resolved.departureAt,
      seats: records.map((record) => ({
        seatId: record.seatId,
        name: record.name,
        age: record.age,
        gender: record.gender,
        basePaise: cell.farePaise,
        reservationFeePaise: resolved.service.reservationFeePaise,
        tollPaise: resolved.service.tollPaise,
      })),
      settlementCorporation: attributed
        ? resolved.service.operatingCorporation
        : null,
      settlementBasis: resolved.service.operatingCorporationBasis,
      nowMs,
      order: ({ orderId, reference }) =>
        this.buildOrder({
          resolved,
          pair,
          farePaise: cell.farePaise,
          fareSourcing: cell.sourcing,
          seatCount: records.length,
          identity,
          seatIds: records.map((record) => record.seatId),
          concessionClaim: concessionFromOrderTags(input.tags),
          fulfillmentTags: [
            seatMapRefTag(resolved.seatMap.seatMapId),
            bookingRefTag(reference),
            manifestTagFrom(records),
            vehicleLookupTag(resolved.service, resolved.travelDate),
            specimenTag(CONFIRMED_SPECIMEN_NOTICE),
          ],
          billing: input.billing,
          payments: input.payments,
          id: orderId,
          status: "ACTIVE",
          createdAt: nowMs,
        }),
    });
    return booking;
  }

  /* ---------------------------------------------------------------- *
   * status
   * ---------------------------------------------------------------- */

  status(request: ReservedRequest): Record<string, unknown> {
    this.assertBppAddress(request.context);
    const message = request.message as { order_id?: string; ref_id?: string };
    const reference = message.order_id ?? message.ref_id;
    if (!reference) {
      throw new ReservedLifecycleError(
        "BOOKING-NOT-FOUND",
        "A status request names an order id or a booking reference",
      );
    }
    const booking = this.findBookingOrRefuse(request.context, reference);
    // The manifest sweep runs on whoever next reads, in the same lazy shape as
    // the hold sweep. A booking whose coach went a month ago comes back
    // without the names it carried.
    this.store.sweepManifests(
      this.now().getTime(),
      this.options.reservation.manifestRetentionDays,
    );
    const fresh = this.findBookingOrRefuse(request.context, reference);
    return {
      order: fresh.order,
      ...(fresh.refundPaise === null
        ? {}
        : { refund: this.storedRefund(fresh) }),
    };
  }

  /* ---------------------------------------------------------------- *
   * cancel
   * ---------------------------------------------------------------- */

  async cancel(request: ReservedRequest): Promise<Record<string, unknown>> {
    this.assertBppAddress(request.context);
    const message = request.message as {
      order_id: string;
      descriptor: { code: string };
      tags?: Array<Record<string, unknown>>;
    };
    const booking = this.findBookingOrRefuse(request.context, message.order_id);
    const named = this.seatIdsFrom(message.tags);
    const confirmedSeats = booking.seats.filter(
      (seat) => seat.status === "CONFIRMED",
    );
    const unknown = named.filter(
      (seatId) => !booking.seats.some((seat) => seat.seatId === seatId),
    );
    if (unknown.length > 0) {
      throw new ReservedLifecycleError(
        "CANCEL-SEAT-NOT-ON-BOOKING",
        `Booking ${booking.reference} does not hold seats ${unknown.join(", ")}`,
      );
    }
    // Naming no seats cancels the whole booking.
    const targetSeats = (named.length > 0
      ? booking.seats.filter((seat) => named.includes(seat.seatId))
      : confirmedSeats
    ).slice();

    if (message.descriptor.code === "SOFT_CANCEL") {
      return this.softCancel(booking, targetSeats);
    }
    return this.confirmCancel(booking, targetSeats, message.tags);
  }

  private softCancel(
    booking: BookingRecord,
    seats: BookingRecord["seats"],
  ): Record<string, unknown> {
    const live = seats.filter((seat) => seat.status === "CONFIRMED");
    if (live.length === 0) {
      // Nothing left to quote. The stored figure is the honest answer, and
      // re-evaluating the slab for a cancellation that already happened would
      // return a smaller number as time passed.
      return { order: booking.order, refund: this.storedRefund(booking) };
    }
    const nowMs = this.now().getTime();
    const refund = computeRefund(live, booking.departureAt, nowMs);
    const quote = this.store.saveRefundQuote({
      id: this.store.newRefundQuoteId(),
      bookingId: booking.id,
      seatIds: live.map((seat) => seat.seatId).sort(),
      slabCode: refund.slab.code,
      slabPercent: refund.slab.deductionPercent,
      refundPaise: refund.refundPaise,
      quotedAt: nowMs,
      // Two minutes. Short enough that a slab crossing between the quote and
      // the commitment is a rare path rather than a routine one.
      expiresAt: nowMs + 2 * 60 * 1000,
    });
    return {
      // Nothing changes state. The booking is still live and still says so.
      order: booking.order,
      refund: this.refundPayload(refund),
      tags: [
        refundSlabTag({
          slabCode: quote.slabCode,
          slabPercent: quote.slabPercent,
          quoteId: quote.id,
          quoteExpiresAt: quote.expiresAt,
        }),
      ],
    };
  }

  private confirmCancel(
    booking: BookingRecord,
    seats: BookingRecord["seats"],
    tags: Array<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    const live = seats.filter((seat) => seat.status === "CONFIRMED");
    if (live.length === 0) {
      // Idempotent on an already-cancelled booking: the stored figure from the
      // cancellation that actually happened, never a re-evaluation. A retry
      // must not look like a penalty.
      return { order: booking.order, refund: this.storedRefund(booking) };
    }
    const nowMs = this.now().getTime();
    const quoteId = this.tagValue(tags, "REFUND_SLAB", "REFUND_QUOTE_ID");
    const quote = quoteId ? this.store.findRefundQuote(quoteId) : undefined;
    const wanted = live.map((seat) => seat.seatId).sort();
    if (
      !quote ||
      quote.bookingId !== booking.id ||
      quote.seatIds.join(",") !== wanted.join(",")
    ) {
      throw new ReservedLifecycleError(
        "REFUND-QUOTE-EXPIRED",
        "This cancellation carries no live refund quote for these seats; ask for one and commit against it",
      );
    }
    if (quote.expiresAt <= nowMs) {
      throw new ReservedLifecycleError(
        "REFUND-QUOTE-EXPIRED",
        `Refund quote ${quote.id} lapsed at ${istIsoInstant(quote.expiresAt)}`,
      );
    }

    const refund = computeRefund(live, booking.departureAt, nowMs);
    if (refund.slab.code !== quote.slabCode) {
      // The rider crossed a slab boundary between quoting and committing.
      // Honouring the stale quote would pay a refund the slab does not
      // support; honouring the new one silently would let a rider commit to
      // one number and receive another. So the commitment is refused and the
      // real figure goes back with it.
      const replacement = this.store.saveRefundQuote({
        id: this.store.newRefundQuoteId(),
        bookingId: booking.id,
        seatIds: wanted,
        slabCode: refund.slab.code,
        slabPercent: refund.slab.deductionPercent,
        refundPaise: refund.refundPaise,
        quotedAt: nowMs,
        expiresAt: nowMs + 2 * 60 * 1000,
      });
      throw new ReservedLifecycleError(
        "REFUND-SLAB-MOVED",
        `The refund slab moved from ${quote.slabCode} to ${refund.slab.code} between the quote and this request`,
        {
          refund: this.refundPayload(refund),
          tags: [
            refundSlabTag({
              slabCode: replacement.slabCode,
              slabPercent: replacement.slabPercent,
              quoteId: replacement.id,
              quoteExpiresAt: replacement.expiresAt,
            }),
          ],
        },
      );
    }

    const updated = this.store.applyCancellation({
      bookingId: booking.id,
      seatIds: wanted,
      slabCode: refund.slab.code,
      refundBySeat: refund.perSeatPaise,
      nowMs,
    });
    const rewritten = this.cancelledOrder(updated);
    this.store.updateStoredOrder(updated.id, rewritten);
    return {
      order: rewritten,
      refund: this.refundPayload(refund),
      tags: [
        refundSlabTag({
          slabCode: refund.slab.code,
          slabPercent: refund.slab.deductionPercent,
          quoteId: quote.id,
          quoteExpiresAt: quote.expiresAt,
        }),
      ],
    };
  }

  /**
   * The stored order after a cancellation.
   *
   * The status, the seat list and the manifest change; the quote does not. The
   * quote is what was sold, and shrinking it retroactively would leave no
   * record of what the rider actually bought. What came back is the refund,
   * which is a separate figure and travels separately.
   *
   * **A cancelled booking holds no seats, and it says so by carrying no seat
   * list rather than by carrying an empty one.** This is where a whole-booking
   * cancellation used to become unanswerable. The rewrite mapped `SEATS` and
   * `MANIFEST` in place, so cancelling everything left both with an empty
   * `list`; `tag.list` is `minItems: 1` in this domain's own schema, so the
   * generated `on_cancel` failed its own validation, was never sent, and the
   * client waited out its timeout with no answer at all. Partial cancellation
   * left at least one seat behind, which is why it worked and why this
   * survived.
   *
   * Of the three answers available - relax the schema to admit an empty list,
   * omit the tag, or give a cancelled order a different shape - the schema is
   * right and the writer was wrong. A tag with no entries carries no
   * information and is a shape bug everywhere else it could occur, and this
   * file already knew it: `buildOrder` publishes no `SEATS` tag at all on a
   * browse with no seats. The rewrite simply did not follow its own precedent.
   *
   * Omission alone would lose something, though, so the cancelled seats are
   * published rather than merely subtracted. `SEATS` is what the booking still
   * holds and `CANCELLED_SEATS` is what it released; on a whole-booking
   * cancellation the first is absent and the second names every seat. Nothing
   * is ambiguous: a settled order carries `SEATS` whenever it holds seats, so
   * its absence means none, and `status: CANCELLED` says the same thing about
   * the booking. A partial cancellation now says which seats it took, which it
   * previously dropped on the floor.
   */
  private cancelledOrder(booking: BookingRecord): Record<string, unknown> {
    const order = structuredClone(booking.order) as Record<string, unknown>;
    const remaining = booking.seats.filter((seat) => seat.status === "CONFIRMED");
    const released = booking.seats.filter((seat) => seat.status === "CANCELLED");
    order.status = booking.status === "CANCELLED" ? "CANCELLED" : "ACTIVE";
    // Rewritten where the seat list already sat, so a second cancellation on
    // the same booking does not shuffle the order of its own tags.
    const seatTags = [
      ...(remaining.length > 0
        ? [seatsTag(remaining.map((seat) => seat.seatId))]
        : []),
      ...(released.length > 0
        ? [cancelledSeatsTag(released.map((seat) => seat.seatId))]
        : []),
    ];
    let seatTagsPlaced = false;
    order.tags = (order.tags as Tag[]).flatMap((candidate) => {
      if (
        candidate.descriptor.code !== "SEATS" &&
        candidate.descriptor.code !== "CANCELLED_SEATS"
      ) {
        return [candidate];
      }
      if (seatTagsPlaced) return [];
      seatTagsPlaced = true;
      return seatTags;
    });
    order.fulfillments = (order.fulfillments as Array<Record<string, unknown>>).map(
      (fulfillment) => ({
        ...fulfillment,
        tags: (fulfillment.tags as Tag[]).flatMap((candidate) => {
          if (candidate.descriptor.code !== "MANIFEST") return [candidate];
          // A manifest of nobody is not an empty manifest, it is no manifest.
          if (remaining.length === 0) return [];
          return [
            manifestTagFrom(
              remaining.map((seat) => ({
                seatId: seat.seatId,
                name: seat.name ?? "",
                age: seat.age,
                gender: seat.gender,
              })),
            ),
          ];
        }),
      }),
    );
    return order;
  }

  private refundPayload(refund: RefundComputation): Record<string, unknown> {
    return {
      price: {
        currency: "INR",
        value: signedPaiseToRupees(refund.refundPaise),
      },
      // The lines add up to the price. The specification's own worked example
      // does not: it prints the reservation fee as a deduction from the refund
      // while its formula, stated twice and agreeing with its own complement,
      // keeps the fee out of the sum entirely. The fee is published as the
      // zero it returns, so a rider who paid one can see that none of it is
      // coming back rather than wondering where it went.
      breakup: [
        {
          code: "BASE_FARE",
          title: "Base fare",
          price: { currency: "INR", value: signedPaiseToRupees(refund.basePaise) },
        },
        {
          code: "SLAB_DEDUCTION",
          title: "Cancellation deduction",
          price: {
            currency: "INR",
            value: signedPaiseToRupees(-refund.slabDeductionPaise),
          },
        },
        {
          code: "RESERVATION_FEE",
          title: "Reservation fee",
          price: { currency: "INR", value: signedPaiseToRupees(0) },
        },
        {
          code: "TOLL_REFUND",
          title: "Toll refund",
          price: {
            currency: "INR",
            value: signedPaiseToRupees(refund.tollRefundPaise),
          },
        },
      ],
    };
  }

  private storedRefund(booking: BookingRecord): Record<string, unknown> {
    const cancelled = booking.seats.filter((seat) => seat.status === "CANCELLED");
    const basePaise = cancelled.reduce((sum, seat) => sum + seat.basePaise, 0);
    const tollPaise = cancelled.reduce((sum, seat) => sum + seat.tollPaise, 0);
    const refundPaise = booking.refundPaise ?? 0;
    return {
      price: { currency: "INR", value: signedPaiseToRupees(refundPaise) },
      breakup: [
        {
          code: "BASE_FARE",
          title: "Base fare",
          price: { currency: "INR", value: signedPaiseToRupees(basePaise) },
        },
        {
          code: "SLAB_DEDUCTION",
          title: "Cancellation deduction",
          price: {
            currency: "INR",
            value: signedPaiseToRupees(
              -(basePaise + tollPaise - refundPaise),
            ),
          },
        },
        {
          code: "RESERVATION_FEE",
          title: "Reservation fee",
          price: { currency: "INR", value: signedPaiseToRupees(0) },
        },
        {
          code: "TOLL_REFUND",
          title: "Toll refund",
          price: { currency: "INR", value: signedPaiseToRupees(tollPaise) },
        },
      ],
    };
  }

  /* ---------------------------------------------------------------- *
   * Shared work
   * ---------------------------------------------------------------- */

  private buildOrder(input: {
    resolved: Resolved;
    pair: BoardingPair;
    farePaise: number;
    fareSourcing: "V" | "S" | "I";
    seatCount: number;
    identity: ReservedIdentity;
    seatIds: string[];
    hold?: HoldRecord;
    concessionClaim?: string;
    fulfillmentTags: Tag[];
    billing?: Record<string, unknown>;
    payments?: Array<Record<string, unknown>>;
    id?: string;
    status?: string;
    createdAt?: number;
  }): Record<string, unknown> {
    const { resolved } = input;
    const snapshot = this.snapshot(
      resolved.service,
      resolved.seatMap,
      resolved.travelDate,
      input.identity,
    );
    const basePaise = input.farePaise * input.seatCount;
    const feePaise = resolved.service.reservationFeePaise * input.seatCount;
    const tollPaise = resolved.service.tollPaise * input.seatCount;
    const discountPaise = input.concessionClaim
      ? concessionDiscountPaise(
          basePaise,
          concessionRatePercent(
            input.concessionClaim,
            resolved.service.serviceClass,
          ),
        )
      : 0;
    const totalPaise = basePaise - discountPaise + feePaise + tollPaise;

    // `title` is what the rider reads and `code` is what a client keys off.
    // They were one field carrying the code, which put `BASE_FARE` on a fare
    // screen: a client cannot invent a label for a code it was never given a
    // label for, and the alternative - every client shipping its own private
    // map from this provider's codes to English - is a translation table that
    // silently rots the day a line is added. So both travel.
    const breakup: Array<Record<string, unknown>> = [
      {
        code: "BASE_FARE",
        title: "Base fare",
        price: { currency: "INR", value: paiseToRupees(basePaise) },
      },
      ...(discountPaise > 0
        ? [
            {
              code: `${input.concessionClaim}_CONCESSION`,
              title: `${concessionLabel(input.concessionClaim!)} concession`,
              price: {
                currency: "INR",
                value: signedPaiseToRupees(-discountPaise),
              },
            },
          ]
        : []),
      {
        // Never refunded, in any slab. Named on the quote so that the refund
        // breakup's zero line is not the first a rider hears of it.
        code: "RESERVATION_FEE",
        title: "Reservation fee",
        price: { currency: "INR", value: paiseToRupees(feePaise) },
      },
      {
        // Refunded in full, in every slab. It was never the corporation's
        // revenue: it is a pass-through to a toll authority.
        code: "TOLL",
        title: "Toll",
        price: { currency: "INR", value: paiseToRupees(tollPaise) },
      },
    ];

    return {
      ...(input.id ? { id: input.id } : {}),
      ...(input.status ? { status: input.status } : {}),
      provider: {
        id: this.source.operator.id,
        descriptor: { name: this.source.operator.name },
      },
      items: [
        reservedItem({
          service: resolved.service,
          travelDate: resolved.travelDate,
          pricePaise: input.farePaise,
          pair: input.pair,
          fareSourcing: input.fareSourcing,
          availableCount: snapshot.availableCount,
          selectedCount: input.seatCount,
        }),
      ],
      fulfillments: [
        orderFulfillment(
          resolved.service,
          resolved.travelDate,
          input.pair,
          input.fulfillmentTags,
        ),
      ],
      quote: {
        price: { currency: "INR", value: paiseToRupees(totalPaise) },
        breakup,
      },
      ...(input.billing ? { billing: structuredClone(input.billing) } : {}),
      ...(input.payments
        ? {
            payments: input.payments.map((payment, index) => ({
              ...structuredClone(payment),
              id:
                (payment.id as string | undefined) ??
                `PAY-${this.operatorKey.toUpperCase()}-${index + 1}`,
            })),
          }
        : {}),
      cancellation_terms: [
        {
          external_ref: {
            mimetype: "text/html",
            url: `${this.options.publicBaseUrl}/terms`,
          },
        },
      ],
      ...(input.createdAt
        ? {
            // `+05:30`, like every other instant inside a message this
            // category builds. The envelope's own `context.timestamp` stays
            // `Z`: that field belongs to the protocol and is shared with the
            // two categories next door, and moving it would move a path this
            // change has no business moving.
            created_at: istIsoInstant(input.createdAt),
            updated_at: istIsoInstant(input.createdAt),
          }
        : {}),
      tags: [
        specimenTag(),
        // Both decks, every seat, every time, so a client always has a current
        // view without a second call.
        seatMapTag(resolved.seatMap.seatMapId, snapshot.states),
        // And the geometry those states are states of, so that a client draws
        // this coach rather than its own reading of a paragraph.
        seatMapLayoutTag(resolved.seatMap),
        ...(input.seatIds.length > 0 ? [seatsTag(input.seatIds)] : []),
        ...(input.hold
          ? [
              holdInfoTag({
                holdId: input.hold.holdId,
                expiresAt: input.hold.expiresAt,
                ttlSeconds: this.options.reservation.holdTtlSeconds,
              }),
            ]
          : []),
      ],
    };
  }

  /**
   * The live hold this action must run against, and the manifest it carries.
   *
   * A confirm arriving one second after the expiry is refused even when the
   * seat is still free. Forgiving lateness when nobody else wanted the seat is
   * the tempting behaviour and the wrong one: it makes the outcome depend on
   * whether an unrelated third party happened to be looking at the same coach
   * in the same second, which the client cannot observe, cannot reproduce and
   * cannot test against. A hold that is sometimes honoured after expiry is not
   * a hold, it is a suggestion, and every client would then have to handle
   * both outcomes anyway.
   *
   * The strictness is affordable only because no money moves anywhere in this
   * stack, so a late confirm strands nothing and costs one extra round trip on
   * a rare path. On a stack where a payment had been captured against a lapsed
   * hold, this rule would need a compensating answer and would not be this
   * rule.
   */
  private liveHoldAndManifest(
    resolved: Resolved,
    identity: ReservedIdentity,
    input: OrderInput,
  ): { hold: HoldRecord; records: ManifestRecord[] } {
    const nowMs = this.now().getTime();
    this.store.sweepExpiredHolds(
      resolved.service.serviceId,
      resolved.travelDate,
      nowMs,
    );
    const hold = this.store.findLatestHold(this.operatorKey, identity);
    if (!hold) {
      throw new ReservedLifecycleError(
        "HOLD-REQUIRED",
        "This transaction holds no seats; select the seats first and this provider will hold them",
      );
    }
    const status = this.store.holdStatus(hold, nowMs);
    if (status !== "LIVE") {
      throw new ReservedLifecycleError(
        "HOLD-EXPIRED",
        // The sentence claims to quote the instant published on the select
        // that took the hold, so it has to be that instant character for
        // character. `HOLD_INFO.EXPIRES_AT` is `+05:30`; this said `Z`.
        `Hold ${hold.holdId} expired at ${istIsoInstant(hold.expiresAt)}, which is the instant published on the select that took it`,
        { holdId: hold.holdId, expiresAt: istIsoInstant(hold.expiresAt) },
      );
    }
    if (
      hold.serviceId !== resolved.service.serviceId ||
      hold.travelDate !== resolved.travelDate
    ) {
      throw new ReservedLifecycleError(
        "HOLD-SEAT-MISMATCH",
        `This transaction holds seats on ${hold.serviceId} for ${hold.travelDate}, not on the departure this order names`,
      );
    }

    const entries = manifestTag(input.tags);
    if (!entries) {
      throw new ReservedLifecycleError(
        "MANIFEST-INCOMPLETE",
        `Seats ${hold.seatIds.join(", ")} are held and the order carries no manifest`,
      );
    }
    const records = parseManifest(entries);
    assertManifestMatchesHold(records, hold.seatIds);

    // Re-checked here rather than at select, because the hold taken at select
    // named seats only and the manifest is the first point at which this
    // provider learns which gender is going in which seat.
    const snapshot = this.snapshot(
      resolved.service,
      resolved.seatMap,
      resolved.travelDate,
      identity,
    );
    assertGenderLocks(
      {
        map: resolved.seatMap,
        seededSold: snapshot.seeded,
        claims: snapshot.claims,
        viewer: identity,
      },
      records.map((record) => ({
        seatId: record.seatId,
        gender: record.gender,
      })),
    );
    return { hold, records };
  }

  private snapshot(
    service: ReservedService,
    seatMap: SeatMap,
    travelDate: string,
    viewer?: ReservedIdentity,
  ): Snapshot {
    this.store.sweepExpiredHolds(
      service.serviceId,
      travelDate,
      this.now().getTime(),
    );
    const seeded = seededOccupancy(
      service,
      seatMap,
      travelDate,
      this.options.reservation.occupancySeed,
    );
    const claims = this.store.liveClaims(service.serviceId, travelDate);
    const neighbourhood = { map: seatMap, seededSold: seeded, claims, viewer };
    return {
      seeded,
      claims,
      states: seatStates(neighbourhood),
      availableCount: availableSeatCount(neighbourhood),
    };
  }

  private async resolveSelection(
    context: ReservedContext,
    input: OrderInput,
  ): Promise<Resolved> {
    if (input.provider?.id !== this.source.operator.id) {
      throw new ReservedLifecycleError(
        "SERVICE-NOT-FOUND",
        `Unknown provider ${String(input.provider?.id)}`,
      );
    }
    const items = input.items ?? [];
    if (items.length !== 1) {
      // One booking is one dated departure. An order naming two would have two
      // seat maps, two departures and no coherent manifest.
      throw new ReservedLifecycleError(
        "MIXED-CATEGORY-ORDER",
        "A reserved order names exactly one dated departure",
      );
    }
    const parsed = parseReservedItemId(items[0].id);
    if (!parsed) {
      throw new ReservedLifecycleError(
        "SERVICE-NOT-FOUND",
        `${items[0].id} is not an item this provider published`,
      );
    }
    const service = await this.source.service(parsed.serviceId);
    if (
      !service ||
      service.serviceClass !== parsed.serviceClass ||
      !runsOn(service.operatingPattern, parsed.travelDate)
    ) {
      throw new ReservedLifecycleError(
        "SERVICE-NOT-FOUND",
        `No service ${parsed.serviceId} in class ${parsed.serviceClass} runs on ${parsed.travelDate}`,
      );
    }
    const departureAt = stopInstantMilliseconds(
      parsed.travelDate,
      service.departureMinute,
      0,
    );
    const window = this.windowStatus(departureAt, this.now().getTime());
    if (window.status !== "OPEN") {
      // Named edge and named boundary instant, because a client that filtered
      // correctly will never see this and a client that did not needs to know
      // which of its own two constants disagrees with this provider's.
      throw new ReservedLifecycleError(
        "OUTSIDE-BOOKING-WINDOW",
        window.status === "TOO_LATE"
          ? `Reservations for this departure closed at ${window.boundaryAt}`
          : `This departure is beyond the advance booking horizon, which reaches ${window.boundaryAt}`,
      );
    }
    return {
      service,
      seatMap: await this.seatMapFor(service),
      fareTable: await this.fareTableFor(service),
      travelDate: parsed.travelDate,
      departureAt,
    };
  }

  private windowStatus(departureAt: number, nowMs: number) {
    return bookingWindowStatus(departureAt, nowMs, {
      closeMinutes: this.options.reservation.closeMinutes,
      horizonDays: this.options.reservation.horizonDays,
    });
  }

  private async seatMapFor(service: ReservedService): Promise<SeatMap> {
    const map = await this.source.seatMap(service.seatMapId);
    if (!map) {
      throw new ReservedLifecycleError(
        "SERVICE-NOT-FOUND",
        `Service ${service.serviceId} names seat map ${service.seatMapId}, which this source does not carry`,
      );
    }
    return map;
  }

  private async fareTableFor(service: ReservedService): Promise<FareTable> {
    const table = await this.source.fareTable(service.fareTableId);
    if (!table) {
      throw new ReservedLifecycleError(
        "FARE-NOT-PUBLISHED",
        `Service ${service.serviceId} names fare table ${service.fareTableId}, which this source does not carry`,
      );
    }
    return table;
  }

  private assertSeatsOnMap(seatMap: SeatMap, seatIds: string[]): void {
    const known = new Set(seatMap.seats.map((seat) => seat.seatId));
    const unknown = seatIds.filter((seatId) => !known.has(seatId));
    if (unknown.length > 0) {
      throw new ReservedLifecycleError(
        "SEAT-NOT-ON-MAP",
        `Seat map ${seatMap.seatMapId} has no seats ${unknown.join(", ")}`,
      );
    }
  }

  private seatIdsFrom(tags: Array<Record<string, unknown>> | undefined): string[] {
    const group = tags?.find(
      (candidate) =>
        (candidate.descriptor as { code?: string } | undefined)?.code === "SEATS",
    );
    if (!group) return [];
    return ((group.list as Array<Record<string, unknown>>) ?? [])
      .filter(
        (item) =>
          (item.descriptor as { code?: string } | undefined)?.code === "SEAT_ID",
      )
      .map((item) => String(item.value))
      .filter((seatId) => seatId.length > 0);
  }

  private tagValue(
    tags: Array<Record<string, unknown>> | undefined,
    groupCode: string,
    entryCode: string,
  ): string | undefined {
    const group = tags?.find(
      (candidate) =>
        (candidate.descriptor as { code?: string } | undefined)?.code === groupCode,
    );
    const entry = ((group?.list as Array<Record<string, unknown>>) ?? []).find(
      (item) =>
        (item.descriptor as { code?: string } | undefined)?.code === entryCode,
    );
    return entry?.value as string | undefined;
  }

  private findBookingOrRefuse(
    context: ReservedContext,
    reference: string,
  ): BookingRecord {
    const booking = this.store.findBooking(
      this.operatorKey,
      { bapId: context.bap_id, bapUri: context.bap_uri },
      reference,
    );
    if (!booking) {
      // One buyer app must not be able to read another's booking, so an
      // unknown reference and somebody else's reference are the same answer.
      throw new ReservedLifecycleError(
        "BOOKING-NOT-FOUND",
        `No booking ${reference} belongs to this buyer app`,
      );
    }
    return booking;
  }

  private assertPaymentStatus(
    payments: Array<Record<string, unknown>> | undefined,
    expected: "NOT_PAID" | "PAID",
  ): void {
    if (
      !payments ||
      payments.length === 0 ||
      payments.some((payment) => payment.status !== expected)
    ) {
      throw new ReservedLifecycleError(
        "INVALID-PAYMENT-STATUS",
        `All payments must have status ${expected}`,
      );
    }
  }

  private assertBppAddress(context: ReservedContext): void {
    if (
      context.bpp_id !== this.runtime.subscriberId ||
      context.bpp_uri !== this.runtime.subscriberUri
    ) {
      throw new ReservedLifecycleError(
        "BPP-ADDRESS-MISMATCH",
        `Request must address ${this.runtime.subscriberId} at ${this.runtime.subscriberUri}`,
      );
    }
  }

  private identity(context: ReservedContext): ReservedIdentity {
    return {
      bapId: context.bap_id,
      bapUri: context.bap_uri,
      transactionId: context.transaction_id,
    };
  }
}
