import type { DB } from '../db.ts';
import { MINUTE } from '../time.ts';
import { requireActive } from './markets.ts';
import { credit, debit } from './points.ts';
import type { Rng } from './resolution.ts';

/** Rounds are the wall-clock minutes; a round's raffle is drawn when its minute ends. */
export const roundStart = (t: number): number => Math.floor(t / MINUTE) * MINUTE;

/** Puts points into the current round. Entering again in the same round adds to the entry. */
export function enterRaffle(db: DB, userId: number, amount: number, now: number): number {
  requireActive(db, userId);
  debit(db, userId, 'raffle_stake', amount, null, now);
  const round = roundStart(now);
  db.prepare(
    `INSERT INTO raffle_entries (round, user_id, amount) VALUES (?, ?, ?)
     ON CONFLICT (round, user_id) DO UPDATE SET amount = amount + excluded.amount`,
  ).run(round, userId, amount);
  return round;
}

/**
 * Draws every finished round that has entries and no draw yet. Each point is one ticket, so a
 * member's chance of taking the whole pot is their share of it. Safe to run repeatedly.
 */
export function drawRaffles(db: DB, now: number, rng: Rng): void {
  const rounds = db
    .prepare(
      `SELECT DISTINCT round FROM raffle_entries
       WHERE round + ? <= ? AND round NOT IN (SELECT round FROM raffle_draws) ORDER BY round`,
    )
    .all(MINUTE, now) as { round: number }[];
  for (const { round } of rounds) {
    const entries = db
      .prepare('SELECT user_id, amount FROM raffle_entries WHERE round = ? ORDER BY user_id')
      .all(round) as { user_id: number; amount: number }[];
    const pot = entries.reduce((n, e) => n + e.amount, 0);
    const ticket = rng(pot);
    let upTo = 0;
    const winner = entries.find((e) => ticket < (upTo += e.amount))!;
    db.prepare('INSERT INTO raffle_draws (round, winner_id, pot, ticket, entrants, drawn_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      round,
      winner.user_id,
      pot,
      ticket,
      entries.length,
      now,
    );
    credit(db, winner.user_id, 'raffle_win', pot, null, now);
  }
}

export interface RaffleEntry {
  user_id: number;
  name: string;
  amount: number;
}

export function currentEntries(db: DB, now: number): RaffleEntry[] {
  return db
    .prepare(
      `SELECT e.user_id, u.display_name AS name, e.amount FROM raffle_entries e JOIN users u ON u.id = e.user_id
       WHERE e.round = ? ORDER BY e.amount DESC, u.display_name`,
    )
    .all(roundStart(now)) as RaffleEntry[];
}

export interface RaffleResult {
  round: number;
  winner_id: number;
  winner: string;
  pot: number;
  entrants: number;
  mine: number;
}

export function recentDraws(db: DB, userId: number, limit = 20): RaffleResult[] {
  return db
    .prepare(
      `SELECT d.round, d.winner_id, u.display_name AS winner, d.pot, d.entrants,
              COALESCE(e.amount, 0) AS mine
       FROM raffle_draws d JOIN users u ON u.id = d.winner_id
       LEFT JOIN raffle_entries e ON e.round = d.round AND e.user_id = ?
       ORDER BY d.round DESC LIMIT ?`,
    )
    .all(userId, limit) as RaffleResult[];
}
