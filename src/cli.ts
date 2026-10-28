import { openDb } from './db.ts';
import { RuleError } from './domain/rules.ts';
import { getUserByName, linkAuthUsername, setOwner } from './domain/users.ts';
import { DEMO_NAMES, seedDemo } from './seed.ts';

const USAGE = `Usage: node src/cli.ts <command>

  link-login <name> <login>     Let the member called <name>, from before sign-in moved to Authelia,
                                sign in as the Authelia login <login>. They keep their points and bets.
  set-owner <name>              Hand ownership (appointing and removing admins) to the member called
                                <name>. The previous owner stays an admin.
  seed-demo                     Fill an empty database with 6 demo members and 3 markets.
  backup <file>                 Write a consistent copy of the database to <file>.

Everyone else joins by visiting the site signed in to Authelia. In an empty database the first
person to join becomes the owner, who can make others admins from the Members page.

The database is DATABASE_PATH (default data/arblab.db).`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const name = args[0];
const db = openDb(process.env.DATABASE_PATH ?? 'data/arblab.db');
const memberCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

try {
  switch (command) {
    case 'link-login': {
      const login = args[1];
      if (!name || !login) fail(USAGE);
      const user = getUserByName(db, name) ?? fail(`No member called "${name}".`);
      linkAuthUsername(db, user.id, login);
      console.log(`${user.display_name} now signs in as the Authelia login "${login}".`);
      break;
    }
    case 'set-owner': {
      if (!name) fail(USAGE);
      const user = getUserByName(db, name) ?? fail(`No member called "${name}".`);
      setOwner(db, user.id);
      console.log(`${user.display_name} is now the owner.`);
      break;
    }
    case 'seed-demo': {
      if (memberCount > 0) fail('seed-demo only runs on an empty database.');
      seedDemo(db, Date.now());
      console.log(`Seeded ${DEMO_NAMES.join(', ')} (logins ${DEMO_NAMES.map((n) => n.toLowerCase()).join(', ')}; Alice is the owner) and 3 markets.`);
      break;
    }
    case 'backup': {
      if (!name) fail(USAGE);
      await db.backup(name);
      console.log(`Backed up to ${name}.`);
      break;
    }
    default:
      fail(USAGE);
  }
} catch (err) {
  if (err instanceof RuleError) fail(err.message);
  throw err;
} finally {
  db.close();
}
