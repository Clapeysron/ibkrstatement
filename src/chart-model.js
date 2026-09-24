const DAY_MS = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validLength = length => Number.isInteger(length) && length > 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function utcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

// The caller supplies a range covered by the report and confirms that Trades exists.
// A missing trade day means zero realized trading P/L, not zero account P/L.
export function buildRealizedSeries(days, range, base = null) {
  const start = utcDay(range?.start);
  const end = utcDay(range?.end);
  if (start === null || end === null || start > end) return [];

  const byDay = new Map();
  for (const row of days || []) {
    const timestamp = utcDay(row.date);
    if (timestamp === null || timestamp < start || timestamp > end || !finite(row.value)) continue;
    const day = byDay.get(timestamp) || { value: 0, count: 0 };
    day.value += row.value;
    day.count += Number.isInteger(row.count) && row.count >= 0 ? row.count : 0;
    byDay.set(timestamp, day);
  }

  const hasBase = finite(base) && base > 0;
  const points = [];
  let cumulative = 0;
  for (let timestamp = start; timestamp <= end; timestamp += DAY_MS) {
    const row = byDay.get(timestamp);
    const daily = row?.value ?? 0;
    cumulative += daily;
    points.push({
      date: new Date(timestamp).toISOString().slice(0, 10),
      daily, cumulative,
      dailyPercent: hasBase ? daily / base * 100 : null,
      cumulativePercent: hasBase ? cumulative / base * 100 : null,
      count: row?.count ?? 0
    });
  }
  return points;
}

// Coordinates must share one system: CSS pixels or SVG viewBox units.
export function chartIndexAtX(x, left, width, length) {
  if (!validLength(length) || !finite(x) || !finite(left) || !finite(width) || width <= 0) return null;
  const fraction = clamp((x - left) / width, 0, 1);
  return Math.round(fraction * (length - 1));
}

export function chartIndexForKey(key, current, length) {
  if (!validLength(length)) return null;
  const index = finite(current) ? clamp(Math.round(current), 0, length - 1) : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(length - 1, index + 1);
  return null;
}
