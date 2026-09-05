import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeRefund,
  retainedPaise,
  roundHalfUp,
  slabFor,
} from "../../src/reserved/refund.js";

/**
 * The refund slabs, which are the best-sourced numbers in this whole category.
 *
 * They are the operator's own published reservation terms rather than
 * anything this repository invented: 10% deducted from the base fare more than
 * 72 hours out, 25% from 72 to 24 hours, 50% from 24 to 2 hours, and nothing
 * refunded inside 2 hours or after departure. The reservation fee is
 * non-refundable in every slab and the toll is refunded in full in every slab,
 * which is why the two are separate fields on a service rather than folded
 * into the fare.
 */

const HOUR = 60 * 60 * 1000;
const DEPARTURE = Date.UTC(2026, 8, 30, 17, 29); // 22:59 IST on 30 September

function seat(basePaise: number, tollPaise = 2_000, feePaise = 2_000) {
  return {
    seatId: "U3A",
    basePaise,
    tollPaise,
    reservationFeePaise: feePaise,
  };
}

test("each slab boundary belongs to the stricter side of itself", () => {
  // The published wording puts the boundary figure in the later band: "72 to
  // 24 hours" names 72 itself, and only "more than 72 hours" is above it. So
  // the deduction rises the instant a boundary is reached rather than a second
  // afterwards. Tested at one second either side of all three.
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 72 * HOUR - 1000).code, "OVER_72H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 72 * HOUR).code, "72H_TO_24H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 24 * HOUR - 1000).code, "72H_TO_24H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 24 * HOUR).code, "24H_TO_2H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 2 * HOUR - 1000).code, "24H_TO_2H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE - 2 * HOUR).code, "UNDER_2H");
});

test("after departure is the no-refund slab, not an error", () => {
  // A rider is entitled to have the record say what happened, and refusing
  // would leave a booking that reads as live for a coach that has gone.
  assert.equal(slabFor(DEPARTURE, DEPARTURE + HOUR).code, "UNDER_2H");
  assert.equal(slabFor(DEPARTURE, DEPARTURE + HOUR).deductionPercent, 100);
});

test("the reservation fee never enters the sum and the toll always does", () => {
  const refund = computeRefund(
    [seat(55_000)],
    DEPARTURE,
    DEPARTURE - 48 * HOUR,
  );
  assert.equal(refund.slab.code, "72H_TO_24H");
  // 550 base, 25% deducted, 20 reservation fee kept in full, 20 toll returned.
  assert.equal(refund.basePaise, 55_000);
  assert.equal(refund.slabDeductionPaise, 13_750);
  assert.equal(refund.reservationFeePaise, 2_000);
  assert.equal(refund.tollRefundPaise, 2_000);
  assert.equal(refund.refundPaise, 43_250);
});

test("the breakup adds up to the refund, so the arithmetic is checkable", () => {
  // The specification's own worked example shows a breakup that does not sum
  // to the figure beside it: it prints the reservation fee as a deduction from
  // the refund while its own formula keeps the fee out of the sum entirely.
  // The formula is stated twice and its complement agrees with it, so the
  // formula is right and the example is wrong. What is published is a breakup
  // whose lines add to the price, with the fee shown as the zero it returns.
  const refund = computeRefund([seat(55_000)], DEPARTURE, DEPARTURE - 48 * HOUR);
  const sum =
    refund.basePaise -
    refund.slabDeductionPaise +
    refund.reservationFeeRefundPaise +
    refund.tollRefundPaise;
  assert.equal(sum, refund.refundPaise);
  assert.equal(refund.reservationFeeRefundPaise, 0);
});

test("rounding is half up on paise, and this category actually exercises it", () => {
  assert.equal(roundHalfUp(33_787.5), 33_788);
  assert.equal(roundHalfUp(33_788.25), 33_788);
  assert.equal(roundHalfUp(-0.5), 0);
  // A 25% deduction on a base that does not divide. 450500 paise at 25% is
  // 112625 exactly, so the case the document names is not in fact a rounding
  // case; one that is takes an odd number of paise.
  const exact = computeRefund([seat(450_500, 0, 0)], DEPARTURE, DEPARTURE - 48 * HOUR);
  assert.equal(exact.slabDeductionPaise, 112_625);
  assert.equal(exact.refundPaise, 337_875);
  const inexact = computeRefund([seat(45_051, 0, 0)], DEPARTURE, DEPARTURE - 48 * HOUR);
  assert.equal(inexact.refundPaise, 33_788);
  assert.equal(inexact.basePaise - inexact.slabDeductionPaise, 33_788);
});

test("a partial cancellation prorates per seat rather than dividing a total", () => {
  const refund = computeRefund(
    [seat(55_000), { ...seat(55_000), seatId: "U3B" }],
    DEPARTURE,
    DEPARTURE - 48 * HOUR,
  );
  assert.equal(refund.refundPaise, 86_500);
  assert.equal(refund.perSeatPaise.get("U3A"), 43_250);
  assert.equal(refund.perSeatPaise.get("U3B"), 43_250);
});

test("what the corporation keeps is the complement of what the rider gets", () => {
  // The two split the same base fare, and the toll sits outside the split on
  // both sides because it was never the corporation's revenue: it is a
  // pass-through to a toll authority.
  const seats = [seat(55_000)];
  const refund = computeRefund(seats, DEPARTURE, DEPARTURE - 48 * HOUR);
  const retained = retainedPaise(seats, refund.slab.deductionPercent);
  assert.equal(retained, 13_750 + 2_000);
  assert.equal(
    refund.refundPaise + retained,
    55_000 + 2_000 + 2_000,
  );
});

test("no refund inside two hours still returns the toll", () => {
  // The slab deducts from the base fare. The toll is refunded in full in every
  // slab, and "no refund" is a statement about the fare rather than about
  // every rupee the rider paid.
  const refund = computeRefund([seat(55_000)], DEPARTURE, DEPARTURE - HOUR);
  assert.equal(refund.slab.code, "UNDER_2H");
  assert.equal(refund.slabDeductionPaise, 55_000);
  assert.equal(refund.refundPaise, 2_000);
});
