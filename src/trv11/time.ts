const INDIA_OFFSET_MILLISECONDS = 5.5 * 60 * 60 * 1000;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_DURATION =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;

export function durationMilliseconds(duration: string): number {
  const match = ISO_DURATION.exec(duration);
  if (!match?.groups) {
    throw new Error(`Unsupported ticket validity duration ${duration}`);
  }
  const days = Number(match.groups.days ?? 0);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);
  const milliseconds =
    (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`Ticket validity must be a positive duration: ${duration}`);
  }
  return milliseconds;
}

export function serviceInstant(timestamp: string, hhmm: string): string {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid service timestamp ${timestamp}`);
  }
  if (!HHMM.test(hhmm)) {
    throw new Error(`Invalid service time ${hhmm}`);
  }
  const localDate = new Date(
    instant.getTime() + INDIA_OFFSET_MILLISECONDS,
  ).toISOString().slice(0, 10);
  return `${localDate}T${hhmm}:00.000+05:30`;
}
