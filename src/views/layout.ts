import type { MarketListRow } from '../domain/markets.ts';
import { impliedYes } from '../domain/payout.ts';
import { type Html, html } from '../html.ts';
import { formatDuration, formatUtc } from '../time.ts';

export const APP_NAME = 'Arblab';

export interface Viewer {
  id: number;
  name: string;
  isAdmin: boolean;
  balance: number;
}

export interface Flash {
  kind: 'ok' | 'error';
  message: string;
}

export interface PageCtx {
  viewer: Viewer | null;
  flash: Flash | null;
  now: number;
}

export function page(ctx: PageCtx, title: string, body: Html): string {
  const v = ctx.viewer;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${APP_NAME}</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header>
  <a class="brand" href="/">${APP_NAME}</a>
  ${v
    ? html`<nav>
    <a href="/">Markets</a>
    <a href="/markets/new">New market</a>
    <a href="/me">My bets</a>
    <a href="/leaderboard">Leaderboard</a>
    <a href="/members">Members</a>
    <a href="/rules">Rules</a>
  </nav>
  <div class="me">
    <span title="Play points. No cash value.">${pts(v.balance)}</span>
    <form method="post" action="/logout"><button class="link">Log out ${v.name}</button></form>
  </div>`
    : html`<nav><a href="/login">Log in</a> <a href="/rules">Rules</a></nav>`}
</header>
<main>
${ctx.flash ? html`<p class="flash ${ctx.flash.kind}" role="status">${ctx.flash.message}</p>` : ''}
${body}
</main>
<footer>Play points only. They have no cash value and cannot be bought, sold, transferred or redeemed. <a href="/rules">House Rules</a></footer>
</body>
</html>`.value;
}

export function pts(n: number): string {
  return `${n.toLocaleString('en-US')} pts`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
}

/** A timestamp; app.js rewrites it in the viewer's time zone (`short` drops the year, for tables). */
export function when(t: number, short = false): Html {
  return html`<time datetime="${new Date(t).toISOString()}" ${short ? html`data-short` : ''}>${formatUtc(t)}</time>`;
}

export function until(t: number, now: number): string {
  return formatDuration(t - now);
}

/** Shows a link only for http(s) URLs; everything else is plain text. */
export function linkify(text: string): Html {
  return /^https?:\/\/\S+$/i.test(text)
    ? html`<a href="${text}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`
    : html`${text}`;
}

export function statusLine(m: MarketListRow, now: number): Html {
  switch (m.status) {
    case 'pending':
      return html`<span class="tag">Waiting for ${m.subject_name} to opt in</span>`;
    case 'open':
      return html`<span class="tag open">Open</span> closes in ${until(m.close_at, now)}`;
    case 'closed':
      return html`<span class="tag wait">Closed</span> awaiting a proposed outcome`;
    case 'proposed':
      return html`<span class="tag wait">Outcome proposed</span> challenge window open`;
    case 'disputed':
      return html`<span class="tag wait">Disputed</span> jury voting`;
    case 'resolved':
      return html`<span class="tag ${m.outcome?.toLowerCase()}">Resolved ${m.outcome}</span>`;
  }
}

export function poolBar(yes: number, no: number): Html {
  const p = impliedYes(yes, no);
  if (p === null) return html`<p class="muted">No bets yet.</p>`;
  return html`<div class="pool">
  <div class="bar" role="img" aria-label="YES ${p}%, NO ${100 - p}%"><span style="width:${p}%"></span></div>
  <div class="split"><span>YES ${p}% · ${pts(yes)}</span><span>NO ${100 - p}% · ${pts(no)}</span></div>
</div>`;
}

export function marketList(rows: MarketListRow[], now: number, empty: string): Html {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<ul class="markets">${rows.map(
    (m) => html`<li>
  <a href="/markets/${m.id}">${m.question}</a>
  <div class="meta">${statusLine(m, now)}${m.subject_name ? html` · about ${m.subject_name}` : ''} · pool ${pts(m.yes_pool + m.no_pool)}</div>
  ${m.status === 'resolved' ? '' : poolBar(m.yes_pool, m.no_pool)}
</li>`,
  )}</ul>`;
}

export function outcomeRadios(name: string, options: readonly string[]): Html {
  return html`<div class="choices">${options.map(
    (o) => html`<label class="choice"><input type="radio" name="${name}" value="${o}" required> ${o}</label>`,
  )}</div>`;
}
