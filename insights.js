// Leak Log - stage 7: the History / Insights tabs and the three charts.
//
// Loaded before app.js. It uses app.js's shared data and helpers (leaks,
// hourly weather, formatting) only when it's called, so the load order
// doesn't matter while the app runs. Everything is worked out on the phone
// and nothing is sent anywhere.
//
// The charts compare two groups of rainy hours (see buildModel): "leak" hours,
// which a logged leak covers, and "rainy" hours, with no leak. Hours with no
// rain are in neither group. Rainy hours count from the day tracking started;
// hours before that are unknown, so they're left out. A leak logged for an
// earlier time still counts: it's a leak, and its weather was fetched for this.

(() => {
  'use strict';

  const MIN_LEAKS_TO_COMPARE = 3;
  const RAINY_MM = 0.1; // an hour is "rainy" with at least this much rain in it
  const MIN_RAINY_HOURS = 10; // fewer rainy hours than this isn't enough to compare
  const LEAD_HOURS = 24; // timeline: hours shown before a leak starts
  const TRAIL_HOURS = 6; // ...and after it ends
  const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; // wind comes FROM these
  const RAIN_WINDOWS = [[1, 'This hour'], [6, 'Past 6 h'], [24, 'Past 24 h']];

  const state = {
    tab: 'history',
    switchId: 0,
    leakId: null, // leak shown in the timeline
    selected: null, // hour picked in the timeline (slot number)
    rainWindow: 6,
    refocus: null, // a control to put keyboard focus back on after a redraw
    sector: null, // direction picked in the wind rose
    tables: { timeline: false, compare: false, rose: false }, // "Show table" per chart
    signature: '', // what was last drawn, so unchanged data isn't redrawn
    model: null,
  };

  // ---------- Small helpers ----------

  // Builds an element. Text is always set as text, never as HTML.
  function make(ns, tag, attrs, kids) {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }
  const h = (tag, attrs, ...kids) => make(null, tag, attrs, kids);
  const s = (tag, attrs, ...kids) => make('http://www.w3.org/2000/svg', tag, attrs, kids);

  const count = (n) => n.toLocaleString('en-GB');
  const oneDecimal = (v) => v.toFixed(1);
  const whole = (v) => String(Math.round(v));
  const percent = (share) => `${Math.round(share * 100)}%`;

  // Quantile of a sorted list, by linear interpolation between neighbours.
  function quantile(sorted, q) {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  // Rounds up to a tidy axis maximum: 1, 2, 5, 10, 20, 50...
  function niceCeil(value) {
    const size = 10 ** Math.floor(Math.log10(value));
    const fraction = value / size;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * size;
  }

  // Bar with a rounded top (4 px) and a square base, as the chart guidance asks.
  function topRoundedBar(x, y, width, base, radius = 4) {
    const r = Math.min(radius, width / 2, base - y);
    return `M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}` +
           `Q${x + width} ${y} ${x + width} ${y + r}V${base}Z`;
  }

  // ---------- Tabs ----------

  const TAB_NAMES = ['history', 'insights'];

  function setTab(name) {
    if (name === state.tab || !TAB_NAMES.includes(name)) return;
    const outgoing = $(`panel-${state.tab}`);
    const incoming = $(`panel-${name}`);
    state.tab = name;
    document.body.dataset.tab = name; // the CSS slides the underline and fades the + button
    document.querySelectorAll('.tab').forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    const id = ++state.switchId; // a quick second tap supersedes the first
    animate(outgoing, 'fade-out', () => {
      if (id !== state.switchId) return;
      outgoing.hidden = true;
      incoming.hidden = false;
      if (name === 'insights') renderInsights();
      animate(incoming, 'fade-in', () => {});
    });
  }

  function onTabKey(event) {
    const steps = { ArrowRight: 1, ArrowLeft: -1 };
    let index = TAB_NAMES.indexOf(state.tab);
    if (Object.hasOwn(steps, event.key)) index = (index + steps[event.key] + TAB_NAMES.length) % TAB_NAMES.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = TAB_NAMES.length - 1;
    else return;
    event.preventDefault();
    setTab(TAB_NAMES[index]);
    $(`tab-${TAB_NAMES[index]}`).focus();
  }

  // ---------- The data the charts use ----------

  function buildModel() {
    const leaks = loadLeaks().sort((a, b) => b.from.localeCompare(a.from)); // newest first
    const trackedFrom = floorHour(Date.parse(trackingStartedAt())) + HOUR;
    const lastFinal = floorHour(Date.now()); // the hour still in progress is left out
    const leakAt = new Map(); // hour (ms) -> the leak covering it
    for (const leak of leaks) {
      const [first, last] = leakHours(leak);
      for (let t = first; t <= last; t += HOUR) leakAt.set(t, leak);
    }
    // Charts 2 and 3 compare two groups of rainy hours (rain in that hour is at
    // least RAINY_MM): "leak" hours, covered by a logged leak, and "rainy"
    // hours with no leak, from tracking start. Hours with no rain are in
    // neither group, including leak hours with no rain in that hour (e.g. the
    // quiet hours inside a long logged range); those are counted in leakNoRain
    // so the chart can say how many were left out.
    const rows = [];
    let leakNoRain = 0;
    for (const [key, rec] of hours) {
      const t = Date.parse(key);
      if (t > lastFinal) continue;
      if ([rec.rain, rec.wind_speed_10m, rec.wind_gusts_10m, rec.wind_direction_10m].some((v) => v == null)) continue;
      const rainy = rec.rain >= RAINY_MM;
      if (leakAt.has(t)) {
        if (rainy) rows.push({ t, rec, status: 'leak' });
        else leakNoRain++;
      } else if (rainy && t >= trackedFrom) {
        rows.push({ t, rec, status: 'rainy' });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    const leakRainy = rows.filter((row) => row.status === 'leak').length;
    return { leaks, leakAt, rows, leakRainy, rainyCount: rows.length - leakRainy, leakNoRain, trackedFrom, lastFinal };
  }

  // Rain over the hour and the ones before it, or null if any is missing.
  function windowRain(t, windowHours) {
    let total = 0;
    for (let k = 0; k < windowHours; k++) {
      const rec = hours.get(hourKey(t - k * HOUR));
      if (!rec || rec.rain == null) return null;
      total += rec.rain;
    }
    return total;
  }

  // Values for leak and rainy hours that have the whole rain window.
  function compareValues(model, windowHours) {
    const groups = { leak: { rain: [], wind: [], gust: [] }, rainy: { rain: [], wind: [], gust: [] } };
    for (const row of model.rows) {
      const rain = windowRain(row.t, windowHours);
      if (rain == null) continue;
      const group = groups[row.status];
      group.rain.push(rain);
      group.wind.push(row.rec.wind_speed_10m);
      group.gust.push(row.rec.wind_gusts_10m);
    }
    return groups;
  }

  function roseCounts(model) {
    const counts = { leak: Array(8).fill(0), rainy: Array(8).fill(0) };
    for (const row of model.rows) counts[row.status][Math.round(row.rec.wind_direction_10m / 45) % 8]++;
    return counts;
  }

  // ---------- Shared card parts ----------

  function cardShell(key, title, explain) {
    const card = h('section', { class: 'card insight-card', 'aria-labelledby': `${key}-title` });
    card.append(h('h2', { id: `${key}-title`, text: title }), h('p', { class: 'supporting', text: explain }));
    return card;
  }

  function emptyCard(title, text, button) {
    return h('section', { class: 'card insight-card' }, h('h2', { text: title }),
      h('p', { class: 'supporting', text }), button);
  }

  // Text for screen readers that describes a chart in words.
  function summaryNode(key, text) {
    return h('p', { class: 'sr-only', id: `${key}-summary`, text });
  }

  // "Show table" swaps a card's chart for a plain table of the same numbers.
  function addTableToggle(card, key, chartParts, tableBlock) {
    const button = h('button', { type: 'button', class: 'btn text table-toggle' });
    const apply = () => {
      const on = state.tables[key];
      chartParts.forEach((part) => { part.hidden = on; });
      tableBlock.hidden = !on;
      button.textContent = on ? 'Show chart' : 'Show table';
      button.setAttribute('aria-pressed', String(on));
    };
    button.addEventListener('click', () => {
      state.tables[key] = !state.tables[key];
      apply();
      animate(state.tables[key] ? tableBlock : chartParts[0], 'fade-in', () => {});
    });
    apply();
    card.append(tableBlock, h('div', { class: 'card-actions' }, button));
  }

  function table(caption, headers, rows) {
    return h('div', { class: 'table-scroll', role: 'region', 'aria-label': caption, tabindex: '0' },
      h('table', { class: 'data-table' },
        h('caption', { class: 'sr-only', text: caption }),
        h('thead', {}, h('tr', {}, ...headers.map((name) => h('th', { scope: 'col', text: name })))),
        h('tbody', {}, ...rows.map((row) => h('tr', {},
          ...row.map((cell, i) => (i === 0 ? h('th', { scope: 'row', text: String(cell) }) : h('td', { text: String(cell) }))))))));
  }

  const swatch = (kind) => h('span', { class: `swatch ${kind}`, 'aria-hidden': 'true' });
  function legend(...items) {
    return h('div', { class: 'legend' },
      ...items.map(([kind, label]) => h('span', { class: 'legend-item' }, swatch(kind), label)));
  }

  // ---------- Chart 1: around a leak ----------

  function timelineCard(model) {
    const leaks = model.leaks;
    if (!leaks.some((leak) => leak.id === state.leakId)) { state.leakId = leaks[0].id; state.selected = null; }
    const leak = leaks.find((l) => l.id === state.leakId);

    const card = cardShell('timeline', 'Around a leak',
      `The weather from ${LEAD_HOURS} hours before the leak starts to ${TRAIL_HOURS} hours after it ends.`);

    const select = h('select', { id: 'insight-leak', 'aria-label': 'Choose a leak' },
      ...leaks.map((l) => new Option(formatRange(l.from, l.to), l.id)));
    select.value = state.leakId;
    select.addEventListener('change', () => { state.leakId = select.value; state.selected = null; renderInsights(true); });

    const key = legend(['key-wind', 'Wind (mph)'], ['key-gust', 'Gust (mph)'], ['key-rain', 'Rain (mm per hour)'], ['leak', 'Leak hours']);
    const chart = h('div', { class: 'chart-block viz' });
    const readout = h('div', { class: 'readout', 'aria-live': 'polite' });
    const stepper = h('div', { class: 'stepper' });
    const prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous hour', text: '‹' });
    const next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next hour', text: '›' });
    stepper.append(prev, readout, next);

    const [first, last] = leakHours(leak);
    const start = first - LEAD_HOURS * HOUR;
    const slots = [];
    for (let t = start; t <= last + TRAIL_HOURS * HOUR; t += HOUR) slots.push({ t, rec: hours.get(hourKey(t)) ?? null });
    const withWeather = slots.filter((slot) => slot.rec && slot.rec.rain != null);
    const duringLeak = withWeather.filter((slot) => slot.t >= first && slot.t <= last);
    const missing = slots.length - withWeather.length;

    card.append(h('div', { class: 'field select-field' }, h('span', { text: 'Leak' }), select),
      h('p', { class: 'sample', text: missing
        ? `Weather for ${plural(missing, 'of these hour')} isn't in yet.`
        : `${plural(slots.length, 'hour')} of weather.` }),
      key, chart, stepper);

    const peakGust = duringLeak.reduce((max, slot) => Math.max(max, slot.rec.wind_gusts_10m ?? 0), 0);
    const totalRain = duringLeak.reduce((sum, slot) => sum + slot.rec.rain, 0);
    card.append(summaryNode('timeline', `Weather around the leak on ${formatRange(leak.from, leak.to)}. ` +
      (duringLeak.length ? `During the leak, ${oneDecimal(totalRain)} millimetres of rain and a strongest gust of ${whole(peakGust)} miles per hour. ` : '') +
      'Use the previous and next buttons, or the table, to read each hour.'));

    const tableBlock = table(`Hourly weather around the leak on ${formatRange(leak.from, leak.to)}`,
      ['Hour (UK time)', 'Leak or no leak', 'Rain (mm)', 'Wind (mph)', 'Gust (mph)', 'Wind from'],
      slots.filter((slot) => slot.rec).map((slot) => [
        `${formatDay(new Date(slot.t - HOUR))}, ${ukHour(slot.t - HOUR)}–${ukHour(slot.t)}`,
        model.leakAt.has(slot.t) ? 'Leak' : 'No leak',
        oneDecimal(slot.rec.rain ?? 0), whole(slot.rec.wind_speed_10m ?? 0),
        whole(slot.rec.wind_gusts_10m ?? 0), compassPoint(slot.rec.wind_direction_10m ?? 0),
      ]));
    tableBlock.classList.add('table-block');
    addTableToggle(card, 'timeline', [key, chart, stepper], tableBlock);

    // Drawn once the card is on the page, so it can use the real width.
    const draw = () => {
      const picker = drawTimeline(chart, model, slots, first, last, Math.round(chart.clientWidth) || 320, (i) => showHour(i));
      function showHour(i) {
        state.selected = i;
        picker.highlight(i);
        const slot = slots[i];
        const rec = slot.rec;
        readout.replaceChildren(...[h('strong', {}, `${formatDay(new Date(slot.t - HOUR))}, ${ukHour(slot.t - HOUR)}–${ukHour(slot.t)}`),
          h('span', { class: `status ${model.leakAt.has(slot.t) ? 'leak' : 'noleak'}` },
            swatch(model.leakAt.has(slot.t) ? 'leak' : 'noleak'), model.leakAt.has(slot.t) ? 'Leak hour' : 'No-leak hour'),
          rec && rec.rain != null
            ? h('div', { class: 'weather readout-values' },
              weatherPart('rain', `${oneDecimal(rec.rain)} mm`, `Rain ${oneDecimal(rec.rain)} mm`),
              weatherPart('wind', `${whole(rec.wind_speed_10m)} mph ${compassPoint(rec.wind_direction_10m)}`,
                `Wind ${whole(rec.wind_speed_10m)} mph from ${compassPoint(rec.wind_direction_10m)}`, rec.wind_direction_10m),
              weatherPart('gust', `${whole(rec.wind_gusts_10m)} mph`, `Gust ${whole(rec.wind_gusts_10m)} mph`))
            : h('span', { class: 'supporting', text: "Weather for this hour isn't in yet." }),
          slot.t > model.lastFinal ? h('span', { class: 'supporting', text: 'Still being updated.' }) : null].filter(Boolean));
        prev.disabled = i === 0;
        next.disabled = i === slots.length - 1;
      }
      prev.onclick = () => showHour(state.selected - 1);
      next.onclick = () => showHour(state.selected + 1);
      showHour(state.selected ?? LEAD_HOURS); // starts on the first leak hour
    };
    return { card, draw };
  }

  // Two stacked panels on one time axis (never two y-axes on one chart):
  // wind and gust lines on top, rain bars underneath.
  function drawTimeline(box, model, slots, first, last, width, onPick) {
    const margin = { left: 34, right: 6, top: 18 };
    const windH = 100;
    const rainH = 64;
    const gap = 20;
    const axisH = 40;
    const rainTop = margin.top + windH + gap;
    const height = rainTop + rainH + axisH;
    const n = slots.length;
    const step = (width - margin.left - margin.right) / n;
    const x = (i) => margin.left + i * step;
    const centre = (i) => x(i) + step / 2;

    const gusts = slots.map((slot) => slot.rec?.wind_gusts_10m ?? 0);
    const rains = slots.map((slot) => slot.rec?.rain ?? 0);
    const windMax = niceCeil(Math.max(...gusts, 5));
    const rainMax = niceCeil(Math.max(...rains, 1));
    const yWind = (v) => margin.top + windH - (v / windMax) * windH;
    const yRain = (v) => rainTop + rainH - (v / rainMax) * rainH;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart', 'aria-hidden': 'true' });

    // Gridlines and y-axis numbers.
    for (const [top, panelH, max, fmt] of [[margin.top, windH, windMax, whole], [rainTop, rainH, rainMax, (v) => String(v)]]) {
      for (const fraction of [0, 0.5, 1]) {
        const y = top + panelH - fraction * panelH;
        svg.append(s('line', { class: 'grid', x1: margin.left, x2: width - margin.right, y1: y, y2: y }),
          s('text', { x: margin.left - 6, y: y + 4, 'text-anchor': 'end', text: fmt(max * fraction) }));
      }
    }

    // The leak's logged hours, shaded in both panels, with a solid rule and a label.
    const iFirst = (first - slots[0].t) / HOUR;
    const bandX = x(iFirst);
    const bandW = ((last - first) / HOUR + 1) * step;
    for (const [top, panelH] of [[margin.top, windH], [rainTop, rainH]]) {
      svg.append(s('rect', { class: 'band', x: bandX, y: top, width: bandW, height: panelH }),
        s('line', { class: 'band-rule', x1: bandX, x2: bandX + bandW, y1: top, y2: top }));
    }
    svg.append(s('text', { class: 'band-label', x: Math.min(bandX + 4, width - margin.right - 30), y: margin.top + windH - 6, text: 'Leak' }));

    // Rain bars.
    const barGap = step > 6 ? 2 : 0;
    slots.forEach((slot, i) => {
      if (!slot.rec || !(slot.rec.rain > 0)) return;
      svg.append(s('path', { class: 'rain-bar grow-up', d: topRoundedBar(x(i) + barGap / 2, yRain(slot.rec.rain), Math.max(1, step - barGap), rainTop + rainH) }));
    });

    // Gust then wind lines, broken where hours are missing.
    const line = (field, className) => {
      let d = '';
      let drawing = false;
      slots.forEach((slot, i) => {
        const v = slot.rec?.[field];
        if (v == null) { drawing = false; return; }
        d += `${drawing ? 'L' : 'M'}${centre(i)} ${yWind(v)}`;
        drawing = true;
      });
      svg.append(s('path', { class: className, d }));
    };
    line('wind_gusts_10m', 'gust-line');
    line('wind_speed_10m', 'wind-line');

    // The strongest gust is labelled; everything else is read from the readout.
    const peak = gusts.indexOf(Math.max(...gusts));
    if (gusts[peak] > 0) {
      svg.append(s('circle', { class: 'peak-dot', cx: centre(peak), cy: yWind(gusts[peak]), r: 4 }),
        s('text', { class: 'peak-label', x: Math.max(margin.left + 16, Math.min(centre(peak), width - margin.right - 16)), y: yWind(gusts[peak]) - 9, 'text-anchor': 'middle', text: `Gust ${whole(gusts[peak])}` }));
    }

    // Time axis, in UK time: a label every six hours, and the date at midnight.
    let lastLabelX = -100;
    slots.forEach((slot, i) => {
      const label = ukHour(slot.t - HOUR);
      if (!['00:00', '06:00', '12:00', '18:00'].includes(label)) return;
      const lx = Math.max(margin.left + 14, Math.min(x(i), width - margin.right - 14));
      if (lx - lastLabelX < 34) return;
      lastLabelX = lx;
      svg.append(s('line', { class: 'grid', x1: x(i), x2: x(i), y1: rainTop + rainH, y2: rainTop + rainH + 4 }),
        s('text', { x: lx, y: rainTop + rainH + 18, 'text-anchor': 'middle', text: label }));
      if (label === '00:00') {
        svg.append(s('text', { x: lx, y: rainTop + rainH + 33, 'text-anchor': 'middle',
          text: new Date(slot.t - HOUR).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: UK_ZONE }) }));
      }
    });

    // The picked hour.
    const highlight = s('rect', { class: 'sel-slot', y: margin.top, height: rainTop + rainH - margin.top, width: Math.max(step, 3) });
    const dotWind = s('circle', { class: 'sel-dot wind', r: 4 });
    const dotGust = s('circle', { class: 'sel-dot gust', r: 4 });
    svg.append(highlight, dotWind, dotGust);

    const pick = (event) => {
      const rect = svg.getBoundingClientRect();
      const px = (event.clientX - rect.left) * (width / rect.width);
      onPick(Math.max(0, Math.min(n - 1, Math.floor((px - margin.left) / step))));
    };
    svg.addEventListener('pointerdown', (event) => { svg.setPointerCapture?.(event.pointerId); pick(event); });
    svg.addEventListener('pointermove', (event) => { if (event.buttons) pick(event); });

    box.replaceChildren(svg);
    return {
      highlight(i) {
        highlight.setAttribute('x', x(i) - (Math.max(step, 3) - step) / 2);
        const rec = slots[i].rec;
        for (const [dot, field] of [[dotWind, 'wind_speed_10m'], [dotGust, 'wind_gusts_10m']]) {
          dot.toggleAttribute('hidden', rec?.[field] == null);
          if (rec?.[field] != null) { dot.setAttribute('cx', centre(i)); dot.setAttribute('cy', yWind(rec[field])); }
          dot.style.display = rec?.[field] == null ? 'none' : '';
        }
      },
    };
  }

  // ---------- Charts 2 and 3: leak hours vs rainy hours ----------

  // Why these charts can't be drawn yet, or null if they can.
  function compareBlocker(model) {
    if (model.leaks.length < MIN_LEAKS_TO_COMPARE) return 'Log a few more leaks to compare them with rainy hours.';
    if (!model.leakRainy) return 'None of your leak hours had rain, so there is nothing to compare yet.';
    if (model.rainyCount < MIN_RAINY_HOURS) return 'Not enough rainy hours without a leak to compare yet.';
    return null;
  }

  // What the two groups are, and how many leak hours were left out for having
  // no rain in them.
  function groupNotes(model) {
    const notes = [h('p', { class: 'supporting small',
      text: `Leak hours: a leak was logged and it rained that hour. Rainy hours: no leak, and ${RAINY_MM} mm or more of rain that hour.` })];
    if (model.leakNoRain) {
      notes.push(h('p', { class: 'supporting small',
        text: `${plural(model.leakNoRain, 'more leak hour')} had no rain that hour and ${model.leakNoRain === 1 ? "isn't" : "aren't"} included.` }));
    }
    return notes;
  }

  function compareCard(model) {
    const card = cardShell('compare', 'Leak hours vs rainy hours',
      'The typical value (dot) and the middle half of values (bar), for rainy hours with a leak and without one. ' +
      'The data window changes whether the rain readings from before a leak was recorded are included, ' +
      'because leaks sometimes take a while to come through.');
    const blocked = compareBlocker(model);
    if (blocked) {
      card.append(h('p', { class: 'insight-note', text: blocked }));
      return { card };
    }
    const windowHours = state.rainWindow;
    const windowLabel = RAIN_WINDOWS.find(([n]) => n === windowHours)[1].toLowerCase();
    const groups = compareValues(model, windowHours);
    const kinds = ['leak', 'rainy'];
    const sample = h('p', { class: 'sample',
      text: `Based on ${plural(groups.leak.rain.length, 'leak hour')} and ${plural(groups.rainy.rain.length, 'rainy hour')}.` });

    const windowTitle = h('div', { class: 'control-title', id: 'data-window-title', text: 'Data window' });
    const control = h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'data-window-title' },
      ...RAIN_WINDOWS.map(([n, label]) => h('label', {},
        h('input', { type: 'radio', name: 'rain-window', value: String(n), checked: n === windowHours }), h('span', { text: label }))));
    control.addEventListener('change', (event) => {
      state.rainWindow = Number(event.target.value);
      state.refocus = `input[name="rain-window"][value="${state.rainWindow}"]`;
      renderInsights(true);
    });

    const measures = [
      ['rain', `Rain, ${windowLabel} (mm)`, 'mm', 1],
      ['wind', 'Wind speed (mph)', 'mph', 0],
      ['gust', 'Gust (mph)', 'mph', 0],
    ];
    const blocks = h('div', { class: 'compare-blocks' });
    const summary = [];
    const tableRows = [];
    for (const [field, title, unit, digits] of measures) {
      const stats = {};
      for (const kind of kinds) {
        const sorted = [...groups[kind][field]].sort((a, b) => a - b);
        stats[kind] = sorted.length
          ? { q1: quantile(sorted, 0.25), median: quantile(sorted, 0.5), q3: quantile(sorted, 0.75), n: sorted.length }
          : null;
      }
      const top = niceCeil(Math.max(0.5, ...kinds.map((kind) => stats[kind]?.q3 ?? 0)));
      const at = (v) => `${Math.min(100, Math.max(0, (v / top) * 100))}%`;
      const rows = kinds.map((kind) => {
        const st = stats[kind];
        const label = h('span', { class: 'range-label' }, swatch(kind), kind === 'leak' ? 'Leak' : 'Rainy');
        const track = h('div', { class: 'range-track' });
        const value = h('div', { class: 'range-value' });
        if (st) {
          track.append(
            h('span', { class: `range-bar ${kind} grow-right`, style: `left:${at(st.q1)};width:max(4px,calc(${at(st.q3)} - ${at(st.q1)}))` }),
            h('span', { class: `range-dot ${kind}`, style: `left:${at(st.median)}` }));
          value.append(h('strong', { text: `${st.median.toFixed(digits)} ${unit}` }),
            h('span', { text: `${st.q1.toFixed(digits)}–${st.q3.toFixed(digits)}` }));
          tableRows.push([title, kind === 'leak' ? 'Leak hours' : 'Rainy hours', st.median.toFixed(digits),
            st.q1.toFixed(digits), st.q3.toFixed(digits), count(st.n)]);
        } else {
          value.append(h('span', { text: 'No hours' }));
        }
        return h('div', { class: 'range-row' }, label, track, value);
      });
      summary.push(`${title}: ` + kinds.map((kind) => stats[kind]
        ? `${kind} hours typically ${stats[kind].median.toFixed(digits)} ${unit}`
        : `no ${kind} hours`).join(', ') + '.');
      blocks.append(h('div', { class: 'compare-block' },
        ...(field === 'rain' ? [windowTitle, control] : []),
        h('h3', { text: title }), ...rows,
        h('div', { class: 'range-axis' }, h('span', { text: '0' }), h('span', { text: `${top} ${unit}` }))));
    }

    const key = legend(['leak', 'Leak hours'], ['rainy', 'Rainy hours']);
    const chart = h('div', { class: 'chart-block' }, blocks);
    const tableBlock = table(`Leak hours vs rainy hours, rain ${windowLabel}`,
      ['Measure', 'Hours', 'Typical (median)', 'Lower quarter', 'Upper quarter', 'Number of hours'], tableRows);
    tableBlock.classList.add('table-block');
    card.append(sample, key, ...groupNotes(model), chart, summaryNode('compare', summary.join(' ')));
    addTableToggle(card, 'compare', [key, chart], tableBlock);
    return { card };
  }

  // ---------- Chart 3: wind direction ----------

  function roseCard(model) {
    const card = cardShell('rose', 'Wind direction',
      'Where the wind came from: the share of leak hours and of rainy hours for each direction.');
    const blocked = compareBlocker(model);
    if (blocked) {
      card.append(h('p', { class: 'insight-note', text: blocked }));
      return { card };
    }
    const counts = roseCounts(model);
    const totals = { leak: counts.leak.reduce((a, b) => a + b, 0), rainy: counts.rainy.reduce((a, b) => a + b, 0) };
    const share = (kind, k) => (totals[kind] ? counts[kind][k] / totals[kind] : 0);
    const best = (kind) => counts[kind].reduce((top, c, k) => (c > counts[kind][top] ? k : top), 0);
    const sentence = (k) => `${SECTORS[k]}: ${percent(share('leak', k))} of leak hours (${count(counts.leak[k])}) ` +
      `and ${percent(share('rainy', k))} of rainy hours (${count(counts.rainy[k])})`;

    const sample = h('p', { class: 'sample',
      text: `Based on ${plural(totals.leak, 'leak hour')} and ${plural(totals.rainy, 'rainy hour')}.` });
    const key = legend(['leak', 'Leak hours'], ['rainy', 'Rainy hours']);
    const chart = h('div', { class: 'chart-block viz rose' });
    const readout = h('p', { class: 'readout', 'aria-live': 'polite' });
    const tableBlock = table('Wind direction for leak hours and rainy hours',
      ['Wind from', 'Leak hours', 'Share of leak hours', 'Rainy hours', 'Share of rainy hours'],
      SECTORS.map((name, k) => [name, count(counts.leak[k]), percent(share('leak', k)),
        count(counts.rainy[k]), percent(share('rainy', k))]));
    tableBlock.classList.add('table-block');
    readout.textContent = `Most leak hours: wind from ${SECTORS[best('leak')]} (${percent(share('leak', best('leak')))}). ` +
      `Most rainy hours: ${SECTORS[best('rainy')]} (${percent(share('rainy', best('rainy')))}). Tap a direction for its numbers.`;

    const caption = h('p', { class: 'supporting small' });
    card.append(sample, key, ...groupNotes(model), chart, readout, caption,
      summaryNode('rose', `Wind direction. Most leak hours had wind from ${SECTORS[best('leak')]}, ${percent(share('leak', best('leak')))} of them. ` +
        `${SECTORS.map((_, k) => sentence(k)).join('. ')}.`));
    addTableToggle(card, 'rose', [key, chart, readout, caption], tableBlock);

    const draw = () => {
      const size = Math.min(Math.round(chart.clientWidth) || 300, 340);
      const centreX = size / 2;
      const radius = size / 2 - 34; // room for the direction letters
      const maxShare = Math.max(0.05, ...SECTORS.flatMap((_, k) => [share('leak', k), share('rainy', k)]));
      const ringMax = Math.max(0.2, Math.ceil(maxShare / 0.1) * 0.1); // outer ring, in steps of 10%
      caption.textContent = `Rings mark ${percent(ringMax / 2)} and ${percent(ringMax)} of hours, from the centre out. ` +
        'Wind direction is where the wind blows from.';
      const point = (angle, r) => [centreX + r * Math.sin((angle * Math.PI) / 180), centreX - r * Math.cos((angle * Math.PI) / 180)];
      const wedge = (from, to, r) => {
        const [x1, y1] = point(from, r);
        const [x2, y2] = point(to, r);
        return `M${centreX} ${centreX}L${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}Z`;
      };
      const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'chart' });
      for (const fraction of [0.5, 1]) svg.append(s('circle', { class: 'grid', cx: centreX, cy: centreX, r: radius * fraction, fill: 'none' }));
      for (let k = 0; k < 8; k++) svg.append(s('line', { class: 'grid', x1: centreX, y1: centreX, x2: point(k * 45, radius)[0], y2: point(k * 45, radius)[1] }));
      const selectedWash = s('path', { class: 'sel-slot', d: '', hidden: true });
      svg.append(selectedWash);
      SECTORS.forEach((name, k) => {
        const angle = k * 45;
        const rLeak = (share('leak', k) / ringMax) * radius;
        const rRainy = (share('rainy', k) / ringMax) * radius;
        if (rLeak > 0) svg.append(s('path', { class: 'wedge leak grow-out', d: wedge(angle - 19, angle - 1, rLeak), style: `transform-origin:${centreX}px ${centreX}px` }));
        if (rRainy > 0) svg.append(s('path', { class: 'wedge rainy grow-out', d: wedge(angle + 1, angle + 19, rRainy), style: `transform-origin:${centreX}px ${centreX}px` }));
        const [lx, ly] = point(angle, radius + 18);
        svg.append(s('text', { class: 'compass', x: lx, y: ly + 4, 'text-anchor': 'middle', text: name }));
      });
      // One big invisible target per direction: tap or focus it for its numbers.
      SECTORS.forEach((name, k) => {
        const hit = s('path', { class: 'hit', d: wedge(k * 45 - 22.5, k * 45 + 22.5, radius + 6), tabindex: '0', role: 'button', 'aria-label': sentence(k) });
        const choose = () => {
          state.sector = k;
          readout.textContent = sentence(k) + '.';
          selectedWash.setAttribute('d', wedge(k * 45 - 22.5, k * 45 + 22.5, radius + 6));
          selectedWash.removeAttribute('hidden');
        };
        hit.addEventListener('click', choose);
        hit.addEventListener('focus', choose);
        hit.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
        svg.append(hit);
      });
      chart.replaceChildren(svg);
    };
    return { card, draw };
  }

  // ---------- Putting it together ----------

  function renderInsights(force = false) {
    if (state.tab !== 'insights') return;
    const root = $('insights-content');
    const model = buildModel();
    const width = Math.round(root.clientWidth);
    const signature = JSON.stringify([model.leaks.map((l) => [l.id, l.from, l.to, l.updatedAt ?? '']),
      hours.size, model.lastFinal, !!loadLocation(), width, state.leakId, state.rainWindow]);
    if (!force && signature === state.signature) return;
    state.signature = signature;
    state.model = model;

    root.replaceChildren();
    const settingsButton = () => {
      const button = h('button', { type: 'button', class: 'btn filled', text: 'Set location' });
      button.addEventListener('click', openSettings);
      return button;
    };
    if (!model.leaks.length) {
      root.append(emptyCard('No leaks yet', 'Insights compare the weather during leaks with rainy hours without a leak. Log a leak to get started.'));
      return;
    }
    if (!loadLocation()) {
      root.append(emptyCard('Set your location', 'Insights need the weather at your flat, and that needs your location.', settingsButton()));
      return;
    }
    if (!hours.size) {
      root.append(emptyCard('Weather isn\'t in yet', navigator.onLine
        ? 'The weather is being fetched. Check back in a moment.'
        : 'The weather will be fetched when you\'re back online.'));
      return;
    }
    const cards = [timelineCard(model), compareCard(model), roseCard(model)];
    root.append(...cards.map(({ card }) => card));
    cards.forEach(({ draw }) => draw?.()); // charts that need the real width are drawn now it's on the page
    if (state.refocus) { // a control was used and the cards were rebuilt: keep keyboard focus on it
      root.querySelector(state.refocus)?.focus();
      state.refocus = null;
    }
  }

  function initInsights() {
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
    $('tablist').addEventListener('keydown', onTabKey);
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width && width !== lastWidth) { lastWidth = width; renderInsights(true); }
    }).observe($('panel-insights'));
  }

  window.initInsights = initInsights;
  window.renderInsights = renderInsights;
})();
