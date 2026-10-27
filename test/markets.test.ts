import { describe, expect, it } from 'vitest';
import { createMarket, getMarket, placeBet, pools, respondAsSubject } from '../src/domain/markets.ts';
import { tick } from '../src/domain/tick.ts';
import { DAY } from '../src/time.ts';
import { T0, makeMarket, setup } from './helpers.ts';

describe('creating markets', () => {
  it('requires every checklist item and stores the attestation', () => {
    const { db, ids } = setup(1);
    const input = {
      question: 'Will it snow in town before New Year?',
      criteria: 'YES if the Met Office reports snow at the town station.',
      evidenceSource: 'Met Office',
      closeAt: T0 + DAY,
      subjectId: null,
    };
    expect(() => createMarket(db, ids[0], { ...input, attestations: ['no_harm', 'no_crime'] }, T0)).toThrow(/checklist/);
    const id = createMarket(db, ids[0], { ...input, attestations: ['no_harm', 'no_crime', 'no_minors'] }, T0);
    const m = getMarket(db, id);
    expect(JSON.parse(m.attestation)).toHaveLength(3);
    expect(m.attested_at).toBe(T0);
  });

  it('rejects money talk in market text', () => {
    const { db, ids } = setup(1);
    expect(() =>
      createMarket(
        db,
        ids[0],
        { question: 'Loser owes the winner $20?', criteria: 'Self-evident really', evidenceSource: 'Us', closeAt: T0 + DAY, subjectId: null, attestations: ['no_harm', 'no_crime', 'no_minors'] },
        T0,
      ),
    ).toThrow(/play points/);
  });
});

describe('subjects', () => {
  it('keeps the market pending until the subject opts in', () => {
    const { db, ids } = setup(3);
    const [creator, subject, other] = ids;
    const m = makeMarket(db, creator, { subjectId: subject });
    expect(getMarket(db, m).status).toBe('pending');
    expect(() => placeBet(db, m, other, 'YES', 10, T0)).toThrow(/opt in/);
    expect(() => respondAsSubject(db, m, other, true, T0)).toThrow(/Only the subject/);
    respondAsSubject(db, m, subject, true, T0);
    placeBet(db, m, other, 'YES', 10, T0);
    expect(pools(db, m).yes).toBe(10);
  });

  it('never lets the subject bet', () => {
    const { db, ids, bal } = setup(2);
    const [creator, subject] = ids;
    const m = makeMarket(db, creator, { subjectId: subject });
    respondAsSubject(db, m, subject, true, T0);
    expect(() => placeBet(db, m, subject, 'YES', 10, T0)).toThrow(/subject/);
    expect(() => placeBet(db, m, subject, 'NO', 10, T0)).toThrow(/subject/);
    expect(bal(subject)).toBe(1000);
    expect(pools(db, m).total).toBe(0);
  });

  it('treats naming yourself as opting in, and still blocks your bets', () => {
    const { db, ids } = setup(1);
    const m = makeMarket(db, ids[0], { subjectId: ids[0] });
    expect(getMarket(db, m).status).toBe('open');
    expect(() => placeBet(db, m, ids[0], 'YES', 10, T0)).toThrow(/subject/);
  });

  it('voids the market if the subject declines or never answers', () => {
    const { db, ids } = setup(2);
    const declined = makeMarket(db, ids[0], { subjectId: ids[1] });
    const ignored = makeMarket(db, ids[0], { subjectId: ids[1] });
    respondAsSubject(db, declined, ids[1], false, T0);
    expect(getMarket(db, declined)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    tick(db, T0 + DAY);
    expect(getMarket(db, ignored)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
  });
});

describe('betting', () => {
  it('debits the stake and refuses to overdraw', () => {
    const { db, ids, bal } = setup(1);
    const m = makeMarket(db, ids[0]);
    placeBet(db, m, ids[0], 'NO', 400, T0);
    expect(bal(ids[0])).toBe(600);
    expect(() => placeBet(db, m, ids[0], 'NO', 601, T0)).toThrow(/Not enough points/);
    expect(() => placeBet(db, m, ids[0], 'NO', 1.5, T0)).toThrow(/whole number/);
    expect(() => placeBet(db, m, ids[0], 'NO', 0, T0)).toThrow(/whole number/);
  });

  it('stops at the close time even before the tick has run', () => {
    const { db, ids } = setup(1);
    const m = makeMarket(db, ids[0]);
    expect(() => placeBet(db, m, ids[0], 'YES', 10, T0 + DAY)).toThrow(/closed/);
  });

  it('refuses deactivated members', () => {
    const { db, ids } = setup(2);
    const m = makeMarket(db, ids[0]);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ids[1]);
    expect(() => placeBet(db, m, ids[1], 'YES', 10, T0)).toThrow(/not active/);
  });
});
