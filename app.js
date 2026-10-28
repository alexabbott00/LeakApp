// Leak Log - stage 1: record leaks on the phone. Stage 2: set the flat's
// location by postcode. Stage 3: keep an hourly weather record for the flat.
//
// Only leaks are logged. Any time after tracking started that isn't inside
// a logged leak counts as dry.
//
// All data is kept on this device: leaks and settings in localStorage, the
// hourly weather in IndexedDB. The only things sent anywhere are the
// postcode, to postcodes.io when it's applied, and rounded coordinates, to
// Open-Meteo for the weather.

const LEAKS_KEY = 'leakLog.leaks.v1';
const TRACKING_KEY = 'leakLog.trackingStartedAt';
const LOCATION_KEY = 'leakLog.location.v1';
const MAX_VOLUME_ML = 10000;

// ---------- Storage ----------

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const loadLeaks = () => loadJson(LEAKS_KEY, []);
const saveLeaks = (leaks) => saveJson(LEAKS_KEY, leaks);

// Saved once, the first time the app opens, and never changed after that.
function trackingStartedAt() {
  let started = loadJson(TRACKING_KEY, null);
  if (!started) {
    started = new Date().toISOString();
    saveJson(TRACKING_KEY, started);
  }
  return started;
}

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Value for <input type="datetime-local">, in local time, e.g. "2026-10-28T14:05"
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const formatDay = (date) =>
  date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const formatTime = (date) =>
  date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// e.g. "Tue 27 Oct, 09:00 – 17:30" or "Mon 26 Oct, 22:00 – Tue 27 Oct, 07:00"
function formatRange(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const start = `${formatDay(from)}, ${formatTime(from)}`;
  if (from.getTime() === to.getTime()) return start;
  const sameDay = from.toDateString() === to.toDateString();
  return `${start} – ${sameDay ? '' : `${formatDay(to)}, `}${formatTime(to)}`;
}

const SEVERITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  mug: 'Spilled Sports Direct mug',
};

const describeAmount = (leak) =>
  leak.volumeMl != null ? `${leak.volumeMl} ml` : SEVERITY_LABELS[leak.severity] ?? leak.severity;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Rendering ----------

