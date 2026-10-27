// Pure parimutuel math. No database access, so it is easy to test exhaustively.
import type { Outcome, Side } from './rules.ts';

export interface Bet {
  userId: number;
  side: Side;
  amount: number;
  createdAt: number;
}

export interface Payout {
  userId: number;
  amount: number;
  type: 'winnings' | 'refund';
}

interface Stake {
  userId: number;
  amount: number;
  firstAt: number;
}

function stakesByUser(bets: Bet[]): Stake[] {
  const byUser = new Map<number, Stake>();
  for (const b of bets) {
    const s = byUser.get(b.userId);
    if (s) {
      s.amount += b.amount;
      s.firstAt = Math.min(s.firstAt, b.createdAt);
    } else {
      byUser.set(b.userId, { userId: b.userId, amount: b.amount, firstAt: b.createdAt });
    }
  }
  return [...byUser.values()].sort((a, b) => a.userId - b.userId);
}

const total = (xs: { amount: number }[]) => xs.reduce((n, x) => n + x.amount, 0);

function refundAll(bets: Bet[]): Payout[] {
  return stakesByUser(bets).map((s) => ({ userId: s.userId, amount: s.amount, type: 'refund' }));
}

/**
 * VOID refunds every stake. Otherwise each winner gets their stake back plus
 * floor(losingPool × stake / winningPool). The points lost to rounding go out
 * one at a time to winners by stake size (largest first, then earliest bet).
 * If nobody backed the winning side there is nobody to pay, so everyone is refunded.
 */
export function computePayouts(bets: Bet[], outcome: Outcome): Payout[] {
  if (outcome === 'VOID') return refundAll(bets);
  const winners = stakesByUser(bets.filter((b) => b.side === outcome));
  const winPool = total(winners);
  const losePool = total(bets.filter((b) => b.side !== outcome));
  if (winPool === 0) return refundAll(bets);

  const shares = new Map(winners.map((w) => [w.userId, Math.floor((losePool * w.amount) / winPool)]));
  let leftover = losePool - [...shares.values()].reduce((a, b) => a + b, 0);
  const order = [...winners].sort((a, b) => b.amount - a.amount || a.firstAt - b.firstAt || a.userId - b.userId);
  for (let i = 0; leftover > 0; i = (i + 1) % order.length, leftover--) {
    shares.set(order[i].userId, shares.get(order[i].userId)! + 1);
  }
  return winners.map((w) => ({ userId: w.userId, amount: w.amount + shares.get(w.userId)!, type: 'winnings' }));
}

/** Splits `amount` evenly, rounding down; the remainder goes +1 each from the front of the list. */
export function splitEvenly(amount: number, recipients: number[]): { userId: number; amount: number }[] {
  if (recipients.length === 0) return [];
  const base = Math.floor(amount / recipients.length);
  const extra = amount % recipients.length;
  return recipients.map((userId, i) => ({ userId, amount: base + (i < extra ? 1 : 0) }));
}

/** Implied probability of YES in whole percent, or null with an empty pool. */
export function impliedYes(yes: number, no: number): number | null {
  return yes + no === 0 ? null : Math.round((100 * yes) / (yes + no));
}
