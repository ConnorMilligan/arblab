// Progressive enhancement only: every page works without this file.

// Show times in the viewer's time zone (the server renders UTC). The zone is the device's own unless
// they pick another in the footer; the choice is kept per browser.
const TZ_KEY = 'arblab-tz';
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function validZone(z) {
  try {
    return Boolean(z) && Boolean(new Intl.DateTimeFormat('en', { timeZone: z }));
  } catch {
    return false;
  }
}
function savedZone() {
  try {
    const z = localStorage.getItem(TZ_KEY);
    return validZone(z) ? z : '';
  } catch {
    return '';
  }
}
let zone = savedZone() || deviceZone;

const long = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
const short = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
function format(d, el) {
  const style = el.hasAttribute('data-short') ? short : long;
  const opts = el.hasAttribute('data-seconds') || el.hasAttribute('data-clock') ? { ...style, second: '2-digit' } : style;
  return d.toLocaleString(undefined, { ...opts, timeZone: zone });
}
function localTimes(root) {
  for (const el of root.querySelectorAll('time[datetime]')) {
    const d = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(d.getTime())) continue;
    el.dataset.utc ??= el.textContent;
    el.title = el.dataset.utc;
    el.textContent = format(d, el);
  }
  for (const el of root.querySelectorAll('[data-tz-name]')) el.textContent = zone.replaceAll('_', ' ');
}
localTimes(document);

// Live clocks start from the server's time and advance with this device's clock.
const clocks = document.querySelectorAll('time[data-clock]');
if (clocks.length) {
  const offset = new Date(clocks[0].getAttribute('datetime')).getTime() - Date.now();
  setInterval(() => {
    const d = new Date(Date.now() + offset);
    for (const el of clocks) {
      el.setAttribute('datetime', d.toISOString());
      el.textContent = format(d, el);
    }
  }, 1000);
}

// Time zone picker in the footer: "Automatic" follows the device, anything else is remembered.
const tzSelect = document.getElementById('tz');
if (tzSelect && typeof Intl.supportedValuesOf === 'function') {
  const zones = Intl.supportedValuesOf('timeZone');
  if (!zones.includes('UTC')) zones.unshift('UTC');
  tzSelect.add(new Option(`Automatic (${deviceZone.replaceAll('_', ' ')})`, ''));
  for (const z of zones) tzSelect.add(new Option(z.replaceAll('_', ' '), z));
  tzSelect.value = savedZone();
  tzSelect.addEventListener('change', () => {
    try {
      if (tzSelect.value) localStorage.setItem(TZ_KEY, tzSelect.value);
      else localStorage.removeItem(TZ_KEY);
    } catch {
      // storage blocked: the choice lasts until the page is left
    }
    zone = tzSelect.value || deviceZone;
    localTimes(document);
  });
  tzSelect.closest('label').hidden = false;
}

// How far `tz` is ahead of UTC at instant `t`, in ms.
function zoneOffset(t, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(t);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

// A datetime-local value is a wall-clock time in the chosen zone; find the instant it means.
// The second pass corrects for a DST change between the guess and the answer.
function wallTimeToEpoch(value) {
  const asUtc = Date.parse(`${value}Z`);
  if (Number.isNaN(asUtc)) return NaN;
  const guess = asUtc - zoneOffset(asUtc, zone);
  return asUtc - zoneOffset(guess, zone);
}

// Send the exact instant alongside the typed wall-clock time.
for (const input of document.querySelectorAll('input[data-epoch]')) {
  input.form.addEventListener('submit', () => {
    const t = wallTimeToEpoch(input.value);
    input.form.elements[input.dataset.epoch].value = Number.isNaN(t) ? '' : String(t);
  });
}

// Select an invite link on focus so it is easy to copy.
for (const input of document.querySelectorAll('.invites input')) {
  input.addEventListener('focus', () => input.select());
}

// Keep the raffle page live: poll for entrants, pot, draws and balance, and tick the countdown between polls.
// The form is outside the swapped parts, so a half-typed entry survives. The countdown runs from page load
// rather than the server's clock, so a wrong clock on this device doesn't matter.
if (document.querySelector('[data-raffle-live]')) {
  const byId = (id) => document.getElementById(id);
  let end = 0;
  let fetching = false;
  let lastPoll = 0;

  async function poll() {
    if (fetching) return;
    fetching = true;
    lastPoll = Date.now();
    try {
      const res = await fetch('/raffle/state', { credentials: 'same-origin', cache: 'no-store' });
      if (res.redirected || !res.ok) return location.reload(); // logged out, or the server is unhappy
      const s = await res.json();
      end = Date.now() + s.left;
      byId('raffle-status').innerHTML = s.status;
      byId('raffle-entrants').innerHTML = s.entrants;
      byId('raffle-draws').innerHTML = s.draws;
      byId('raffle-balance').textContent = s.balanceText;
      const balance = byId('balance');
      if (balance) balance.textContent = s.balanceText;
      document.querySelector('[data-raffle-live] input[name=amount]').max = s.balance;
      localTimes(byId('raffle-draws'));
    } catch {
      // offline or a blip: the next poll tries again
    } finally {
      fetching = false;
    }
  }

  setInterval(() => {
    const countdown = byId('countdown');
    if (!end || !countdown) return;
    const left = end - Date.now();
    countdown.textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
    // Just after the draw, ask again every second until the new round shows up.
    if (left <= 0 && Date.now() - lastPoll >= 1000) poll();
  }, 250);
  setInterval(poll, 3000);
  poll();
}