// newId: a leak that was just added, so it can animate in.
function render(newId) {
  const leaks = loadLeaks().sort((a, b) => b.from.localeCompare(a.from));
  const since = new Date(trackingStartedAt()).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  $('summary').textContent =
    `${leaks.length} leak${leaks.length === 1 ? '' : 's'} logged · Tracking since ${since}`;
  $('empty').hidden = leaks.length > 0;
  $('location-prompt').hidden = !!loadLocation();

  const list = $('history');
  list.replaceChildren();

  for (const leak of leaks) {
    const li = document.createElement('li');
    li.dataset.id = leak.id;
    if (leak.id === newId) li.classList.add('entering');

    const entry = document.createElement('div');
    entry.className = 'entry';

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = formatRange(leak.from, leak.to);

    const amount = document.createElement('div');
    amount.className = 'amount';
    amount.textContent = describeAmount(leak);

    const weather = document.createElement('div');
    weather.className = 'weather';
    weather.textContent = weatherSummary(leak) ?? 'Weather pending';

    entry.append(when, amount, weather);

    if (leak.notes) {
      const notes = document.createElement('div');
      notes.className = 'notes';
      notes.textContent = leak.notes; // textContent, never innerHTML, for user text
      entry.append(notes);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn text';
    del.textContent = 'Delete';
    del.addEventListener('click', () => askToDelete(leak.id));

    li.append(entry, del);
    list.append(li);
  }
}

// ---------- Record leak ----------
//
// Bad values are blocked as they're entered, rather than reported on save.
// Only a required field left empty is flagged, by turning it red.

const severityChips = () => document.querySelectorAll('input[name="severity"]');

function setInvalid(id, invalid) {
  $(id).classList.toggle('invalid', invalid);
}

function openRecordDialog() {
  const now = toLocalInputValue(new Date());
  $('leak-form').reset();
  cleanVolume.last = '';
  for (const input of [$('leak-from'), $('leak-to')]) {
    input.value = now;
    input.max = now; // the phone's picker won't offer future times
  }
  ['from-field', 'to-field', 'amount'].forEach((id) => setInvalid(id, false));
  $('record-dialog').showModal();
  $('record-dialog').scrollTop = 0; // always open at the top, not where it was last left
}

// A time later than now is pulled back to now.
function keepInPast(input) {
  const now = toLocalInputValue(new Date());
  input.max = now;
  if (input.value > now) input.value = now; // same format, so text comparison works
}

// Digits only, no leading zeros, and never above the maximum.
function cleanVolume() {
  const input = $('volume');
  let digits = input.value.replace(/\D/g, '').replace(/^0+/, '');
  if (Number(digits) > MAX_VOLUME_ML) digits = cleanVolume.last ?? '';
  input.value = digits;
  cleanVolume.last = digits;

  // Severity and volume can't both be entered: typing a volume clears the severity.
  if (digits) {
    severityChips().forEach((r) => { r.checked = false; });
    setInvalid('amount', false);
  }
}

function addLeak(event) {
  event.preventDefault();

  keepInPast($('leak-from'));
  keepInPast($('leak-to'));
  let from = new Date($('leak-from').value);
  let to = new Date($('leak-to').value);
  const severity = document.querySelector('input[name="severity"]:checked')?.value ?? null;
  const volume = $('volume').value ? Number($('volume').value) : null;

  setInvalid('from-field', isNaN(from));
  setInvalid('to-field', isNaN(to));
  setInvalid('amount', !severity && !volume);
  const firstInvalid = document.querySelector('#leak-form .invalid');
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    return;
  }

  // "To" before "From" is almost certainly a slip, so swap them.
  if (to < from) [from, to] = [to, from];

  const leak = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    from: from.toISOString(), // stored in UTC so it lines up with weather data later
    to: to.toISOString(),
    severity: volume ? null : severity,
    volumeMl: volume,
    notes: $('notes').value.trim(),
    createdAt: new Date().toISOString(),
  };

  saveLeaks([...loadLeaks(), leak]);
  $('record-dialog').close();
  render(leak.id);
  toast('Leak logged');
  updateWeather(); // fetches any hours this leak needs that aren't in yet
}

// ---------- Delete ----------

let pendingDeleteId = null;

function askToDelete(id) {
  pendingDeleteId = id;
  $('delete-dialog').showModal();
}

function confirmDelete() {
  const id = pendingDeleteId;
  pendingDeleteId = null;
  saveLeaks(loadLeaks().filter((l) => l.id !== id));
  $('delete-dialog').close();
  toast('Leak deleted');

  // Let the row slide away before the list is redrawn.
  const row = [...$('history').children].find((li) => li.dataset.id === id);
  if (!row) return render();
  animate(row, 'leaving', render);
}

// Plays the animation for className on el, then calls done. The timer is a
// fallback: browsers can pause animations (e.g. app in the background),
// and then the animation's end never fires.
function animate(el, className, done) {
  if (reduceMotion()) return done();
  el.classList.add(className);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.classList.remove(className);
    done();
  };
  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 450);
}

// ---------- Settings: location ----------
//
// The postcode is looked up once, on Apply, and only the result is kept.

// Full UK postcode: outward code ("AB1", "SW1A") then inward code ("2CD").
const POSTCODE_PATTERN = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/;
const POSTCODE_LOOKUP = 'https://api.postcodes.io/postcodes/';

const loadLocation = () => loadJson(LOCATION_KEY, null);
const describeLocation = (loc) => (loc.area ? `${loc.postcode} (${loc.area})` : loc.postcode);

// Capitals, letters/digits only, at most one space, at most 8 characters.
function tidyPostcode(text) {
  const [first, ...rest] = text.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trimStart().split(/ +/);
  return (rest.length ? `${first} ${rest.join('')}` : first).slice(0, 8);
}

function cleanPostcode() {
  const input = $('postcode');
  const tidy = tidyPostcode(input.value);
  if (tidy !== input.value) {
    const caret = tidyPostcode(input.value.slice(0, input.selectionStart)).length;
    input.value = tidy;
    input.setSelectionRange(caret, caret);
  }
  showPostcodeError(false);
}

