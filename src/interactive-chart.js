import { buildRealizedSeries, chartIndexAtX, chartIndexForKey } from './chart-model.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const format = (value, digits = 2) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signed = value => (value > 0 ? '+' : '') + format(value);
const tone = value => value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
const dateLabel = date => `${date.replaceAll('-', '/')} 星期${'日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;

// Only the inspector changes during a gesture; the dashboard is never re-rendered.
export function createRealizedChart({ days, range, base = null, currency, selectedDate = null, mobile = false, onSelect = () => {} }) {
  const series = buildRealizedSeries(days, range, base);
  if (!series.length) return null;
  const percent = Number.isFinite(base) && base > 0;
  const unit = percent ? '%' : currency;
  const valueOf = point => percent ? point.cumulativePercent : point.cumulative;
  const dailyOf = point => percent ? point.dailyPercent : point.daily;
  const width = mobile ? 420 : 920, height = mobile ? 250 : 280;
  const left = 8, right = mobile ? 74 : 98, top = 18, bottom = 30;
  const plotWidth = width - left - right;
  const values = series.map(valueOf);
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  const pad = (max - min || 1) * .15;
  min -= pad; max += pad;
  const x = index => left + index / Math.max(1, series.length - 1) * plotWidth;
  const y = value => top + (max - value) / (max - min) * (height - top - bottom);
  const line = series.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(valueOf(point)).toFixed(2)}`).join(' ');
  const area = `${line} L${x(series.length - 1)},${height - bottom} L${left},${height - bottom}Z`;
  const ticks = Array.from({ length: 5 }, (_, index) => max - (max - min) * index / 4);
  const display = value => `${signed(value)}${percent ? '%' : ''}`;
  const html = `<div class="chart-wrap interactive-chart" data-realized-chart>
    <div class="chart-inspection">
      <div class="chart-tooltip" hidden aria-hidden="true">
        <div class="chart-tooltip-head"><time data-chart-date></time><span>当日</span><span>累计</span></div>
        <div class="chart-tooltip-values"><span class="chart-series-label"><i class="legend-dot"></i>我的已实现盈亏</span><strong data-chart-daily></strong><strong data-chart-total></strong></div>
        <p class="chart-day-note" data-chart-note></p>
      </div>
    </div>
    <div class="chart-surface" role="slider" tabindex="0" aria-label="按日期查看已实现盈亏" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="${series.length - 1}" aria-valuenow="${series.length - 1}" aria-describedby="chart-instructions">
      <svg class="line-chart" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <defs><linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff5900" stop-opacity=".23"/><stop offset="100%" stop-color="#ff5900" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map(value => `<line class="chart-grid" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/><text class="chart-label" x="${width - right + 12}" y="${y(value) + 4}">${format(value, percent ? 2 : 0)}${percent ? '%' : ''}</text>`).join('')}
        <path class="chart-area" d="${area}" fill="url(#profitFill)" stroke="none"/>
        <path class="chart-line" d="${line}"/>
        ${series.length === 1 ? `<circle class="chart-single-point" cx="${left}" cy="${y(values[0])}" r="3"/>` : ''}
        <g class="chart-selection" hidden><line class="chart-crosshair" y1="${top}" y2="${height - bottom}"/><circle class="chart-selected-point" r="4.5"/></g>
        <text class="chart-label" x="${left}" y="${height - 3}">${range.start.replaceAll('-', '/')}</text>
        ${series.length > 1 ? `<text class="chart-label" x="${width - right}" y="${height - 3}" text-anchor="end">${range.end.replaceAll('-', '/')}</text>` : ''}
      </svg>
    </div>
    <span class="sr-only" id="chart-instructions">左右方向键逐日查看，Home 到首日，End 到末日，Escape 关闭提示。金额单位 ${escapeHtml(unit)}。</span>
  </div>`;

  function mount(root) {
    if (!root) return;
    const surface = root.querySelector('.chart-surface');
    const svg = root.querySelector('svg');
    const tooltip = root.querySelector('.chart-tooltip');
    const selection = root.querySelector('.chart-selection');
    const crosshair = root.querySelector('.chart-crosshair');
    const dot = root.querySelector('.chart-selected-point');
    const date = root.querySelector('[data-chart-date]');
    const daily = root.querySelector('[data-chart-daily]');
    const total = root.querySelector('[data-chart-total]');
    const note = root.querySelector('[data-chart-note]');
    let index = selectedDate ? series.findIndex(point => point.date >= selectedDate) : series.length - 1;
    if (index < 0) index = series.length - 1;
    let pinned = Boolean(selectedDate), pointer = null;

    function describe(point) {
      return `${dateLabel(point.date)}，当日已实现盈亏 ${display(dailyOf(point))}，区间累计已实现盈亏 ${display(valueOf(point))}${percent ? '' : ` ${currency}`}`;
    }
    function show(next) {
      index = next;
      const point = series[index];
      date.textContent = dateLabel(point.date);
      date.setAttribute('datetime', point.date);
      daily.textContent = display(dailyOf(point));
      daily.className = tone(dailyOf(point));
      total.textContent = display(valueOf(point));
      total.className = tone(valueOf(point));
      note.textContent = point.count ? (percent ? '占报表固定投入基数' : `金额 (${currency})`) : '当日无股票及期权成交，累计值沿用前日';
      tooltip.hidden = false;
      selection.removeAttribute('hidden');
      crosshair.setAttribute('x1', x(index));
      crosshair.setAttribute('x2', x(index));
      dot.setAttribute('cx', x(index));
      dot.setAttribute('cy', y(valueOf(point)));
      surface.setAttribute('aria-valuenow', index);
      surface.setAttribute('aria-valuetext', describe(point));
      onSelect(point.date);
    }
    function hide() {
      tooltip.hidden = true;
      selection.setAttribute('hidden', '');
      onSelect(null);
    }
    function atPointer(event) {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      const position = point.matrixTransform(matrix.inverse());
      const next = chartIndexAtX(position.x, left, plotWidth, series.length);
      if (next !== null) show(next);
    }
    surface.setAttribute('aria-valuetext', describe(series[index]));
    if (selectedDate) show(index);
    surface.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      pinned = true; pointer = event.pointerId;
      surface.dataset.inputMode = 'pointer';
      surface.focus({ preventScroll: true });
      surface.setPointerCapture(pointer);
      atPointer(event);
    });
    surface.addEventListener('pointermove', event => {
      if (pointer === event.pointerId || pointer === null && event.pointerType === 'mouse') atPointer(event);
    });
    surface.addEventListener('pointerup', event => {
      if (pointer !== event.pointerId) return;
      atPointer(event);
      if (surface.hasPointerCapture(pointer)) surface.releasePointerCapture(pointer);
      pointer = null;
    });
    surface.addEventListener('pointercancel', () => { pointer = null; });
    surface.addEventListener('lostpointercapture', () => { pointer = null; });
    surface.addEventListener('pointerleave', () => { if (pointer === null && !pinned) hide(); });
    surface.addEventListener('focus', () => show(index));
    surface.addEventListener('keydown', event => {
      surface.dataset.inputMode = 'keyboard';
      if (event.key === 'Escape') { event.preventDefault(); pinned = false; hide(); return; }
      const next = chartIndexForKey(event.key, index, series.length);
      if (next === null) return;
      event.preventDefault(); pinned = true; show(next);
    });
  }
  return { html, mount };
}
