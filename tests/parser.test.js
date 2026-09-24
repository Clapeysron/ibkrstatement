import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIbkrReport } from '../src/parser.js';
import { account, positionsHeader, tradesHeader, stockRoundTrip, rates, forex, plHeader, completeReport, chineseReport } from './fixtures.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' != ' + expected);

test('rejects HTML in base, position, and explicit field currencies', () => {
  const payload = '<img src=x onerror=alert(1)>';
  for (const csv of [
    account.replace(',USD', ',' + payload),
    account + positionsHeader + 'Open Positions,Data,Summary,Stocks,' + payload + ',ABC,1,1,1,1,1,0\n',
    account + rates + forex.replace('Comm in USD', 'Comm in ' + payload),
    account + rates + forex.replace('MTM in USD', 'MTM in ' + payload)
  ]) assert.throws(() => parseIbkrReport(csv), { code: 'invalidCurrency' });
});

test('stock and option net does not deduct capitalized commissions twice', () => {
  for (const trades of [stockRoundTrip, stockRoundTrip.replaceAll('Stocks', 'Equity and Index Options')]) {
    const data = parseIbkrReport(account + trades);
    near(data.monthlySummary[0].net, 18);
    near(data.monthlySummary[0].commissions, 2);
    near(data.tradeSummary.realizedPL, 18);
  }
});

test('opening stock commission is capitalized, with no realized monthly loss', () => {
  const data = parseIbkrReport(account + stockRoundTrip.split('\n').slice(0, 2).join('\n'));
  assert.equal(data.monthlySummary[0].net, 0);
  assert.equal(data.monthlySummary[0].commissions, 1);
});

test('explicit USD commission and MTM remain USD in every aggregation', () => {
  const data = parseIbkrReport(account + rates + forex);
  near(data.tradeDetails[0].baseCommission, -0.35);
  near(data.tradeDetails[0].baseMtmPL, 2.1);
  assert.equal(data.tradeDetails[0].commissionCurrency, 'USD');
  assert.equal(data.tradeDetails[0].mtmCurrency, 'USD');
  near(data.tradeSummary.totalCommissions, 0.35);
  near(data.dailyTradeStats[0].commissions, 0.35);
  near(data.dailyTradeStats[0].mtmPL, 2.1);
  near(data.monthlySummary[0].commissions, 0.35);
  near(data.monthlySummary[0].forexPL, 2.1);
  near(data.monthlySummary[0].net, 1.75);
});

test('explicit field currency converts correctly with a non-USD base', () => {
  const data = parseIbkrReport(account.replace(',USD', ',EUR') +
    'Base Currency Exchange Rate,Header,Currency,Exchange Rate\nBase Currency Exchange Rate,Data,HKD,0.12\nBase Currency Exchange Rate,Data,USD,0.9\n' + forex);
  near(data.tradeDetails[0].baseCommission, -0.315);
  near(data.tradeDetails[0].baseMtmPL, 1.89);
});

test('zero Forex MTM remains zero instead of falling back to realized P/L', () => {
  const data = parseIbkrReport(account +
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,Proceeds,Comm/Fee,Realized P/L,MTM P/L\n' +
    'Trades,Data,Order,Forex,USD,EUR.USD,2026-01-03,1,-1,-0.35,2,0\n');
  near(data.monthlySummary[0].forexPL, 0);
  near(data.monthlySummary[0].net, -0.35);
});

test('Forex realized-only reports do not deduct their commission twice', () => {
  const data = parseIbkrReport(account +
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,Proceeds,Comm/Fee,Realized P/L\n' +
    'Trades,Data,Order,Forex,USD,EUR.USD,2026-01-03,1,-1,-0.35,2\n');
  near(data.monthlySummary[0].net, 2);
  near(data.monthlySummary[0].commissions, 0.35);
});

test('Comm/Fee and MTM P/L use the trade currency', () => {
  const data = parseIbkrReport(account + rates + tradesHeader +
    'Trades,Data,Order,Stocks,HKD,0700,"2026-01-03, 12:00:00",1,100,-100,-1,101,0,2,O\n');
  near(data.tradeDetails[0].baseCommission, -0.128);
  near(data.tradeDetails[0].baseMtmPL, 0.256);
});

test('explicit FX rates take precedence; latest dated rate wins', () => {
  const data = parseIbkrReport(account +
    'Mark-to-Market Performance Summary,Header,Asset Category,Symbol,Current Price\nMark-to-Market Performance Summary,Data,Forex,HKD,0.13\n' +
    'Base Currency Exchange Rate,Header,Currency,Date,Exchange Rate\nBase Currency Exchange Rate,Data,HKD,2026-01-31,0.128\nBase Currency Exchange Rate,Data,HKD,2026-01-01,0.125\n' +
    positionsHeader + 'Open Positions,Data,Summary,Stocks,HKD,0700,10,1,780,100,1000,220\n');
  near(data.positions[0].baseValue, 128);
  near(data.exchangeRates.HKD, 0.128);
  assert.equal(data.exchangeRates.USD, 1);
});

