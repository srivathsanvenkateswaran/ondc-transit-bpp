import { ReservedLifecycleError } from "./errors.js";
import type { ManifestGender } from "./store.js";

/**
 * The passenger manifest, and everything this provider refuses to collect.
 *
 * A reserved booking names people, which nothing else in this repository does:
 * an order carries one contact pair for the whole order, and there is no
 * precedent anywhere for more than one named traveller per transaction.
 *
 * Four fields, and no fifth. The research is precise about what a boarding
 * check actually is: an online booking produces a printout or a phone-shown
 * ticket, and a government photo identity document must be carried and matched
 * against the name on the manifest. The conclusion that follows is the one
 * this repository has already reached once for a different product: an
 * identity document must be carried, and its number does not have to be
 * collected at booking to make that work. The conductor matches a name on a
 * manifest against a card in a hand, and nothing in that loop requires a
 * document number to have crossed a network.
 *
 * So an unexpected entry is refused rather than quietly stripped, and the
 * refusal names the unexpected codes and never their values. That asymmetry is
 * the whole point of the rule: error messages reach the event log, and an
 * unexpected value is exactly where a document number would arrive.
 */

export interface ManifestRecord {
  seatId: string;
  name: string;
  /** Null when not supplied. Never inferred, never defaulted, never zero. */
  age: number | null;
  gender: ManifestGender | null;
}

const ACCEPTED_CODES = new Set(["SEAT_ID", "NAME", "AGE", "GENDER"]);
const GENDERS = new Set(["male", "female", "other"]);

interface TagEntry {
  descriptor?: { code?: string };
  value?: string;
}

export function manifestTag(
  tags: Array<Record<string, unknown>> | undefined,
): TagEntry[] | undefined {
  const group = tags?.find(
    (tag) =>
      (tag.descriptor as { code?: string } | undefined)?.code === "MANIFEST",
  );
  return group ? ((group.list as TagEntry[] | undefined) ?? []) : undefined;
}

/**
 * Read the manifest as records delimited by each `SEAT_ID`, in order.
 *
 * `AGE` is omitted rather than sent as null or zero when it is not known, the
 * same absence-means-say-nothing discipline the rest of this repository
 * already applies.
 */
export function parseManifest(entries: TagEntry[]): ManifestRecord[] {
  const unexpected = [
    ...new Set(
      entries
        .map((entry) => entry.descriptor?.code ?? "")
        .filter((code) => !ACCEPTED_CODES.has(code)),
    ),
  ].sort();
  if (unexpected.length > 0) {
    throw new ReservedLifecycleError(
      "MANIFEST-FIELD-NOT-ACCEPTED",
      `A manifest carries a seat, a name, an age and a gender and nothing else; these codes are not accepted and their values were not read: ${unexpected.join(
        ", ",
      )}`,
      { unexpectedCodes: unexpected },
    );
  }

  const records: ManifestRecord[] = [];
  let current: Partial<ManifestRecord> & { seatId?: string } = {};
  const flush = () => {
    if (current.seatId === undefined) return;
    if (!current.name) {
      throw new ReservedLifecycleError(
        "MANIFEST-INCOMPLETE",
        `The manifest record for seat ${current.seatId} carries no NAME`,
      );
    }
    records.push({
      seatId: current.seatId,
      name: current.name,
      age: current.age ?? null,
      gender: current.gender ?? null,
    });
    current = {};
  };

  entries.forEach((entry) => {
    const code = entry.descriptor?.code;
    const value = entry.value;
    if (code === "SEAT_ID") {
      flush();
      if (!value) {
        throw new ReservedLifecycleError(
          "MANIFEST-INCOMPLETE",
          "A manifest record begins with a SEAT_ID and this one carries none",
        );
      }
      current = { seatId: value };
      return;
    }
    if (current.seatId === undefined) {
      throw new ReservedLifecycleError(
        "MANIFEST-INCOMPLETE",
        `A manifest record begins with a SEAT_ID, and a ${code} entry arrived before any`,
      );
    }
    if (code === "NAME") {
      if (!value) {
        throw new ReservedLifecycleError(
          "MANIFEST-INCOMPLETE",
          `The manifest record for seat ${current.seatId} carries an empty NAME`,
        );
      }
      current.name = value;
      return;
    }
    if (code === "AGE") {
      const age = Number(value);
      if (!Number.isInteger(age) || age < 0 || age > 130) {
        // The code is named and the value is not, for the same reason an
        // unexpected code's value is never echoed.
        throw new ReservedLifecycleError(
          "MANIFEST-INCOMPLETE",
          `The AGE entry for seat ${current.seatId} is not a whole number of years; omit it rather than sending a placeholder when it is not known`,
        );
      }
      current.age = age;
      return;
    }
    if (code === "GENDER") {
      if (!value || !GENDERS.has(value)) {
        throw new ReservedLifecycleError(
          "MANIFEST-INCOMPLETE",
          `The GENDER entry for seat ${current.seatId} is not one of male, female or other`,
        );
      }
      current.gender = value as ManifestGender;
    }
  });
  flush();

  const seatIds = records.map((record) => record.seatId);
  if (new Set(seatIds).size !== seatIds.length) {
    throw new ReservedLifecycleError(
      "MANIFEST-INCOMPLETE",
      "The manifest names one seat twice, and a seat carries one passenger",
    );
  }
  return records;
}

/**
 * The manifest's seat set must be exactly the hold's.
 *
 * A held seat with nobody in it is an incomplete manifest. A manifest naming a
 * seat the hold does not cover is a different mistake and gets a different
 * code: the seat set is not the hold's, and a client that wants to drop a
 * passenger re-selects rather than sending a shorter list, which is one round
 * trip and produces a hold whose expiry it can show honestly.
 */
export function assertManifestMatchesHold(
  records: ManifestRecord[],
  heldSeatIds: string[],
): void {
  const named = new Set(records.map((record) => record.seatId));
  const held = new Set(heldSeatIds);
  // A seat the hold does not cover is checked first, because it is the more
  // fundamental of the two mistakes: a client naming a seat it does not hold
  // is confused about which hold it has, and telling it instead that some
  // other seat is missing a passenger would send it looking in the wrong
  // place.
  const extra = [...named].filter((seatId) => !held.has(seatId)).sort();
  if (extra.length > 0) {
    throw new ReservedLifecycleError(
      "HOLD-SEAT-MISMATCH",
      `The manifest names seats ${extra.join(", ")}, which this transaction does not hold`,
    );
  }
  const missing = heldSeatIds.filter((seatId) => !named.has(seatId));
  if (missing.length > 0) {
    throw new ReservedLifecycleError(
      "MANIFEST-INCOMPLETE",
      `Held seats ${missing.join(", ")} have no manifest record`,
    );
  }
}

/** The manifest as it goes back out on the wire, in seat order. */
export function manifestTagFrom(records: ManifestRecord[]) {
  return {
    descriptor: { code: "MANIFEST" },
    display: false,
    list: records.flatMap((record) => [
      { descriptor: { code: "SEAT_ID" }, value: record.seatId },
      { descriptor: { code: "NAME" }, value: record.name },
      ...(record.age === null
        ? []
        : [{ descriptor: { code: "AGE" }, value: String(record.age) }]),
      ...(record.gender === null
        ? []
        : [{ descriptor: { code: "GENDER" }, value: record.gender }]),
    ]),
  };
}
