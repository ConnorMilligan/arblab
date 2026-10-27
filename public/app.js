// Progressive enhancement only: every page works without this file.

// Show times in the viewer's own time zone (the server renders UTC).
const long = { dateStyle: 'medium', timeStyle: 'short' };
const short = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
for (const el of document.querySelectorAll('time[datetime]')) {
  const d = new Date(el.getAttribute('datetime'));
  if (!Number.isNaN(d.getTime())) {
    el.title = el.textContent;
    const style = el.hasAttribute('data-short') ? short : long;
    el.textContent = d.toLocaleString(undefined, el.hasAttribute('data-seconds') ? { ...style, second: '2-digit' } : style);
  }
}

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

// Count down to the raffle draw, then reload to show the result. Counts from page load so a wrong clock doesn't matter.
for (const el of document.querySelectorAll('[data-countdown]')) {
  const end = Date.now() + Number(el.dataset.countdown);
  const timer = setInterval(() => {
    const left = end - Date.now();
    el.textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
    if (left <= -1000) {
      clearInterval(timer);
      location.reload();
    }
  }, 250);
}
