/**
 * Dates, instants and the booking window.
 *
 * Everything in this category is anchored to a calendar day in `Asia/Kolkata`
 * rather than to an instant. A planner that collapses a timestamp to a time of
 * day silently discards the date component, and a rider asking about the 25th
 * must not be sold the 26th - so a date is a date here, all the way down, and
 * an instant is only ever derived from one.
 *
 * India has one fixed offset and has observed no daylight saving, so a fixed
 * offset is correct rather than a simplification. The rest of this repository
 * already writes `+05:30` on the wire for the same reason.
 */

import type { OperatingPattern } from "./types.js";

const INDIA_OFFSET_MILLISECONDS = 5.5 * 60 * 60 * 1000;
const MINUTE_MILLISECONDS = 60_000;
const DAY_MILLISECONDS = 24 * 60 * MINUTE_MILLISECONDS;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day an instant falls on, in IST. */
export function istCalendarDate(atMilliseconds: number): string {
  return new Date(atMilliseconds + INDIA_OFFSET_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

function midnightMilliseconds(travelDate: string): number {
  const match = CALENDAR_DATE.exec(travelDate);
  if (!match) {
    throw new Error(
      `A travel date must be a bare calendar date in YYYY-MM-DD, not ${travelDate}`,
    );
  }
  const [, year, month, day] = match;
  const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(midnight)) {
    throw new Error(`Unparseable travel date ${travelDate}`);
  }
  return midnight - INDIA_OFFSET_MILLISECONDS;
}

/**
 * The absolute instant a stop is reached: IST midnight on the travel date,
 * plus the service's departure minute, plus the stop's own reporting offset.
 *
 * Both addends can push past midnight, and the result is allowed to land on
 * the following calendar day. That is the case the two existing categories
 * have never produced, and it is why the travel date and the departure instant
 * are separate fields rather than one.
 */
export function stopInstant(
  travelDate: string,
  departureMinute: number,
  reportingOffsetMinutes: number,
): string {
  const atMilliseconds =
    midnightMilliseconds(travelDate) +
    (departureMinute + reportingOffsetMinutes) * MINUTE_MILLISECONDS;
  return istIsoInstant(atMilliseconds);
}

/** Epoch milliseconds for the same instant, for arithmetic rather than wire. */
export function stopInstantMilliseconds(
  travelDate: string,
  departureMinute: number,
  reportingOffsetMinutes: number,
): number {
  return (
    midnightMilliseconds(travelDate) +
    (departureMinute + reportingOffsetMinutes) * MINUTE_MILLISECONDS
  );
}

/**
 * `+05:30` rather than `Z`, so the calendar boundary the instant is anchored
 * to stays legible on the wire. The rest of this repository already does the
 * same for the same reason.
 */
export function istIsoInstant(atMilliseconds: number): string {
  const shifted = new Date(atMilliseconds + INDIA_OFFSET_MILLISECONDS);
  return `${shifted.toISOString().slice(0, 23)}+05:30`;
}

/**
 * Whether a service runs on a date.
 *
 * There is no nearest-date fallback and no silent roll-forward. The existing
 * single-journey path's rollover discipline does not apply here, because a
 * reserved departure has a real calendar date rather than a time of day.
 */
export function runsOn(pattern: OperatingPattern, travelDate: string): boolean {
  switch (pattern.kind) {
    case "daily":
      return true;
    case "daysOfWeek": {
      const day = new Date(
        midnightMilliseconds(travelDate) + INDIA_OFFSET_MILLISECONDS,
      ).getUTCDay();
      return pattern.days.includes(day);
    }
    case "dates":
      return pattern.dates.includes(travelDate);
  }
}

export interface BookingWindow {
  closeMinutes: number;
  horizonDays: number;
}

export type BookingWindowVerdict =
  | { status: "OPEN" }
  /** Inside the closing window, or already gone. */
  | { status: "TOO_LATE"; boundaryAt: string }
  /** Beyond the advance horizon. */
  | { status: "TOO_FAR"; boundaryAt: string };

/**
 * Whether a departure can be transacted now.
 *
 * The buyer app holds a copy of this gate so that unsellable legs never appear
 * in a plan; this provider holds the authoritative version, and the two are
 * not redundant. A refusal names which edge was crossed and the boundary
 * instant, because a client that filtered correctly will never see it and a
 * client that did not needs to know which of its two constants disagrees.
 *
 * The two constants are not the same kind of fact. The closing window is close
 * to a hard operational reality; the horizon is a fidelity choice about how far
 * ahead simulated inventory bothers to exist.
 *
 * The boundary is `+05:30`, like every other instant this category publishes.
 * A rider on the wrong side of a booking window is being told about a calendar
 * evening in India, and printing it in UTC hands the client an off-by-five-and-
 * a-half-hours reading of its own error message.
 */
export function bookingWindowStatus(
  departureAtMilliseconds: number,
  nowMilliseconds: number,
  window: BookingWindow,
): BookingWindowVerdict {
  const closesAt = departureAtMilliseconds - window.closeMinutes * MINUTE_MILLISECONDS;
  if (nowMilliseconds > closesAt) {
    return { status: "TOO_LATE", boundaryAt: istIsoInstant(closesAt) };
  }
  const horizonAt = nowMilliseconds + window.horizonDays * DAY_MILLISECONDS;
  if (departureAtMilliseconds > horizonAt) {
    return { status: "TOO_FAR", boundaryAt: istIsoInstant(horizonAt) };
  }
  return { status: "OPEN" };
}