test('MTM forex rate remains a supported fallback', () => {
  const data = parseIbkrReport(account +
    'Mark-to-Market Performance Summary,Header,Asset Category,Symbol,Current Price\nMark-to-Market Performance Summary,Data,Forex,HKD,0.13\n' + forex);
  near(data.exchangeRates.HKD, 0.13);
});

test('missing, zero, or negative exchange rates stop conversion instead of using 1', () => {
  for (const rate of ['', rates.replace('0.128', '0'), rates.replace('0.128', '-1')]) {
    assert.throws(() => parseIbkrReport(account + rate + forex), { code: 'missingExchangeRate', currency: 'HKD' });
  }
});

test('stock dividends never duplicate onto calls or puts, including option-only holdings', () => {
  const stock = 'Open Positions,Data,Summary,Stocks,USD,AAPL,10,1,900,100,1000,100\n';
  const options = 'Open Positions,Data,Summary,Equity and Index Options,USD,AAPL 19JUN26 100 C,1,100,90,1,100,10\n' +
    'Open Positions,Data,Summary,Equity and Index Options,USD,AAPL 19JUN26 100 P,-1,100,-90,1,-100,-10\n';
  const dividend = 'Dividends,Header,Currency,Date,Description,Amount\nDividends,Data,USD,2026-01-02,AAPL(US000000) Cash Dividend USD 1 per Share,10\n';
  for (const holding of [stock + options, options]) {
    const data = parseIbkrReport(account + positionsHeader + holding + dividend);
    assert.equal(data.dividendIncome.total, 10);
    for (const position of data.positions) {
      assert.equal(position.dividends, position.assetCategory === 'Stocks' ? 10 : 0);
      assert.equal(position.baseDividends, position.assetCategory === 'Stocks' ? 10 : 0);
    }
  }
});

test('missing P/L section and missing all-assets total are unknown, not zero', () => {
  const missing = parseIbkrReport(account + stockRoundTrip);
  assert.equal(missing.plSummary.total.realized, null);
  assert.ok(missing.warnings.includes('missingPlSummary'));
  assert.equal(missing.tradeSummary.realizedPL, 18);
  const partial = parseIbkrReport(account + plHeader + 'Realized & Unrealized Performance Summary,Data,Stocks,ABC,18,0,18\n');
  assert.equal(partial.plSummary.total.total, null);
  assert.ok(partial.warnings.includes('missingPlTotal'));
  const zero = parseIbkrReport(account + plHeader + 'Realized & Unrealized Performance Summary,Data,Total (All Assets),,0,0,0\n');
  assert.equal(zero.plSummary.total.total, 0);
  assert.ok(!zero.warnings.includes('missingPlTotal'));
});

test('complete synthetic report reconciles trade commission totals', () => {
  const data = parseIbkrReport(completeReport);
  near(data.tradeSummary.totalCommissions, 2.35);
  near(data.monthlySummary[0].net, 19.75);
  near(data.dailyTradeStats.reduce((sum, row) => sum + row.commissions, 0), 2.35);
  assert.deepEqual(data.warnings, []);
});

test('Chinese Activity Statement fields normalize into the existing analytics model', () => {
  const data = parseIbkrReport(chineseReport);
  assert.equal(data.accountInfo.account, 'U00000000');
  assert.equal(data.accountInfo.name, '测试用户');
  assert.equal(data.accountInfo.baseCurrency, 'USD');
  assert.equal(data.accountInfo.period, 'January 2026');
  near(data.nav.cash, 900);
  near(data.nav.total, 2000);
  near(data.nav.rateOfReturn, 10);
  near(data.exchangeRates.HKD, 0.128);
  assert.equal(data.positions.length, 1);
  assert.equal(data.positions[0].symbol, 'ABC');
  near(data.positions[0].baseDividends, 10);
  assert.equal(data.tradeSummary.orderCount, 2);
  near(data.tradeSummary.totalCommissions, 1.35);
  near(data.tradeDetails[1].baseCommission, -0.35);
  near(data.tradeDetails[1].baseMtmPL, 2.1);
  near(data.plSummary.total.total, 118);
  near(data.monthlySummary[0].net, 19.77);
  assert.equal(data.navChange.find((row) => row.key === 'stockGrantActivity').value, 5);
  assert.equal(data.navChange.find((row) => row.key === 'changeInDividendAccruals').value, 2);
  assert.deepEqual(data.warnings, []);
  assert.ok(data.sectionStats['Account Information'] > 0);
  assert.ok(data.sectionStats.Trades > 0);
});

