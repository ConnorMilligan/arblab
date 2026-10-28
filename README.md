# Dannymarket

[![Tests](https://github.com/ConnorMilligan/arblab/actions/workflows/test.yml/badge.svg?branch=dannysserverserver)](https://github.com/ConnorMilligan/arblab/actions/workflows/test.yml?query=branch%3Adannysserverserver)

A small prediction market for a group of friends (up to 50), behind Authelia. Members bet
**play points** on yes/no questions, resolve them with a bonded propose/dispute/jury
process, and compare results on a leaderboard.

Points have no cash value. They cannot be bought, sold, transferred, redeemed or cashed
out, and real-money side bets are not part of the app.

One Node process, one SQLite file, server-rendered HTML, one CSS file, no client framework
and no build step. The design and the rule interpretations are in [PLAN.md](PLAN.md).

## Run with Docker

Needs Docker with the Compose plugin, and a reverse proxy with Authelia in front (see
[Signing in through Authelia](#signing-in-through-authelia)). Everything runs in one container, and the
SQLite file lives on the `arblab-data` volume.

```sh
cp .env.example .env            # set LOGOUT_URL
docker compose up -d --build    # listens on 127.0.0.1:8080 for the proxy
```

Anyone with an Authelia login can then join by visiting the site: they pick a display name and confirm
they are 18 or older. In an empty database the first person to join becomes the owner, who can make other members admins from the Members page. To try it with demo
data instead, run `docker compose exec arblab node src/cli.ts seed-demo` on an empty database (6 members
with the logins alice, bob, …; Alice is the owner; plus 3 markets).

To update after pulling new code: `docker compose up -d --build`. The volume keeps the data.

## Commands

Run these inside the container: `docker compose exec arblab node src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `set-owner <name>` | Hand ownership to another member. The owner appoints and removes admins; the previous owner stays an admin |
| `link-login <name> <login>` | Let a member from before sign-in moved to Authelia sign in as that Authelia login, keeping their points and bets |
| `seed-demo` | Fill an empty database with demo data |
| `backup <file>` | Write a consistent copy of the database |

Other useful ones: `docker compose logs -f` to follow the log, `docker compose ps` for the health status.

## Configuration

Set these in `.env`; `compose.yaml` passes them through.

| Variable | Default | Notes |
| --- | --- | --- |
| `ARBLAB_BIND` | `127.0.0.1` | Host address to publish on. Keep it on `127.0.0.1`: see below. |
| `ARBLAB_PORT` | `8080` | Host port to publish on |
| `LOGOUT_URL` | | Where "Log out" goes, e.g. `https://auth.example.com/logout` |
| `USER_HEADER` | `Remote-User` | The header the proxy fills with the Authelia login |
| `SECURE_COOKIES` | `true` in the image | The one-time notice cookie is HTTPS-only. Set `false` only to serve plain HTTP. |

The image also sets `NODE_ENV=production`, `PORT=8080` and `DATABASE_PATH=/data/arblab.db`.

## Deploy

Run exactly one container: SQLite is a single file on a single disk.

On your own server, use the same `docker compose up -d --build`, keep `ARBLAB_BIND=127.0.0.1`, and
put a reverse proxy that handles HTTPS (Caddy, nginx, Traefik) in front of port 8080. The container
has a built-in health check on `/healthz`, a read-only filesystem apart from `/data` and `/tmp`, and
no Linux capabilities.

### Signing in through Authelia

The app has no passwords of its own: anyone with an Authelia login can use it, the way other services
behind the same proxy do. In Caddy:

```caddy
market.example.com {
  route {
    # Drop any copy a visitor sends. Inside `route` these run in this order; outside it Caddy would run
    # request_header after forward_auth and delete the real values too.
    request_header -Remote-User
    request_header -Remote-Name
    forward_auth localhost:9091 {
      uri /api/authz/forward-auth
      copy_headers Remote-User Remote-Name
    }
    reverse_proxy localhost:8080
  }
}
```

`copy_headers` alone isn't enough: a header the auth response leaves out is passed through from the visitor
as sent. The app trusts `Remote-User` completely, so nothing but the proxy may reach it: keep
`ARBLAB_BIND=127.0.0.1`.
Authelia's `Remote-Name` is offered as the display name on someone's first visit.

### Naming people who haven't joined yet

A market's subject can be anyone with an Authelia login, not just members. With Authelia's file backend, a
small helper container copies each enabled user's login and full name out of `users.yml` for the subject
picker. It's the only container that can read that file (which also holds the password hashes): it has no
network, no capabilities and a read-only filesystem, and reads the file through Authelia's group. In `.env`:

```sh
COMPOSE_PROFILES=authelia-users
AUTHELIA_USERS_DIR=/var/lib/authelia-main   # the directory holding users.yml
AUTHELIA_GID=993                            # its group: stat -c %g users.yml
```

A market about someone who hasn't joined stays pending. When they first sign in (or a pre-Authelia member is
linked with `link-login`), it becomes theirs and their "Needs you" box asks them to opt in. If they never
do, it's cancelled at close like any other pending market. Without the helper, the picker lists members only.

### Backups

All state is in one file. Write a copy into the volume, then copy it out of the container:

```sh
docker compose exec arblab node src/cli.ts backup /data/backup.db
docker compose cp arblab:/data/backup.db ./dannymarket-$(date +%F).db
```

### Other hosts

The same `Dockerfile` works anywhere that runs containers with a persistent volume at `/data`.

Wherever it runs, it needs Authelia (or another forward-auth proxy that sets `Remote-User`) in front, and must
not be reachable any other way.

- **Podman + systemd**: `deploy/arblab.container` and `deploy/arblab.network` are Quadlet units;
  `deploy/update.sh` rebuilds and restarts them.

## Development

Needs Node 22.18 or newer (Node runs the TypeScript directly, no build step).

```sh
npm install
npm run cli -- seed-demo           # demo data in data/arblab.db
DEV_USER=alice npm run dev         # http://localhost:3000 signed in as alice, restarts on file changes
npm test                   # vitest
npm run typecheck          # tsc --noEmit
```

Outside Docker the defaults are `PORT=3000` and `DATABASE_PATH=data/arblab.db`. `DEV_USER` stands in for
Authelia by signing every request in as that login; it is ignored when `NODE_ENV=production`.

## How it works

```
src/server.ts        entry point: opens the DB, serves HTTP, runs the deadline check every 5 s
src/app.ts           routes, sign-in from the Authelia header, same-origin check for form posts
src/db.ts            schema; the ledger is append-only (UPDATE/DELETE triggers abort)
src/domain/          every rule, as plain functions taking (db, ..., now)
  points.ts          ledger, derived balances, weekly allowance, leaderboard
  users.ts           members, Authelia logins, 50-member cap, deactivation
src/directory.ts     reads Authelia's users file (logins and names only) for the subject picker
src/authelia-users.ts  the helper container that copies that list out
  markets.ts         creation + checklist, subject opt-in, bets, final payout
  payout.ts          pure parimutuel math (rounding and leftover points)
  raffle.ts          stake-weighted raffles every 30 seconds: entries and draws
  resolution.ts      proposals, disputes, jury draw, voting, bond forfeiture
  tick.ts            applies every deadline that has passed; safe to run repeatedly
src/views/           HTML templates (tagged template literals with auto-escaping)
public/              style.css, app.js (time zone picker, local times, live clocks, close-time input)
test/                vitest: domain rules plus HTTP tests against the real app
```

- **Balances** are always `SUM(amount)` over the ledger, so there is no cached balance to drift.
- **Every rule is enforced on the server** in `src/domain/`. The UI hides forms you can't use,
  but the tests post directly to show the server refuses them anyway.
- **Deadlines** (close, the 24-hour challenge window, 7-day and 72-hour auto-void, Monday allowance)
  are applied by `tick()` before each request and every 5 seconds. Each step only touches rows still in
  the earlier state, so running it twice changes nothing.

## Dependencies

Runtime (3):

- **hono**: routing, cookies and security headers, all built in.
- **@hono/node-server**: the adapter that runs Hono on Node's HTTP server.
- **better-sqlite3**: synchronous SQLite, so a transaction is just a function call. Prebuilt
  binaries ship inside the package, so nothing is compiled.

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

- No email: no notifications (a "Needs you" box on the home page lists opt-ins and jury duty).
- Accounts live in Authelia. The app keeps only each member's display name and login; removing someone's
  Authelia login stops them signing in, and an admin can also deactivate them here.
- Markets and bets can't be edited, cancelled or deleted once created. No comments or discussion.
- No pagination. Lists show up to 200 rows.
- No migration tool. The schema is `CREATE TABLE IF NOT EXISTS`, so a future schema change needs a
  small migration step.
- If the server is down over several Mondays, only the current week's allowance is granted when it
  comes back; missed weeks aren't paid retroactively.
- Times render in UTC on the server and switch to the viewer's time zone in the browser. That is the
  device's zone unless they pick another from the footer; the choice is saved per browser (not per
  account). Each market has its own zone, chosen when it's created: its times show in the viewer's zone
  first, with the market's local time underneath when that differs. Without JavaScript, times stay UTC
  and a new market's zone starts on UTC.
- The "no money talk" check on member-written text is a regex (currency symbols plus a short word
  list), not a moderation system.
- CSRF protection is Authelia's `SameSite` session cookie plus an `Origin` check, not per-form tokens.
- The container runs as root so it can write to a freshly mounted volume without extra setup;
  `compose.yaml` drops all capabilities and makes the rest of the filesystem read-only.
