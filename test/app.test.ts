import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { type DB, openDb } from '../src/db.ts';
import { getMarket } from '../src/domain/markets.ts';
import { balanceOf } from '../src/domain/points.ts';
import { ATTESTATIONS } from '../src/domain/rules.ts';
import { createUser, getUserByName } from '../src/domain/users.ts';
import { seedDemo } from '../src/seed.ts';
import { DAY } from '../src/time.ts';
import { T0 } from './helpers.ts';

const HOST = 'arblab.test';
const PASSWORD = 'correct horse';
const hash = bcrypt.hashSync(PASSWORD, 4);

let db: DB;
let now: number;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  app = createApp({ db, secret: 'test-secret-test-secret-test-secret', clock: () => now, bcryptCost: 4, rng: () => 0 });
});

/** A browser-ish client: keeps cookies and sends same-origin form posts. */
function client() {
  const jar = new Map<string, string>();
  async function send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('host', HOST);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await app.request(`http://${HOST}${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/max-age=0/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  return {
    get: (path: string) => send(path),
    text: async (path: string) => (await send(path)).text(),
    post: (path: string, form: Record<string, string | string[]>, origin = `http://${HOST}`) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
      return send(path, { method: 'POST', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } });
    },
    async login(name: string) {
      const res = await this.post('/login', { name, password: PASSWORD });
      expect(res.status).toBe(303);
    },
  };
}

function member(name: string, admin = false): number {
  return createUser(db, { name, passwordHash: hash, isAdmin: admin, adult: true }, now);
}

const marketForm = (extra: Record<string, string> = {}) => ({
  question: 'Will Sam finish the crossword today?',
  criteria: 'YES if Sam posts a completed grid in the chat.',
  evidence_source: 'The group chat',
  close_at_ms: String(T0 + DAY),
  attest: ATTESTATIONS.map((a) => a.key),
  ...extra,
});

describe('access', () => {
  it('sends visitors to the login page, except for the House Rules', async () => {
    const c = client();
    expect((await c.get('/')).headers.get('location')).toBe('/login');
    expect((await c.get('/markets/1')).status).toBe(303);
    expect(await c.text('/rules')).toContain('no cash value');
  });

  it('rejects wrong passwords and deactivated members', async () => {
    member('Admin', true);
    const bob = member('Bob');
    const c = client();
    expect((await c.post('/login', { name: 'Bob', password: 'nope' })).status).toBe(401);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(bob);
    expect((await c.post('/login', { name: 'Bob', password: PASSWORD })).status).toBe(403);
  });

  it('logs a member out everywhere once deactivated', async () => {
    member('Admin', true);
    member('Bob');
    const bob = client();
    await bob.login('Bob');
    expect((await bob.get('/')).status).toBe(200);
    const a = client();
    await a.login('Admin');
    await a.post(`/members/${getUserByName(db, 'Bob')!.id}/deactivate`, {});
    expect((await bob.get('/')).status).toBe(303);
  });

  it('blocks cross-site form posts', async () => {
    member('Admin', true);
    const c = client();
    await c.login('Admin');
    const res = await c.post('/invites', {}, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({ n: 0 });
  });
});

describe('invites over HTTP', () => {
  it('lets a member invite a friend who signs up once', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    await a.post('/invites', {});
    const page = await a.text('/members');
    const token = page.match(/\/invite\/([\w-]+)/)![1];
    expect(page).toContain(`http://${HOST}/invite/${token}`);

    const friend = client();
    expect(await friend.text(`/invite/${token}`)).toContain('I confirm I am 18 or older');
    const noAdult = await friend.post(`/invite/${token}`, { name: 'Newbie', password: 'long enough' });
    expect(noAdult.status).toBe(400);
    const ok = await friend.post(`/invite/${token}`, { name: 'Newbie', password: 'long enough', adult: 'yes' });
    expect(ok.status).toBe(303);
    expect(await friend.text('/')).toContain('Log out Newbie');
    expect(balanceOf(db, getUserByName(db, 'Newbie')!.id)).toBe(1000);

    const again = await client().post(`/invite/${token}`, { name: 'Second', password: 'long enough', adult: 'yes' });
    expect(again.status).toBe(404);
    expect(getUserByName(db, 'Second')).toBeUndefined();
  });
});

describe('markets over HTTP', () => {
  it('enforces the subject betting block on the server', async () => {
    member('Admin', true);
    const sam = member('Sam');
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm({ subject_id: String(sam) }));
    const id = Number(created.headers.get('location')!.split('/').pop());
    expect(getMarket(db, id).status).toBe('pending');

    const s = client();
    await s.login('Sam');
    await s.post(`/markets/${id}/subject`, { answer: 'accept' });
    expect(getMarket(db, id).status).toBe('open');
    expect(await s.text(`/markets/${id}`)).not.toContain('Place a bet');

    // Hand-crafted POST that the UI never offers:
    await s.post(`/markets/${id}/bet`, { side: 'YES', amount: '100' });
    expect(await s.text(`/markets/${id}`)).toContain('you cannot bet on it');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bets').get()).toEqual({ n: 0 });
    expect(balanceOf(db, sam)).toBe(1000);
  });

  it('requires the checklist and keeps the form filled in on error', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const res = await a.post('/markets', marketForm({ attest: 'no_harm' }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Tick every item on the checklist');
    expect(body).toContain('Will Sam finish the crossword today?');
  });

  it('escapes member-written text', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm({ question: '<script>alert(1)</script> will it?' }));
    const page = await a.text(created.headers.get('location')!);
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('applies deadlines lazily on the next request', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm());
    const id = Number(created.headers.get('location')!.split('/').pop());
    now = T0 + 9 * DAY; // closed and 7 days without a proposal, with no timer running
    expect(await a.text(`/markets/${id}`)).toContain('Resolved VOID');
  });
});

describe('copy', () => {
  it('never mentions money anywhere in the app', async () => {
    seedDemo(db, now, hash);
    const a = client();
    expect(await a.text('/login')).not.toMatch(/\p{Sc}/u);
    await a.login('Alice');
    await a.post('/invites', {});
    const token = (await a.text('/members')).match(/\/invite\/([\w-]+)/)![1];
    const paths = [
      '/', '/?tab=awaiting', '/?tab=resolved', '/markets/1', '/markets/2', '/markets/3', '/markets/new',
      '/me', '/leaderboard', '/leaderboard?view=all', '/members', '/rules', `/invite/${token}`, '/nope',
    ];
    const banned = /\p{Sc}|\b(owes?|owed|settle up|dollars?|usd|wallet|payments?|venmo|paypal)\b/iu;
    for (const p of paths) {
      const page = await a.text(p);
      expect(page, p).toContain('<footer>');
      expect(page.match(banned), p).toBeNull();
    }
  });
});
