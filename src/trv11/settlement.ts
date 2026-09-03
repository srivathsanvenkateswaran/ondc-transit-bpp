import { OrderLifecycleError, type PassCredentialRecord } from "../orders/store.js";
import type { Payment } from "../protocol/types.js";
import type { OperatorProfile, ServiceTier, TransitOffer } from "../sources/types.js";
import { passCovers } from "./pass.js";
import { verifyTotpCode } from "./totp.js";

/**
 * Paying for a ride with a pass.
 *
 * There is no second order path. A rider boarding a bus or entering a metro
 * gate on a pass they already hold goes through exactly the same
 * `search`/`select`/`init`/`confirm` sequence as an ordinary on-board sale,
 * on the same single-journey item this repo already sells. The only thing
 * that changes is one tag group on the payment, naming which pass settled the
 * fare.
 *
 * `params.amount` still carries the fare that would have been charged. A pass
 * ride is not a zero-rupee ride: the ticket has to keep saying what the ride
 * was worth, which is what later lets a buyer app tell a rider whether their
 * pass paid for itself.
 *
 * The claim comes from the buyer app; checking it is this provider's job,
 * because this provider minted the secret.
 */

const SETTLEMENT_TAG_CODE = "PASS_SETTLEMENT";
const PASS_ORDER_ID_CODE = "PASS_ORDER_ID";
const PASS_CODE_CODE = "PASS_CODE";

export interface PassSettlementClaim {
  passOrderId: string;
  /** The code the rider's device computed for the current time window. */
  passCode: string;
}

interface TagEntry {
  descriptor?: { code?: unknown };
  value?: unknown;
}

function entryValue(list: unknown, code: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const matches = (list as TagEntry[]).filter((entry) => {
    const entryCode = entry?.descriptor?.code;
    return typeof entryCode === "string" && entryCode.trim().toUpperCase() === code;
  });
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.value;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function rejected(code: string, message: string): never {
  throw new OrderLifecycleError(code, message);
}

/**
 * Read the settlement claim off the order's payments. Absence is the ordinary
 * case: a rider paying cash-equivalent, or riding a service their pass does
 * not cover, sends no `PASS_SETTLEMENT` tag at all and the order is priced at
 * the full fare.
 */
export function passSettlementClaim(
  payments: Payment[],
): PassSettlementClaim | undefined {
  const groups = payments.flatMap((payment) =>
    (Array.isArray(payment.tags) ? payment.tags : []).filter((group) => {
      const code = (group as { descriptor?: { code?: unknown } })?.descriptor?.code;
      return (
        typeof code === "string" && code.trim().toUpperCase() === SETTLEMENT_TAG_CODE
      );
    }),
  );
  if (groups.length === 0) return undefined;
  if (groups.length > 1) {
    rejected(
      "PASS-SETTLEMENT-INVALID",
      `An order carries at most one ${SETTLEMENT_TAG_CODE} tag group; ${groups.length} were sent`,
    );
  }
  const list = (groups[0] as { list?: unknown }).list;
  const passOrderId = entryValue(list, PASS_ORDER_ID_CODE);
  const passCode = entryValue(list, PASS_CODE_CODE);
  if (!passOrderId || !passCode) {
    rejected(
      "PASS-SETTLEMENT-INVALID",
      `${SETTLEMENT_TAG_CODE} needs exactly one ${PASS_ORDER_ID_CODE} and one ${PASS_CODE_CODE} entry`,
    );
  }
  return { passOrderId, passCode };
}

/**
 * The tier a ride is on. A source may state it; when none does, it falls back
 * to the operator's vehicle category. For BMTC that means Ordinary, which is
 * what this repo's fixture bus fares actually are - so an AC bus ride cannot
 * be told apart from an ordinary one unless the journey source says so. Stated
 * in `docs/passes.md` rather than papered over.
 */
export function defaultServiceTier(profile: OperatorProfile): ServiceTier {
  return profile.vehicleCategory === "METRO" ? "METRO" : "ORDINARY_BUS";
}

export function serviceTierForOffer(
  offer: TransitOffer,
  profile: OperatorProfile,
): ServiceTier {
  return offer.serviceTier ?? defaultServiceTier(profile);
}

/**
 * Check a settlement claim against the credentials this operator minted.
 *
 * Refuses rather than falling back to an ordinary sale. A claim this provider
 * cannot verify must not be recorded as pass-settled, and a buyer app that
 * sent one needs to hear which check failed. The presented code is never
 * echoed into an error message, because error messages reach the event log.
 */
export function assertPassSettlement(
  claim: PassSettlementClaim,
  credentials: PassCredentialRecord[],
  tiers: ServiceTier[],
  atMilliseconds: number,
): PassCredentialRecord {
  if (credentials.length === 0) {
    rejected(
      "PASS-ORDER-NOT-FOUND",
      `This operator holds no pass under order id ${claim.passOrderId} for this buyer app; an operator can only verify a pass it issued itself`,
    );
  }
  const covering = credentials.filter((credential) =>
    tiers.every((tier) => passCovers(credential.scope, tier)),
  );
  if (covering.length === 0) {
    rejected(
      "PASS-SCOPE-MISMATCH",
      `Pass ${claim.passOrderId} is scoped to ${[
        ...new Set(credentials.map((credential) => credential.scope)),
      ].join(", ")}, which does not cover ${[...new Set(tiers)].join(", ")}. An uncovered service is charged the full fare, with no ${SETTLEMENT_TAG_CODE} tag`,
    );
  }
  const inWindow = covering.filter(
    (credential) =>
      atMilliseconds >= credential.validFromMs &&
      atMilliseconds < credential.validToMs,
  );
  if (inWindow.length === 0) {
    rejected(
      "PASS-WINDOW-EXPIRED",
      `Pass ${claim.passOrderId} is outside its validity window. A verifier checks the window first and the code second`,
    );
  }
  const verified = inWindow.find((credential) =>
    verifyTotpCode(credential.secretBase32, claim.passCode, atMilliseconds, {
      algorithm: credential.algorithm,
      digits: credential.digits,
      periodSeconds: credential.periodSeconds,
    }),
  );
  if (!verified) {
    rejected(
      "PASS-CODE-INVALID",
      `The code presented for pass ${claim.passOrderId} does not match its credential for the current time window`,
    );
  }
  return verified;
}