test('bundled reports still parse', () => {
  for (const file of ['ibkr-sample-demo.csv', 'ibkr-sample-9999.csv']) {
    const data = parseIbkrReport(readFileSync(new URL('../samples/' + file, import.meta.url), 'utf8'));
    assert.equal(data.positions.length, 10);
    assert.equal(data.tradeSummary.orderCount, 109);
  }
});

test('report dates preserve source generation time and parse explicit Chinese and English endpoints', () => {
  for (const period of [
    '一月 1, 2026 - 九月 23, 2026',
    'January 1, 2026 - September 23, 2026',
    '2026-01-01 - 2026-09-23',
    '2026年1月1日 至 2026年9月23日'
  ]) {
    const csv = account + 'Statement,Header,Field Name,Field Value\n' +
      `Statement,Data,Period,"${period}"\n` +
      'Statement,Data,WhenGenerated,"2026-09-24, 12:00:00 EDT"\n';
    const info = parseIbkrReport(csv).accountInfo;
    assert.equal(info.period, period);
    assert.equal(info.periodStart, '2026-01-01');
    assert.equal(info.periodEnd, '2026-09-23');
    assert.equal(info.reportGeneratedAt, '2026-09-24, 12:00:00 EDT');
  }
  for (const period of ['January 2026', 'February 30, 2026 - March 1, 2026', 'September 23, 2026 - January 1, 2026', '']) {
    const info = parseIbkrReport(account + `Statement,Header,Field Name,Field Value\nStatement,Data,Period,"${period}"\n`).accountInfo;
    assert.equal(info.periodStart, null);
    assert.equal(info.periodEnd, null);
    assert.equal(info.reportGeneratedAt, '');
  }
  const singleDay = parseIbkrReport(account + 'Statement,Header,Field Name,Field Value\nStatement,Data,Period,"September 23, 2026"\n').accountInfo;
  assert.equal(singleDay.periodStart, singleDay.periodEnd);
  assert.equal(singleDay.periodEnd, '2026-09-23');
});

test('instrument descriptions prefer the instrument section with position fallbacks and original cost prices', () => {
  const data = parseIbkrReport(account + [
    '金融产品信息,Header,资产分类,代码,描述,上市交易所,乘数,代码',
    '金融产品信息,Data,股票,ABC,Instrument name,NASDAQ,1,',
    '金融产品信息,Data,股票,XYZ,,NYSE,1,',
    '净股票持仓总结,Header,资产分类,货币,代码,描述,净股份',
    '净股票持仓总结,Data,股票,USD,ABC,Fallback name,10',
    '净股票持仓总结,Data,股票,USD,XYZ,Fallback XYZ,5',
    '净股票持仓总结,Data,股票,USD,DEF,Position only,2',
    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数,成本价格,成本基础,收盘价格,价值,未实现的损益,代码',
    '未平仓持仓,Data,Summary,股票,USD,ABC,10,1,100.125,1002.25,110,1100,97.75,',
    '未平仓持仓,Data,Summary,股票,USD,XYZ,5,1,,500,110,550,50,'
  ].join('\n'));
  assert.deepEqual(data.instruments, [
    { symbol: 'ABC', name: 'Instrument name', assetCategory: 'Stocks', exchange: 'NASDAQ', multiplier: 1 },
    { symbol: 'XYZ', name: 'Fallback XYZ', assetCategory: 'Stocks', exchange: 'NYSE', multiplier: 1 },
    { symbol: 'DEF', name: 'Position only', assetCategory: 'Stocks', exchange: '', multiplier: null }
  ]);
  assert.equal(data.positions.find((row) => row.symbol === 'ABC').costPrice, 100.125);
  assert.equal(data.positions.find((row) => row.symbol === 'XYZ').costPrice, null);
  assert.equal(parseIbkrReport(completeReport).positions[0].costPrice, null);
});

