import { describe, expect, it } from 'vitest';
import { credit, grantWeeklyAllowance, ledgerFor } from '../src/domain/points.ts';
import { setActive } from '../src/domain/users.ts';
import { tick } from '../src/domain/tick.ts';
import { DAY, MINUTE } from '../src/time.ts';
import { T0, makeMarket, setup } from './helpers.ts';

const NEXT_MONDAY = Date.UTC(2026, 10, 2); // 2026-11-02 00:00 UTC

describe('weekly allowance', () => {
  it('gives new members this week\'s 1,000 when they join, once', () => {
    const { db, ids, bal } = setup(1);
    expect(bal(ids[0])).toBe(1000);
    tick(db, T0 + DAY);
    tick(db, NEXT_MONDAY - MINUTE); // Sunday 23:59 is still the same week
    expect(bal(ids[0])).toBe(1000);
  });

  it('grants 1,000 every Monday 00:00 UTC', () => {
    const { db, ids, bal } = setup(1);
    tick(db, NEXT_MONDAY);
    tick(db, NEXT_MONDAY + 5 * MINUTE);
    expect(bal(ids[0])).toBe(2000);
    tick(db, NEXT_MONDAY + 7 * DAY);
    expect(bal(ids[0])).toBe(3000);
  });

  it('never lifts a balance above 5,000', () => {
    const { db, ids, bal } = setup(3);
    const [a, b, c] = ids;
    credit(db, a, 'refund', 3500, makeMarket(db, a), T0); // a: 4,500
    credit(db, b, 'refund', 4000, makeMarket(db, b), T0); // b: 5,000
    credit(db, c, 'winnings', 6000, makeMarket(db, c), T0); // c: 7,000 from winnings
    tick(db, NEXT_MONDAY);
    expect(bal(a)).toBe(5000);
    expect(bal(b)).toBe(5000);
    expect(bal(c)).toBe(7000); // winnings are kept; the cap only limits the allowance
    expect(grantWeeklyAllowance(db, a, NEXT_MONDAY + DAY)).toBe(0);
  });

  it('skips deactivated members', () => {
    const { db, ids, bal } = setup(2);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ids[0]);
    setActive(db, ids[0], ids[1], false);
    tick(db, NEXT_MONDAY);
    expect(bal(ids[1])).toBe(1000);
  });
});

describe('ledger', () => {
  it('is append-only', () => {
    const { db } = setup(1);
    expect(() => db.prepare('UPDATE ledger SET amount = 1000000').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM ledger').run()).toThrow(/append-only/);
  });

  it('rejects rows whose sign does not match their type', () => {
    const { db, ids } = setup(1);
    const m = makeMarket(db, ids[0]);
    expect(() =>
      db.prepare("INSERT INTO ledger (user_id, type, amount, market_id, created_at) VALUES (?, 'stake', 5, ?, 0)").run(ids[0], m),
    ).toThrow(/CHECK/);
  });

  it('shows a running balance', () => {
    const { db, ids } = setup(1);
    tick(db, NEXT_MONDAY);
    expect(ledgerFor(db, ids[0]).map((r) => r.running)).toEqual([2000, 1000]);
  });
});
