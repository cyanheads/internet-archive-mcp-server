/**
 * @fileoverview The string-or-list rule for Archive record fields: a non-empty string or a list
 * of strings is kept as sent, any other shape is left out.
 * @module services/string-or-list
 */

/**
 * An Archive API value as the API sent it when it is a non-empty string or a list of strings;
 * `undefined` for an empty string or any other shape — a number, an object, or a list holding
 * a non-string — so the value is left out instead of failing the call's output validation.
 * Every relayed item field (Metadata API) and every string-or-list field of a search row
 * (Advanced Search) is read through it: the Archive documents several as single-valued, and
 * they arrive as lists on some records.
 */
export const stringOrList = (value: unknown): string | string[] | undefined => {
  if (typeof value === 'string') return value === '' ? undefined : value;
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string')
    ? value
    : undefined;
};
