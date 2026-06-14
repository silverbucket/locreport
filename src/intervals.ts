import type { Interval } from "./types.js";

const MONTHS: Record<Interval, number> = {
  "1m": 1,
  "3m": 3,
  "6m": 6,
  "1y": 12,
};

export const INTERVALS = Object.keys(MONTHS) as Interval[];

export function isInterval(value: string): value is Interval {
  return value in MONTHS;
}

/** Format a Date as a UTC YYYY-MM-DD string. */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonthsUTC(d: Date, months: number): Date {
  const result = new Date(d);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Generate the list of sampling boundary dates (inclusive of both ends),
 * stepping by `interval` from `first` up to `last`.
 *
 * The first boundary is anchored to `first`; the final boundary is always
 * `last` (the repo's most recent commit) so the report ends at "today's" state
 * even if it doesn't fall on a clean interval step.
 *
 * Returns ISO (YYYY-MM-DD) strings, ascending, de-duplicated.
 */
export function intervalDates(first: Date, last: Date, interval: Interval): string[] {
  if (last < first) throw new Error("`last` must be on or after `first`");
  const step = MONTHS[interval];
  const dates: string[] = [];
  let cursor = first;
  while (cursor <= last) {
    dates.push(toISODate(cursor));
    cursor = addMonthsUTC(cursor, step);
  }
  const lastISO = toISODate(last);
  if (dates[dates.length - 1] !== lastISO) dates.push(lastISO);
  return [...new Set(dates)];
}
