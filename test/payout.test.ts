import { describe, expect, it } from 'vitest';
import { type Bet, computePayouts, splitEvenly } from '../src/domain/payout.ts';

const bet = (userId: number, side: 'YES' | 'NO', amount: number, createdAt = userId): Bet => ({ userId, side, amount, createdAt });
const sum = (xs: { amount: number }[]) => xs.reduce((n, x) => n + x.amount, 0);

describe('computePayouts', () => {
  it('splits the losing pool in proportion to stake', () => {
    const bets = [bet(1, 'YES', 100), bet(2, 'YES', 300), bet(3, 'NO', 200)];
    expect(computePayouts(bets, 'YES')).toEqual([
      { userId: 1, amount: 150, type: 'winnings' },
      { userId: 2, amount: 450, type: 'winnings' },
    ]);
  });

  it('rounds shares down and gives leftover points to the biggest stakers first', () => {
    // Losing pool 7 over winning pool 15: raw shares 1.4, 2.33, 3.27 -> 1, 2, 3 with 1 left over.
    const bets = [bet(1, 'YES', 3), bet(2, 'YES', 5), bet(3, 'YES', 7), bet(4, 'NO', 7)];
    expect(computePayouts(bets, 'YES')).toEqual([
      { userId: 1, amount: 4, type: 'winnings' },
      { userId: 2, amount: 7, type: 'winnings' },
      { userId: 3, amount: 11, type: 'winnings' },
    ]);
  });

  it('breaks stake-size ties by earliest bet', () => {
    // Losing pool 2 over three equal stakes: shares 0 each, 2 left over -> the two earliest bettors.
    const bets = [bet(1, 'NO', 1, 30), bet(2, 'NO', 1, 10), bet(3, 'NO', 1, 20), bet(4, 'YES', 2)];
    const out = computePayouts(bets, 'NO');
    expect(out.map((p) => [p.userId, p.amount])).toEqual([
      [1, 1],
      [2, 2],
      [3, 2],
    ]);
  });

  it('adds up several bets by the same member, and loses their stake on the other side', () => {
    const bets = [bet(1, 'YES', 50), bet(1, 'YES', 50), bet(1, 'NO', 40), bet(2, 'NO', 60)];
    // Winning pool 100 (all user 1), losing pool 100 -> user 1 gets 200 back.
    expect(computePayouts(bets, 'YES')).toEqual([{ userId: 1, amount: 200, type: 'winnings' }]);
  });

  it('returns stakes when nobody took the other side', () => {
    expect(computePayouts([bet(1, 'YES', 80), bet(2, 'YES', 20)], 'YES')).toEqual([
      { userId: 1, amount: 80, type: 'winnings' },
      { userId: 2, amount: 20, type: 'winnings' },
    ]);
  });

  it('refunds everyone when nobody backed the winning side', () => {
    expect(computePayouts([bet(1, 'NO', 80), bet(2, 'NO', 20)], 'YES')).toEqual([
      { userId: 1, amount: 80, type: 'refund' },
      { userId: 2, amount: 20, type: 'refund' },
    ]);
  });

  it('VOID refunds every stake, combined per member', () => {
    const bets = [bet(1, 'YES', 10), bet(1, 'NO', 5), bet(2, 'NO', 7)];
    expect(computePayouts(bets, 'VOID')).toEqual([
      { userId: 1, amount: 15, type: 'refund' },
      { userId: 2, amount: 7, type: 'refund' },
    ]);
  });

  it('never creates or destroys points (randomised)', () => {
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 500; round++) {
      const bets = Array.from({ length: 1 + rand(12) }, (_, i) =>
        bet(1 + rand(6), rand(2) ? 'YES' : 'NO', 1 + rand(997), i),
      );
      for (const outcome of ['YES', 'NO', 'VOID'] as const) {
        const out = computePayouts(bets, outcome);
        expect(sum(out)).toBe(sum(bets));
        const winPool = sum(bets.filter((b) => b.side === outcome));
        const losePool = sum(bets) - winPool;
        if (outcome === 'VOID' || winPool === 0) continue;
        for (const p of out) {
          const stake = sum(bets.filter((b) => b.userId === p.userId && b.side === outcome));
          const exact = (losePool * stake) / winPool;
          expect(p.amount - stake).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(p.amount - stake).toBeLessThanOrEqual(Math.floor(exact) + 1);
        }
      }
    }
  });
});

describe('splitEvenly', () => {
  it('rounds down and hands the remainder to the front of the list', () => {
    expect(splitEvenly(50, [7, 8, 9])).toEqual([
      { userId: 7, amount: 17 },
      { userId: 8, amount: 17 },
      { userId: 9, amount: 16 },
    ]);
    expect(splitEvenly(10, [])).toEqual([]);
  });
});
