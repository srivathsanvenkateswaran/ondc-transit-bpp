import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bookingWindowStatus,
  istCalendarDate,
  istIsoInstant,
  runsOn,
  stopInstant,
} from "../../src/reserved/calendar.js";
import type { OperatingPattern } from "../../src/reserved/types.js";

test("a travel date is a calendar day in IST, not a day in UTC", () => {
  // 18:45 UTC on the 24th is already 00:15 on the 25th in Asia/Kolkata, and a
  // rider asking about the 25th means the 25th where the coach is.
  assert.equal(istCalendarDate(Date.parse("2026-09-24T18:45:00.000Z")), "2026-09-25");
  assert.equal(istCalendarDate(Date.parse("2026-09-24T18:15:00.000Z")), "2026-09-24");
});

test("a stop instant crosses midnight rather than wrapping", () => {
  // The 22:59 from Bengaluru reaches Hampi 451 minutes later, which is 06:30
  // on the following calendar day. This is the case the existing categories
  // have never produced, and it is why the travel date and the departure
  // instant are separate fields rather than one.
  assert.equal(
    stopInstant("2026-09-25", 1_379, 451),
    "2026-09-26T06:30:00.000+05:30",
  );
  assert.equal(stopInstant("2026-09-25", 1_379, 0), "2026-09-25T22:59:00.000+05:30");
});

test("a departure minute past midnight lands on the next day", () => {
  // departureMinute may exceed 1440 for a service whose board says it leaves
  // after midnight on the named travel date.
  assert.equal(stopInstant("2026-09-25", 1_500, 0), "2026-09-26T01:00:00.000+05:30");
});

test("a stop instant refuses a travel date that is not a calendar date", () => {
  assert.throws(() => stopInstant("25-09-2026", 600, 0), /travel date/i);
});

test("a daily service runs on every date", () => {
  assert.equal(runsOn({ kind: "daily" }, "2026-09-25"), true);
  assert.equal(runsOn({ kind: "daily" }, "2027-02-28"), true);
});

test("a day-of-week pattern is read against the IST calendar", () => {
  // 2026-09-25 is a Friday; 0 is Sunday.
  const fridaysOnly: OperatingPattern = { kind: "daysOfWeek", days: [5] };
  assert.equal(runsOn(fridaysOnly, "2026-09-25"), true);
  assert.equal(runsOn(fridaysOnly, "2026-09-26"), false);
});

test("a dated pattern runs on exactly the dates it names", () => {
  const pattern: OperatingPattern = {
    kind: "dates",
    dates: ["2026-09-25", "2026-10-02"],
  };
  assert.equal(runsOn(pattern, "2026-09-25"), true);
  assert.equal(runsOn(pattern, "2026-09-26"), false);
});

test("there is no nearest-date fallback and no roll-forward", () => {
  // A rider asking about the 25th must not be sold the 26th. The existing
  // single-journey path's rollover discipline does not apply here, because a
  // reserved departure has a real calendar date rather than a time of day.
  const pattern: OperatingPattern = { kind: "dates", dates: ["2026-09-26"] };
  assert.equal(runsOn(pattern, "2026-09-25"), false);
});

const window = { closeMinutes: 45, horizonDays: 30 };

test("a date inside the window is sellable", () => {
  const departure = Date.parse("2026-09-25T22:59:00.000+05:30");
  const now = Date.parse("2026-09-05T09:00:00.000+05:30");
  assert.deepEqual(bookingWindowStatus(departure, now, window), { status: "OPEN" });
});

test("a departure inside the closing window names which edge and the instant", () => {
  // A client that filtered correctly never sees this; a client that did not
  // needs to know which of its two constants disagrees with this provider's.
  const departure = Date.parse("2026-09-25T22:59:00.000+05:30");
  const now = departure - 44 * 60_000;
  const verdict = bookingWindowStatus(departure, now, window);
  assert.equal(verdict.status, "TOO_LATE");
  assert.equal(verdict.boundaryAt, istIsoInstant(departure - 45 * 60_000));
});

test("the closing boundary is inclusive of the last sellable instant", () => {
  const departure = Date.parse("2026-09-25T22:59:00.000+05:30");
  assert.equal(
    bookingWindowStatus(departure, departure - 45 * 60_000, window).status,
    "OPEN",
  );
  assert.equal(
    bookingWindowStatus(departure, departure - 45 * 60_000 + 1, window).status,
    "TOO_LATE",
  );
});

test("a departure past the horizon names the far edge and its instant", () => {
  const now = Date.parse("2026-09-05T09:00:00.000+05:30");
  const departure = Date.parse("2026-10-20T22:59:00.000+05:30");
  const verdict = bookingWindowStatus(departure, now, window);
  assert.equal(verdict.status, "TOO_FAR");
  assert.equal(verdict.boundaryAt, istIsoInstant(now + 30 * 24 * 60 * 60_000));
});

test("a departure that has already gone is too late, not too far", () => {
  const departure = Date.parse("2026-09-01T22:59:00.000+05:30");
  const now = Date.parse("2026-09-05T09:00:00.000+05:30");
  assert.equal(bookingWindowStatus(departure, now, window).status, "TOO_LATE");
});