test('cash records include only dated details, preserve signs and do not double-count section totals', () => {
  const data = parseIbkrReport(account + rates + [
    '存款和取款,Header,货币,结算日期,描述,金额',
    '存款和取款,Data,USD,2026-01-01,Deposit,1000',
    '存款和取款,Data,HKD,2026-01-02,Withdrawal,-100',
    '存款和取款,Data,总数,,Summary,900',
    '存款和取款,Data,总数 USD,2026-01-02,Dated summary,900',
    '存款和取款,Data,USD,2026-01-03,Missing amount,',
    'Fees,Header,Currency,Date,Description,Amount',
    'Fees,Data,USD,2026-01-03,Other fee,-1',
    'Interest,Header,Currency,Date,Description,Amount',
    'Interest,Data,USD,2026-01-04,Interest,0',
    'Dividends,Header,Currency,Date,Description,Amount',
    'Dividends,Data,USD,2026-01-05,ABC(US000000) Cash Dividend USD 1 per Share,10',
    '代扣税,Header,货币,日期,描述,金额,代码',
    '代扣税,Data,USD,2026-01-05,Dividend tax,-1.5,',
    '代扣税,Data,总数,,Tax total,-1.5,'
  ].join('\n'));
  assert.equal(data.cashTransactions.length, 6);
  assert.deepEqual(data.cashTransactions.map((row) => row.type), ['deposit', 'withdrawal', 'fee', 'interest', 'dividend', 'withholdingTax']);
  assert.equal(data.cashTransactions[0].date, '2026-01-01');
  assert.equal(data.cashTransactions[0].dateTime, undefined);
  assert.equal(data.cashTransactions[1].amount, -100);
  near(data.cashTransactions[1].baseAmount, -12.8);
  assert.equal(data.cashTransactions[3].baseAmount, 0);
  assert.equal(data.cashTransactions[5].baseAmount, -1.5);
  assert.equal(data.dividendIncome.total, 10);
});

test('optional cash detail without an exchange rate keeps original currency and an unknown converted amount', () => {
  const data = parseIbkrReport(account + 'Deposits & Withdrawals,Header,Currency,Date/Time,Description,Amount\n' +
    'Deposits & Withdrawals,Data,HKD,"2026-01-01, 12:30:00",Deposit,100\n');
  assert.equal(data.cashTransactions[0].currency, 'HKD');
  assert.equal(data.cashTransactions[0].amount, 100);
  assert.equal(data.cashTransactions[0].baseAmount, null);
  assert.equal(data.cashTransactions[0].date, '2026-01-01');
  assert.ok(data.cashTransactions[0].dateTime);
});

test('NAV metadata distinguishes unavailable fields from actual zero and recognizes additional Chinese aliases', () => {
  const absent = parseIbkrReport(account);
  assert.deepEqual(absent.navDetails, { hasNav: false, hasCash: false, hasReturn: false, hasChange: false, changeKeys: [] });
  assert.equal(absent.nav.total, 0); // Existing output remains compatible.
  const data = parseIbkrReport(account + [
    '净资产值,Header,资产类型,当前合计',
    '净资产值,Data,总数,0',
    '净资产值,Header,时间加权的收益率',
    '净资产值,Data,0%',
    '净资产值变更,Header,域名称,域值',
    '净资产值变更,Data,开始价值,0',
    '净资产值变更,Data,应计利息变更,95.5',
    '净资产值变更,Data,其它外汇换算,-0.01',
    '净资产值变更,Data,佣金,--',
    '净资产值变更,Data,股息,',
    '净资产值变更,Data,结束价值,95.49'
  ].join('\n'));
  assert.deepEqual(data.navDetails, {
    hasNav: true, hasCash: false, hasReturn: true, hasChange: true,
    changeKeys: ['startingValue', 'changeInInterestAccruals', 'otherFXTranslations', 'endingValue']
  });
  near(data.navChange.find((row) => row.key === 'changeInInterestAccruals').value, 95.5);
  near(data.navChange.find((row) => row.key === 'otherFXTranslations').value, -0.01);
});

test('NAV cash presence distinguishes missing or invalid cash from zero and negative balances', () => {
  for (const value of ['', '--', 'not a number']) {
    const data = parseIbkrReport(account +
      'Net Asset Value,Header,Asset Class,Current Total\nNet Asset Value,Data,Cash,' + value + '\n');
    assert.equal(data.navDetails.hasCash, false);
    assert.equal(data.nav.cash, 0);
  }
  for (const value of [0, 125.5, -250]) {
    for (const column of ['Current Total', 'Total']) {
      const data = parseIbkrReport(account +
        `Net Asset Value,Header,Asset Class,${column}\nNet Asset Value,Data,Cash,${value}\n`);
      assert.equal(data.navDetails.hasCash, true);
      assert.equal(data.nav.cash, value);
    }
  }
  assert.equal(parseIbkrReport(chineseReport).navDetails.hasCash, true);
  assert.equal(parseIbkrReport(chineseReport).nav.cash, 900);
});

test('trade raw time is retained without changing the existing timestamp or counting subtotals', () => {
  const csv = account + stockRoundTrip +
    'Trades,SubTotal,,Stocks,USD,ABC,,0,,20,-2,0,18,0,\n' +
    'Trades,Total,,Stocks,USD,,,0,,20,-2,0,18,0,\n';
  const data = parseIbkrReport(csv);
  assert.equal(data.tradeDetails.length, 2);
  assert.equal(data.tradeDetails[0].dateTimeText, '2026-01-02, 12:00:00');
  assert.equal(data.tradeDetails[0].dateTime, new Date(2026, 0, 2, 12, 0, 0).toISOString());
  near(data.tradeSummary.realizedPL, 18);
});