// Red on its own for an empty field; red plus a hint when the value is wrong.
function showPostcodeError(invalid, hint = '') {
  setInvalid('postcode-field', invalid);
  $('postcode-hint').textContent = hint;
  $('postcode-hint').hidden = !hint;
}

function updateApplyButton() {
  const button = $('apply-location');
  button.disabled = !navigator.onLine;
  button.textContent = navigator.onLine ? 'Apply' : 'Needs an internet connection';
}

function renderLocation() {
  const loc = loadLocation();
  $('current-location').textContent = loc ? `Current: ${describeLocation(loc)}` : '';
  $('current-location').hidden = !loc;
}

async function applyLocation(event) {
  event.preventDefault();
  const postcode = $('postcode').value.trim();
  if (!postcode) return showPostcodeError(true);
  if (!POSTCODE_PATTERN.test(postcode)) return showPostcodeError(true, 'Enter a full UK postcode');
  if (!navigator.onLine) return updateApplyButton();

  const button = $('apply-location');
  button.disabled = true;
  button.textContent = 'Looking up…';
  try {
    const response = await fetch(POSTCODE_LOOKUP + encodeURIComponent(postcode.replace(' ', '')));
    const result = response.ok ? (await response.json()).result : null;
    if (response.status === 404 || (result && result.latitude == null)) {
      return showPostcodeError(true, 'Postcode not found');
    }
    if (!result) throw new Error(`Lookup failed: ${response.status}`);

    const location = {
      postcode: result.postcode, // standard form, with the space
      lat: result.latitude,
      lon: result.longitude,
      area: result.admin_district ?? '',
      setAt: new Date().toISOString(),
    };
    saveJson(LOCATION_KEY, location);
    $('postcode').value = location.postcode;
    renderLocation();
    toast(`Location set: ${describeLocation(location)}`);
    render();
    // Weather already fetched keeps its old location; new hours use this one.
    updateWeather(true);
  } catch {
    showPostcodeError(true, "Couldn't reach the postcode lookup. Try again.");
  } finally {
    updateApplyButton();
  }
}

// Opening Settings adds a history entry, so the phone's back button closes
// it instead of leaving the app.
function openSettings() {
  if (!$('settings-view').hidden) return;
  history.pushState({ view: 'settings' }, '');
  $('postcode').value = loadLocation()?.postcode ?? '';
  showPostcodeError(false);
  updateApplyButton();
  renderLocation();
  for (const el of document.querySelectorAll('header, main, #fab')) el.inert = true;
  const view = $('settings-view');
  view.hidden = false;
  view.scrollTop = 0;
  animate(view, 'entering', () => {});
}

function closeSettings() {
  const view = $('settings-view');
  if (view.hidden) return;
  for (const el of document.querySelectorAll('header, main, #fab')) el.inert = false;
  view.classList.remove('entering');
  animate(view, 'leaving', () => { view.hidden = true; });
}

// ---------- Weather ----------
//
// One record per hour, keyed by the hour it ends: the 10:00 record covers
// 09:00-10:00 (Open-Meteo's totals and gusts are "preceding hour"). A web
// app can't run in the background, so each time the app opens it fetches
// every hour it's missing, plus the latest 3 hours, which the model may
// still revise. The current hour is included as a provisional value.

const HOUR = 3600 * 1000;
const WEATHER_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const WEATHER_MODEL = 'ukmo_uk_deterministic_2km';
const WEATHER_FIELDS = [
  'rain', 'precipitation', 'snowfall', 'hail', 'temperature_2m',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'wind_speed_20m', 'wind_direction_20m', 'wind_speed_30m', 'wind_direction_30m',
  'wind_speed_50m', 'wind_direction_50m',
];
const UKV_START = Date.UTC(2022, 2, 1); // no UKV data before 1 March 2022
const REFRESH_HOURS = 3;
const SUMMARY_LEAD_HOURS = 6; // the summary also shows the hours before a leak
const MAX_DAYS_PER_REQUEST = 90;
const WEATHER_CHECKED_KEY = 'leakLog.weatherCheckedAt';

