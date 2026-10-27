import { randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import { grantWeeklyAllowance } from './points.ts';
import { INVITE_TTL, MAX_MEMBERS, RuleError, cleanText, rule } from './rules.ts';

export interface User {
  id: number;
  display_name: string;
  password_hash: string;
  is_admin: number;
  is_active: number;
  session_version: number;
  created_at: number;
}

export interface Invite {
  id: number;
  token: string;
  created_by: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  used_by: number | null;
  used_at: number | null;
}

export function getUser(db: DB, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByName(db: DB, name: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE display_name = ?').get(name.trim()) as User | undefined;
}

export function activeMemberCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get() as { n: number }).n;
}

export function validateDisplayName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  cleanText(name, 'Display name', 2, 24);
  rule(/^[\p{L}\p{N} ._'-]+$/u.test(name), 'Display name may only use letters, numbers, spaces and . _ \' -');
  return name;
}

export function validatePassword(pw: string): void {
  rule(pw.length >= 8, 'Password must be at least 8 characters.');
  rule(pw.length <= 200, 'Password is too long.');
}

/** Inserts a member, enforcing the cap, and grants this week's allowance. Call inside a transaction. */
export function createUser(
  db: DB,
  opts: { name: string; passwordHash: string; isAdmin?: boolean; invitedBy?: number | null; adult: boolean },
  now: number,
): number {
  const name = validateDisplayName(opts.name);
  rule(opts.adult, 'You must confirm you are 18 or older.');
  rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members).`);
  rule(!getUserByName(db, name), 'That display name is taken.');
  const res = db
    .prepare(
      `INSERT INTO users (display_name, password_hash, is_admin, adult_confirmed_at, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, opts.passwordHash, opts.isAdmin ? 1 : 0, now, opts.invitedBy ?? null, now);
  const id = Number(res.lastInsertRowid);
  grantWeeklyAllowance(db, id, now);
  return id;
}

export function createInvite(db: DB, userId: number, now: number): Invite {
  rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members), so no new invites.`);
  const token = randomBytes(18).toString('base64url');
  const res = db
    .prepare('INSERT INTO invites (token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + INVITE_TTL);
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(res.lastInsertRowid) as Invite;
}

/** Returns the invite if it can still be used, otherwise throws a RuleError explaining why. */
export function usableInvite(db: DB, token: string, now: number): Invite {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as Invite | undefined;
  rule(inv, 'This invite link is not valid.');
  rule(inv.used_by === null, 'This invite link has already been used.');
  rule(inv.revoked_at === null, 'This invite link was revoked.');
  rule(inv.expires_at > now, 'This invite link has expired. Ask for a new one.');
  rule(getUser(db, inv.created_by)?.is_active, 'This invite link is no longer valid.');
  rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members).`);
  return inv;
}

/** Single-use: the invite is claimed and the member created in one transaction. */
export function redeemInvite(
  db: DB,
  token: string,
  opts: { name: string; passwordHash: string; adult: boolean },
  now: number,
): number {
  return db.transaction(() => {
    const inv = usableInvite(db, token, now);
    const userId = createUser(db, { ...opts, invitedBy: inv.created_by }, now);
    const claimed = db
      .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL')
      .run(userId, now, inv.id);
    if (claimed.changes !== 1) throw new RuleError('This invite link has already been used.');
    return userId;
  })();
}

export function revokeInvite(db: DB, userId: number, inviteId: number, now: number): void {
  const res = db
    .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND created_by = ? AND used_by IS NULL AND revoked_at IS NULL')
    .run(now, inviteId, userId);
  rule(res.changes === 1, 'That invite cannot be revoked.');
}

export function openInvites(db: DB, userId: number, now: number): Invite[] {
  return db
    .prepare(
      `SELECT * FROM invites WHERE created_by = ? AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY id DESC`,
    )
    .all(userId, now) as Invite[];
}

export function setActive(db: DB, actorId: number, targetId: number, active: boolean): void {
  rule(getUser(db, actorId)?.is_admin, 'Only the admin can do that.');
  rule(actorId !== targetId, 'You cannot deactivate yourself.');
  const target = getUser(db, targetId);
  rule(target, 'No such member.');
  if (active) rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members).`);
  db.prepare('UPDATE users SET is_active = ?, session_version = session_version + 1 WHERE id = ?').run(
    active ? 1 : 0,
    targetId,
  );
}

export function setPasswordHash(db: DB, userId: number, hash: string): void {
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(hash, userId);
}

export interface MemberRow {
  id: number;
  display_name: string;
  is_admin: number;
  is_active: number;
  created_at: number;
  invited_by_name: string | null;
}

export function listMembers(db: DB): MemberRow[] {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.is_admin, u.is_active, u.created_at, i.display_name AS invited_by_name
       FROM users u LEFT JOIN users i ON i.id = u.invited_by
       ORDER BY u.is_active DESC, u.display_name`,
    )
    .all() as MemberRow[];
}
