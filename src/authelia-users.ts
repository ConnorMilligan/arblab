// Runs in its own container, beside the app, with Authelia's users file mounted read-only and no network.
// It copies out each enabled user's login and full name for the subject picker, so the password hashes in
// that file never reach the web-facing container.
//
//   node src/authelia-users.ts <authelia users.yml> <output .json>
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { parseAutheliaUsers } from './directory.ts';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node src/authelia-users.ts <authelia users.yml> <output .json>');
  process.exit(1);
}

let lastMtime = -1;
function sync(): void {
  try {
    const mtime = statSync(source).mtimeMs;
    if (mtime === lastMtime) return;
    const entries = parseAutheliaUsers(readFileSync(source, 'utf8'));
    writeFileSync(`${target}.tmp`, JSON.stringify(entries));
    renameSync(`${target}.tmp`, target); // readers never see half a file
    lastMtime = mtime;
    console.log(`Copied ${entries.length} Authelia users.`);
  } catch (err) {
    console.error('Could not copy the Authelia users:', (err as Error).message);
  }
}

sync();
setInterval(sync, 10_000);
process.on('SIGTERM', () => process.exit(0));
