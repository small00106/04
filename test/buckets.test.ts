import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleRange,
  dayKey,
  hourBucketKey,
  isValidTimeZone,
  localParts,
} from '../src/time/buckets.js';

describe('localParts', () => {
  test('converts instants to tenant-local wall-clock parts', () => {
    // 2024-03-10 16:30 UTC = 2024-03-11 00:30 Shanghai
    const p = localParts(new Date('2024-03-10T16:30:00Z'), 'Asia/Shanghai');
    assert.deepEqual(p, { year: 2024, month: 3, day: 11, hour: 0 });

    const u = localParts(new Date('2024-03-10T16:30:00Z'), 'UTC');
    assert.deepEqual(u, { year: 2024, month: 3, day: 10, hour: 16 });
  });

  test('DST spring-forward gap zones still produce sane parts', () => {
    // America/New_York exists and returns values
    const p = localParts(new Date('2024-07-01T15:00:00Z'), 'America/New_York');
    assert.equal(p.hour, 11);
    assert.equal(dayKey(p), '2024-07-01');
    assert.equal(hourBucketKey(p), '2024-07-01 11:00:00');
  });
});

describe('isValidTimeZone', () => {
  test('accepts IANA names, rejects junk', () => {
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Asia/Shanghai'), true);
    assert.equal(isValidTimeZone('America/New_York'), true);
    assert.equal(isValidTimeZone('GMT+8'), false);
    assert.equal(isValidTimeZone('Shanghai'), false);
  });
});

describe('cycleRange', () => {
  test('anchor=1 is the calendar month', () => {
    const r = cycleRange({ year: 2024, month: 3, day: 15 }, 1);
    assert.deepEqual(r, { start: '2024-03-01', end: '2024-04-01' });
  });

  test('day before anchor belongs to the previous month cycle', () => {
    const r = cycleRange({ year: 2024, month: 3, day: 14 }, 15);
    assert.deepEqual(r, { start: '2024-02-15', end: '2024-03-15' });
  });

  test('day on/after anchor belongs to this month cycle', () => {
    const r = cycleRange({ year: 2024, month: 3, day: 15 }, 15);
    assert.deepEqual(r, { start: '2024-03-15', end: '2024-04-15' });
    const r2 = cycleRange({ year: 2024, month: 3, day: 31 }, 15);
    assert.deepEqual(r2, { start: '2024-03-15', end: '2024-04-15' });
  });

  test('cycle wraps across year boundary', () => {
    const before = cycleRange({ year: 2024, month: 1, day: 5 }, 15);
    assert.deepEqual(before, { start: '2023-12-15', end: '2024-01-15' });

    const dec = cycleRange({ year: 2024, month: 12, day: 20 }, 15);
    assert.deepEqual(dec, { start: '2024-12-15', end: '2025-01-15' });
  });
});
