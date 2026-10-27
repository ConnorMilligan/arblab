import bcrypt from 'bcryptjs';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from './db.ts';
import {
  type MarketGroup,
  betsFor,
  createMarket,
  getMarketRow,
  listMarkets,
  pendingOptIns,
  placeBet,
  positionsFor,
  respondAsSubject,
  betList,
} from './domain/markets.ts';
import { computePayouts } from './domain/payout.ts';
import { balanceOf, ledgerFor, leaderboard, netForMarket } from './domain/points.ts';
import {
  type Rng,
  bondFor,
  castVote,
  dispute,
  disputesThisWeek,
  eligibleJurors,
  getDispute,
  getJurors,
  getProposal,
  juryDuty,
  jurySize,
  propose,
} from './domain/resolution.ts';
import { DISPUTES_PER_WEEK, RuleError, parseOutcome, parseSide } from './domain/rules.ts';
import { tick } from './domain/tick.ts';
import {
  type User,
  createInvite,
  getUser,
  getUserByName,
  listMembers,
  openInvites,
  redeemInvite,
  revokeInvite,
  setActive,
  setPasswordHash,
  usableInvite,
  validateDisplayName,
  validatePassword,
} from './domain/users.ts';
import { LoginLimiter } from './ratelimit.ts';
import { DAY, seasonOf } from './time.ts';
import { leaderboardPage, loginPage, mePage, membersPage, messagePage, rulesPage, signupPage } from './views/account.ts';
import type { Flash, PageCtx } from './views/layout.ts';
import { type TodoItem, marketPage, marketsPage, newMarketPage } from './views/markets.ts';

export interface AppOptions {
  db: DB;
  /** Signs the session cookie. */
  secret: string;
  secureCookies?: boolean;
  clock?: () => number;
  bcryptCost?: number;
  rng?: Rng;
  /** Public base URL used in invite links, e.g. https://arblab.fly.dev. Derived from the request if unset. */
  appUrl?: string;
}

type Env = { Variables: { now: number; user: User | null } };
type Form = Record<string, string | File | (string | File)[]>;

const SESSION_COOKIE = 'session';
const SESSION_TTL = 30 * DAY;
const PUBLIC_PATHS = [/^\/login$/, /^\/invite\/[\w-]+$/, /^\/rules$/];

const field = (form: Form, key: string): string => {
  const v = Array.isArray(form[key]) ? form[key][0] : form[key];
  return typeof v === 'string' ? v : '';
};
const fieldList = (form: Form, key: string): string[] =>
  [form[key] ?? []].flat().filter((v): v is string => typeof v === 'string');
const toInt = (s: string): number => (/^\s*\d{1,9}\s*$/.test(s) ? Number(s) : NaN);

