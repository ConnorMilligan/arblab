import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { MAX_MEMBERS } from '../src/domain/rules.ts';
import {
  activeMemberCount,
  createUser,
  getUser,
  getUserByAuthName,
  linkAuthUsername,
  setActive,
  setAdmin,
  setOwner,
} from '../src/domain/users.ts';
import { T0, addUser, setup } from './helpers.ts';

describe('member cap', () => {
  it('stops at 50 active members', () => {
    const { db } = setup(MAX_MEMBERS);
    expect(activeMemberCount(db)).toBe(50);
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

describe('joining', () => {
  it('requires an 18+ confirmation, a unique name and a login with no account yet', () => {
    const { db } = setup(1);
    expect(() => createUser(db, { name: 'Kid', authUsername: 'kid', adult: false }, T0)).toThrow(/18/);
    expect(() => createUser(db, { name: 'user1', authUsername: 'someone', adult: true }, T0)).toThrow(/taken/);
    expect(() => createUser(db, { name: 'Someone', authUsername: 'USER1', adult: true }, T0)).toThrow(/already has an account/);
  });
});

describe('linking a login', () => {
  it('lets a member from before Authelia sign in as a login, once each way', () => {
    const { db, ids } = setup(1);
    db.prepare("INSERT INTO users (display_name, adult_confirmed_at, created_at) VALUES ('Old Timer', ?, ?)").run(T0, T0);
    const old = (db.prepare("SELECT id FROM users WHERE display_name = 'Old Timer'").get() as { id: number }).id;
    expect(() => linkAuthUsername(db, old, 'user1')).toThrow(/already has an account/);
    linkAuthUsername(db, old, 'oldtimer');
    expect(getUserByAuthName(db, 'OldTimer')!.id).toBe(old);
    expect(() => linkAuthUsername(db, old, 'other')).toThrow(/already linked/);
    expect(() => linkAuthUsername(db, ids[0], 'other')).toThrow(/already linked/);
  });
});

describe('admin', () => {
  it('only the admin can deactivate, and not themselves', () => {
    const db = openDb(':memory:');
    const admin = addUser(db, 'Admin');
    const bob = addUser(db, 'Bob');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin);
    expect(() => setActive(db, bob, admin, false)).toThrow(/Only an admin/);
    expect(() => setActive(db, admin, admin, false)).toThrow(/yourself/);
  });
});

describe('migrations', () => {
  it('drops passwords, sessions, invites and reset links from a database made before Authelia, keeping members', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dannymarket-')), 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, adult_confirmed_at INTEGER NOT NULL,
      invited_by INTEGER REFERENCES users(id), session_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL)');
    old.exec('CREATE TABLE invites (id INTEGER PRIMARY KEY, token TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id))');
    old.exec("INSERT INTO users (display_name, password_hash, is_admin, adult_confirmed_at, created_at) VALUES ('connor', '$2b$hash', 1, 1, 1)");
    old.exec("INSERT INTO sessions VALUES ('s1', 1, 1)");
    old.close();

    const db = openDb(path);
    const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('password_hash');
    expect(cols).not.toContain('session_version');
    expect(cols).toContain('auth_username');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain('sessions');
    expect(tables).not.toContain('invites');
    expect(db.prepare('SELECT display_name, is_admin, is_owner, auth_username FROM users').get()).toEqual({
      display_name: 'connor',
      is_admin: 1,
      is_owner: 1, // the longest-standing admin becomes the owner
      auth_username: null,
    });
    db.close();
  });
});

describe('the owner and admins', () => {
  /** User1 owns the group, User2 is an admin, User3 and User4 are members. */
  function group() {
    const g = setup(4);
    g.db.prepare('UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?').run(g.ids[0]);
    g.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(g.ids[1]);
    return { db: g.db, owner: g.ids[0], admin: g.ids[1], cara: g.ids[2], dan: g.ids[3] };
  }

  it('only the owner appoints and removes admins', () => {
    const { db, owner, admin, cara } = group();
    expect(() => setAdmin(db, admin, cara, true)).toThrow(/Only the owner/);
    setAdmin(db, owner, cara, true);
    expect(getUser(db, cara)!.is_admin).toBe(1);
    setAdmin(db, owner, cara, false);
    expect(getUser(db, cara)!.is_admin).toBe(0);
    expect(() => setAdmin(db, owner, owner, false)).toThrow(/always an admin/);
  });

  it('stops an admin taking over: they can deactivate members, but not admins or the owner', () => {
    const { db, owner, admin, cara } = group();
    setAdmin(db, owner, cara, true);
    expect(() => setActive(db, admin, cara, false)).toThrow(/Only the owner can deactivate an admin/);
    expect(() => setActive(db, admin, owner, false)).toThrow(/owner cannot be deactivated/);
    expect(() => setAdmin(db, admin, owner, false)).toThrow(/Only the owner/);
    setActive(db, owner, cara, false); // the owner can
    expect(getUser(db, cara)!.is_active).toBe(0);
    expect(() => setAdmin(db, owner, cara, true)).toThrow(/active/);
  });

  it('lets admins deactivate ordinary members', () => {
    const { db, admin, dan } = group();
    setActive(db, admin, dan, false);
    expect(getUser(db, dan)!.is_active).toBe(0);
  });

  it('hands ownership over from the server, keeping the old owner an admin', () => {
    const { db, owner, cara } = group();
    setOwner(db, cara);
    expect(getUser(db, cara)).toMatchObject({ is_owner: 1, is_admin: 1 });
    expect(getUser(db, owner)).toMatchObject({ is_owner: 0, is_admin: 1 });
    expect(() => db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(owner)).toThrow(/UNIQUE/); // only ever one
  });
});
