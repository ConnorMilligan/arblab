import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { type DB, openDb } from '../src/db.ts';
import { getMarket, marketIdFromUrl } from '../src/domain/markets.ts';
import { balanceOf } from '../src/domain/points.ts';
import { ATTESTATIONS } from '../src/domain/rules.ts';
import { createUser, getUserByName } from '../src/domain/users.ts';
import { seedDemo } from '../src/seed.ts';
import { DAY } from '../src/time.ts';
import { T0 } from './helpers.ts';

const HOST = 'dannymarket.test';
const LOGOUT = 'https://auth.dannymarket.test/logout';

let db: DB;
let now: number;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  app = createApp({ db, clock: () => now, rng: () => 0, logoutUrl: LOGOUT });
});

/**
 * A browser-ish client behind Authelia: keeps cookies, sends same-origin form posts, and after `login` carries
 * the Remote-User (and Remote-Name) headers Caddy adds for a signed-in login.
 */
function client() {
  const jar = new Map<string, string>();
  const auth: Record<string, string> = {};
  async function send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('host', HOST);
    for (const [k, v] of Object.entries(auth)) headers.set(k, v);
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
    /** Signs in to Authelia as `login` (members made by `member` use their name in lower case). */
    login(login: string, fullName?: string) {
      auth['remote-user'] = login.toLowerCase();
      if (fullName) auth['remote-name'] = fullName;
    },
  };
}

/** Every market's page, by its public id. */
const marketPaths = () => (db.prepare('SELECT public_id FROM markets ORDER BY id').all() as { public_id: string }[]).map((m) => `/markets/${m.public_id}`);

function member(name: string, admin = false): number {
  return createUser(db, { name, authUsername: name.toLowerCase(), isAdmin: admin, adult: true }, now);
}

const marketForm = (extra: Record<string, string> = {}) => ({
  question: 'Will Sam finish the crossword today?',
  criteria: 'YES if Sam posts a completed grid in the chat.',
  evidence_source: 'The group chat',
  close_local: '2026-10-27T12:00', // T0 + DAY
  timezone: 'UTC',
  attest: ATTESTATIONS.map((a) => a.key),
  ...extra,
});

