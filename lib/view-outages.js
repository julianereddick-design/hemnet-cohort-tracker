'use strict';

// lib/view-outages.js
//
// Known periods when a site's view counters were NOT captured, so the view charts
// can draw a labelled gap there instead of a line across it.
//
// The frozen readings themselves are nulled in cohort_daily_views (CHANGELOG
// 2026-11-03); every chart and report already skips a null reading. This list only
// adds what the data cannot say on its own: WHY the gap is there. Without it the
// charts' spanGaps would join the last point before the outage to the first one
// after, which reads as a measured line through days nobody measured.
//
// The counters are cumulative, so the views themselves are not lost: the first
// reading after an outage carries everything since the last good one. Only how
// they were spread across the outage days is unknown.
//
//   node lib/view-outages.js --smoke

const VIEW_OUTAGES = [
  // Hemnet moved to the Next.js App Router ~2026-10-30; every Hemnet read failed
  // until the fix on 2026-11-02, so the 31 Oct and 1 Nov readings were frozen at
  // their 29 Oct values. 3 Nov is the first good reading.
  { from: '2026-10-30', to: '2026-11-02', site: 'hemnet', label: 'Hemnet data outage, website change' },
];

const ms = (d) => Date.parse(`${d}T00:00:00Z`);

// Fractional label position of a calendar date on a chart whose x labels are
// `dates` (sorted YYYY-MM-DD). Category scales accept fractional values, so a
// date between two tracking readings lands proportionally between them.
function datePosition(dates, date) {
  const x = ms(date);
  if (x <= ms(dates[0])) return 0;
  for (let i = 1; i < dates.length; i++) {
    const a = ms(dates[i - 1]);
    const b = ms(dates[i]);
    if (x <= b) return i - 1 + (x - a) / (b - a);
  }
  return dates.length - 1;
}

// The outages that overlap the chart's date range, as label positions.
function outageBands(dates, outages = VIEW_OUTAGES) {
  if (!dates.length) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  return outages
    .filter(o => o.to >= first && o.from <= last)
    .map(o => ({ x0: datePosition(dates, o.from), x1: datePosition(dates, o.to), label: o.label }));
}

// Browser-side JS for a generated Chart.js page: a shaded, labelled band over each
// outage, and withOutageGaps(dataset), which hides any line segment that crosses
// one (segments elsewhere still span ordinary gaps as before). Register the plugin
// per chart: plugins: [viewOutagePlugin].
function outageChartJs(dates, outages = VIEW_OUTAGES) {
  return [
    `const VIEW_OUTAGE_BANDS = ${JSON.stringify(outageBands(dates, outages))};`,
    'const viewOutagePlugin = {',
    '  id: "viewOutages",',
    '  beforeDatasetsDraw: function (chart) {',
    '    const a = chart.chartArea, x = chart.scales.x, ctx = chart.ctx;',
    '    ctx.save();',
    '    VIEW_OUTAGE_BANDS.forEach(function (b) {',
    '      const x0 = x.getPixelForValue(b.x0), x1 = x.getPixelForValue(b.x1);',
    '      ctx.fillStyle = "rgba(0,0,0,0.07)";',
    '      ctx.fillRect(x0, a.top, Math.max(x1 - x0, 2), a.bottom - a.top);',
    '      ctx.fillStyle = "#666"; ctx.font = "11px Arial"; ctx.textAlign = "center";',
    '      ctx.fillText(b.label, (x0 + x1) / 2, a.top + 12);',
    '    });',
    '    ctx.restore();',
    '  }',
    '};',
    // With spanGaps, Chart.js styles a bridge over missing points piecewise, one
    // point-pair at a time, and draws it in a single style. So judge every piece by
    // the real points the bridge runs between, not by its own two (often missing) ends.
    'function withOutageGaps(ds) {',
    '  const has = function (i) { return ds.data[i] !== null && ds.data[i] !== undefined; };',
    '  ds.segment = { borderColor: function (c) {',
    '    let a = c.p0DataIndex, z = c.p1DataIndex;',
    '    while (a > 0 && !has(a)) a--;',
    '    while (z < ds.data.length - 1 && !has(z)) z++;',
    '    return VIEW_OUTAGE_BANDS.some(function (b) { return a <= b.x1 && z >= b.x0; })',
    '      ? "rgba(0,0,0,0)" : undefined;',
    '  } };',
    '  return ds;',
    '}',
  ].join('\n');
}

