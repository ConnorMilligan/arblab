import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileDirectory, parseAutheliaUsers } from '../src/directory.ts';

const USERS = `# Authelia users
users:
  danny:
    disabled: false
    displayname: "Danny Smith"
    password: "$argon2id$v=19$m=65536,t=3,p=4$not-a-real-hash"
    email: danny@example.com
    groups:
      - admins
      - wiki_admin
  'old.friend':
    disabled: true
    displayname: 'Old Friend'
    password: "$argon2id$hash"
  sam:   # no display name
    password: "$argon2id$hash"
  o_neil:
    displayname: 'Pat O''Neil'  # quoted with an escaped quote
    password: "$argon2id$hash"
`;

describe('Authelia users file', () => {
  it('keeps the login and full name of each enabled user, and nothing else', () => {
    expect(parseAutheliaUsers(USERS)).toEqual([
      { login: 'danny', name: 'Danny Smith' },
      { login: 'o_neil', name: "Pat O'Neil" },
      { login: 'sam', name: 'sam' },
    ]);
    expect(JSON.stringify(parseAutheliaUsers(USERS))).not.toMatch(/argon|@|admins/);
  });

  it('handles four-space indents and an empty file', () => {
    expect(parseAutheliaUsers('users:\n    ann:\n        displayname: Ann Lee\n')).toEqual([{ login: 'ann', name: 'Ann Lee' }]);
    expect(parseAutheliaUsers('')).toEqual([]);
    expect(parseAutheliaUsers('users: {}\n')).toEqual([]);
  });

  it('reads the copied list again when it changes, and treats a missing file as nobody', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dannymarket-')), 'users.json');
    const read = fileDirectory(path);
    expect(read()).toEqual([]);
    writeFileSync(path, JSON.stringify([{ login: 'ann', name: 'Ann' }, { bogus: true }]));
    expect(read()).toEqual([{ login: 'ann', name: 'Ann' }]);
  });
});