const hours = new Map(); // hour (ISO string) -> weather record, mirrors IndexedDB

const hourKey = (ms) => new Date(ms).toISOString();
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;
const ceilHour = (ms) => Math.ceil(ms / HOUR) * HOUR;

// The first and last hourly records a leak's range touches.
// 09:00-17:00 -> the 10:00 to 17:00 records (8 hours).
function leakHours(leak) {
  const first = floorHour(Date.parse(leak.from)) + HOUR;
  return [first, Math.max(first, ceilHour(Date.parse(leak.to)))];
}

// "leak" if any logged leak covers the hour, otherwise "dry". Worked out
// each time, never stored, so deleting a leak turns its hours back to dry.
function hourStatus(hourMs) {
  return loadLeaks().some((leak) => {
    const [first, last] = leakHours(leak);
    return hourMs >= first && hourMs <= last;
  }) ? 'leak' : 'dry';
}

// --- Database: a single "hours" table in IndexedDB ---

function openDb() {
  openDb.promise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('leakLog', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('hours', { keyPath: 'time' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return openDb.promise;
}

async function loadHours() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('hours').objectStore('hours').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHours(records) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('hours', 'readwrite');
    records.forEach((record) => tx.objectStore('hours').put(record));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Fetching ---

// Earliest hour needed: tracking start, or 6 hours before the earliest leak
// if that's sooner (so every leak's summary can be filled in).
function earliestNeededHour() {
  let start = floorHour(Date.parse(trackingStartedAt())) + HOUR;
  for (const leak of loadLeaks()) start = Math.min(start, leakHours(leak)[0] - SUMMARY_LEAD_HOURS * HOUR);
  return Math.max(start, UKV_START);
}

async function fetchWeather(location, fromMs, toMs) {
  const params = new URLSearchParams({
    // Rounded to about 1 km: the grid is 2 km, and the exact address isn't shared.
    latitude: location.lat.toFixed(2),
    longitude: location.lon.toFixed(2),
    hourly: WEATHER_FIELDS.join(','),
    models: WEATHER_MODEL,
    timezone: 'UTC',
    wind_speed_unit: 'mph',
    start_date: hourKey(fromMs - HOUR).slice(0, 10),
    end_date: hourKey(toMs).slice(0, 10),
  });
  const response = await fetch(`${WEATHER_URL}?${params}`);
  if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
  const { hourly } = await response.json();

  const records = [];
  hourly.time.forEach((time, i) => {
    const ms = Date.parse(`${time}Z`);
    // Hours the model hasn't produced yet come back empty; skip them so
    // they're fetched again next time.
    if (ms < fromMs || ms > toMs || hourly.precipitation[i] == null) return;
    const record = { time: hourKey(ms), lat: Number(params.get('latitude')), lon: Number(params.get('longitude')) };
    for (const field of WEATHER_FIELDS) record[field] = hourly[field][i];
    records.push(record);
  });
  return records;
}

// Fills every missing hour and refreshes the latest few. Checks at most
// every 15 minutes unless hours are missing or force is set.
async function updateWeather(force = false) {
  const location = loadLocation();
  if (!location || !navigator.onLine || updateWeather.running) return;

  const end = ceilHour(Date.now()); // the current hour, provisional
  let missingFrom = null;
  for (let t = earliestNeededHour(); t <= end - REFRESH_HOURS * HOUR; t += HOUR) {
    if (!hours.has(hourKey(t))) { missingFrom = t; break; }
  }
  const recentlyChecked = Date.now() - loadJson(WEATHER_CHECKED_KEY, 0) < 15 * 60 * 1000;
  if (missingFrom == null && recentlyChecked && !force) return;

  const from = Math.min(missingFrom ?? Infinity, end - REFRESH_HOURS * HOUR);
  updateWeather.running = true;
  try {
    for (let chunk = from; chunk <= end; chunk += MAX_DAYS_PER_REQUEST * 24 * HOUR) {
      const chunkEnd = Math.min(end, chunk + MAX_DAYS_PER_REQUEST * 24 * HOUR - HOUR);
      // Re-fetched hours only replace ones from the same location: after a
      // location change, weather already fetched keeps its old location.
      const records = (await fetchWeather(location, chunk, chunkEnd)).filter((record) => {
        const saved = hours.get(record.time);
        return !saved || (saved.lat === record.lat && saved.lon === record.lon);
      });
      await saveHours(records).catch(() => {}); // still usable this session if the database fails
      records.forEach((record) => hours.set(record.time, record));
    }
    saveJson(WEATHER_CHECKED_KEY, Date.now());
    render();
  } catch (error) {
    // Nothing is lost: the next open, reconnect or new leak tries again.
    console.warn(error);
  } finally {
    updateWeather.running = false;
  }
}

// --- Leak summary ---

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassPoint = (degrees) => COMPASS[Math.round(degrees / 22.5) % 16];

// Average of compass bearings, done with vectors so N and NNW average to
// about N, not S.
function averageBearing(bearings) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = bearings.reduce((sum, d) => sum + Math.sin(rad(d)), 0);
  const y = bearings.reduce((sum, d) => sum + Math.cos(rad(d)), 0);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

// e.g. "4.2 mm rain · Wind 18 mph SW · Gust 35 mph W", over the leak's
// range plus the 6 hours before it. Null until all those hours are in.
function weatherSummary(leak) {
  const [first, last] = leakHours(leak);
  const records = [];
  for (let t = first - SUMMARY_LEAD_HOURS * HOUR; t <= last; t += HOUR) {
    const record = hours.get(hourKey(t));
    if (!record) return null;
    records.push(record);
  }
  const rain = records.reduce((sum, r) => sum + r.rain, 0);
  const wind = records.reduce((sum, r) => sum + r.wind_speed_10m, 0) / records.length;
  const windFrom = averageBearing(records.map((r) => r.wind_direction_10m));
  // Open-Meteo has no separate gust direction, so use the wind direction in
  // the hour of the strongest gust.
  const gustiest = records.reduce((a, b) => (b.wind_gusts_10m > a.wind_gusts_10m ? b : a));
  return `${rain.toFixed(1)} mm rain · Wind ${Math.round(wind)} mph ${compassPoint(windFrom)}` +
         ` · Gust ${Math.round(gustiest.wind_gusts_10m)} mph ${compassPoint(gustiest.wind_direction_10m)}`;
}

// ---------- Start up ----------

function init() {
  trackingStartedAt();

  $('fab').addEventListener('click', openRecordDialog);
  $('close-record').addEventListener('click', () => $('record-dialog').close());
  $('leak-form').addEventListener('submit', addLeak);

  for (const [inputId, fieldId] of [['leak-from', 'from-field'], ['leak-to', 'to-field']]) {
    $(inputId).addEventListener('change', () => {
      keepInPast($(inputId));
      setInvalid(fieldId, !$(inputId).value);
    });
  }

  $('volume').addEventListener('input', cleanVolume);
  // Severity chips are checkboxes so a selected one can be tapped off again,
  // but only one can be on at a time.
  severityChips().forEach((chip) =>
    chip.addEventListener('change', () => {
      if (!chip.checked) return;
      severityChips().forEach((other) => { if (other !== chip) other.checked = false; });
      $('volume').value = '';
      cleanVolume.last = '';
      setInvalid('amount', false);
    }));

  $('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
  $('confirm-delete').addEventListener('click', confirmDelete);

  $('open-settings').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => history.back());
  window.addEventListener('popstate', closeSettings);
  $('postcode').addEventListener('input', cleanPostcode);
  $('location-form').addEventListener('submit', applyLocation);
  window.addEventListener('online', updateApplyButton);
  window.addEventListener('offline', updateApplyButton);
  window.addEventListener('online', () => updateWeather());
  $('prompt-settings').addEventListener('click', openSettings);

  render();

  // Load the saved hourly weather, then fill in anything missing.
  loadHours()
    .then((records) => records.forEach((record) => hours.set(record.time, record)))
    .catch((error) => console.warn('Weather database unavailable', error))
    .finally(() => { render(); updateWeather(); });

  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.();

  // The service worker lets the app open offline and be installed on the home screen.
  // Browsers only allow it on https (GitHub Pages) or localhost.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js');
  }
}

init();