describe('signing in through Authelia', () => {
  it('turns away requests without a login, except for the House Rules', async () => {
    const c = client();
    const res = await c.get('/');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in with your login for this server');
    expect((await c.get('/markets/1')).status).toBe(401);
    expect(await c.text('/rules')).toContain('no cash value');
  });

  it('signs a member in from the header, ignoring case', async () => {
    member('Bob');
    const c = client();
    c.login('BOB');
    const page = await c.text('/');
    expect(page).toContain(`<a href="${LOGOUT}">Log out Bob</a>`);
  });

  it('welcomes a new login: suggests their name, requires 18+, and gives them this week\'s points', async () => {
    member('Admin', true);
    const c = client();
    c.login('newbie', 'Nina Newbie');
    expect((await c.get('/')).headers.get('location')).toBe('/welcome');
    expect((await c.get('/markets/new')).headers.get('location')).toBe('/welcome');
    const page = await c.text('/welcome');
    expect(page).toContain('signed in as <b>newbie</b>');
    expect(page).toContain('value="Nina Newbie"');

    expect((await c.post('/welcome', { name: 'Nina Newbie' })).status).toBe(400);
    expect((await c.post('/welcome', { name: 'Admin', adult: 'yes' })).status).toBe(400); // name taken
    const ok = await c.post('/welcome', { name: 'Nina Newbie', adult: 'yes' });
    expect(ok.headers.get('location')).toBe('/');
    const nina = getUserByName(db, 'Nina Newbie')!;
    expect(nina).toMatchObject({ auth_username: 'newbie', is_admin: 0 });
    expect(balanceOf(db, nina.id)).toBe(1000);
    expect(await c.text('/')).toContain('Log out Nina Newbie');
    expect((await c.get('/welcome')).headers.get('location')).toBe('/'); // only once
  });

  it('keeps deactivated members out', async () => {
    member('Admin', true);
    const bob = member('Bob');
    const c = client();
    c.login('bob');
    expect((await c.get('/')).status).toBe(200);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(bob);
    expect((await c.get('/')).status).toBe(403);
    expect((await c.post('/welcome', { name: 'Bob Again', adult: 'yes' })).status).toBe(403);
  });

  it('has no passwords, invites or reset links any more', async () => {
    member('Admin', true);
    const c = client();
    c.login('admin');
    for (const path of ['/login', '/invite/abc', '/reset/abc']) expect((await c.get(path)).status, path).toBe(404);
    expect((await c.post('/invites', {})).status).toBe(404);
    const members = await c.text('/members');
    expect(members).not.toMatch(/invite|reset link/i);
    expect(await c.text('/me')).not.toContain('password');
  });

  it('lets the owner appoint admins from the Members page, and nobody else', async () => {
    const owner = createUser(db, { name: 'Owner', authUsername: 'owner', isOwner: true, adult: true }, now);
    const bob = member('Bob');
    const cara = member('Cara');
    const o = client();
    o.login('owner');
    expect(await o.text('/members')).toContain(`action="/members/${bob}/make-admin"`);
    await o.post(`/members/${bob}/make-admin`, {});
    expect(await o.text('/members')).toContain('Bob is now an admin.');

    const b = client();
    b.login('bob');
    const page = await b.text('/members');
    expect(page).not.toContain('make-admin');
    expect(page).not.toContain(`/members/${owner}/`); // no buttons on the owner's row
    expect(page).toContain(`action="/members/${cara}/deactivate"`);
    await b.post(`/members/${cara}/make-admin`, {}); // hand-crafted: refused on the server
    expect(await b.text('/members')).toContain('Only the owner can appoint or remove admins.');
  });

  it('makes the first person to join the owner', async () => {
    const c = client();
    c.login('first');
    await c.post('/welcome', { name: 'First One', adult: 'yes' });
    expect(getUserByName(db, 'First One')).toMatchObject({ is_owner: 1, is_admin: 1 });
  });

  it('rejects oversized request bodies', async () => {
    const c = client();
    c.login('newbie');
    const res = await c.post('/welcome', { name: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it('blocks cross-site form posts', async () => {
    member('Admin', true);
    const c = client();
    c.login('admin');
    const res = await c.post('/markets', marketForm(), 'https://evil.example');
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM markets').get()).toEqual({ n: 0 });
  });
});

describe('markets over HTTP', () => {
  it('enforces the subject betting block on the server', async () => {
    member('Admin', true);
    const sam = member('Sam');
    const a = client();
    a.login('Admin');
    const created = await a.post('/markets', marketForm({ subject_id: String(sam) }));
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(getMarket(db, id).status).toBe('pending');

    const s = client();
    s.login('Sam');
    await s.post(`${path}/subject`, { answer: 'accept' });
    expect(getMarket(db, id).status).toBe('open');
    expect(await s.text(path)).not.toContain('Place a bet');

    // Hand-crafted POST that the UI never offers:
    await s.post(`${path}/bet`, { side: 'YES', amount: '100' });
    expect(await s.text(path)).toContain('you cannot bet on it');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bets').get()).toEqual({ n: 0 });
    expect(balanceOf(db, sam)).toBe(1000);
  });

  it('requires the checklist and keeps the form filled in on error', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const res = await a.post('/markets', marketForm({ attest: 'no_harm' }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Tick every item on the checklist');
    expect(body).toContain('Will Sam finish the crossword today?');
  });

  it('escapes member-written text', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const created = await a.post('/markets', marketForm({ question: '<script>alert(1)</script> will it?' }));
    const page = await a.text(created.headers.get('location')!);
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reads the close time in the chosen zone and shows the market in it', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const created = await a.post('/markets', marketForm({ close_local: '2026-10-28T09:00', timezone: 'Asia/Tokyo' }));
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(getMarket(db, id)).toMatchObject({ close_at: Date.UTC(2026, 9, 28, 0), timezone: 'Asia/Tokyo' });
    const page = await a.text(path);
    expect(page).toContain('data-zone="Asia/Tokyo"');
    expect(page).toContain('Japan &amp; Korea Time');
  });

  it('rejects a time zone it does not know', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const res = await a.post('/markets', marketForm({ timezone: 'Mars/Olympus_Mons' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Pick a time zone');
  });

  it('offers one entry per time zone, with major cities, on the new market form', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const form = await a.text('/markets/new');
    expect(form).toContain('<option value="America/New_York" >UTC−04:00 Eastern Time (New York, Toronto, Miami, Atlanta)</option>');
    expect(form).toContain('<option value="UTC" selected>');
    expect(form).toContain('data-viewer-zone');
  });

  it('lets a market name someone with a login who has not joined, and asks them when they do', async () => {
    member('Admin', true);
    member('Sam');
    app = createApp({
      db,
      clock: () => now,
      directory: () => [
        { login: 'danny', name: 'Danny Smith' },
        { login: 'sam', name: 'Sam Jones' }, // already a member: not offered twice
      ],
    });
    const a = client();
    a.login('Admin');
    const form = await a.text('/markets/new');
    expect(form).toContain('<option value="login:danny" >Danny Smith (not joined yet)</option>');
    expect(form).not.toContain('login:sam');
    expect((await a.post('/markets', marketForm({ subject_id: 'login:nobody' }))).status).toBe(400);

    const created = await a.post('/markets', marketForm({ subject_id: 'login:danny' }));
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(await a.text(path)).toContain('Danny Smith (has not joined yet)');
    expect(await a.text('/')).toContain('Waiting for Danny Smith to opt in');

    const danny = client();
    danny.login('danny', 'Danny Smith');
    await danny.post('/welcome', { name: 'Danny Smith', adult: 'yes' });
    expect(await danny.text('/')).toContain('Needs you');
    await danny.post(`${path}/subject`, { answer: 'accept' });
    expect(getMarket(db, id).status).toBe('open');
  });

  it('deletes a market only with the box ticked, then hides it but keeps its page', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const created = await a.post('/markets', marketForm());
    const path = created.headers.get('location')!;
    expect(await a.text(path)).toContain('Delete this market');
    await a.post(`${path}/delete`, {});
    expect(await a.text(path)).toContain('Tick the box');
    await a.post(`${path}/delete`, { confirm: 'yes' });
    const page = await a.text(path);
    expect(page).toContain('Admin deleted this market');
    expect(page).not.toContain('Delete this market');
    expect(await a.text('/?tab=resolved')).not.toContain(path);
  });

  it('gives markets random ids, and sends links that use an old number to the new id', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const path = (await a.post('/markets', marketForm())).headers.get('location')!;
    expect(path).toMatch(/^\/markets\/[\w-]{8}$/);
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(await a.text(path)).not.toContain('Market #');
    expect((await a.get(`/markets/${id}`)).status).toBe(404); // new markets have no number to guess

    db.prepare('UPDATE markets SET old_number = 3 WHERE id = ?').run(id); // as if made before random ids
    const res = await a.get('/markets/3');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(path);
  });

  it('applies deadlines lazily on the next request', async () => {
    member('Admin', true);
    const a = client();
    a.login('Admin');
    const created = await a.post('/markets', marketForm());
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    now = T0 + 9 * DAY; // closed and 7 days without a proposal, with no timer running
    expect(await a.text(path)).toContain('Resolved VOID');
  });
});

describe('raffle', () => {
  it('lets members enter, draws when the minute ends, and refuses a bad entry', async () => {
    const a = member('Ann');
    const b = member('Bob');
    const ann = client();
    const bob = client();
    ann.login('Ann');
    bob.login('Bob');
    await ann.post('/raffle/enter', { amount: '300' });
    await bob.post('/raffle/enter', { amount: '200' });
    expect(await ann.text('/raffle')).toContain('Pot: <b>500 pts</b>');

    await bob.post('/raffle/enter', { amount: '5000' });
    await bob.get('/raffle/state'); // background polling must not swallow the message
    expect(await bob.text('/raffle')).toContain('Not enough points');

    const live = await ann.get('/raffle/state');
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect(await live.json()).toMatchObject({ left: 30_000, balance: 700, balanceText: '700 pts' });

    now += 30_000; // rng is 0, so the first ticket (Ann's) wins
    const page = await ann.text('/raffle');
    expect(page).toContain('Recent draws');
    expect(balanceOf(db, a)).toBe(1200);
    expect(balanceOf(db, b)).toBe(800);
  });
});

describe('copy', () => {
  it('never mentions money anywhere in the app', async () => {
    seedDemo(db, now);
    const newcomer = client();
    newcomer.login('newcomer');
    expect(await newcomer.text('/welcome')).not.toMatch(/\p{Sc}/u);
    const a = client();
    a.login('alice');
    const paths = [
      '/', '/?tab=awaiting', '/?tab=resolved', ...marketPaths(), '/markets/new',
      '/me', '/raffle', '/leaderboard', '/leaderboard?view=all', '/members', '/rules', '/nope',
    ];
    const banned = /\p{Sc}|\b(owes?|owed|settle up|dollars?|usd|wallet|payments?|venmo|paypal)\b/iu;
    for (const p of paths) {
      const res = await a.get(p);
      expect(res.status, p).toBe(p === '/nope' ? 404 : 200);
      const page = await res.text();
      expect(page, p).toContain('<footer>');
      expect(page.match(banned), p).toBeNull();
    }
  });
});
