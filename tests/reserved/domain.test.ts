import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RESERVED_CATEGORY_CODE,
  RESERVED_DOMAIN,
  RESERVED_ERROR_CODES,
  RESERVED_FULFILLMENT_TYPE,
  RESERVED_ITEM_CODE,
  RESERVED_TAG_CODES,
  RESERVED_VEHICLE_CATEGORY,
  RESERVED_VERSION,
  SEAT_STATES,
  SIMULATED_INVENTORY_MARK,
  SPECIMEN_NOTICE,
  reservedItemId,
} from "../../src/reserved/domain.js";

test("the domain string is local, and says so on its face", () => {
  assert.equal(RESERVED_DOMAIN, "TRANSIT.LOCALHOST:INTERCITY");
  assert.equal(RESERVED_VERSION, "0.1.0");
});

test("a grep of a consuming codebase gets no false positive from this domain", () => {
  // The whole point of not publishing under a namespace this stack does not
  // administer is that the strings a consumer would grep for are absent.
  assert.ok(!RESERVED_DOMAIN.includes("ONDC"));
  assert.ok(!RESERVED_DOMAIN.includes("TRV"));
  assert.ok(!RESERVED_VERSION.startsWith("2."));
});

test("an item id carries the travel date, because a date is a different inventory", () => {
  assert.equal(
    reservedItemId("2259BNGHMP", "2026-09-25", "PALLAKKI"),
    "RSV-2259BNGHMP-2026-09-25-PALLAKKI",
  );
});

test("an item id refuses a travel date that is not a bare IST calendar date", () => {
  assert.throws(
    () => reservedItemId("2259BNGHMP", "2026-09-25T22:59:00+05:30", "PALLAKKI"),
    /travel date/i,
  );
});

test("the third axis is named alongside the two that already exist", () => {
  assert.equal(RESERVED_CATEGORY_CODE, "RESERVED");
  assert.equal(RESERVED_ITEM_CODE, "RESERVED");
  assert.equal(RESERVED_FULFILLMENT_TYPE, "RESERVATION");
  assert.equal(RESERVED_VEHICLE_CATEGORY, "COACH");
});

test("the vocabulary table is exactly the one a future mapping has to read", () => {
  // Section 14.8 keeps these in one table precisely so that mapping them onto
  // a released specification is a table-to-table exercise rather than a search
  // through source. This asserts the table.
  assert.deepEqual([...RESERVED_TAG_CODES].sort(), [
    "BOOKING_REF",
    "CANCELLED_SEATS",
    "HOLD_INFO",
    "MANIFEST",
    "OPERATOR_DISCLOSURE",
    "PRICED_FOR",
    "REFUND_SLAB",
    "SEATS",
    "SEAT_MAP",
    "SEAT_MAP_LAYOUT",
    "SEAT_MAP_REF",
    "SERVICE_INFO",
    "SERVICE_PROVENANCE",
    "SIMULATED_INVENTORY",
    "SPECIMEN_INFO",
    "STOP_ROLE",
    "UNAVAILABLE_SEATS",
    "VEHICLE_LOOKUP",
  ]);
});

const DOCUMENTED_ERROR_CODES = [
  "BOOKING-NOT-FOUND",
  "CONCESSION-NOT-APPLICABLE",
  "CONCESSION-RATE-NOT-PUBLISHED",
  "FARE-NOT-PUBLISHED",
  "HOLD-EXPIRED",
  "HOLD-REQUIRED",
  "HOLD-SEAT-MISMATCH",
  "MANIFEST-FIELD-NOT-ACCEPTED",
  "MANIFEST-INCOMPLETE",
  "MIXED-CATEGORY-ORDER",
  "OUTSIDE-BOOKING-WINDOW",
  "REFUND-QUOTE-EXPIRED",
  "REFUND-SLAB-MOVED",
  "SEAT-COUNT-MISMATCH",
  "SEAT-GENDER-LOCKED",
  "SEAT-NOT-ON-MAP",
  "SEAT-UNAVAILABLE",
  "SERVICE-NOT-FOUND",
  "TRAVEL-DATE-REQUIRED",
];

test("every error code the document names is declared", () => {
  const declared = new Set<string>(RESERVED_ERROR_CODES);
  assert.deepEqual(
    DOCUMENTED_ERROR_CODES.filter((code) => !declared.has(code)),
    [],
  );
});

test("the codes this implementation added are declared and are four", () => {
  // The table in the document is nineteen codes and this implementation issues
  // twenty-three. Each addition is deliberate and each is worth naming rather
  // than letting the set drift: a cancellation may name a seat the booking
  // does not hold, a request may address a different seller, an init or a
  // confirm may arrive with the wrong payment status, and this provider may
  // fail to answer at all. The document has no code for any of the four, and
  // inventing one in a message string rather than in this list is how a client
  // ends up matching on prose - or, in `INTERNAL-ERROR`'s case, how a client
  // ends up classifying a live code as unknown and rendering reassurance for
  // it.
  const documented = new Set<string>(DOCUMENTED_ERROR_CODES);
  assert.deepEqual(
    [...RESERVED_ERROR_CODES].filter((code) => !documented.has(code)).sort(),
    [
      "BPP-ADDRESS-MISMATCH",
      "CANCEL-SEAT-NOT-ON-BOOKING",
      "INTERNAL-ERROR",
      "INVALID-PAYMENT-STATUS",
    ],
  );
});

test("no error code reaches a client without passing through the table", async () => {
  // The check that was missing, and the reason `INTERNAL-ERROR` shipped
  // undeclared for as long as it did: every test above compares the declared
  // table against the documented table, and neither of them is the source. The
  // source is what the code actually puts in `error.code`, and until now
  // nothing read that. A client's error table is only as complete as this.
  const sourceRoot = fileURLToPath(new URL("../../src/reserved", import.meta.url));
  const declared = new Set<string>(RESERVED_ERROR_CODES);
  const raised = new Set<string>();
  const literalErrorObjects: string[] = [];
  for (const file of await readdir(sourceRoot)) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(join(sourceRoot, file), "utf8");
    for (const match of text.matchAll(
      /new ReservedLifecycleError\(\s*"([^"]+)"/g,
    )) {
      raised.add(match[1]);
    }
    // The other road to `error.code`: a callback assembled by hand. It is how
    // `INTERNAL-ERROR` got onto a wire without ever reaching the table, so the
    // code has to come from a value the compiler can check against it.
    if (/error:\s*\{[^}]*?code:\s*"/s.test(text)) {
      literalErrorObjects.push(file);
    }
  }
  assert.ok(raised.size > 0, "no refusal code was found at all");
  assert.deepEqual([...raised].filter((code) => !declared.has(code)).sort(), []);
  assert.deepEqual(
    literalErrorObjects,
    [],
    "an error code written as a bare string cannot be checked against the table",
  );
});

test("nothing this software issues claims to be valid for travel", () => {
  assert.match(SPECIMEN_NOTICE, /NOT VALID FOR TRAVEL/);
  assert.match(SIMULATED_INVENTORY_MARK, /simulated/i);
});

test("a seat has five publishable states, and the fifth is not a colour hint", () => {
  assert.deepEqual([...SEAT_STATES], [
    "AVAILABLE",
    "HELD",
    "HELD_BY_YOU",
    "FEMALE_ONLY",
    "SOLD:simulated",
    "SOLD:booked",
  ]);
});
