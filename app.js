// Leak Log - stage 1: record leaks on the phone.
//
// Only leaks are logged. Any time after tracking started that isn't inside
// a logged leak counts as dry.
//
// All data is kept in the browser's localStorage on this device.
// Nothing is sent to any server.

const LEAKS_KEY = 'leakLog.leaks.v1';
const TRACKING_KEY = 'leakLog.trackingStartedAt';
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

  // Let the row slide away before the list is redrawn. The timer is a
  // fallback: browsers can pause animations (e.g. app in the background),
  // and then the animation's end never fires.
  const row = [...$('history').children].find((li) => li.dataset.id === id);
  if (!row || reduceMotion()) return render();
  row.classList.add('leaving');
  let done = false;
  const finish = () => { if (!done) { done = true; render(); } };
  row.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 400);
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
