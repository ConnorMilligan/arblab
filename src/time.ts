export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Monday 00:00 UTC of the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

/** Seasons are calendar quarters (UTC). */
export function seasonOf(t: number): { start: number; end: number; label: string } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  return { start: Date.UTC(y, q * 3, 1), end: Date.UTC(y, q * 3 + 3, 1), label: `${y} Q${q + 1}` };
}

/** "2026-10-27 18:00 UTC" — app.js swaps this for the viewer's local time. */
export function formatUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / HOUR);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return `${h}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
  return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
}
