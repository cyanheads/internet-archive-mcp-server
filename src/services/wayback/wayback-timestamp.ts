/**
 * @fileoverview The Wayback timestamp grammar `ia_find_snapshots` and `ia_get_snapshot`
 * accept for `timestamp`, `from`, and `to`, read into the digit form every Wayback endpoint
 * takes before any request is sent.
 * @module services/wayback/wayback-timestamp
 */

/** The longest accepted form, `YYYY-MM-DDTHH:MM:SSZ`. Longer text is rejected before any pattern reads it. */
const MAX_LENGTH = 20;

const DIGITS = /^\d{1,14}$/;

/** `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`, then optionally `THH:MM` or `THH:MM:SS` and a `Z`. */
const ISO_8601 = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?)?)?$/i;

/** The forms `waybackTimestamp` accepts, as a rejection message completes "<field> must be …". */
export const TIMESTAMP_FORMS =
  '1–14 digits (YYYYMMDDHHMMSS or a prefix of it) or an ISO 8601 date or UTC date-time (YYYY, YYYY-MM, or YYYY-MM-DD, optionally followed by THH:MM or THH:MM:SS and Z), naming a real Gregorian date and time';

/**
 * `value` as the 1–14 digit timestamp the Wayback endpoints read as a prefix of
 * `YYYYMMDDHHMMSS`: digits as given, or an ISO 8601 date or date-time with its separators
 * removed, read as UTC. Undefined for anything else — another separator, an offset,
 * fractional seconds, 15 or more digits — and for a month, day, hour, minute, or second no
 * Gregorian date-time has, including a field cut short that no value in its range begins
 * with (`20152`): every endpoint misreads those without saying so. Surrounding whitespace
 * is trimmed; blank text is undefined, so a caller that gives blank a meaning checks first.
 */
export function waybackTimestamp(value: string): string | undefined {
  const text = value.trim();
  if (text.length > MAX_LENGTH) return;
  const digits = DIGITS.test(text)
    ? text
    : ISO_8601.test(text)
      ? text.replace(/\D/g, '')
      : undefined;
  return digits !== undefined && beginsDateTime(digits) ? digits : undefined;
}

/**
 * Whether some Gregorian date-time's `YYYYMMDDHHMMSS` form begins with `digits`: each
 * field present, whole or cut to its first digit, must begin a value in its range.
 */
function beginsDateTime(digits: string): boolean {
  const field = (start: number) => digits.slice(start, start + 2);
  const year = Number(digits.slice(0, 4));
  const month = Number(field(4));
  return (
    fits(field(4), 1, 12) &&
    fits(field(6), 1, daysIn(year, month)) &&
    fits(field(8), 0, 23) &&
    fits(field(10), 0, 59) &&
    fits(field(12), 0, 59)
  );
}

/** Whether a two-digit field, absent or cut to its first digit, begins some value in `min`–`max`. */
function fits(field: string, min: number, max: number): boolean {
  return (
    field === '' || (Number(field.padEnd(2, '9')) >= min && Number(field.padEnd(2, '0')) <= max)
  );
}

/** Days in `month` of `year`, Gregorian. Read only once the day field is present, when both are whole. */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