// Methodology bullet for the charts' notes, or '' when no outage is in range.
function outageNoteHtml(dates, outages = VIEW_OUTAGES) {
  const hits = outages.filter(o => dates.length && o.to >= dates[0] && o.from <= dates[dates.length - 1]);
  if (!hits.length) return '';
  const items = hits.map(o => `${o.label} (${o.from} to ${o.to})`).join('; ');
  return `<li><strong>Data outages (shaded):</strong> ${items}. Readings in that window were frozen and are left out, so the line breaks there instead of being drawn through it. The counters are cumulative, so no views are lost: the first point after the gap is measured against a good reading on each side.</li>`;
}

module.exports = { VIEW_OUTAGES, datePosition, outageBands, outageChartJs, outageNoteHtml };

// ---------------------------------------------------------------
//   node lib/view-outages.js --smoke
// ---------------------------------------------------------------
if (require.main === module && process.argv.includes('--smoke')) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { console.error(`SMOKE FAIL [${n}]: ${e.message}`); fail++; } };

  // The real tracking dates around the outage (odd days, so 31 Oct and 1 Nov are adjacent).
  const DATES = ['2026-10-27', '2026-10-29', '2026-10-31', '2026-11-01', '2026-11-03', '2026-11-05'];

  check('the outage band sits between the 29 Oct and 3 Nov readings', () => {
    const [b] = outageBands(DATES);
    assert.strictEqual(b.x0, 1.5, '30 Oct is halfway between 29 Oct (1) and 31 Oct (2)');
    assert.strictEqual(b.x1, 3.5, '2 Nov is halfway between 1 Nov (3) and 3 Nov (4)');
    assert.strictEqual(b.label, 'Hemnet data outage, website change');
  });

  check('no band, no note on a chart that ends before the outage', () => {
    const early = ['2026-09-01', '2026-09-03'];
    assert.deepStrictEqual(outageBands(early), []);
    assert.strictEqual(outageNoteHtml(early), '');
  });

  check('a chart that starts after the outage gets no band either', () => {
    assert.deepStrictEqual(outageBands(['2026-11-03', '2026-11-05']), []);
  });

  // Mirrors the browser segment test: the 29 Oct -> 5 Nov segment (spanning the nulled
  // readings) is hidden; the segments either side are drawn.
  check('only the segments that cross the outage are hidden', () => {
    const [b] = outageBands(DATES);
    const hidden = (p0, p1) => p0 <= b.x1 && p1 >= b.x0;
    assert.strictEqual(hidden(1, 5), true, '29 Oct -> 5 Nov crosses the outage');
    assert.strictEqual(hidden(0, 1), false, '27 -> 29 Oct is before it');
    assert.strictEqual(hidden(4, 5), false, '3 -> 5 Nov is after it');
  });

  check('the browser JS is self-contained and parses', () => {
    const js = outageChartJs(DATES);
    // eslint-disable-next-line no-new-func
    const out = new Function(`${js}; return { VIEW_OUTAGE_BANDS, viewOutagePlugin, withOutageGaps };`)();
    assert.strictEqual(out.VIEW_OUTAGE_BANDS.length, 1);
    assert.strictEqual(out.viewOutagePlugin.id, 'viewOutages');
    // Real points on 27 Oct, 29 Oct, 5 Nov; the outage readings and 3 Nov are blank.
    const ds = out.withOutageGaps({ label: 'x', data: [50, 52, null, null, null, 55] });
    const colour = (p0, p1) => ds.segment.borderColor({ p0DataIndex: p0, p1DataIndex: p1 });
    assert.strictEqual(colour(0, 1), undefined, '27 -> 29 Oct is drawn');
    assert.strictEqual(colour(1, 2), 'rgba(0,0,0,0)', 'the bridge from 29 Oct is hidden');
    // Chart.js asks about 3 Nov -> 5 Nov too, which lies past the band, but it is still
    // part of the 29 Oct -> 5 Nov bridge: hiding only the in-band pieces left it drawn.
    assert.strictEqual(colour(4, 5), 'rgba(0,0,0,0)', 'the tail of the same bridge is hidden too');
    const after = out.withOutageGaps({ label: 'y', data: [50, 52, null, null, 54, 55] });
    assert.strictEqual(after.segment.borderColor({ p0DataIndex: 4, p1DataIndex: 5 }), undefined, '3 -> 5 Nov, both real, is drawn');
  });

  check('the methodology note names the outage and its dates', () => {
    assert.match(outageNoteHtml(DATES), /Hemnet data outage, website change \(2026-10-30 to 2026-11-02\)/);
  });

  console.log(`smoke: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
