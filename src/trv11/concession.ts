import { OrderLifecycleError } from "../orders/store.js";
import {
  CONCESSION_CLASSES,
  concessionRateCode,
  type ConcessionClass,
} from "./pass.js";

/**
 * Reading a concession off an order, and refusing cleanly when it names
 * something this provider publishes no rate for.
 *
 * This repo verifies nothing. It does not check an age, a student status or a
 * document, and it has no way to. It trusts the class a buyer app asserts,
 * the same trust a BPP already extends to a BAP on every other field in an
 * order - the buyer app is the party that did the verifying, off-network,
 * face to face, before the order was ever placed. See `docs/passes.md`.
 *
 * The order names a class and nothing else. No document type, no document
 * number, no verification date, no rider identity. Anything else inside the
 * `CONCESSION` tag group is refused rather than quietly stripped, because
 * silently accepting an order that tried to hand this provider a rider's
 * document would be the wrong shape of tolerant.
 */

const CONCESSION_TAG_CODE = "CONCESSION";
const CLASS_ENTRY_CODE = "CLASS";

/**
 * A class value is echoed back into an error message only when it is already
 * a bare screaming-snake code. Anything else is withheld: error messages
 * reach the event log, and a rider's identity must never reach one - and a
 * `value` this provider did not expect is exactly where one could be smuggled.
 */
const SAFE_TO_ECHO = /^[A-Z][A-Z0-9_]{0,31}$/;

const PUBLISHED_RATES = CONCESSION_CLASSES.map(concessionRateCode).join(" and ");

interface TagEntry {
  descriptor?: { code?: unknown };
  value?: unknown;
}

interface TagGroup {
  descriptor?: { code?: unknown };
  display?: unknown;
  list?: unknown;
}

function groupCode(group: unknown): string | undefined {
  const code = (group as TagGroup | undefined)?.descriptor?.code;
  return typeof code === "string" ? code.trim().toUpperCase() : undefined;
}

function invalid(message: string): never {
  throw new OrderLifecycleError("CONCESSION-TAG-INVALID", message);
}

/**
 * Read the concession class off `order.tags`. Absence is the ordinary case
 * and returns `undefined`; an order with no concession carries no
 * `CONCESSION` tag at all rather than a zero-value entry.
 */
export function concessionFromOrderTags(tags: unknown): ConcessionClass | undefined {
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags)) {
    invalid("order.tags must be an array of tag groups");
  }
  const groups = tags.filter((group) => groupCode(group) === CONCESSION_TAG_CODE);
  if (groups.length === 0) return undefined;
  if (groups.length > 1) {
    invalid(
      `An order carries at most one ${CONCESSION_TAG_CODE} tag group; ${groups.length} were sent`,
    );
  }
  const list = (groups[0] as TagGroup).list;
  if (!Array.isArray(list) || list.length === 0) {
    invalid(`${CONCESSION_TAG_CODE} tag group must carry a non-empty list`);
  }
  const codes = (list as TagEntry[]).map((entry) => {
    const code = entry?.descriptor?.code;
    return typeof code === "string" ? code.trim().toUpperCase() : "";
  });
  const unexpected = codes.filter((code) => code !== CLASS_ENTRY_CODE);
  if (unexpected.length > 0) {
    // Codes are field names, not rider values, so naming them is safe and
    // useful. The values beside them are never read and never echoed.
    invalid(
      `${CONCESSION_TAG_CODE} tag group accepts ${CLASS_ENTRY_CODE} only; this provider never accepts, stores or logs a rider identity or document. Unexpected: ${[
        ...new Set(unexpected.map((code) => code || "(missing code)")),
      ].join(", ")}`,
    );
  }
  if (codes.length > 1) {
    invalid(
      `${CONCESSION_TAG_CODE} tag group must carry exactly one ${CLASS_ENTRY_CODE} entry; ${codes.length} were sent`,
    );
  }
  const value = (list as TagEntry[])[0]?.value;
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${CONCESSION_TAG_CODE} ${CLASS_ENTRY_CODE} must be a non-empty string`);
  }
  return assertPublishedClass(value.trim());
}

/**
 * Refuse a class this provider publishes no rate for, rather than silently
 * pricing it at zero or at the full rate. The message names the rate that is
 * missing, which is the honest answer to a request for a rate that does not
 * exist.
 */
function assertPublishedClass(value: string): ConcessionClass {
  const candidate = value.toUpperCase();
  if ((CONCESSION_CLASSES as readonly string[]).includes(candidate)) {
    return candidate as ConcessionClass;
  }
  throw new OrderLifecycleError(
    "CONCESSION-RATE-NOT-PUBLISHED",
    SAFE_TO_ECHO.test(candidate)
      ? `No ${concessionRateCode(candidate)} rate is published on this catalogue; this provider publishes ${PUBLISHED_RATES} only`
      : `The order names a concession class this provider publishes no rate for; this provider publishes ${PUBLISHED_RATES} only. The class value is withheld from this message because a class value is never stored or logged`,
  );
}

/**
 * A concession is a modifier on one of the nine pass items. It is not a
 * discount on a single-journey fare, and a single-journey order carrying one
 * is refused rather than quietly charged the full fare - the buyer app asked
 * for a price this provider did not give it, and it needs to hear that.
 */
export function assertNoConcessionOnTicketOrder(tags: unknown): void {
  // Checked by presence, not by class: an unrecognised class on a
  // single-journey order is not applicable either way, and naming the missing
  // rate would be the wrong answer to the wrong question.
  if (!Array.isArray(tags)) return;
  if (!tags.some((group) => groupCode(group) === CONCESSION_TAG_CODE)) return;
  throw new OrderLifecycleError(
    "CONCESSION-NOT-APPLICABLE",
    "A concession applies to a pass item only; this order selects single-journey items, which this provider prices at the full fare",
  );
}
