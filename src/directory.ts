import { readFileSync, statSync } from 'node:fs';

/** Someone with an Authelia login: what the subject picker needs, and nothing else from Authelia. */
export interface DirectoryEntry {
  login: string;
  name: string;
}

/** Authelia's users file holds plain YAML strings, bare or quoted. */
function unquote(raw: string): string {
  const v = raw.trim();
  const single = v.match(/^'((?:[^']|'')*)'/);
  if (single) return single[1].replaceAll("''", "'");
  const double = v.match(/^"((?:[^"\\]|\\.)*)"/);
  if (double) {
    try {
      return JSON.parse(double[0]) as string;
    } catch {
      return double[1];
    }
  }
  return v.replace(/\s+#.*$/, ''); // a trailing comment on a bare value
}

/**
 * The enabled users in Authelia's file backend (users.yml), as login and full name. This reads only the
 * shape Authelia uses, a `users:` map of logins to fields, and keeps only `displayname` and `disabled`.
 */
export function parseAutheliaUsers(yaml: string): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  let inUsers = false;
  let userIndent = -1;
  let fieldIndent = -1;
  let current: { login: string; name: string; disabled: boolean } | undefined;
  const finish = () => {
    if (current && !current.disabled) out.push({ login: current.login, name: current.name || current.login });
    current = undefined;
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      finish();
      inUsers = /^users:\s*(#.*)?$/.test(text);
      userIndent = -1;
      continue;
    }
    if (!inUsers) continue;
    if (userIndent < 0) userIndent = indent;
    if (indent === userIndent) {
      finish();
      const key = text.match(/^(.+?):\s*(#.*)?$/);
      current = key ? { login: unquote(key[1]), name: '', disabled: false } : undefined;
      fieldIndent = -1;
      continue;
    }
    if (!current || indent < userIndent) continue;
    if (fieldIndent < 0) fieldIndent = indent;
    if (indent !== fieldIndent) continue; // inside a field's own list, like groups
    const field = text.match(/^(displayname|disabled):\s*(.*)$/);
    if (field?.[1] === 'displayname') current.name = unquote(field[2]);
    if (field?.[1] === 'disabled') current.disabled = unquote(field[2]) === 'true';
  }
  finish();
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads the directory the helper container writes (a JSON list of entries), again whenever the file changes.
 * A missing or unreadable file reads as nobody, so the picker just offers members.
 */
export function fileDirectory(path: string): () => DirectoryEntry[] {
  let cached: { mtime: number; entries: DirectoryEntry[] } | undefined;
  return () => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (cached?.mtime !== mtime) {
        const list = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        const entries = Array.isArray(list)
          ? list.filter((e): e is DirectoryEntry => typeof e?.login === 'string' && typeof e?.name === 'string')
          : [];
        cached = { mtime, entries };
      }
      return cached.entries;
    } catch {
      return [];
    }
  };
}
