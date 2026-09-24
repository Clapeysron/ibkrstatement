import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIbkrReport } from '../src/parser.js';
import { account, positionsHeader, stockRoundTrip, rates, forex } from './fixtures.js';
import {
  reportRange, selectRange, filterTrades, instrumentFor, dailyRealized,
  rankRealized, cashRecords, assetBridge, holdingTotals
} from '../src/dashboard-model.js';

const trade = (date, overrides = {}) => ({
  date, dateTimeText: `${date}, 12:00:00`, symbol: 'ABC', assetCategory: 'Stocks',
  side: 'Sell', currency: 'USD', baseRealizedPL: 10, ...overrides
});
const report = (start, end, trades = []) => ({ accountInfo: { periodStart: start, periodEnd: end }, tradeDetails: trades, baseCurrency: 'USD' });

test('report ranges prefer the declared period and never substitute the current date', () => {
  assert.deepEqual(reportRange(report('2024-01-01', '2024-03-31', [trade('2024-02-01')])), {
    start: '2024-01-01', end: '2024-03-31', year: 2024, month: 3, source: 'report'
  });
  assert.deepEqual(reportRange({ tradeDetails: [trade('2025-01-03'), trade('2024-12-31'), trade('invalid')] }), {
    start: '2024-12-31', end: '2025-01-03', year: 2025, month: 1, source: 'trades'
  });
  assert.deepEqual(reportRange(report('2024-02-31', '2024-03-31')), {
    start: null, end: null, year: null, month: null, source: 'unknown'
  });
  assert.equal(selectRange({}).end, null);
});

test('fallback report ranges cover deposits before trading and interest after trading', () => {
  const data = parseIbkrReport(account +
    'Statement,Header,Field Name,Field Value\nStatement,Data,Period,January 2026\n' + stockRoundTrip +
    'Deposits & Withdrawals,Header,Currency,Date,Description,Amount\nDeposits & Withdrawals,Data,USD,2026-01-01,Deposit,1000\n' +
    'Interest,Header,Currency,Date,Description,Amount\nInterest,Data,USD,2026-01-31,Credit interest,1\n');
  assert.deepEqual(reportRange(data), {
    start: '2026-01-01', end: '2026-01-31', year: 2026, month: 1, source: 'data'
  });
  const range = selectRange(data, 'all');
  const records = cashRecords(data);
  assert.ok(records.every(row => row.date >= range.start && row.date <= range.end));
  assert.equal(records.filter(row => row.type === 'deposit').length, 1);
  assert.equal(records.filter(row => row.type === 'interest').length, 1);
});

test('cash-only reports have a usable date range without inventing trading dates', () => {
  const data = { cashTransactions: [{ date: '2025-12-31' }, { date: '2026-01-05' }, { date: 'invalid' }] };
  assert.deepEqual(reportRange(data), {
    start: '2025-12-31', end: '2026-01-05', year: 2026, month: 1, source: 'data'
  });
  assert.deepEqual(selectRange(data, 'all'), {
    start: '2025-12-31', end: '2026-01-05', isFull: true, label: '全部', partialCoverage: false
  });
  assert.deepEqual(reportRange({ cashTransactions: [{ date: 'invalid' }] }), {
    start: null, end: null, year: null, month: null, source: 'unknown'
  });
});

test('rolling periods clamp month-end and leap-day dates without losing the requested start', () => {
  assert.equal(selectRange(report('2020-01-01', '2024-03-31'), '1m').start, '2024-02-29');
  assert.equal(selectRange(report('2020-01-01', '2023-03-31'), '1m').start, '2023-02-28');
  assert.equal(selectRange(report('2020-01-01', '2024-02-29'), '1y').start, '2023-02-28');
  assert.equal(selectRange(report('2020-01-01', '2024-08-31'), '6m').start, '2024-02-29');
  assert.deepEqual(selectRange(report('2024-02-20', '2024-09-23'), 'year'), {
    start: '2024-01-01', end: '2024-09-23', isFull: true, label: '本年', partialCoverage: true
  });
  assert.deepEqual(selectRange(report('2024-02-20', '2024-09-23'), 'all'), {
    start: '2024-02-20', end: '2024-09-23', isFull: true, label: '全部', partialCoverage: false
  });
  assert.equal(selectRange(report('2024-02-20', '2024-09-23'), 'month').isFull, false);
  assert.equal(selectRange(report('2024-01-01', '2025-01-03'), 'year').start, '2025-01-01');
});

