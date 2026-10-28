// Leak Log - stage 1: record leaks on the phone. Stage 2: set the flat's
// location by postcode, for the weather lookups to come.
//
// Only leaks are logged. Any time after tracking started that isn't inside
// a logged leak counts as dry.
//
// All data is kept in the browser's localStorage on this device. The only
// thing sent anywhere is the postcode, to postcodes.io, when it's applied.

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

    entry.append(when, amount);

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

  render();

  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.();

  // The service worker lets the app open offline and be installed on the home screen.
  // Browsers only allow it on https (GitHub Pages) or localhost.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js');
  }
}

init();
