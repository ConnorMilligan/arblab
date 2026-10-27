import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

// All times are integer milliseconds since the epoch (UTC).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  adult_confirmed_at INTEGER NOT NULL,
  invited_by INTEGER REFERENCES users(id),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per login. The cookie names a row, so logging out revokes it server-side.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- Admin-issued, single-use password reset links. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  used_by INTEGER UNIQUE REFERENCES users(id),
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  criteria TEXT NOT NULL,
  evidence_source TEXT NOT NULL,
  close_at INTEGER NOT NULL,
  subject_id INTEGER REFERENCES users(id),
  subject_opted_in_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'proposed', 'disputed', 'resolved')),
  outcome TEXT CHECK (outcome IN ('YES', 'NO', 'VOID')),
  resolution_note TEXT,
  resolved_at INTEGER,
  attestation TEXT NOT NULL,
  attested_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((status = 'resolved') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS markets_status ON markets(status);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id);

-- Every balance change. Balances are SUM(amount); rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('allowance', 'stake', 'winnings', 'refund', 'bond', 'bond_return', 'jury_reward')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  market_id INTEGER REFERENCES markets(id),
  created_at INTEGER NOT NULL,
  CHECK ((type IN ('stake', 'bond')) = (amount < 0)),
  CHECK ((type = 'allowance') = (market_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS ledger_market ON ledger(market_id);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

-- One row per member per week, so the Monday allowance is granted at most once.
CREATE TABLE IF NOT EXISTS allowances (
  user_id INTEGER NOT NULL REFERENCES users(id),
  week_start INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS proposals (
  market_id INTEGER PRIMARY KEY REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO', 'VOID')),
  note TEXT NOT NULL,
  bond INTEGER NOT NULL CHECK (bond > 0),
  created_at INTEGER NOT NULL,
  challenge_ends_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  market_id INTEGER PRIMARY KEY REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  bond INTEGER NOT NULL CHECK (bond > 0),
  created_at INTEGER NOT NULL,
  voting_ends_at INTEGER NOT NULL,
  closed_at INTEGER,
  jury_outcome TEXT CHECK (jury_outcome IN ('YES', 'NO', 'VOID'))
);
CREATE INDEX IF NOT EXISTS disputes_user ON disputes(user_id, created_at);

CREATE TABLE IF NOT EXISTS jurors (
  market_id INTEGER NOT NULL REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  drawn_at INTEGER NOT NULL,
  vote TEXT CHECK (vote IN ('YES', 'NO', 'VOID')),
  voted_at INTEGER,
  PRIMARY KEY (market_id, user_id)
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
