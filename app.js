// Leak Log - stage 1: record leaks on the phone.
//
// Only leaks are logged. Any time after tracking started that isn't inside
// a logged leak counts as dry.
//
// All data is kept in the browser's localStorage on this device.
// Nothing is sent to any server.

const LEAKS_KEY = 'leakLog.leaks.v1';
const TRACKING_KEY = 'leakLog.trackingStartedAt';

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

function render() {
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

function openRecordDialog() {
  const now = toLocalInputValue(new Date());
  $('leak-form').reset();
  for (const input of [$('leak-from'), $('leak-to')]) {
    input.value = now;
    input.max = now; // the phone's picker won't offer future times
  }
  showError('');
  $('record-dialog').showModal();
}

function showError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}

function addLeak(event) {
  event.preventDefault();

  let from = new Date($('leak-from').value);
  let to = new Date($('leak-to').value);
  const severity = document.querySelector('input[name="severity"]:checked')?.value ?? null;
  const volumeText = $('volume').value.trim();
  const volume = Number(volumeText);

  if (isNaN(from) || isNaN(to)) return showError('Enter both a From and a To time.');
  if (from > Date.now() || to > Date.now()) return showError("Leak times can't be in the future.");
  if (!severity && !volumeText) return showError('Pick how bad it was, or enter the spill volume.');
  if (severity && volumeText) return showError('Pick a severity or enter a volume, not both.');
  if (volumeText && !(Number.isInteger(volume) && volume >= 1)) {
    return showError('Spill volume must be a whole number of ml, 1 or more.');
  }

  // "To" before "From" is almost certainly a slip, so swap them.
  if (to < from) [from, to] = [to, from];

  const leak = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    from: from.toISOString(), // stored in UTC so it lines up with weather data later
    to: to.toISOString(),
    severity: volumeText ? null : severity,
    volumeMl: volumeText ? volume : null,
    notes: $('notes').value.trim(),
    createdAt: new Date().toISOString(),
  };

  saveLeaks([...loadLeaks(), leak]);
  $('record-dialog').close();
  render();
  toast('Leak logged');
}

// ---------- Delete ----------

let pendingDeleteId = null;

function askToDelete(id) {
  pendingDeleteId = id;
  $('delete-dialog').showModal();
}

function confirmDelete() {
  saveLeaks(loadLeaks().filter((l) => l.id !== pendingDeleteId));
  pendingDeleteId = null;
  $('delete-dialog').close();
  render();
  toast('Leak deleted');
}

// ---------- Export ----------

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const leaks = loadLeaks().sort((a, b) => a.from.localeCompare(b.from));
  const started = trackingStartedAt();
  const header = ['from_utc', 'to_utc', 'severity', 'volume_ml', 'notes', 'id',
                  'created_at_utc', 'tracking_started_utc'];
  const rows = leaks.map((l) =>
    [l.from, l.to, l.severity, l.volumeMl, l.notes, l.id, l.createdAt, started]
      .map(csvCell).join(','));
  const csv = [header.join(','), ...rows].join('\n');

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `leak-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- Start up ----------

function init() {
  trackingStartedAt();

  $('fab').addEventListener('click', openRecordDialog);
  $('close-record').addEventListener('click', () => $('record-dialog').close());
  $('leak-form').addEventListener('submit', addLeak);

  // Severity and volume can't both be entered: choosing one clears the other.
  $('volume').addEventListener('input', () => {
    if ($('volume').value !== '') {
      document.querySelectorAll('input[name="severity"]').forEach((r) => { r.checked = false; });
    }
  });
  document.querySelectorAll('input[name="severity"]').forEach((radio) =>
    radio.addEventListener('change', () => { $('volume').value = ''; }));

  $('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
  $('confirm-delete').addEventListener('click', confirmDelete);
  $('export-csv').addEventListener('click', exportCsv);

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
