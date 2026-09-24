import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealizedSeries, chartIndexAtX, chartIndexForKey } from '../src/chart-model.js';

test('series includes each covered calendar day and carries cumulative realized P/L across gaps', () => {
  const points = buildRealizedSeries([
    { date: '2026-01-02', value: 20, count: 1 },
    { date: '2026-01-05', value: -5, count: 1 }
  ], { start: '2026-01-01', end: '2026-01-06' }, 100);
  assert.deepEqual(points.map(point => [point.date, point.daily, point.cumulative, point.count]), [
    ['2026-01-01', 0, 0, 0],
    ['2026-01-02', 20, 20, 1],
    ['2026-01-03', 0, 20, 0],
    ['2026-01-04', 0, 20, 0],
    ['2026-01-05', -5, 15, 1],
    ['2026-01-06', 0, 15, 0]
  ]);
  assert.equal(points.at(-1).dailyPercent, 0);
  assert.equal(points.at(-1).cumulativePercent, 15);
});

test('first-day values appear once and retain the difference between zero P/L and no trades', () => {
  const range = { start: '2026-01-01', end: '2026-01-01' };
  assert.deepEqual(buildRealizedSeries([{ date: range.start, value: -10, count: 2 }], range, 100), [{
    date: '2026-01-01', daily: -10, cumulative: -10,
    dailyPercent: -10, cumulativePercent: -10, count: 2
  }]);
  const zero = buildRealizedSeries([{ date: range.start, value: 0, count: 2 }], range)[0];
  const absent = buildRealizedSeries([], range)[0];
  assert.equal(zero.daily, absent.daily);
  assert.equal(zero.count, 2);
  assert.equal(absent.count, 0);
});

test('series merges duplicate unsorted days, excludes outside trades and does not mutate inputs', () => {
  const rows = Object.freeze([
    Object.freeze({ date: '2026-01-03', value: 7, count: 2 }),
    Object.freeze({ date: '2026-01-01', value: 1000, count: 1 }),
    Object.freeze({ date: '2026-01-02', value: 5, count: 1 }),
    Object.freeze({ date: '2026-01-03', value: -3, count: 1 }),
    Object.freeze({ date: '2026-01-04', value: 1000, count: 1 })
  ]);
  const points = buildRealizedSeries(rows, { start: '2026-01-02', end: '2026-01-03' });
  assert.deepEqual(points.map(point => [point.date, point.daily, point.cumulative, point.count]), [
    ['2026-01-02', 5, 5, 1], ['2026-01-03', 4, 9, 3]
  ]);
  assert.equal(rows[0].value, 7);
});

test('UTC calendar steps cover leap days, year boundaries and daylight-saving dates', () => {
  for (const [start, end, expected] of [
    ['2024-02-28', '2024-03-01', ['2024-02-28', '2024-02-29', '2024-03-01']],
    ['2025-12-31', '2026-01-02', ['2025-12-31', '2026-01-01', '2026-01-02']],
    ['2026-03-07', '2026-03-09', ['2026-03-07', '2026-03-08', '2026-03-09']],
    ['2026-10-31', '2026-11-02', ['2026-10-31', '2026-11-01', '2026-11-02']]
  ]) {
    assert.deepEqual(buildRealizedSeries([], { start, end }).map(point => point.date), expected);
  }
});

test('invalid dates and ranges cannot produce fabricated chart points', () => {
  for (const range of [
    null, {}, { start: '2026-01-01' },
    { start: '2026-02-30', end: '2026-03-02' },
    { start: '2026-01-02', end: '2026-01-01' },
    { start: '2026-01-01T00:00:00Z', end: '2026-01-02' }
  ]) assert.deepEqual(buildRealizedSeries([], range), []);
  const rows = [
    { date: 'invalid', value: 100, count: 1 },
    { date: '2026-01-01', value: null, count: 1 },
    { date: '2026-01-01', value: Infinity, count: 1 },
    { date: '2026-01-01', value: NaN, count: 1 },
    { date: '2026-01-01', value: 3, count: 1 }
  ];
  const [point] = buildRealizedSeries(rows, { start: '2026-01-01', end: '2026-01-01' });
  assert.equal(point.daily, 3);
  assert.equal(point.count, 1);
});

test('percentages use the unrounded cumulative amount and only a valid positive fixed base', () => {
  const rows = [
    { date: '2026-01-01', value: 0.01, count: 1 },
    { date: '2026-01-02', value: 0.01, count: 1 },
    { date: '2026-01-03', value: 0.01, count: 1 }
  ];
  const range = { start: '2026-01-01', end: '2026-01-03' };
  const last = buildRealizedSeries(rows, range, 300).at(-1);
  assert.equal(last.cumulative, 0.03);
  assert.ok(Math.abs(last.cumulativePercent - 0.01) < 1e-12);
  assert.equal(last.dailyPercent, 0.01 / 300 * 100);
  for (const base of [null, undefined, 0, -1, NaN, Infinity, '300']) {
    const points = buildRealizedSeries(rows, range, base);
    assert.ok(points.every(point => point.dailyPercent === null && point.cumulativePercent === null));
    assert.equal(points.at(-1).cumulative, 0.03);
  }
});

test('horizontal selection uses the plot bounds, rounds to the nearest date and clamps', () => {
  assert.equal(chartIndexAtX(100, 100, 400, 5), 0);
  assert.equal(chartIndexAtX(500, 100, 400, 5), 4);
  assert.equal(chartIndexAtX(249, 100, 400, 5), 1);
  assert.equal(chartIndexAtX(250, 100, 400, 5), 2);
  assert.equal(chartIndexAtX(-100, 100, 400, 5), 0);
  assert.equal(chartIndexAtX(700, 100, 400, 5), 4);
  assert.equal(chartIndexAtX(300, 100, 400, 1), 0);
  assert.equal(chartIndexAtX(300, 100, 0, 5), null);
  assert.equal(chartIndexAtX(300, 100, -1, 5), null);
  assert.equal(chartIndexAtX(NaN, 100, 400, 5), null);
  assert.equal(chartIndexAtX(300, 100, 400, 0), null);
});

test('keyboard selection traverses all calendar dates, including empty days', () => {
  assert.equal(chartIndexForKey('ArrowLeft', 2, 5), 1);
  assert.equal(chartIndexForKey('ArrowRight', 2, 5), 3);
  assert.equal(chartIndexForKey('ArrowLeft', 0, 5), 0);
  assert.equal(chartIndexForKey('ArrowRight', 4, 5), 4);
  assert.equal(chartIndexForKey('Home', 3, 5), 0);
  assert.equal(chartIndexForKey('End', 0, 5), 4);
  assert.equal(chartIndexForKey('ArrowRight', 0, 1), 0);
  assert.equal(chartIndexForKey('ArrowRight', null, 5), 1);
  assert.equal(chartIndexForKey('ArrowLeft', 2, 0), null);
  assert.equal(chartIndexForKey('Tab', 2, 5), null);
  assert.equal(chartIndexForKey('Escape', 2, 5), null);
});
