import { ROUND, type RaffleEntry, type RaffleResult } from '../domain/raffle.ts';
import { type Html, html } from '../html.ts';
import { formatUtc } from '../time.ts';
import { type PageCtx, page, pts, signed } from './layout.ts';

const percent = (part: number, whole: number) => `${Math.round((1000 * part) / whole) / 10}%`;
const sum = (entries: RaffleEntry[]) => entries.reduce((n, e) => n + e.amount, 0);

export interface RaffleData {
  round: number;
  entries: RaffleEntry[];
  draws: RaffleResult[];
}

function status(ctx: PageCtx, d: RaffleData): Html {
  const pot = sum(d.entries);
  const mine = d.entries.find((e) => e.user_id === ctx.viewer!.id)?.amount ?? 0;
  const left = d.round + ROUND - ctx.now;
  return html`Draws in <b id="countdown">${Math.ceil(left / 1000)}s</b>. Pot: <b>${pts(pot)}</b> from ${d.entries.length}
     ${d.entries.length === 1 ? 'entrant' : 'entrants'}.
     ${mine ? html`You have <b>${pts(mine)}</b> in (${percent(mine, pot)} chance).` : "You aren't in yet."}`;
}

function entrants(ctx: PageCtx, d: RaffleData): Html {
  const pot = sum(d.entries);
  if (!d.entries.length) return html`<p class="muted">Nobody has entered this round's raffle.</p>`;
  return html`<div class="scroll"><table><thead><tr><th>Entrant</th><th class="num">Points</th><th class="num">Chance</th></tr></thead><tbody>
    ${d.entries.map(
      (e) => html`<tr class="${e.user_id === ctx.viewer!.id ? 'you' : ''}"><td>${e.name}</td><td class="num">${e.amount.toLocaleString('en-US')}</td><td class="num">${percent(e.amount, pot)}</td></tr>`,
    )}</tbody></table></div>`;
}

function draws(ctx: PageCtx, d: RaffleData): Html {
  const me = ctx.viewer!.id;
  if (!d.draws.length) return html`<p class="muted">No raffles drawn yet.</p>`;
  return html`<div class="scroll"><table><thead><tr><th>Drawn</th><th>Winner</th><th class="num">Pot</th><th class="num">Entrants</th><th class="num">You</th></tr></thead><tbody>
    ${d.draws.map(
      (r) => html`<tr class="${r.winner_id === me ? 'you' : ''}"><td><time datetime="${new Date(r.round + ROUND).toISOString()}" data-short data-seconds>${formatUtc(r.round + ROUND)}</time></td><td>${r.winner}</td>
        <td class="num">${r.pot.toLocaleString('en-US')}</td><td class="num">${r.entrants}</td>
        <td class="num">${r.mine ? signed(r.winner_id === me ? r.pot - r.mine : -r.mine) : '–'}</td></tr>`,
    )}</tbody></table></div>`;
}

/** The pieces app.js swaps in while the page is open (see /raffle/state). */
export function raffleState(ctx: PageCtx, d: RaffleData) {
  const balance = ctx.viewer!.balance;
  return {
    left: d.round + ROUND - ctx.now,
    balance,
    balanceText: pts(balance),
    status: status(ctx, d).value,
    entrants: entrants(ctx, d).value,
    draws: draws(ctx, d).value,
  };
}

export function rafflePage(ctx: PageCtx, d: RaffleData): string {
  const mine = d.entries.some((e) => e.user_id === ctx.viewer!.id);
  return page(
    ctx,
    'Raffle',
    html`<h1>Raffle</h1>
<p>A raffle is drawn every 30 seconds. Each point you put in is a ticket, and one ticket wins the whole pot, so your chance is your share of it.
   Entries are final once made. This page updates by itself.</p>

<div data-raffle-live>
<section class="notice">
  <h2>This round</h2>
  <p id="raffle-status">${status(ctx, d)}</p>
  <form method="post" action="/raffle/enter" class="inline">
    <input type="number" name="amount" min="1" max="${ctx.viewer!.balance}" step="1" required inputmode="numeric" aria-label="Points" placeholder="Points">
    <button>${mine ? 'Add to my entry' : 'Enter'}</button>
  </form>
  <small>You have <span id="raffle-balance">${pts(ctx.viewer!.balance)}</span>. If nobody else enters you just get your points back.</small>
</section>

<div id="raffle-entrants">${entrants(ctx, d)}</div>

<h2>Recent draws</h2>
<div id="raffle-draws">${draws(ctx, d)}</div>
</div>`,
  );
}
