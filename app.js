// Leak Log - stage 1: record leak checks on the phone.
//
// All data is kept in the browser's localStorage on this device.
// Nothing is sent to any server.

const CHECKS_KEY = 'leakLog.checks.v1';
const SETTINGS_KEY = 'leakLog.settings.v1';

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

const loadChecks = () => loadJson(CHECKS_KEY, []);
const saveChecks = (checks) => saveJson(CHECKS_KEY, checks);
const loadSettings = () => loadJson(SETTINGS_KEY, {});
const saveSettings = (settings) => saveJson(SETTINGS_KEY, settings);

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);

// Value for <input type="datetime-local">, in local time, e.g. "2026-10-28T14:05"
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

const SEVERITY_LABELS = { damp: 'Damp patch', drip: 'Dripping', heavy: 'Heavy / pooling' };

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Rendering ----------

function render() {
  const checks = loadChecks().sort((a, b) => b.time.localeCompare(a.time));
  const leaks = checks.filter((c) => c.leak).length;

  $('summary').textContent =
    `${checks.length} check${checks.length === 1 ? '' : 's'} logged, ${leaks} with a leak`;
  $('empty').hidden = checks.length > 0;

  const list = $('history');
  list.replaceChildren();

  for (const check of checks) {
    const li = document.createElement('li');

    const entry = document.createElement('div');
    entry.className = 'entry';

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = formatWhen(check.time);

    const badge = document.createElement('div');
    badge.className = `badge ${check.leak ? 'leak' : 'dry'}`;
    badge.textContent = check.leak
      ? `Leak - ${SEVERITY_LABELS[check.severity] ?? check.severity}`
      : 'Dry';

    entry.append(when, badge);

    if (check.notes) {
      const notes = document.createElement('div');
      notes.className = 'notes';
      notes.textContent = check.notes; // textContent, never innerHTML, for user text
      entry.append(notes);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteCheck(check.id));

    li.append(entry, del);
    list.append(li);
  }
}

// ---------- Actions ----------

function resetForm() {
  $('check-form').reset();
  $('check-time').value = toLocalInputValue(new Date());
  $('severity-row').hidden = true;
}

function addCheck(event) {
  event.preventDefault();

  const outcome = document.querySelector('input[name="outcome"]:checked')?.value;
  const time = new Date($('check-time').value);
  if (!outcome || isNaN(time)) return;

  const check = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    time: time.toISOString(), // stored in UTC so it lines up with weather data later
    leak: outcome === 'leak',
    severity: outcome === 'leak' ? $('severity').value : null,
    notes: $('notes').value.trim(),
    createdAt: new Date().toISOString(),
  };

  saveChecks([...loadChecks(), check]);
  resetForm();
  render();
  toast(check.leak ? 'Leak logged' : 'Dry check logged');
}

function deleteCheck(id) {
  if (!confirm('Delete this check?')) return;
  saveChecks(loadChecks().filter((c) => c.id !== id));
  render();
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    toast('Location is not available in this browser');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // 3 decimal places is about 100 m: plenty for a 2 km weather grid.
      $('lat').value = pos.coords.latitude.toFixed(3);
      $('lon').value = pos.coords.longitude.toFixed(3);
      toast('Location found - tap Save location');
    },
    () => toast('Could not get your location'),
    { enableHighAccuracy: false, timeout: 15000 },
  );
}

function saveLocation() {
  const lat = parseFloat($('lat').value);
  const lon = parseFloat($('lon').value);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
    toast('Enter a valid latitude and longitude');
    return;
  }
  saveSettings({ ...loadSettings(), lat, lon });
  toast('Location saved on this phone');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const checks = loadChecks().sort((a, b) => a.time.localeCompare(b.time));
  const header = ['time_utc', 'leak', 'severity', 'notes', 'id', 'created_at_utc'];
  const rows = checks.map((c) =>
    [c.time, c.leak ? 1 : 0, c.severity, c.notes, c.id, c.createdAt].map(csvCell).join(','));
  const csv = [header.join(','), ...rows].join('\n');

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `leak-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- Start up ----------

function init() {
  resetForm();

  const { lat, lon } = loadSettings();
  if (lat != null) $('lat').value = lat;
  if (lon != null) $('lon').value = lon;

  $('check-form').addEventListener('submit', addCheck);
  document.querySelectorAll('input[name="outcome"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      $('severity-row').hidden = radio.value !== 'leak' || !radio.checked;
    }));
  $('use-location').addEventListener('click', useCurrentLocation);
  $('save-location').addEventListener('click', saveLocation);
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