test('trade filters include date boundaries across years and preserve source object identity', () => {
  const trades = [trade('2024-12-30'), trade('2024-12-31'), trade('2025-01-01'), trade('2025-01-02')];
  const data = { tradeDetails: trades };
  const result = filterTrades(data, { start: '2024-12-31', end: '2025-01-01' });
  assert.deepEqual(result, [trades[2], trades[1]]);
  assert.equal(result[0], trades[2]);
  assert.deepEqual(trades.map(row => row.date), ['2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02']);
});

test('instrument names match full contracts and categories without guessing a market', () => {
  const data = {
    instruments: [
      { symbol: 'ABC', name: '名称', assetCategory: 'Stocks', exchange: 'NASDAQ' },
      { symbol: 'ABC 19JUN26 100 C', name: '看涨合约', assetCategory: 'Equity and Index Options' }
    ],
    tradeDetails: [trade('2026-01-03'), trade('2026-01-03', { symbol: 'ABC 19JUN26 100 C', assetCategory: 'Equity and Index Options', side: 'Buy', currency: 'HKD' })]
  };
  assert.equal(instrumentFor(data, 'ABC', 'Stocks').name, '名称');
  assert.equal(instrumentFor(data, 'ABC', 'Options').name, 'ABC');
  assert.equal(instrumentFor(data, '12345', 'Stocks').exchange, '');
  assert.equal(filterTrades(data, null, { query: '看涨', asset: 'Options', currency: 'HKD', side: 'buy' }).length, 1);
  assert.equal(filterTrades(data, null, { query: 'abc', asset: 'Equity and Index Options' }).length, 1);
  assert.equal(filterTrades(data, null, { query: '名称', side: 'sell' }).length, 1);
});

test('daily realized returns use base realized P/L without Forex MTM or double-counted fees', () => {
  const data = parseIbkrReport(account + rates + stockRoundTrip + forex);
  const days = dailyRealized(data, selectRange(data, 'all'));
  assert.deepEqual(days, [
    { date: '2026-01-02', value: 0, count: 1 },
    { date: '2026-01-03', value: 18, count: 1 }
  ]);
  assert.equal(days.reduce((sum, row) => sum + row.value, 0), 18);
  assert.deepEqual(dailyRealized(data, null, 'Forex'), []);
});

test('realized rankings aggregate each dated trade and keep option contracts distinct', () => {
  const data = report('2025-01-01', '2026-02-28', [
    trade('2025-12-31', { baseRealizedPL: 100 }), trade('2026-01-02', { baseRealizedPL: -10 }),
    trade('2026-01-03', { symbol: 'ABC 19JUN26 100 C', assetCategory: 'Equity and Index Options', baseRealizedPL: 4 }),
    trade('2026-01-03', { symbol: 'ABC 19JUN26 100 P', assetCategory: 'Options', baseRealizedPL: 6 }),
    trade('2026-01-03', { symbol: 'EUR.USD', assetCategory: 'Forex', baseRealizedPL: 999 }),
    trade('2026-01-04', { symbol: 'MISSING', baseRealizedPL: null })
  ]);
  const rows = rankRealized(data, selectRange(data, 'year'));
  assert.deepEqual(rows.map(row => [row.symbol, row.value, row.currency]), [
    ['ABC 19JUN26 100 P', 6, 'USD'], ['ABC 19JUN26 100 C', 4, 'USD'], ['ABC', -10, 'USD']
  ]);
  assert.equal(rankRealized(data, null, 'Options').length, 2);
});

test('cash records keep mixed commission currencies and signed proceeds separate', () => {
  const data = parseIbkrReport(account + rates + stockRoundTrip + forex);
  const records = cashRecords(data);
  const fx = records.filter(row => row.symbol === 'USD.HKD');
  assert.deepEqual(fx.map(row => [row.type, row.currency, row.amount]), [
    ['buy', 'HKD', -780], ['commission', 'USD', -0.35]
  ]);
  assert.equal(fx[1].baseAmount, -0.35);
  assert.equal(fx[0].dateTimeText, fx[1].dateTimeText);
  assert.equal(new Set(records.map(row => row.id)).size, records.length);
  assert.equal(records.filter(row => row.symbol === 'ABC').reduce((sum, row) => sum + row.baseAmount, 0), 18);
  assert.equal(data.tradeDetails.length, 3);
});

