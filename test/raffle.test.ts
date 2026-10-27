import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { credit } from '../src/domain/points.ts';
import { ROUND, currentEntries, drawRaffles, enterRaffle, recentDraws, roundStart } from '../src/domain/raffle.ts';
import { RuleError } from '../src/domain/rules.ts';
import { tick } from '../src/domain/tick.ts';
import { T0, addUser, setup } from './helpers.ts';

describe('raffle', () => {
  it('takes the stake at once and lets a member add to their entry', () => {
    const { db, ids, bal } = setup(2);
    enterRaffle(db, ids[0], 300, T0 + 1_000);
    enterRaffle(db, ids[0], 200, T0 + 3_000);
    expect(bal(ids[0])).toBe(500);
    expect(currentEntries(db, T0 + 4_000)).toMatchObject([{ user_id: ids[0], amount: 500 }]);
  });

  it('refuses entries above the balance or that are not whole positive numbers', () => {
    const { db, ids } = setup(1);
    expect(() => enterRaffle(db, ids[0], 1001, T0)).toThrow(RuleError);
    expect(() => enterRaffle(db, ids[0], 0, T0)).toThrow(RuleError);
    expect(() => enterRaffle(db, ids[0], 1.5, T0)).toThrow(RuleError);
  });

  it('draws nothing until the round is over, then pays the whole pot to the ticket holder', () => {
    const { db, ids, bal } = setup(3);
    enterRaffle(db, ids[0], 300, T0); // tickets 0-299
    enterRaffle(db, ids[1], 200, T0 + 1); // 300-499
    const end = roundStart(T0) + ROUND;
    tick(db, end - 1, () => 300);
    expect(recentDraws(db, ids[0])).toEqual([]);
    tick(db, end, () => 300);
    expect(recentDraws(db, ids[0])).toMatchObject([{ winner_id: ids[1], pot: 500, entrants: 2, mine: 300 }]);
    expect(bal(ids[0])).toBe(700);
    expect(bal(ids[1])).toBe(1300);
    expect(bal(ids[2])).toBe(1000);
  });

  it('draws each round once and catches up on rounds missed while the server slept', () => {
    const { db, ids, bal } = setup(2);
    enterRaffle(db, ids[0], 100, T0);
    enterRaffle(db, ids[1], 100, T0 + ROUND);
    tick(db, T0 + 10 * ROUND, () => 0);
    tick(db, T0 + 11 * ROUND, () => 0);
    expect(recentDraws(db, ids[0])).toHaveLength(2);
    expect(bal(ids[0]) + bal(ids[1])).toBe(2000);
  });

  it('gives a lone entrant their points back', () => {
    const { db, ids, bal } = setup(2);
    enterRaffle(db, ids[0], 400, T0);
    drawRaffles(db, T0 + ROUND, () => 399);
    expect(bal(ids[0])).toBe(1000);
  });
});

describe('ledger migration', () => {
  it('rebuilds a pre-raffle ledger without losing rows, and keeps it append-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'arblab-')), 'old.db');
    const old = openDb(path);
    old.exec(`DROP TABLE ledger;
      CREATE TABLE ledger (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type TEXT NOT NULL CHECK (type IN ('allowance', 'stake', 'winnings', 'refund', 'bond', 'bond_return', 'jury_reward')),
        amount INTEGER NOT NULL CHECK (amount <> 0),
        market_id INTEGER REFERENCES markets(id),
        created_at INTEGER NOT NULL,
        CHECK ((type IN ('stake', 'bond')) = (amount < 0)),
        CHECK ((type = 'allowance') = (market_id IS NULL))
      )`);
    const user = addUser(old, 'Alice');
    expect(() => credit(old, user, 'raffle_win', 50, null, 6)).toThrow();
    old.close();

    const db = openDb(path);
    credit(db, user, 'raffle_win', 50, null, 6);
    expect(db.prepare('SELECT type, amount FROM ledger ORDER BY id').all()).toEqual([
      { type: 'allowance', amount: 1000 },
      { type: 'raffle_win', amount: 50 },
    ]);
    expect(() => db.prepare('DELETE FROM ledger').run()).toThrow(/append-only/);
    db.close();
  });
});
