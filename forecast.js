// Leak Log - stage 12: the Forecast card on History.
//
// Checks the next 24 hours of Met Office UKV forecast (via Open-Meteo) against
// the leaks logged so far, and says whether to put a bucket out. The rule is
// rain only: a forecast hour matches if it has at least as much rain as the
// lightest rain ever present in a leak hour. Rain is shown as a total, with
// wind and gusts as context; wind never changes the answer.
//
// Loaded before app.js. It uses app.js's shared data and helpers only when
// it's called, so the load order doesn't matter while the app runs. Only the
// latest forecast is kept (one key on the phone); it is never added to the
// stored hourly weather or the export.

(() => {
  'use strict';

  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const FORECAST_MODEL = 'ukmo_uk_deterministic_2km';
  const FORECAST_KEY = 'leakLog.forecast.v1';
  const ON_KEY = 'leakLog.forecastOn';
  const HOURS_AHEAD = 24;

  const state = { loading: false, failed: false, signature: '' };

  const forecastIsOn = () => loadJson(ON_KEY, true) !== false;

  const roundedSpot = (location) => ({ lat: Number(location.lat.toFixed(2)), lon: Number(location.lon.toFixed(2)) });

  // ---------- Fetching ----------

  // The next 24 hours from the hour in progress. As with the stored hours, the
  // record at 04:00 covers 03:00-04:00.
  async function fetchForecast(location) {
    const spot = roundedSpot(location);
    const params = new URLSearchParams({
      // Rounded to about 1 km, as for the history weather: the exact address isn't shared.
      latitude: spot.lat.toFixed(2),
      longitude: spot.lon.toFixed(2),
      hourly: 'rain,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      models: FORECAST_MODEL,
      timezone: 'UTC',
      wind_speed_unit: 'mph',
      forecast_days: 2,
    });
    const response = await fetch(`${FORECAST_URL}?${params}`);
    if (!response.ok) throw new Error(`Forecast request failed: ${response.status}`);
    const { hourly } = await response.json();

    const now = Date.now();
    const records = [];
    hourly.time.forEach((time, i) => {
      const ms = Date.parse(`${time}Z`);
      if (ms <= now || records.length >= HOURS_AHEAD) return;
      const record = {
        time: hourKey(ms),
        rain: hourly.rain[i],
        wind_speed_10m: hourly.wind_speed_10m[i],
        wind_direction_10m: hourly.wind_direction_10m[i],
        wind_gusts_10m: hourly.wind_gusts_10m[i],
      };
      if (Object.values(record).some((v) => v == null)) return;
      records.push(record);
    });
    return { checkedAt: now, ...spot, hours: records };
  }

  // Checks at most once an hour (or at once if there's nothing saved for this
  // location, or force is set). Never throws: failures show on the card.
  async function refreshForecast(force = false) {
    const location = loadLocation();
    if (!forecastIsOn() || !location || !navigator.onLine || refreshForecast.running) return;
    const spot = roundedSpot(location);
    const saved = savedForecast(spot);
    if (!force && saved && Date.now() - saved.checkedAt < HOUR) return;

    refreshForecast.running = true;
    state.loading = true;
    state.failed = false;
    renderForecast();
    try {
      saveJson(FORECAST_KEY, await fetchForecast(location));
    } catch (error) {
      console.warn(error);
      state.failed = true;
    } finally {
      refreshForecast.running = false;
      state.loading = false;
      renderForecast();
    }
  }

  // The saved forecast, if it's for this location and still has hours to come.
  function savedForecast(spot) {
    const saved = loadJson(FORECAST_KEY, null);
    if (!saved || saved.lat !== spot.lat || saved.lon !== spot.lon || !Array.isArray(saved.hours)) return null;
    const upcoming = saved.hours.filter((record) => Date.parse(record.time) > Date.now());
    return upcoming.length ? { ...saved, hours: upcoming } : null;
  }

  // ---------- The rule ----------

  // Everything the card says, worked out from the saved forecast and the
  // current leaks each time it draws, so it follows leak changes at once.
  function evaluate(saved) {
    const leakRecords = [];
    for (const leak of loadLeaks()) {
      const [first, last] = leakHours(leak);
      for (let t = first; t <= last; t += HOUR) {
        const record = hours.get(hourKey(t));
        if (record && record.rain >= RAINY_MM && record.wind_speed_10m != null && record.wind_direction_10m != null) {
          leakRecords.push(record);
        }
      }
    }
    if (!leakRecords.length) return { kind: 'few' };

    const threshold = Math.min(...leakRecords.map((record) => record.rain));
    const matching = saved.hours.filter((record) => record.rain >= threshold);

    if (!matching.length) return { kind: 'ok', ahead: spellSummary(saved.hours) };

    // Group consecutive matching hours into spells.
    const spells = [];
    for (const record of matching) {
      const last = spells.at(-1)?.at(-1);
      if (last && Date.parse(record.time) - Date.parse(last.time) === HOUR) spells.at(-1).push(record);
      else spells.push([record]);
    }
    return { kind: 'warn', spells };
  }

  // The weather over a run of hours in the shape renderWeather() takes.
  function spellSummary(spell) {
    const wind = spell.reduce((sum, r) => sum + r.wind_speed_10m, 0) / spell.length;
    const gustiest = spell.reduce((a, b) => (b.wind_gusts_10m > a.wind_gusts_10m ? b : a));
    return {
      rain: spell.reduce((sum, r) => sum + r.rain, 0),
      wind,
      windFrom: averageBearing(spell.map((r) => r.wind_direction_10m)),
      gust: gustiest.wind_gusts_10m,
      gustFrom: gustiest.wind_direction_10m,
    };
  }

  // "03:00 and 07:00", with "tomorrow" where the day isn't today.
  function spellTimes(spell) {
    const from = Date.parse(spell[0].time) - HOUR;
    const to = Date.parse(spell.at(-1).time);
    const day = (ms) => (ukDate(ms) === ukDate(Date.now()) ? '' : ' tomorrow');
    return `${ukHour(from)}${day(from)} and ${ukHour(to)}${ukDate(to) === ukDate(from) ? '' : day(to)}`;
  }

  // ---------- Drawing ----------

  const ICONS = {
    // Bucket brimming over, with a sad face.
    bucket: ['M5 8h14l-1.6 12.5a1 1 0 0 1-1 .9H7.6a1 1 0 0 1-1-.9z', 'M4 7c2-2.4 4.6 1.6 8 0s5.6 1.6 8 0',
      'M4.5 11v3', 'M19.5 11v3', 'M10 17q2-1.6 4 0'],
    // House with a smile, and with a flat mouth.
    house: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M9.5 15.5q2.5 2.5 5 0'],
    houseFlat: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 16h4'],
    hourglass: ['M6 3h12', 'M6 21h12', 'M7.5 3v3.5c0 2 1.6 3.6 4.5 5.5 2.9-1.9 4.5-3.5 4.5-5.5V3',
      'M7.5 21v-3.5c0-2 1.6-3.6 4.5-5.5 2.9 1.9 4.5 3.5 4.5 5.5V21'],
    wifi: ['M3 8.5a13 13 0 0 1 18 0', 'M6 11.5a9 9 0 0 1 12 0', 'M10 20q2-1.6 4 0'],
    pin: ['M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z'],
  };
  const ICON_DOTS = { // little filled eyes, [cx, cy]
    bucket: [[10, 13], [14, 13]], house: [[10, 13], [14, 13]], houseFlat: [[10, 13], [14, 13]],
    hourglass: [], wifi: [[10, 16], [14, 16]], pin: [[12, 10]],
  };

  function statusIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'forecast-icon');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    for (const [cx, cy] of ICON_DOTS[name]) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', name === 'pin' ? 2.5 : 0.9);
      dot.setAttribute('class', name === 'pin' ? 'dot-line' : 'dot');
      svg.append(dot);
    }
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // textContent, never innerHTML
    return node;
  }

  const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: UK_ZONE });

  // The weather line for the card, with its rain labelled as a total.
  function weatherLine(summary) {
    const line = el('div', 'weather');
    renderWeather(line, summary, { rainTotal: true });
    return line;
  }

  function button(label, className, onClick) {
    const b = el('button', `btn ${className}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // What the card should show, as plain data, so an unchanged card isn't redrawn.
  function describe() {
    const location = loadLocation();
    if (!location) return { kind: 'location' };
    const saved = savedForecast(roundedSpot(location));
    if (!saved) return state.loading ? { kind: 'loading' } : { kind: 'none' };
    const result = evaluate(saved);
    const stale = state.failed || !navigator.onLine ? saved.checkedAt : null;
    if (result.kind === 'warn') {
      const [first, ...later] = result.spells;
      return { ...result, first: spellSummary(first), times: spellTimes(first), later: later.length, stale };
    }
    return { ...result, stale };
  }

  function renderForecast() {
    const card = $('forecast-card');
    if (!card) return;
    card.hidden = !forecastIsOn();
    if (card.hidden) { state.signature = ''; return; }

    const view = describe();
    const signature = JSON.stringify([view, state.loading]);
    if (signature === state.signature) return;
    state.signature = signature;

    const body = el('div', 'forecast-body');
    let name; // which icon
    let tone; // warn | ok | quiet
    const stale = view.stale ? el('p', 'supporting small', `Last checked ${clock(view.stale)}. Offline or the forecast couldn't be fetched.`) : null;

    switch (view.kind) {
      case 'location':
        name = 'pin'; tone = 'quiet';
        body.append(el('p', 'forecast-headline', 'Set your location'),
          el('p', 'supporting', 'Needed to look up the weather at your flat and check the forecast.'),
          button('Set location', 'filled', () => openSettings()));
        break;
      case 'loading':
        name = 'houseFlat'; tone = 'quiet';
        body.append(el('p', 'forecast-headline', 'Checking the forecast...'));
        break;
      case 'none':
        name = 'wifi'; tone = 'quiet';
        body.append(el('p', 'forecast-headline', 'No forecast'),
          el('p', 'supporting', "The forecast couldn't be loaded. It needs a signal."),
          button('Retry', 'tonal', () => refreshForecast(true)));
        break;
      case 'few':
        name = 'hourglass'; tone = 'quiet';
        body.append(el('p', 'forecast-headline', 'Not enough leaks to check yet'),
          el('p', 'supporting', "Once a leak has rain in it, this card will say when similar rain is forecast."));
        break;
      case 'ok':
        name = 'house'; tone = 'ok';
        body.append(el('p', 'forecast-headline', 'All good'),
          el('p', 'forecast-detail', 'No weather conditions matching potential leakages are forecast in the next 24 hours.'),
          weatherLine(view.ahead));
        break;
      case 'warn':
        name = 'bucket'; tone = 'warn';
        body.append(el('p', 'forecast-headline', 'Put a bucket out'),
          el('p', 'forecast-detail', `Weather conditions matching potential leakages are forecast between ${view.times}.`),
          weatherLine(view.first));
        if (view.later) body.append(el('p', 'forecast-detail', `And ${view.later} more spell${view.later === 1 ? '' : 's'} later.`));
        break;
      default:
        return;
    }
    if (stale) body.append(stale);
    if (view.stale) body.append(button('Retry', 'tonal', () => refreshForecast(true)));

    card.className = `card forecast ${tone}`;
    card.replaceChildren(el('h2', 'sr-only', 'Forecast'), statusIcon(name), body);
  }

  // ---------- Start up ----------

  function initForecast() {
    const toggle = $('forecast-switch');
    toggle.checked = forecastIsOn();
    toggle.addEventListener('change', () => {
      saveJson(ON_KEY, toggle.checked);
      render(); // shows or hides the card, and the old location prompt with it
      if (toggle.checked) refreshForecast();
    });
    window.addEventListener('online', () => { state.failed = false; refreshForecast(); renderForecast(); });
    window.addEventListener('offline', renderForecast);
    // An installed app can stay open for days: check again when it comes back to the front.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshForecast(); });
  }

  window.initForecast = initForecast;
  window.renderForecast = renderForecast;
  window.refreshForecast = refreshForecast;
  window.forecastIsOn = forecastIsOn;
})();
