// Presentation adapters only. CSV parsing and currency conversion remain in parser.js.
const RANGE_LABELS = { month: '本月', '1m': '近 1 月', '6m': '近 6 月', year: '本年', '1y': '近 1 年', all: '全部' };
const CASH_TITLES = {
  deposit: '资金存入', withdrawal: '资金取出', fee: '其他费用', interest: '利息',
  dividend: '股息', withholdingTax: '代扣税款'
};

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nullable = value => finite(value) ? value : null;
const category = value => value === 'Equity and Index Options' ? 'Options' : value;
const pad = value => String(value).padStart(2, '0');

function dateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ,])/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;
  return `${year}-${month}-${day}`;
}

function dateParts(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function previousMonths(value, count) {
  const { year, month, day } = dateParts(value);
  const target = new Date(Date.UTC(year, month - 1 - count, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

export function reportRange(data) {
  let start = dateKey(data?.accountInfo?.periodStart);
  let end = dateKey(data?.accountInfo?.periodEnd);
  let source = 'report';
  if (!start || !end || start > end) {
    const tradeDates = (data?.tradeDetails || []).map(row => dateKey(row.date)).filter(Boolean);
    const cashDates = (data?.cashTransactions || []).map(row => dateKey(row.date)).filter(Boolean);
    const dates = [...tradeDates, ...cashDates].sort();
    start = dates[0] || null;
    end = dates.at(-1) || null;
    source = dates.length ? (cashDates.length ? 'data' : 'trades') : 'unknown';
  }
  const { year, month } = end ? dateParts(end) : { year: null, month: null };
  return { start, end, year, month, source };
}

export function selectRange(data, key = 'year') {
  const report = reportRange(data);
  const selectedKey = Object.hasOwn(RANGE_LABELS, key) ? key : 'year';
  if (!report.end) return { start: null, end: null, isFull: false, label: RANGE_LABELS[selectedKey], partialCoverage: false };
  let start = report.start;
  if (selectedKey === 'month') start = `${report.year}-${pad(report.month)}-01`;
  if (selectedKey === 'year') start = `${report.year}-01-01`;
  if (selectedKey === '1m') start = previousMonths(report.end, 1);
  if (selectedKey === '6m') start = previousMonths(report.end, 6);
  if (selectedKey === '1y') start = previousMonths(report.end, 12);
  return {
    start, end: report.end, isFull: start <= report.start,
    label: RANGE_LABELS[selectedKey], partialCoverage: start < report.start
  };
}

export function instrumentFor(data, symbol, assetCategory) {
  const canonicalAsset = category(assetCategory);
  const instrument = (data?.instruments || []).find(row => row.symbol === symbol &&
    (!canonicalAsset || category(row.assetCategory) === canonicalAsset));
  return {
    name: instrument?.name || symbol || '', symbol: symbol || '',
    exchange: instrument?.exchange || '',
    assetCategory: canonicalAsset || category(instrument?.assetCategory) || ''
  };
}

export function filterTrades(data, range, filters = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase();
  const asset = category(filters.asset || 'all');
  const currency = filters.currency || 'all';
  const side = String(filters.side || 'all').toLowerCase();
  return (data?.tradeDetails || []).filter(row => {
    const date = dateKey(row.date);
    if (!date || (range?.start && date < range.start) || (range?.end && date > range.end)) return false;
    if (asset !== 'all' && category(row.assetCategory) !== asset) return false;
    if (currency !== 'all' && row.currency !== currency) return false;
    if (side !== 'all' && String(row.side || '').toLowerCase() !== side) return false;
    if (!query) return true;
    const instrument = instrumentFor(data, row.symbol, row.assetCategory);
    return `${row.symbol || ''} ${instrument.name}`.toLocaleLowerCase().includes(query);
  }).sort((left, right) => {
    const dayOrder = right.date.localeCompare(left.date);
    return dayOrder || String(right.dateTimeText || right.dateTime || '').localeCompare(String(left.dateTimeText || left.dateTime || ''));
  });
}

function realizedTrades(data, range, asset) {
  return filterTrades(data, range, { asset }).filter(row =>
    ['Stocks', 'Options'].includes(category(row.assetCategory)) && finite(row.baseRealizedPL));
}

export function dailyRealized(data, range, asset = 'all') {
  const days = new Map();
  for (const row of realizedTrades(data, range, asset)) {
    const date = dateKey(row.date);
    const day = days.get(date) || { date, value: 0, count: 0 };
    day.value += row.baseRealizedPL;
    day.count += 1;
    days.set(date, day);
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function rankRealized(data, range, asset = 'all') {
  const instruments = new Map();
  for (const trade of realizedTrades(data, range, asset)) {
    const assetCategory = category(trade.assetCategory);
    const key = JSON.stringify([assetCategory, trade.symbol]);
    const row = instruments.get(key) || {
      symbol: trade.symbol, name: instrumentFor(data, trade.symbol, assetCategory).name,
      assetCategory, value: 0, count: 0, currency: data?.baseCurrency || data?.accountInfo?.baseCurrency || ''
    };
    row.value += trade.baseRealizedPL;
    row.count += 1;
    instruments.set(key, row);
  }
  return [...instruments.values()].sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol));
}

export function cashRecords(data) {
  const records = [];
  for (const [tradeIndex, trade] of (data?.tradeDetails || []).entries()) {
    const date = dateKey(trade.date);
    if (!date) continue;
    const isSell = String(trade.side).toLowerCase() === 'sell';
    const direction = isSell ? '卖出' : '买入';
    const assetLabel = { Stocks: '股票', Options: '期权', Forex: '外汇' }[category(trade.assetCategory)] || '证券';
    const common = {
      date, dateTimeText: trade.dateTimeText || date, symbol: trade.symbol || '',
      quantity: nullable(trade.quantity), tradeIndex, description: instrumentFor(data, trade.symbol, trade.assetCategory).name
    };
    if (finite(trade.proceeds) && trade.proceeds !== 0) {
      records.push({
        ...common, id: `trade-${tradeIndex}-proceeds`, type: isSell ? 'sell' : 'buy',
        title: `${assetLabel}${direction}成交`, currency: trade.currency || '',
        amount: trade.proceeds, baseAmount: nullable(trade.baseProceeds)
      });
    }
    if (finite(trade.commission) && trade.commission !== 0) {
      records.push({
        ...common, id: `trade-${tradeIndex}-commission`, type: 'commission',
        title: `${assetLabel}${direction}手续费`, currency: trade.commissionCurrency || trade.currency || '',
        amount: trade.commission, baseAmount: nullable(trade.baseCommission)
      });
    }
  }
  for (const [index, row] of (data?.cashTransactions || []).entries()) {
    const date = dateKey(row.date);
    if (!date || !finite(row.amount)) continue;
    records.push({
      id: `cash-${index}`, date, dateTimeText: row.dateTimeText || row.dateTime || date,
      type: row.type, title: CASH_TITLES[row.type] || '其他资金变动', symbol: row.symbol || '',
      quantity: null, currency: row.currency || '', amount: row.amount,
      baseAmount: nullable(row.baseAmount), tradeIndex: null, description: row.description || ''
    });
  }
  return records.sort((left, right) => right.date.localeCompare(left.date) || right.dateTimeText.localeCompare(left.dateTimeText));
}

export function assetBridge(data) {
  // Old parser output filled absent rows with zero. Only explicit presence metadata is authoritative.
  const present = new Set(data?.navDetails?.changeKeys || []);
  const items = (data?.navChange || []).filter(row => present.has(row.key) && finite(row.value)).map(row => ({ ...row }));
  const values = new Map(items.map(row => [row.key, row.value]));
  const start = values.get('startingValue') ?? null;
  const end = values.get('endingValue') ?? null;
  const cashIn = values.get('depositsAndWithdrawals') ?? null;
  const stockIn = values.get('stockGrantActivity') ?? null;
  const netIn = cashIn !== null || stockIn !== null ? (cashIn ?? 0) + (stockIn ?? 0) : null;
  const available = start !== null && end !== null;
  const profit = available && cashIn !== null ? end - start - netIn : null;
  const changes = items.filter(row => !['startingValue', 'endingValue'].includes(row.key));
  const reconciliation = available && changes.length ? end - start - changes.reduce((sum, row) => sum + row.value, 0) : null;
  const navTotal = data?.navDetails?.hasNav ? nullable(data?.nav?.total) : null;
  return { start, end, netIn, cashIn, stockIn, profit, navTotal, reconciliation, available, items };
}

export function holdingTotals(data) {
  // Presence metadata distinguishes an omitted section from an explicitly empty one.
  // The parser's legacy missingPositions warning also covers an empty section.
  const missingSection = data?.sectionStats
    ? !Object.hasOwn(data.sectionStats, 'Open Positions')
    : data?.warnings?.includes('missingPositions');
  if (!Array.isArray(data?.positions) || missingSection) return { value: null, unrealized: null, grossValue: null };
  const positions = data.positions;
  function sum(field, absolute = false) {
    if (positions.some(row => !finite(row[field]))) return null;
    return positions.reduce((total, row) => total + (absolute ? Math.abs(row[field]) : row[field]), 0);
  }
  return { value: sum('baseValue'), unrealized: sum('baseUnrealizedPL'), grossValue: sum('baseValue', true) };
}

export function holdingDistribution(data) {
  const cash = data?.navDetails?.hasCash ? nullable(data?.nav?.cash) : null;
  const positions = data?.positions || [];
  const hasShort = cash < 0 || positions.some(row => row.baseValue < 0 || row.quantity < 0);
  const totals = holdingTotals(data);
  if (!finite(totals.grossValue)) return { items: [], total: null, cash, hasShort };

  const sorted = [...positions].sort((left, right) =>
    Math.abs(right.baseValue) - Math.abs(left.baseValue) || String(left.symbol || '').localeCompare(String(right.symbol || '')));
  const items = sorted.slice(0, 5).map(row => {
    const instrument = instrumentFor(data, row.symbol, row.assetCategory);
    return {
      kind: 'security', symbol: instrument.symbol, name: instrument.name,
      assetCategory: instrument.assetCategory, value: row.baseValue, grossValue: Math.abs(row.baseValue)
    };
  });
  if (sorted.length > 5) {
    const rest = sorted.slice(5);
    items.push({
      kind: 'other', name: '其他',
      value: rest.reduce((sum, row) => sum + row.baseValue, 0),
      grossValue: rest.reduce((sum, row) => sum + Math.abs(row.baseValue), 0)
    });
  }
  if (cash !== null) items.push({ kind: 'cash', name: '现金', value: cash, grossValue: Math.abs(cash) });
  const total = totals.grossValue + Math.abs(cash ?? 0);
  return {
    items: items.map(item => ({ ...item, weight: total > 0 ? item.grossValue / total : 0 })),
    total, cash, hasShort
  };
}
