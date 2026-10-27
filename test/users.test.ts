import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { MAX_MEMBERS } from '../src/domain/rules.ts';
import { activeMemberCount, createInvite, redeemInvite, setActive } from '../src/domain/users.ts';
import { DAY } from '../src/time.ts';
import { T0, addUser, setup } from './helpers.ts';

const newbie = (name: string) => ({ name, passwordHash: 'hash', adult: true });

describe('member cap', () => {
  it('stops at 50 active members', () => {
    const { db, ids } = setup(MAX_MEMBERS - 1);
    const invite = createInvite(db, ids[0], T0);
    const spare = createInvite(db, ids[0], T0);
    redeemInvite(db, invite.token, newbie('Fiftieth'), T0);
    expect(activeMemberCount(db)).toBe(50);

    expect(() => createInvite(db, ids[0], T0)).toThrow(/full/);
    expect(() => redeemInvite(db, spare.token, newbie('Fifty-first'), T0)).toThrow(/full/);
    expect(() => addUser(db, 'Sneaky')).toThrow(/full/);
    expect(activeMemberCount(db)).toBe(50);
  });

  it('frees a seat when a member is deactivated, and blocks reactivation when full', () => {
    const { db, ids } = setup(MAX_MEMBERS);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ids[0]);
    setActive(db, ids[0], ids[1], false);
    addUser(db, 'Replacement');
    expect(() => setActive(db, ids[0], ids[1], true)).toThrow(/full/);
  });
});

describe('invites', () => {
  it('are single-use', () => {
    const { db, ids } = setup(2);
    const inv = createInvite(db, ids[0], T0);
    redeemInvite(db, inv.token, newbie('Gina'), T0);
    expect(() => redeemInvite(db, inv.token, newbie('Hank'), T0)).toThrow(/already been used/);
  });

  it('expire after 7 days', () => {
    const { db, ids } = setup(1);
    const inv = createInvite(db, ids[0], T0);
    expect(() => redeemInvite(db, inv.token, newbie('Late'), T0 + 7 * DAY)).toThrow(/expired/);
  });

  it('require an 18+ confirmation and a unique name', () => {
    const { db, ids } = setup(1);
    const inv = createInvite(db, ids[0], T0);
    expect(() => redeemInvite(db, inv.token, { ...newbie('Kid'), adult: false }, T0)).toThrow(/18/);
    expect(() => redeemInvite(db, inv.token, newbie('user1'), T0)).toThrow(/taken/);
    redeemInvite(db, inv.token, newbie('Ivy'), T0); // the failed attempts did not use it up
  });

  it('only work while the inviter is active', () => {
    const { db, ids } = setup(2);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ids[0]);
    const inv = createInvite(db, ids[1], T0);
    setActive(db, ids[0], ids[1], false);
    expect(() => redeemInvite(db, inv.token, newbie('Jo'), T0)).toThrow(/no longer valid/);
  });
});

describe('admin', () => {
  it('only the admin can deactivate, and not themselves', () => {
    const db = openDb(':memory:');
    const admin = addUser(db, 'Admin');
    const bob = addUser(db, 'Bob');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin);
    expect(() => setActive(db, bob, admin, false)).toThrow(/Only the admin/);
    expect(() => setActive(db, admin, admin, false)).toThrow(/yourself/);
  });
});
