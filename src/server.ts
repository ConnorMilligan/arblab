import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { fileDirectory } from './directory.ts';
import { tick } from './domain/tick.ts';

const production = process.env.NODE_ENV === 'production';
const dbPath = process.env.DATABASE_PATH ?? 'data/arblab.db';

// Cookies are HTTPS-only in production; SECURE_COOKIES=false allows plain HTTP (e.g. a LAN-only container).
const secureCookies = process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES !== 'false' : production;

// Authelia signs people in; Caddy passes the login in this header.
const userHeader = process.env.USER_HEADER || 'Remote-User';

// Everyone with an Authelia login, as copied out by the helper container (src/authelia-users.ts).
const directoryPath = process.env.AUTHELIA_USERS_JSON;

const db = openDb(dbPath);
const app = createApp({
  db,
  secureCookies,
  userHeader,
  logoutUrl: process.env.LOGOUT_URL || undefined,
  directory: directoryPath ? fileDirectory(directoryPath) : undefined,
});

// For development without Authelia: DEV_USER=alice signs every request in as that login.
const devUser = production ? undefined : process.env.DEV_USER;
const fetch = devUser
  ? (req: Request) => {
      const signedIn = new Request(req);
      signedIn.headers.set(userHeader, devUser);
      return app.fetch(signedIn);
    }
  : app.fetch;
if (devUser) console.warn(`DEV_USER: every request is signed in as "${devUser}".`);

// Deadlines are also checked before every request; this catches quiet periods and draws raffles promptly.
const timer = setInterval(() => {
  try {
    tick(db, Date.now());
  } catch (err) {
    console.error('tick failed', err);
  }
}, 5_000);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch, port }, (info) => console.log(`Listening on http://localhost:${info.port} (db: ${dbPath})`));

// better-sqlite3 is synchronous, so no transaction can be half-done when a signal arrives.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
