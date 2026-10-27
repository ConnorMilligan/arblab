// Progressive enhancement only: every page works without this file.

// Show times in the viewer's own time zone (the server renders UTC).
const long = { dateStyle: 'medium', timeStyle: 'short' };
const short = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
function localTimes(root) {
  for (const el of root.querySelectorAll('time[datetime]')) {
    const d = new Date(el.getAttribute('datetime'));
    if (!Number.isNaN(d.getTime())) {
      el.title = el.textContent;
      const style = el.hasAttribute('data-short') ? short : long;
      el.textContent = d.toLocaleString(undefined, el.hasAttribute('data-seconds') ? { ...style, second: '2-digit' } : style);
    }
  }
}
localTimes(document);

// A datetime-local input holds local time; also send the exact instant it means.
for (const input of document.querySelectorAll('input[data-epoch]')) {
  input.form.addEventListener('submit', () => {
    const t = new Date(input.value).getTime();
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
