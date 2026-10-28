import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { tick } from '../src/domain/tick.ts';
import { seedDemo } from '../src/seed.ts';
import { DAY } from '../src/time.ts';
import { T0 } from './helpers.ts';

describe('seed-demo', () => {
  it('creates 6 members and 3 markets in different states', () => {
    const db = openDb(':memory:');
    seedDemo(db, T0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 6 });
    expect(db.prepare('SELECT status FROM markets ORDER BY id').all()).toEqual([
      { status: 'proposed' },
      { status: 'open' },
      { status: 'open' },
    ]);
    // Ledger ids follow time order, and nobody is overdrawn.
    const times = db.prepare('SELECT created_at FROM ledger ORDER BY id').all() as { created_at: number }[];
    expect(times.map((t) => t.created_at)).toEqual([...times.map((t) => t.created_at)].sort((a, b) => a - b));
    tick(db, T0 + DAY); // the proposal stands after 24h
    expect(db.prepare('SELECT outcome FROM markets WHERE id = 1').get()).toEqual({ outcome: 'YES' });
  });
});
