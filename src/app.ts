import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { readFileSync } from 'node:fs';
import type { DB } from './db.ts';
import type { DirectoryEntry } from './directory.ts';
import {
  type MarketGroup,
  betsFor,
  createMarket,
  getMarket,
  getMarketRow,
  marketIdFromUrl,
  listMarkets,
  pendingOptIns,
  placeBet,
  positionsFor,
  publicIdForOldNumber,
  respondAsSubject,
  betList,
} from './domain/markets.ts';
import { computePayouts } from './domain/payout.ts';
import { currentEntries, enterRaffle, recentDraws, roundStart } from './domain/raffle.ts';
import { balanceOf, ledgerFor, leaderboard, netForMarket } from './domain/points.ts';
import {
  type Rng,
  bondFor,
  castVote,
  deleteMarket,
  deleteRefusal,
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
import { DISPUTES_PER_WEEK, RuleError, parseOutcome, parseSide, rule } from './domain/rules.ts';
import { tick } from './domain/tick.ts';
import { type User, createUser, getUser, getUserByAuthName, listMembers, setActive, setAdmin } from './domain/users.ts';
import { seasonOf, wallTimeToEpoch } from './time.ts';
import { leaderboardPage, mePage, membersPage, messagePage, rulesPage, welcomePage } from './views/account.ts';
import { APP_NAME, type Flash, type PageCtx } from './views/layout.ts';
import { rafflePage, raffleState } from './views/raffle.ts';
import { type TodoItem, marketPage, marketsPage, newMarketPage } from './views/markets.ts';

export interface AppOptions {
  db: DB;
  secureCookies?: boolean;
  clock?: () => number;
  rng?: Rng;
  /**
   * The request header Caddy's forward_auth fills with the Authelia login (default Remote-User). It is trusted
   * completely, so the app must be reachable only through that proxy, and the proxy must strip any copy a
   * visitor sends.
   */
  userHeader?: string;
  /** Where "Log out" goes, e.g. https://auth.example.com/logout. */
  logoutUrl?: string;
  /** Everyone with an Authelia login, so markets can name someone who hasn't joined yet. */
  directory?: () => DirectoryEntry[];
}

type Env = { Variables: { now: number; user: User | null; authName: string | null } };
type Form = Record<string, string | File | (string | File)[]>;

const field = (form: Form, key: string): string => {
  const v = Array.isArray(form[key]) ? form[key][0] : form[key];
  return typeof v === 'string' ? v : '';
};
const fieldList = (form: Form, key: string): string[] =>
  [form[key] ?? []].flat().filter((v): v is string => typeof v === 'string');
const toInt = (s: string): number => (/^\s*\d{1,9}\s*$/.test(s) ? Number(s) : NaN);

export function createApp(opts: AppOptions): Hono<Env> {
  const { db } = opts;
  const userHeader = opts.userHeader ?? 'Remote-User';
  const clock = opts.clock ?? Date.now;
  const directory = opts.directory ?? (() => []);
  /** People with a login who haven't joined (or been linked) yet. */
  const notJoined = () => directory().filter((e) => !getUserByAuthName(db, e.login));
  const secure = opts.secureCookies ?? false;
  const assets = {
    'style.css': { body: readFileSync(new URL('../public/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
    'app.js': { body: readFileSync(new URL('../public/app.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  };

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
      tick(db, now, opts.rng);
    } catch (err) {
      console.error('tick failed', err);
    }
    if (c.req.method === 'POST' && !sameOrigin(c)) return c.text('Cross-site form posts are not allowed.', 403);
    const stop = signIn(c);
    if (stop) return stop;
    await next();
  });

  // ---- helpers ----

  function sameOrigin(c: Context<Env>): boolean {
    const origin = c.req.header('origin');
    if (!origin) return true; // older browsers; the SameSite=Lax cookie still applies
    try {
      return new URL(origin).host === c.req.header('host');
    } catch {
      return false;
    }
  }

  /**
   * Authelia is the sign-in: Caddy sets the header on every request from the signed-in login, so it is the
   * session. A login with no member yet goes to /welcome. Returns a response when the request stops here.
   */
  function signIn(c: Context<Env>): Response | undefined {
    const authName = c.req.header(userHeader)?.trim() || null;
    const user = authName ? getUserByAuthName(db, authName) : undefined;
    c.set('authName', authName);
    c.set('user', user?.is_active ? user : null);
    const path = c.req.path;
    if (path === '/rules') return;
    if (!authName) return c.html(messagePage(ctx(c), 'Sign in', `Sign in with your login for this server to use ${APP_NAME}.`), 401);
    if (user && !user.is_active) return c.html(messagePage(ctx(c), 'Account deactivated', 'This account has been deactivated.'), 403);
    if (!user && path !== '/welcome') return c.redirect('/welcome', 303);
  }

  function flash(c: Context<Env>, kind: Flash['kind'], message: string): void {
    setCookie(c, 'flash', JSON.stringify({ kind, message }), { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 60 });
  }

  /** `peek` leaves a pending flash message alone, for background polling that no one sees. */
  function ctx(c: Context<Env>, override?: Flash, peek = false): PageCtx {
    let f: Flash | null = override ?? null;
    const stored = peek ? undefined : getCookie(c, 'flash');
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
      viewer: u ? { id: u.id, name: u.display_name, isAdmin: !!u.is_admin, isOwner: !!u.is_owner, balance: balanceOf(db, u.id) } : null,
      logoutUrl: opts.logoutUrl,
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

  /** The market's internal id from the public id in its URL (NaN, so "No such market", if there's none). */
  const marketId = (c: Context<Env>) => marketIdFromUrl(db, c.req.param('id') ?? '');
  const backTo = (c: Context<Env>) => `/markets/${encodeURIComponent(c.req.param('id') ?? '')}`;

  // ---- first visit through Authelia ----

  // Authelia's Remote-Name (the person's full name) is a good first guess at a display name.
  const suggestedName = (c: Context<Env>) => (c.req.header('remote-name') ?? '').trim().slice(0, 24);
  const welcome = (c: Context<Env>, status: 200 | 400 = 200, error?: string, name = suggestedName(c)) =>
    c.html(welcomePage(ctx(c, error ? { kind: 'error', message: error } : undefined), c.get('authName')!, name), status);

  app.get('/welcome', (c) => (c.get('user') ? c.redirect('/', 303) : welcome(c)));

  app.post('/welcome', async (c) => {
    if (c.get('user')) return c.redirect('/', 303);
    const form = await c.req.parseBody();
    const name = field(form, 'name');
    try {
      const userId = db.transaction(() => {
        // The first member of a new group owns it.
        const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
        const adult = field(form, 'adult') === 'yes';
        return createUser(db, { name, authUsername: c.get('authName')!, isOwner: first, adult }, c.get('now'));
      })();
      flash(c, 'ok', `Welcome! You start with ${balanceOf(db, userId).toLocaleString('en-US')} points.`);
      return c.redirect('/', 303);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      return welcome(c, 400, err.message, name);
    }
  });

  // ---- markets ----

  app.get('/', (c) => {
    const tab = c.req.query('tab');
    const group: MarketGroup = tab === 'awaiting' || tab === 'resolved' ? tab : 'open';
    const me = c.get('user')!.id;
    const todo: TodoItem[] = [
      ...pendingOptIns(db, me).map((m) => ({ href: `/markets/${m.public_id}`, text: `Opt in or decline: ${m.question}` })),
      ...juryDuty(db, me).map((m) => ({ href: `/markets/${m.public_id}`, text: `Jury duty: ${m.question}` })),
    ];
    return c.html(marketsPage(ctx(c), group, listMarkets(db, group), todo));
  });

  app.get('/markets/new', (c) => c.html(newMarketPage(ctx(c), listMembers(db), notJoined())));

  /** The subject picker sends a member's id, or "login:<login>" for someone who hasn't joined. */
  function subjectOf(value: string): { subjectId: number | null; subjectLogin: DirectoryEntry | null } {
    if (!value) return { subjectId: null, subjectLogin: null };
    if (!value.startsWith('login:')) return { subjectId: toInt(value), subjectLogin: null };
    const login = value.slice('login:'.length);
    const member = getUserByAuthName(db, login);
    if (member) return { subjectId: member.id, subjectLogin: null }; // they joined after the form was loaded
    const entry = directory().find((e) => e.login.toLowerCase() === login.toLowerCase());
    rule(entry, 'Pick the subject from the list.');
    return { subjectId: null, subjectLogin: entry };
  }

  app.post('/markets', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const values = {
      question: field(form, 'question'),
      criteria: field(form, 'criteria'),
      evidence_source: field(form, 'evidence_source'),
      close_local: field(form, 'close_local'),
      timezone: field(form, 'timezone'),
      subject_id: field(form, 'subject_id'),
    };
    const closeAt = wallTimeToEpoch(values.close_local, values.timezone);
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
            timeZone: values.timezone,
            ...subjectOf(values.subject_id),
            attestations: fieldList(form, 'attest'),
          },
          c.get('now'),
        ),
      )();
      flash(c, 'ok', 'Market created.');
      return c.redirect(`/markets/${getMarket(db, id).public_id}`, 303);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      return c.html(newMarketPage(ctx(c, { kind: 'error', message: err.message }), listMembers(db), notJoined(), values), 400);
    }
  });

  app.get('/markets/:id', (c) => {
    // Links from before random ids used the market's number.
    const old = /^\d{1,9}$/.test(c.req.param('id')) ? publicIdForOldNumber(db, Number(c.req.param('id'))) : undefined;
    if (old) return c.redirect(`/markets/${old}`, 301);
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
        canDelete: deleteRefusal(db, id, me) === null,
        deletedBy: m.deleted_by === null ? null : nameOf(m.deleted_by),
        jurySize: jurySize(db),
      }),
    );
  });

  app.post('/markets/:id/bet', (c) =>
    act(c, backTo(c), (form, user, now) => {
      const side = parseSide(field(form, 'side'));
      const amount = toInt(field(form, 'amount'));
      placeBet(db, marketId(c), user.id, side, amount, now);
      return `Bet placed: ${amount.toLocaleString('en-US')} on ${side}.`;
    }),
  );

  app.post('/markets/:id/subject', (c) =>
    act(c, backTo(c), (form, user, now) => {
      const accept = field(form, 'answer') === 'accept';
      respondAsSubject(db, marketId(c), user.id, accept, now);
      return accept ? 'You opted in. Betting is open.' : 'You declined. The market has been cancelled.';
    }),
  );

  app.post('/markets/:id/delete', (c) =>
    act(c, backTo(c), (form, user, now) => {
      rule(field(form, 'confirm') === 'yes', 'Tick the box to confirm you want to delete this market.');
      deleteMarket(db, marketId(c), user.id, now);
      return 'Market deleted. Every stake was returned.';
    }),
  );

  app.post('/markets/:id/propose', (c) =>
    act(c, backTo(c), (form, user, now) => {
      propose(db, marketId(c), user.id, parseOutcome(field(form, 'outcome')), field(form, 'note'), now);
      return 'Outcome proposed. The 24-hour challenge window is open.';
    }),
  );

  app.post('/markets/:id/dispute', (c) =>
    act(c, backTo(c), (form, user, now) => {
      dispute(db, marketId(c), user.id, field(form, 'note'), now, opts.rng);
      return 'Dispute filed.';
    }),
  );

  app.post('/markets/:id/vote', (c) =>
    act(c, backTo(c), (form, user, now) => {
      castVote(db, marketId(c), user.id, parseOutcome(field(form, 'vote')), now);
      return 'Vote recorded.';
    }),
  );

  // ---- raffle ----

  const raffleData = (c: Context<Env>) => ({
    round: roundStart(c.get('now')),
    entries: currentEntries(db, c.get('now')),
    draws: recentDraws(db, c.get('user')!.id),
  });

  app.get('/raffle', (c) => {
    return c.html(rafflePage(ctx(c), raffleData(c)));
  });

  // Polled by app.js so the page stays current without a reload.
  app.get('/raffle/state', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(raffleState(ctx(c, undefined, true), raffleData(c)));
  });

  app.post('/raffle/enter', (c) =>
    act(c, '/raffle', (form, user, now) => {
      const amount = toInt(field(form, 'amount'));
      enterRaffle(db, user.id, amount, now);
      return `You put ${amount.toLocaleString('en-US')} into this round's raffle.`;
    }),
  );

  // ---- account, leaderboard, members ----

  app.get('/me', (c) => {
    const me = c.get('user')!.id;
    return c.html(mePage(ctx(c), positionsFor(db, me), ledgerFor(db, me)));
  });

  app.get('/leaderboard', (c) => {
    const view = c.req.query('view') === 'all' ? 'all' : 'season';
    const season = seasonOf(c.get('now'));
    return c.html(leaderboardPage(ctx(c), view, season.label, leaderboard(db, view === 'all' ? 0 : season.start)));
  });

  app.get('/members', (c) => c.html(membersPage(ctx(c), listMembers(db))));

  for (const action of ['make-admin', 'remove-admin'] as const) {
    app.post(`/members/:id/${action}`, (c) =>
      act(c, '/members', (_form, user) => {
        const target = toInt(c.req.param('id') ?? '');
        setAdmin(db, user.id, target, action === 'make-admin');
        const name = getUser(db, target)!.display_name;
        return action === 'make-admin' ? `${name} is now an admin.` : `${name} is no longer an admin.`;
      }),
    );
  }

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
