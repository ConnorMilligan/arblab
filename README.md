# Arblab

A small, invite-only prediction market for a group of friends (up to 50). Members bet
**play points** on yes/no questions, resolve them with a bonded propose/dispute/jury
process, and compare results on a leaderboard.

Points have no cash value. They cannot be bought, sold, transferred, redeemed or cashed
out, and real-money side bets are not part of the app.

One Node process, one SQLite file, server-rendered HTML, one CSS file, no client framework
and no build step. The design and the rule interpretations are in [PLAN.md](PLAN.md).

## Run locally

Needs Node 22.18 or newer (Node runs the TypeScript directly).

```sh
npm install
npm run cli -- seed-demo        # 6 demo members (password "demo-password", Alice is admin) + 3 markets
npm run dev                     # http://localhost:3000
```

For a real group, start with an empty database and create the first member instead of seeding:

```sh
npm run cli -- create-admin YourName --adult    # prints a generated password (or set ADMIN_PASSWORD)
```

Everyone else joins through single-use invite links from the Members page.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm start` | Run the server (`dev` restarts on file changes) |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cli -- create-admin <name> --adult` | Create the first member (admin). Only works on an empty database. |
| `npm run cli -- reset-password <name>` | Print a new password for a member. There's no email, so this is how a forgotten password is handled. |
| `npm run cli -- seed-demo` | Fill an empty database with demo data |
| `npm run cli -- backup <file>` | Write a consistent copy of the database |

Inside the Docker image, run the CLI as `node src/cli.ts <command>`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | random per start (dev only) | **Required in production**, at least 32 characters: `openssl rand -hex 32` |
| `DATABASE_PATH` | `data/arblab.db` | `/data/arblab.db` in the Docker image |
| `PORT` | `3000` | `8080` in the Docker image |
| `APP_URL` | from the request | Public base URL used in invite links, e.g. `https://arblab.fly.dev` |
| `NODE_ENV` | | `production` makes cookies `Secure` (HTTPS only) and requires `SESSION_SECRET` |

## Deploy

The app is one container with a persistent volume at `/data` for the SQLite file. Run exactly
one instance: SQLite is a single file on a single disk.

### Fly.io

```sh
# Set a unique `app` name in fly.toml first.
fly launch --copy-config --no-deploy
fly volumes create arblab_data --size 1 --region lhr     # same region as primary_region
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)
fly deploy
fly ssh console -C "node src/cli.ts create-admin YourName --adult"
```

`fly.toml` keeps one machine running so the once-a-minute deadline check keeps ticking. Deadlines
are also applied on every request, so nothing is missed if the machine sleeps.

### Railway

1. Create a project from this repo. Railway builds the `Dockerfile`.
2. Add a volume mounted at `/data`.
3. Set `SESSION_SECRET` (and optionally `APP_URL`). Railway supplies `PORT`.
4. Open a shell on the service (`railway ssh`) and run `node src/cli.ts create-admin YourName --adult`.

### Backups

All state is in one file. Run `node src/cli.ts backup /data/backup-$(date +%F).db` on the
server and copy the file off (for example with `fly ssh sftp get`).

## How it works

```
src/server.ts        entry point: opens the DB, serves HTTP, runs the deadline check every 60 s
src/app.ts           routes, signed-cookie sessions, same-origin check for form posts
src/db.ts            schema; the ledger is append-only (UPDATE/DELETE triggers abort)
src/domain/          every rule, as plain functions taking (db, ..., now)
  points.ts          ledger, derived balances, weekly allowance, leaderboard
  users.ts           invites, 50-member cap, deactivation
  markets.ts         creation + checklist, subject opt-in, bets, final payout
  payout.ts          pure parimutuel math (rounding and leftover points)
  resolution.ts      proposals, disputes, jury draw, voting, bond forfeiture
  tick.ts            applies every deadline that has passed; safe to run repeatedly
src/views/           HTML templates (tagged template literals with auto-escaping)
public/              style.css (130 lines), app.js (local times, close-time input)
test/                vitest: domain rules plus HTTP tests against the real app
```

- **Balances** are always `SUM(amount)` over the ledger, so there is no cached balance to drift.
- **Every rule is enforced on the server** in `src/domain/`. The UI hides forms you can't use,
  but the tests post directly to show the server refuses them anyway.
- **Deadlines** (close, the 24-hour challenge window, 7-day and 72-hour auto-void, Monday allowance)
  are applied by `tick()` before each request and once a minute. Each step only touches rows still in
  the earlier state, so running it twice changes nothing.

## Dependencies

Runtime (4):

- **hono**: routing, signed cookies and security headers, all built in.
- **@hono/node-server**: the adapter that runs Hono on Node's HTTP server.
- **better-sqlite3**: synchronous SQLite, so a transaction is just a function call. Prebuilt
  binaries ship inside the package, so nothing is compiled.
- **bcryptjs**: bcrypt password hashing in pure JS, with no native build and no dependencies of its own.

Dev (4): **typescript** (type checking only), **vitest**, **@types/node**, **@types/better-sqlite3**.

The client needs nothing: plain forms plus a 25-line script that only adds conveniences.

## Interpretations

The spec left a few things open. These are the choices made (more detail in PLAN.md):

- The **5,000 cap** limits the allowance top-up. Winnings can take a balance above 5,000.
- The **50-member cap** counts active members, so deactivating someone frees a seat.
- **New members** get the current week's 1,000 points when they join.
- A **dispute** says the proposal is wrong. If the jury picks the proposed outcome the disputer
  forfeits; if it picks anything else (including a third option) the proposer forfeits.
- **No jury decision** (no quorum or no 2/3 majority by 72 hours): VOID, and both bonds are returned.
- **Fewer than 3 eligible jurors**: the dispute voids the market at once and both bonds are
  returned. The dispute form warns about this before you post.
- **Nobody backed the winning side**: every stake is refunded.
- **Bonds** are 10% of the pool rounded up, with a 50-point minimum.
- **Weeks** (allowance and the 3-disputes limit) start Monday 00:00 UTC. **Seasons** are calendar quarters.
- **Votes** are final once cast. Voting closes early when every juror has voted.
- **Bets are public**. Jurors' names and votes stay hidden until voting closes.
- The **subject** can be the market's creator (that counts as opting in), can propose an outcome,
  and can never bet or sit on the jury. A subject who declines voids the market.

## Simplified or left out

- No email: no notifications (a "Needs you" box on the home page lists opt-ins and jury duty), and
  no self-service password reset. The admin runs `reset-password`.
- No login rate limiting. bcrypt makes each guess slow; add a limiter if the URL gets around.
- Markets and bets can't be edited, cancelled or deleted once created. No comments or discussion.
- No pagination. Lists show up to 200 rows.
- No migration tool. The schema is `CREATE TABLE IF NOT EXISTS`, so a future schema change needs a
  small migration step.
- If the server is down over several Mondays, only the current week's allowance is granted when it
  comes back; missed weeks aren't paid retroactively.
- Times render in UTC on the server and switch to local time in the browser. Without JavaScript,
  the close-time input is read as UTC.
- The "no money talk" check on member-written text is a regex (currency symbols plus a short word
  list), not a moderation system.
- CSRF protection is `SameSite=Lax` cookies plus an `Origin` check, not per-form tokens.
- The container runs as root so it can write to a freshly mounted volume without extra setup.
