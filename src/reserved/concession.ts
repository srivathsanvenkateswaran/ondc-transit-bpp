import { ReservedLifecycleError } from "./errors.js";
import type { ServiceClass } from "./types.js";

/**
 * The concessions this category can price, and the several it cannot.
 *
 * The operator publishes real concessions and they are unusually well sourced
 * for this domain, which makes the ones this provider still cannot encode more
 * instructive than the one it can.
 *
 * **Senior**, 60 and over, resident, 25% off the basic fare on "Rajahamsa and
 * lower classes". That upper bound is precise and its lower reach is not: a
 * non-AC sleeper sits below an AC sleeper and above a seater by comfort, and
 * no source places it relative to Rajahamsa for concession purposes. So the
 * rate is published for the one class the source names and refused everywhere
 * else.
 *
 * **The free-travel scheme for women and gender minorities** covers ordinary
 * and express services and its own published exclusion list names every class
 * this category sells. That is a fact rather than a limitation: no path
 * exists, and a claim is refused.
 *
 * **The child concession** is a range rather than a rate: 50 to 75% depending
 * on service class, with no per-class breakdown found. A midpoint would be an
 * invented number, and this repository already carries one constant in that
 * condition. Adding a second is not a precedent worth extending.
 *
 * Verification is nobody's job here. This provider trusts an age and a
 * concession class the buyer app asserts, checks nothing behind them, and
 * never accepts, stores or logs a document. The senior concession requires
 * photo identity at boarding, which is a human check by a conductor, off this
 * network.
 */

export type ConcessionClaim = "SENIOR" | "CHILD" | "STUDENT" | "SHAKTI";

const SENIOR_PERCENT_BY_CLASS: Partial<Record<ServiceClass, number>> = {
  RAJAHAMSA: 25,
};

/**
 * What a rider reads on the line a concession puts on a quote.
 *
 * The quote's `code` stays the claim, because that is what a client keys off.
 * This is the other half: a screen that printed `SENIOR_CONCESSION` would be
 * showing the rider a wire constant. Only `SENIOR` is currently reachable -
 * every other claim is refused before a line is ever built - and the other
 * three are named anyway so that publishing a rate for one of them is a rate
 * change rather than a rate change plus a forgotten label.
 */
const CONCESSION_LABELS: Record<ConcessionClaim, string> = {
  SENIOR: "Senior citizen",
  CHILD: "Child",
  STUDENT: "Student",
  SHAKTI: "Free-travel scheme",
};

export function concessionLabel(claim: string): string {
  return CONCESSION_LABELS[claim as ConcessionClaim] ?? claim;
}

/** The `CONCESSION` group on an order, where a buyer app sent one. */
export function concessionFromOrderTags(
  tags: Array<Record<string, unknown>> | undefined,
): string | undefined {
  const group = tags?.find(
    (tag) =>
      (tag.descriptor as { code?: string } | undefined)?.code === "CONCESSION",
  );
  if (!group) return undefined;
  const entry = (group.list as Array<Record<string, unknown>> | undefined)?.find(
    (item) =>
      (item.descriptor as { code?: string } | undefined)?.code === "CLASS",
  );
  return entry?.value as string | undefined;
}

/**
 * The discount percentage, or a refusal naming which kind of gap it is.
 *
 * The two codes mean different things and the difference is worth keeping. A
 * scheme that provably does not cover this product is not applicable; a scheme
 * that might cover it and whose figure nobody published has no rate. Collapsing
 * them would tell a buyer app to stop asking in a case where the answer is
 * that nobody has published the number yet.
 */
export function concessionRatePercent(
  claim: string,
  serviceClass: ServiceClass,
): number {
  switch (claim) {
    case "SENIOR": {
      const percent = SENIOR_PERCENT_BY_CLASS[serviceClass];
      if (percent === undefined) {
        throw new ReservedLifecycleError(
          "CONCESSION-RATE-NOT-PUBLISHED",
          `No SENIOR_CONCESSION_PERCENT rate is published for class ${serviceClass} on this service; this provider publishes a senior rate for RAJAHAMSA only`,
        );
      }
      return percent;
    }
    case "SHAKTI":
      throw new ReservedLifecycleError(
        "CONCESSION-NOT-APPLICABLE",
        `The free-travel scheme covers ordinary and express services and its published exclusion list names class ${serviceClass}; it never applies to a reserved seat`,
      );
    case "CHILD":
      throw new ReservedLifecycleError(
        "CONCESSION-RATE-NOT-PUBLISHED",
        `The published child concession is a range of 50 to 75 per cent depending on service class rather than a rate, and no per-class breakdown was found for ${serviceClass}`,
      );
    case "STUDENT":
      throw new ReservedLifecycleError(
        "CONCESSION-RATE-NOT-PUBLISHED",
        `No student rate is published for class ${serviceClass} on a reserved intercity seat`,
      );
    default:
      throw new ReservedLifecycleError(
        "CONCESSION-NOT-APPLICABLE",
        `${claim} is not a concession this provider prices`,
      );
  }
}

/** Whole paise, rounded half up, exactly as the refund arithmetic rounds. */
export function concessionDiscountPaise(
  basePaise: number,
  percent: number,
): number {
  return Math.floor((basePaise * percent) / 100 + 0.5);
}