export function createApp(opts: AppOptions): Hono<Env> {
  const { db, secret } = opts;
  const clock = opts.clock ?? Date.now;
  const cost = opts.bcryptCost ?? 11;
  const secure = opts.secureCookies ?? false;
  const prefix = secure ? 'host' : undefined; // __Host- cookies can't be set by sibling subdomains
  const dummyHash = bcrypt.hashSync('not-the-password', cost);
  const assets = {
    'style.css': { body: readFileSync(new URL('../public/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
    'app.js': { body: readFileSync(new URL('../public/app.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  };

  const limiter = new LoginLimiter();
  const app = new Hono<Env>();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
      referrerPolicy: 'same-origin',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
    }),
  );
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Request too large.', 413) }));

  app.get('/static/:file', (c) => {
    const asset = assets[c.req.param('file') as keyof typeof assets];
    if (!asset) return c.notFound();
    return c.body(asset.body, 200, { 'content-type': asset.type, 'cache-control': 'public, max-age=3600' });
  });
  app.get('/healthz', (c) => c.text('ok'));

  // Deadlines are applied lazily before every request (plus a timer in server.ts).
  app.use('*', async (c, next) => {
    const now = clock();
    c.set('now', now);
    try {
      tick(db, now);
    } catch (err) {
      console.error('tick failed', err);
    }
    if (c.req.method === 'POST' && !sameOrigin(c)) return c.text('Cross-site form posts are not allowed.', 403);
    c.set('user', await sessionUser(c, now));
    if (!c.get('user') && !PUBLIC_PATHS.some((p) => p.test(c.req.path))) return c.redirect('/login', 303);
    await next();
  });

  // ---- helpers ----

  /**
   * The address the limiter keys on. Requests that carry the host proxy's identity header use the
   * last X-Forwarded-For entry, because that proxy passes a client-sent Cf-Connecting-Ip through.
   * Everything else uses Cf-Connecting-Ip.
   */
  function clientIp(c: Context<Env>): string {
    if (c.req.header('tailscale-user-login')) return c.req.header('x-forwarded-for')?.split(',').pop()?.trim() || 'tailnet';
    return c.req.header('cf-connecting-ip') ?? 'local';
  }

  function sameOrigin(c: Context<Env>): boolean {
    const origin = c.req.header('origin');
    if (!origin) return true; // older browsers; the SameSite=Lax cookie still applies
    try {
      return new URL(origin).host === c.req.header('host');
    } catch {
      return false;
    }
  }

  async function readSession(c: Context<Env>): Promise<{ id: number; version: number; issuedAt: number; sid: string } | null> {
    const raw = await getSignedCookie(c, secret, SESSION_COOKIE, prefix);
    if (!raw) return null;
    const [id, version, issuedAt, sid] = raw.split(':');
    return sid ? { id: Number(id), version: Number(version), issuedAt: Number(issuedAt), sid } : null;
  }

  async function sessionUser(c: Context<Env>, now: number): Promise<User | null> {
    const s = await readSession(c);
    if (!s || !(s.issuedAt + SESSION_TTL > now)) return null;
    const live = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?').get(s.sid, s.id);
    const user = getUser(db, s.id);
    return live && user && user.is_active && user.session_version === s.version ? user : null;
  }

  async function startSession(c: Context<Env>, userId: number): Promise<void> {
    const u = getUser(db, userId)!;
    const now = c.get('now');
    const sid = randomBytes(24).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE created_at <= ?').run(now - SESSION_TTL);
    db.prepare('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)').run(sid, u.id, now);
    await setSignedCookie(c, SESSION_COOKIE, `${u.id}:${u.session_version}:${now}:${sid}`, secret, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
      prefix,
    });
  }

  function flash(c: Context<Env>, kind: Flash['kind'], message: string): void {
    setCookie(c, 'flash', JSON.stringify({ kind, message }), { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 60 });
  }

  function ctx(c: Context<Env>, override?: Flash): PageCtx {
    let f: Flash | null = override ?? null;
    const stored = getCookie(c, 'flash');
    if (stored) {
      deleteCookie(c, 'flash', { path: '/' });
      try {
        const parsed = JSON.parse(stored);
        if (!f && (parsed.kind === 'ok' || parsed.kind === 'error') && typeof parsed.message === 'string') f = parsed;
      } catch {
        // ignore a malformed flash
      }
    }
    const u = c.get('user');
    return {
      now: c.get('now'),
      flash: f,
      viewer: u ? { id: u.id, name: u.display_name, isAdmin: !!u.is_admin, balance: balanceOf(db, u.id) } : null,
    };
  }

  /** Runs a rule-checked change in one transaction, then redirects with a message. */
  async function act(c: Context<Env>, to: string, fn: (form: Form, user: User, now: number) => string): Promise<Response> {
    const form = await c.req.parseBody({ all: true });
    try {
      flash(c, 'ok', db.transaction(() => fn(form, c.get('user')!, c.get('now')))());
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      flash(c, 'error', err.message);
    }
    return c.redirect(to, 303);
  }

  function baseUrl(c: Context<Env>): string {
    if (opts.appUrl) return opts.appUrl.replace(/\/$/, '');
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    return `${proto}://${c.req.header('host')}`;
  }

  const marketId = (c: Context<Env>) => toInt(c.req.param('id') ?? '');

  // ---- login, invites, sign-up ----

  app.get('/login', (c) => (c.get('user') ? c.redirect('/') : c.html(loginPage(ctx(c)))));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const name = field(form, 'name');
    const wait = limiter.retryAfter(name, clientIp(c), c.get('now'));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.html(
        loginPage(ctx(c, { kind: 'error', message: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }), name),
        429,
      );
    }
    const user = getUserByName(db, name);
    const ok = await bcrypt.compare(field(form, 'password'), user?.password_hash ?? dummyHash);
    if (!user || !ok) {
      limiter.fail(name, clientIp(c), c.get('now'));
      return c.html(loginPage(ctx(c, { kind: 'error', message: 'Wrong name or password.' }), name), 401);
    }
    if (!user.is_active) return c.html(loginPage(ctx(c, { kind: 'error', message: 'This account has been deactivated.' }), name), 403);
    limiter.succeed(name, clientIp(c));
    await startSession(c, user.id);
    return c.redirect('/', 303);
  });

  app.post('/logout', async (c) => {
    const s = await readSession(c);
    if (s) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure, prefix });
    return c.redirect('/login', 303);
  });

  app.get('/invite/:token', (c) => {
    try {
      const inv = usableInvite(db, c.req.param('token'), c.get('now'));
      return c.html(signupPage(ctx(c), inv.token, getUser(db, inv.created_by)!.display_name));
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      return c.html(messagePage(ctx(c), 'Invite', err.message), 404);
    }
  });

  app.post('/invite/:token', async (c) => {
    const token = c.req.param('token');
    const form = await c.req.parseBody();
    const name = field(form, 'name');
    try {
      usableInvite(db, token, c.get('now')); // fail fast before the slow hash
      validateDisplayName(name);
      validatePassword(field(form, 'password'));
      const hash = await bcrypt.hash(field(form, 'password'), cost);
      const userId = redeemInvite(db, token, { name, passwordHash: hash, adult: field(form, 'adult') === 'yes' }, clock());
      await startSession(c, userId);
      flash(c, 'ok', `Welcome! You start with ${balanceOf(db, userId).toLocaleString('en-US')} points.`);
      return c.redirect('/', 303);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      let inviter: string;
      try {
        inviter = getUser(db, usableInvite(db, token, c.get('now')).created_by)!.display_name;
      } catch (dead) {
        if (!(dead instanceof RuleError)) throw dead;
        return c.html(messagePage(ctx(c), 'Invite', dead.message), 404);
      }
      return c.html(signupPage(ctx(c, { kind: 'error', message: err.message }), token, inviter, name), 400);
    }
  });

  // ---- markets ----

  app.get('/', (c) => {
    const tab = c.req.query('tab');
    const group: MarketGroup = tab === 'awaiting' || tab === 'resolved' ? tab : 'open';
    const me = c.get('user')!.id;
    const todo: TodoItem[] = [
      ...pendingOptIns(db, me).map((m) => ({ href: `/markets/${m.id}`, text: `Opt in or decline: ${m.question}` })),
      ...juryDuty(db, me).map((m) => ({ href: `/markets/${m.id}`, text: `Jury duty: ${m.question}` })),
    ];
    return c.html(marketsPage(ctx(c), group, listMarkets(db, group), todo));
  });

  app.get('/markets/new', (c) => c.html(newMarketPage(ctx(c), listMembers(db))));

  app.post('/markets', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const values = {
      question: field(form, 'question'),
      criteria: field(form, 'criteria'),
      evidence_source: field(form, 'evidence_source'),
      close_local: field(form, 'close_local'),
      subject_id: field(form, 'subject_id'),
    };
    // app.js converts the local time to epoch ms; without JS the time is read as UTC.
    const epoch = field(form, 'close_at_ms');
    const closeAt = /^\d+$/.test(epoch) ? Number(epoch) : Date.parse(`${values.close_local}Z`);
    try {
      const id = db.transaction(() =>
        createMarket(
          db,
          c.get('user')!.id,
          {
            question: values.question,
            criteria: values.criteria,
            evidenceSource: values.evidence_source,
            closeAt,
            subjectId: values.subject_id ? toInt(values.subject_id) : null,
            attestations: fieldList(form, 'attest'),
          },
          c.get('now'),
        ),
      )();
      flash(c, 'ok', 'Market created.');
      return c.redirect(`/markets/${id}`, 303);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      return c.html(newMarketPage(ctx(c, { kind: 'error', message: err.message }), listMembers(db), values), 400);
    }
  });

  app.get('/markets/:id', (c) => {
    const id = marketId(c);
    const me = c.get('user')!.id;
    const now = c.get('now');
    const m = getMarketRow(db, id);
    const bets = betsFor(db, id);
    const mine = bets.filter((b) => b.userId === me);
    const backFor = (outcome: 'YES' | 'NO') => computePayouts(bets, outcome).find((p) => p.userId === me)?.amount ?? 0;
    const nameOf = (userId: number) => getUser(db, userId)!.display_name;
    const p = getProposal(db, id);
    const d = getDispute(db, id);
    return c.html(
      marketPage(ctx(c), {
        m,
        bets: betList(db, id),
        my: {
          yes: mine.filter((b) => b.side === 'YES').reduce((n, b) => n + b.amount, 0),
          no: mine.filter((b) => b.side === 'NO').reduce((n, b) => n + b.amount, 0),
          ifYes: backFor('YES'),
          ifNo: backFor('NO'),
          net: netForMarket(db, me, id),
        },
        balance: balanceOf(db, me),
        bond: bondFor(m.yes_pool + m.no_pool),
        proposal: p && { ...p, name: nameOf(p.user_id) },
        dispute: d && { ...d, name: nameOf(d.user_id) },
        jurors: getJurors(db, id).map((j) => ({ ...j, name: nameOf(j.user_id) })),
        disputesLeft: DISPUTES_PER_WEEK - disputesThisWeek(db, me, now),
        eligibleIfIDispute: eligibleJurors(db, id).filter((u) => u !== me).length,
        jurySize: jurySize(db),
      }),
    );
  });

  app.post('/markets/:id/bet', (c) =>
    act(c, `/markets/${marketId(c)}`, (form, user, now) => {
      const side = parseSide(field(form, 'side'));
      const amount = toInt(field(form, 'amount'));
      placeBet(db, marketId(c), user.id, side, amount, now);
      return `Bet placed: ${amount.toLocaleString('en-US')} on ${side}.`;
    }),
  );

  app.post('/markets/:id/subject', (c) =>
    act(c, `/markets/${marketId(c)}`, (form, user, now) => {
      const accept = field(form, 'answer') === 'accept';
      respondAsSubject(db, marketId(c), user.id, accept, now);
      return accept ? 'You opted in. Betting is open.' : 'You declined. The market has been cancelled.';
    }),
  );

  app.post('/markets/:id/propose', (c) =>
    act(c, `/markets/${marketId(c)}`, (form, user, now) => {
      propose(db, marketId(c), user.id, parseOutcome(field(form, 'outcome')), field(form, 'note'), now);
      return 'Outcome proposed. The 24-hour challenge window is open.';
    }),
  );

  app.post('/markets/:id/dispute', (c) =>
    act(c, `/markets/${marketId(c)}`, (form, user, now) => {
      dispute(db, marketId(c), user.id, field(form, 'note'), now, opts.rng);
      return 'Dispute filed.';
    }),
  );

  app.post('/markets/:id/vote', (c) =>
    act(c, `/markets/${marketId(c)}`, (form, user, now) => {
      castVote(db, marketId(c), user.id, parseOutcome(field(form, 'vote')), now);
      return 'Vote recorded.';
    }),
  );

  // ---- account, leaderboard, members ----

  app.get('/me', (c) => {
    const me = c.get('user')!.id;
    return c.html(mePage(ctx(c), positionsFor(db, me), ledgerFor(db, me)));
  });

  app.post('/me/password', async (c) => {
    const form = await c.req.parseBody();
    const user = c.get('user')!;
    try {
      if (!(await bcrypt.compare(field(form, 'current'), user.password_hash))) throw new RuleError('Current password is wrong.');
      validatePassword(field(form, 'password'));
      setPasswordHash(db, user.id, await bcrypt.hash(field(form, 'password'), cost));
      await startSession(c, user.id); // other devices are logged out
      flash(c, 'ok', 'Password changed.');
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      flash(c, 'error', err.message);
    }
    return c.redirect('/me', 303);
  });

  app.get('/leaderboard', (c) => {
    const view = c.req.query('view') === 'all' ? 'all' : 'season';
    const season = seasonOf(c.get('now'));
    return c.html(leaderboardPage(ctx(c), view, season.label, leaderboard(db, view === 'all' ? 0 : season.start)));
  });

  app.get('/members', (c) =>
    c.html(membersPage(ctx(c), listMembers(db), openInvites(db, c.get('user')!.id, c.get('now')), baseUrl(c))),
  );

  app.post('/invites', (c) =>
    act(c, '/members', (_form, user, now) => {
      createInvite(db, user.id, now);
      return 'Invite link created. Copy it from the list below.';
    }),
  );

  app.post('/invites/:id/revoke', (c) =>
    act(c, '/members', (_form, user, now) => {
      revokeInvite(db, user.id, toInt(c.req.param('id')), now);
      return 'Invite revoked.';
    }),
  );

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post(`/members/:id/${action}`, (c) =>
      act(c, '/members', (_form, user) => {
        setActive(db, user.id, toInt(c.req.param('id') ?? ''), action === 'reactivate');
        return action === 'reactivate' ? 'Member reactivated.' : 'Member deactivated.';
      }),
    );
  }

  app.get('/rules', (c) => c.html(rulesPage(ctx(c))));

  app.notFound((c) => c.html(messagePage(ctx(c), 'Not found', 'There is nothing here.'), 404));
  app.onError((err, c) => {
    if (err instanceof RuleError) return c.html(messagePage(ctx(c), 'Not found', err.message), 404);
    console.error(err);
    return c.html(messagePage(ctx(c), 'Something went wrong', 'The error has been logged.'), 500);
  });

  return app;
}