test('cash records preserve unknown conversions and do not invent settlement times', () => {
  const data = {
    cashTransactions: [
      { date: '2026-01-03', type: 'dividend', currency: 'EUR', amount: 10, baseAmount: null, description: '现金红利' },
      { date: '2026-01-02', type: 'deposit', currency: 'USD', amount: 0, baseAmount: 0 }
    ],
    tradeDetails: [trade('2026-01-01', { dateTimeText: undefined, dateTime: '2026-01-01T00:00:00.000Z', proceeds: 0, commission: 0 })]
  };
  const records = cashRecords(data);
  assert.equal(records.length, 2);
  assert.equal(records[0].baseAmount, null);
  assert.equal(records[0].title, '股息');
  assert.equal(records[0].dateTimeText, '2026-01-03');
  assert.equal(records[0].tradeIndex, null);
  assert.equal(records[1].baseAmount, 0);
});

test('asset bridge uses actual present fields and reports unexplained differences separately', () => {
  const data = {
    nav: { total: 1300 }, navDetails: { hasNav: true, changeKeys: ['startingValue', 'endingValue', 'depositsAndWithdrawals', 'stockGrantActivity', 'markToMarket', 'commissions'] },
    navChange: [
      { key: 'startingValue', value: 1000 }, { key: 'endingValue', value: 1300 },
      { key: 'depositsAndWithdrawals', value: 200 }, { key: 'stockGrantActivity', value: 20 },
      { key: 'markToMarket', value: 90 }, { key: 'commissions', value: -5 }, { key: 'otherFees', value: 0 }
    ]
  };
  const bridge = assetBridge(data);
  assert.equal(bridge.netIn, 220);
  assert.equal(bridge.profit, 80);
  assert.equal(bridge.reconciliation, -5);
  assert.equal(bridge.navTotal, 1300);
  assert.equal(bridge.items.length, 6);
  assert.equal(bridge.available, true);
});

test('asset bridge distinguishes absent cash flows and placeholder NAV from genuine zero', () => {
  const absent = assetBridge({ nav: { total: 0 }, navChange: [{ key: 'startingValue', value: 0 }] });
  assert.equal(absent.start, null);
  assert.equal(absent.navTotal, null);
  assert.equal(absent.profit, null);
  assert.equal(absent.available, false);
  const data = {
    nav: { total: 0 }, navDetails: { hasNav: true, changeKeys: ['startingValue', 'endingValue'] },
    navChange: [{ key: 'startingValue', value: 0 }, { key: 'endingValue', value: 0 }, { key: 'depositsAndWithdrawals', value: 0 }]
  };
  assert.equal(assetBridge(data).profit, null);
  assert.equal(assetBridge(data).netIn, null);
  assert.equal(assetBridge(data).navTotal, 0);
  data.navDetails.changeKeys.push('depositsAndWithdrawals');
  assert.equal(assetBridge(data).profit, 0);
  assert.equal(assetBridge(data).netIn, 0);
  assert.equal(assetBridge(data).reconciliation, 0);
});

test('holdings totals use base-currency values and retain short exposure and missing amounts', () => {
  assert.deepEqual(holdingTotals({}), { value: null, unrealized: null, grossValue: null });
  assert.deepEqual(holdingTotals({ positions: [
    { baseValue: 100, baseUnrealizedPL: 5, value: 780 },
    { baseValue: -40, baseUnrealizedPL: -2, value: -40 }
  ] }), { value: 60, unrealized: 3, grossValue: 140 });
  assert.deepEqual(holdingTotals({ positions: [{ baseValue: null, baseUnrealizedPL: 0 }] }), { value: null, unrealized: 0, grossValue: null });
  assert.deepEqual(holdingTotals({ positions: [] }), { value: 0, unrealized: 0, grossValue: 0 });
});

test('holdings totals distinguish omitted holdings sections from explicitly empty sections', () => {
  const unknown = { value: null, unrealized: null, grossValue: null };
  const zero = { value: 0, unrealized: 0, grossValue: 0 };
  assert.deepEqual(holdingTotals(parseIbkrReport(account)), unknown);
  assert.deepEqual(holdingTotals({ positions: [], sectionStats: {} }), unknown);
  assert.deepEqual(holdingTotals({ positions: [], warnings: ['missingPositions'] }), unknown);
  assert.deepEqual(holdingTotals(parseIbkrReport(account + positionsHeader)), zero);
  assert.deepEqual(holdingTotals({ positions: [], sectionStats: { 'Open Positions': 0 } }), zero);
});
