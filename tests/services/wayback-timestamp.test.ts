/**
 * @fileoverview Tests for the Wayback timestamp grammar shared by ia_find_snapshots and
 * ia_get_snapshot: digit prefixes pass unchanged, ISO 8601 dates and UTC date-times lose
 * their separators, and anything an endpoint would misread is rejected.
 * @module tests/services/wayback-timestamp.test
 */

import { describe, expect, it } from 'vitest';
import { waybackTimestamp } from '@/services/wayback/wayback-timestamp.js';

/** A real example.com capture; every prefix of it is a timestamp the endpoints read as a period. */
const CAPTURE = '20150615052729';

describe('waybackTimestamp', () => {
  it.each(Array.from({ length: 14 }, (_, i) => CAPTURE.slice(0, i + 1)))(
    'passes the %s digit prefix through unchanged',
    (prefix) => {
      expect(waybackTimestamp(prefix)).toBe(prefix);
    },
  );

  it.each([
    ['2015', '2015'],
    ['2015-06', '201506'],
    ['2015-01-01', '20150101'],
    ['2020-06-15T12:34', '202006151234'],
    ['2020-06-15T12:34Z', '202006151234'],
    ['2020-06-15T12:34:56', '20200615123456'],
    ['2020-06-15T12:34:56Z', '20200615123456'],
    ['2020-06-15t12:34:56z', '20200615123456'],
  ])('reads the ISO 8601 form %s as %s', (iso, digits) => {
    expect(waybackTimestamp(iso)).toBe(digits);
  });

  it('trims surrounding whitespace, however much of it there is', () => {
    expect(waybackTimestamp('  20200101 \n')).toBe('20200101');
    expect(waybackTimestamp(`${' '.repeat(100_000)}2015-01-01\t`)).toBe('20150101');
  });

  it.each([
    ['the last second of a year', '20151231235959'],
    ['the first second of a year', '20150101000000'],
    ['a leap day', '20160229'],
    ['a leap day in a year divisible by 400', '2000-02-29'],
    ['the 30th of a 30-day month', '20150630'],
    ['the 31st of a 31-day month', '2015-07-31'],
    ['a month field begun with 0', '20150'],
    ['a month field begun with 1', '20151'],
    ['a day field begun with 3 in a month that has a 30th', '2015063'],
    ['a February day field begun with 2', '2015022'],
    ['an hour field begun with 2', '201506152'],
    ['a minute field begun with 5', '20150615235'],
    ['a second field begun with 5', '2015061523595'],
  ])('accepts %s (%s)', (_label, value) => {
    expect(waybackTimestamp(value)).toBeDefined();
  });

  it.each([
    ['a month name', 'January 2015'],
    ['slash separators', '2015/01/01'],
    ['dot separators', '2015.01.01'],
    ['an unpadded ISO month and day', '2015-1-1'],
    ['a space before the time', '2015-06-15 12:34:56'],
    ['a UTC offset', '2015-06-15T12:34:56+00:00'],
    ['a negative offset', '2015-06-15T12:34:56-07:00'],
    ['fractional seconds', '2015-06-15T12:34:56.123Z'],
    ['an hour with no minute', '2015-06-15T12'],
    ['a Z after a date alone', '2015-06-15Z'],
    ['a sign', '+2015'],
    ['a leading minus', '-2015'],
    ['non-ASCII digits', '２０１５'],
    ['15 digits', '201506150527291'],
    ['month 13', '20151345'],
    ['month 00', '201500'],
    ['an ISO month 13', '2015-13-01'],
    ['February 30', '20150230'],
    ['February 29 in a common year', '2015-02-29'],
    ['February 29 in a century year not divisible by 400', '19000229'],
    ['June 31', '20150631'],
    ['day 00', '20150600'],
    ['hour 24', '2015061524'],
    ['minute 60', '201506152360'],
    ['second 60', '20150615235960'],
    ['an ISO hour 24', '2015-06-15T24:00:00Z'],
    ['a month field no month begins with', '20152'],
    ['a February day field no February day begins with', '2015023'],
    ['a day field no day begins with', '2015064'],
    ['an hour field no hour begins with', '201506153'],
    ['a minute field no minute begins with', '20150615236'],
    ['a second field no second begins with', '2015061523596'],
    ['blank text', ''],
  ])('rejects %s (%s)', (_label, value) => {
    expect(waybackTimestamp(value)).toBeUndefined();
  });

  it.each(['20150431', '2015-06-31', '20150931', '2015-11-31T00:00:00Z'])(
    'rejects the 31st of a 30-day month (%s)',
    (value) => {
      expect(waybackTimestamp(value)).toBeUndefined();
    },
  );

  it('rejects text longer than the longest accepted form without reading it', () => {
    expect(waybackTimestamp('2015-06-15T12:34:56Z')).toBe('20150615123456');
    expect(waybackTimestamp('2015-06-15T12:34:56ZZ')).toBeUndefined();
    expect(waybackTimestamp('2'.repeat(320_000))).toBeUndefined();
    expect(waybackTimestamp(`2015-${'-'.repeat(320_000)}`)).toBeUndefined();
  });
});
