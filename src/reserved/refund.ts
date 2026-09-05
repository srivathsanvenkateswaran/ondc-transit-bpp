/**
 * The cancellation slabs and their arithmetic.
 *
 * This is the one part of the category whose numbers are the operator's own
 * published policy rather than this repository's reading of a search summary,
 * and it is encoded rather than invented:
 *
 *   | Time before departure          | Deducted from the base fare |
 *   | more than 72 hours             | 10%                         |
 *   | 72 to 24 hours                 | 25%                         |
 *   | 24 to 2 hours                  | 50%                         |
 *   | less than 2 hours, or after it | everything                  |
 *
 * The reservation fee is non-refundable in every slab and the toll is refunded
 * in full in every slab. That is why a service carries the two as separate
 * fields: the arithmetic is only expressible if the fare is not one number.
 *
 * Nothing here is a payment. No money moves anywhere in this stack, so a
 * refund figure is arithmetic rather than a transfer, and the file computes a
 * number rather than paying one.
 */

export type SlabCode = "OVER_72H" | "72H_TO_24H" | "24H_TO_2H" | "UNDER_2H";

export interface Slab {
  code: SlabCode;
  /** Deducted from the base fare. 100 means the fare is not returned. */
  deductionPercent: number;
}

const HOUR_MILLISECONDS = 60 * 60 * 1000;

/**
 * Which slab applies at an instant.
 *
 * Each boundary belongs to the stricter side of itself: the published wording
 * puts the figure in the later band, naming "72 to 24 hours" for the second
 * slab while only "more than 72 hours" reaches the first. A boundary has to
 * belong to one side or the other, and the reading that follows the operator's
 * own words is the one that costs a rider a little rather than the one that
 * costs them nothing and is not what the terms say.
 */
export function slabFor(departureAtMs: number, nowMs: number): Slab {
  const remaining = departureAtMs - nowMs;
  if (remaining > 72 * HOUR_MILLISECONDS) {
    return { code: "OVER_72H", deductionPercent: 10 };
  }
  if (remaining > 24 * HOUR_MILLISECONDS) {
    return { code: "72H_TO_24H", deductionPercent: 25 };
  }
  if (remaining > 2 * HOUR_MILLISECONDS) {
    return { code: "24H_TO_2H", deductionPercent: 50 };
  }
  // Inside two hours, and equally after the coach has gone. A cancellation
  // after departure is not refused: the rider is entitled to have the record
  // say what happened, and refusing would leave a booking that reads as live
  // for a coach that has left.
  return { code: "UNDER_2H", deductionPercent: 100 };
}

/**
 * Half up, on whole paise.
 *
 * Stated rather than left to the language, because the two sides of this
 * integration have to compute the same figure and JavaScript's own rounding
 * of a negative half is not the same rule.
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export interface RefundableSeat {
  seatId: string;
  basePaise: number;
  reservationFeePaise: number;
  tollPaise: number;
}

export interface RefundComputation {
  slab: Slab;
  /** The base fare of the seats being cancelled, before the deduction. */
  basePaise: number;
  slabDeductionPaise: number;
  /** Always zero. Published so a rider can see that it is zero. */
  reservationFeeRefundPaise: number;
  /** What the fee was, so the zero above is legible. */
  reservationFeePaise: number;
  tollRefundPaise: number;
  refundPaise: number;
  perSeatPaise: Map<string, number>;
}

/**
 * What comes back, per seat and in total.
 *
 * Per seat rather than on the total, because a partial cancellation applies
 * the slab to each cancelled seat's own share and deducts the reservation fee
 * once per cancelled seat. Computing on the total and dividing afterwards
 * would reintroduce a rounding decision at exactly the moment this provider
 * has already made one.
 */
export function computeRefund(
  seats: RefundableSeat[],
  departureAtMs: number,
  nowMs: number,
): RefundComputation {
  const slab = slabFor(departureAtMs, nowMs);
  const perSeatPaise = new Map<string, number>();
  let basePaise = 0;
  let slabDeductionPaise = 0;
  let tollRefundPaise = 0;
  let reservationFeePaise = 0;

  seats.forEach((seat) => {
    const kept = roundHalfUp((seat.basePaise * (100 - slab.deductionPercent)) / 100);
    basePaise += seat.basePaise;
    slabDeductionPaise += seat.basePaise - kept;
    tollRefundPaise += seat.tollPaise;
    reservationFeePaise += seat.reservationFeePaise;
    perSeatPaise.set(seat.seatId, kept + seat.tollPaise);
  });

  return {
    slab,
    basePaise,
    slabDeductionPaise,
    reservationFeeRefundPaise: 0,
    reservationFeePaise,
    tollRefundPaise,
    refundPaise: basePaise - slabDeductionPaise + tollRefundPaise,
    perSeatPaise,
  };
}

/**
 * What is still owed to whichever corporation the sale was attributed to.
 *
 * The complement of the refund: the two split the same base fare between the
 * rider and the corporation, and the toll sits outside the split on both sides
 * because it was never the corporation's revenue to begin with. Nothing about
 * this needs storing. It is arithmetic over figures already frozen on the
 * booking row.
 */
export function retainedPaise(
  seats: RefundableSeat[],
  deductionPercent: number,
): number {
  return seats.reduce((sum, seat) => {
    const kept = roundHalfUp((seat.basePaise * (100 - deductionPercent)) / 100);
    return sum + (seat.basePaise - kept) + seat.reservationFeePaise;
  }, 0);
}
