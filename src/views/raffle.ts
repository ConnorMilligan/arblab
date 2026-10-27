import type { RaffleEntry, RaffleResult } from '../domain/raffle.ts';
import { html } from '../html.ts';
import { MINUTE } from '../time.ts';
import { type PageCtx, page, pts, signed, when } from './layout.ts';

const percent = (part: number, whole: number) => `${Math.round((1000 * part) / whole) / 10}%`;

export function rafflePage(ctx: PageCtx, round: number, entries: RaffleEntry[], draws: RaffleResult[]): string {
  const me = ctx.viewer!.id;
  const pot = entries.reduce((n, e) => n + e.amount, 0);
  const mine = entries.find((e) => e.user_id === me)?.amount ?? 0;
  const left = round + MINUTE - ctx.now;
  return page(
    ctx,
    'Raffle',
    html`<h1>Raffle</h1>
<p>A raffle is drawn every minute. Each point you put in is a ticket, and one ticket wins the whole pot, so your chance is your share of it.
   Entries are final once made.</p>

<section class="notice">
  <h2>This minute</h2>
  <p>Draws in <b data-countdown="${left}">${Math.ceil(left / 1000)}s</b>. Pot: <b>${pts(pot)}</b> from ${entries.length} ${entries.length === 1 ? 'entrant' : 'entrants'}.
     ${mine ? html`You have <b>${pts(mine)}</b> in (${percent(mine, pot)} chance).` : "You aren't in yet."}</p>
  <form method="post" action="/raffle/enter" class="inline">
    <input type="number" name="amount" min="1" max="${ctx.viewer!.balance}" step="1" required inputmode="numeric" aria-label="Points" placeholder="Points">
    <button>${mine ? 'Add to my entry' : 'Enter'}</button>
  </form>
  <small>You have ${pts(ctx.viewer!.balance)}. If nobody else enters you just get your points back.</small>
</section>

${entries.length
  ? html`<div class="scroll"><table><thead><tr><th>Entrant</th><th class="num">Points</th><th class="num">Chance</th></tr></thead><tbody>
    ${entries.map(
      (e) => html`<tr class="${e.user_id === me ? 'you' : ''}"><td>${e.name}</td><td class="num">${e.amount.toLocaleString('en-US')}</td><td class="num">${percent(e.amount, pot)}</td></tr>`,
    )}</tbody></table></div>`
  : html`<p class="muted">Nobody has entered this minute's raffle.</p>`}

<h2>Recent draws</h2>
${draws.length
  ? html`<div class="scroll"><table><thead><tr><th>Drawn</th><th>Winner</th><th class="num">Pot</th><th class="num">Entrants</th><th class="num">You</th></tr></thead><tbody>
    ${draws.map(
      (d) => html`<tr class="${d.winner_id === me ? 'you' : ''}"><td>${when(d.round + MINUTE, true)}</td><td>${d.winner}</td>
        <td class="num">${d.pot.toLocaleString('en-US')}</td><td class="num">${d.entrants}</td>
        <td class="num">${d.mine ? signed(d.winner_id === me ? d.pot - d.mine : -d.mine) : '–'}</td></tr>`,
    )}</tbody></table></div>`
  : html`<p class="muted">No raffles drawn yet.</p>`}`,
  );
}
