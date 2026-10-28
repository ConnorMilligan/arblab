import type { DB } from '../db.ts';
import { grantWeeklyAllowance } from './points.ts';
import { MAX_MEMBERS, cleanText, rule } from './rules.ts';

/** Members sign in through Authelia; `auth_username` is their login there (NULL until a pre-Authelia member is linked). */
export interface User {
  id: number;
  display_name: string;
  is_admin: number;
  /** The owner is also an admin, and the only one who can appoint, remove or deactivate admins. */
  is_owner: number;
  is_active: number;
  auth_username: string | null;
  created_at: number;
}

export function getUser(db: DB, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByName(db: DB, name: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE display_name = ?').get(name.trim()) as User | undefined;
}

/** The member who signs in through Authelia as `authName` (its Remote-User). */
export function getUserByAuthName(db: DB, authName: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE auth_username = ? COLLATE NOCASE').get(authName) as User | undefined;
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

/** Inserts a member, enforcing the cap, and grants this week's allowance. Call inside a transaction. */
export function createUser(
  db: DB,
  /** `isOwner` makes them the owner (and an admin): the first person to join a new group. */
  opts: { name: string; authUsername: string; isAdmin?: boolean; isOwner?: boolean; adult: boolean },
  now: number,
): number {
  const name = validateDisplayName(opts.name);
  rule(opts.adult, 'You must confirm you are 18 or older.');
  rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members).`);
  rule(!getUserByName(db, name), 'That display name is taken.');
  rule(!getUserByAuthName(db, opts.authUsername), 'That login already has an account.');
  const res = db
    .prepare('INSERT INTO users (display_name, is_admin, is_owner, adult_confirmed_at, auth_username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, opts.isAdmin || opts.isOwner ? 1 : 0, opts.isOwner ? 1 : 0, now, opts.authUsername, now);
  const id = Number(res.lastInsertRowid);
  grantWeeklyAllowance(db, id, now);
  claimSubjectMarkets(db, id, opts.authUsername);
  return id;
}

/** Markets that named this login as their subject before the person joined become theirs to opt in to. */
function claimSubjectMarkets(db: DB, userId: number, authName: string): void {
  db.prepare('UPDATE markets SET subject_id = ? WHERE subject_id IS NULL AND subject_login = ? COLLATE NOCASE').run(userId, authName);
}

/** From now on `userId` signs in through Authelia as `authName`. Each side can be linked once. */
export function linkAuthUsername(db: DB, userId: number, authName: string): void {
  const user = getUser(db, userId);
  rule(user, 'No such member.');
  rule(user.auth_username === null, `${user.display_name} is already linked to the login "${user.auth_username}".`);
  rule(!getUserByAuthName(db, authName), `The login "${authName}" already has an account.`);
  db.prepare('UPDATE users SET auth_username = ? WHERE id = ?').run(authName, userId);
  claimSubjectMarkets(db, userId, authName);
}

/** Admins deactivate members; only the owner deactivates admins, and nobody deactivates the owner. */
export function setActive(db: DB, actorId: number, targetId: number, active: boolean): void {
  const actor = getUser(db, actorId);
  rule(actor?.is_admin, 'Only an admin can do that.');
  rule(actorId !== targetId, 'You cannot deactivate yourself.');
  const target = getUser(db, targetId);
  rule(target, 'No such member.');
  rule(!target.is_owner, 'The owner cannot be deactivated.');
  if (target.is_admin) rule(actor.is_owner, 'Only the owner can deactivate an admin.');
  if (active) rule(activeMemberCount(db) < MAX_MEMBERS, `The group is full (${MAX_MEMBERS} members).`);
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, targetId);
}

/**
 * The owner makes another active member an admin, or takes that away, so no admin can remove the others and
 * take over. The owner stays an admin.
 */
export function setAdmin(db: DB, actorId: number, targetId: number, admin: boolean): void {
  const actor = getUser(db, actorId);
  rule(actor?.is_owner && actor.is_active, 'Only the owner can appoint or remove admins.');
  const target = getUser(db, targetId);
  rule(target, 'No such member.');
  rule(!target.is_owner, 'The owner is always an admin.');
  if (admin) rule(target.is_active, 'Only active members can be made admins.');
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(admin ? 1 : 0, targetId);
}

/** Hands the group to another active member (from the server only). The previous owner stays an admin. */
export function setOwner(db: DB, targetId: number): void {
  const target = getUser(db, targetId);
  rule(target?.is_active, 'Only an active member can be the owner.');
  db.transaction(() => {
    db.prepare('UPDATE users SET is_owner = 0 WHERE is_owner = 1').run();
    db.prepare('UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?').run(targetId);
  })();
}

export interface MemberRow {
  id: number;
  display_name: string;
  is_admin: number;
  is_owner: number;
  is_active: number;
  created_at: number;
}

export function listMembers(db: DB): MemberRow[] {
  return db
    .prepare('SELECT id, display_name, is_admin, is_owner, is_active, created_at FROM users ORDER BY is_active DESC, display_name')
    .all() as MemberRow[];
}
