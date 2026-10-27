import { randomInt } from 'node:crypto';
import type { DB } from '../db.ts';
import { finalizeMarket } from './markets.ts';
import { grantAllowances } from './points.ts';
import { drawRaffles } from './raffle.ts';
import { type Rng, acceptProposal, closeVoting } from './resolution.ts';
import { PROPOSAL_DEADLINE } from './rules.ts';

/**
 * Applies every deadline that has passed. Runs before each request and once a minute.
 * Each step only touches rows still in the earlier state, so running it twice is harmless.
 */
export function tick(db: DB, now: number, rng: Rng = randomInt): void {
  db.transaction(() => {
    grantAllowances(db, now);
    drawRaffles(db, now, rng);

    const ids = (sql: string, ...params: number[]) => (db.prepare(sql).all(...params) as { id: number }[]).map((r) => r.id);

    for (const id of ids("SELECT id FROM markets WHERE status = 'pending' AND close_at <= ?", now)) {
      finalizeMarket(db, id, 'VOID', 'The subject did not opt in before trading closed.', now);
    }

    db.prepare("UPDATE markets SET status = 'closed' WHERE status = 'open' AND close_at <= ?").run(now);

    for (const id of ids("SELECT id FROM markets WHERE status = 'closed' AND close_at + ? <= ?", PROPOSAL_DEADLINE, now)) {
      finalizeMarket(db, id, 'VOID', 'No outcome was proposed within 7 days of trading closing.', now);
    }

    for (const id of ids(
      `SELECT m.id FROM markets m JOIN proposals p ON p.market_id = m.id
       WHERE m.status = 'proposed' AND p.challenge_ends_at <= ?`,
      now,
    )) {
      acceptProposal(db, id, now);
    }

    for (const id of ids(
      `SELECT m.id FROM markets m JOIN disputes d ON d.market_id = m.id
       WHERE m.status = 'disputed' AND d.closed_at IS NULL AND d.voting_ends_at <= ?`,
      now,
    )) {
      closeVoting(db, id, now);
    }
  })();
}
