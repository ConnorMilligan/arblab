import { MINUTE } from './time.ts';

export const LOGIN_WINDOW = 15 * MINUTE;
export const LOGIN_MAX_PER_NAME_AND_IP = 5;
export const LOGIN_MAX_PER_IP = 20;
export const LOGIN_MAX_PER_NAME = 30;

/**
 * Counts failed logins in a sliding window under three keys:
 * - name + client address (5): stops guessing at one account without letting a stranger lock
 *   the real member out, since their own address has no failures.
 * - client address (20): stops one client sweeping many names.
 * - name (30): a backstop against guessing spread across many addresses.
 * There is deliberately no global cap, because that would let one client pause logins for all.
 * Names are keyed as submitted, member or not, so a 429 never reveals who is a member. Memory is
 * bounded by the per-address limit: one address can record at most 20 failures per window. Only
 * expired buckets are ever dropped. In memory: a restart clears it, which is fine for a single-instance app.
 */
export class LoginLimiter {
  private buckets = new Map<string, number[]>();

  /** Seconds until another attempt is allowed, or 0 if the attempt may go ahead. */
  retryAfter(name: string, ip: string, now: number): number {
    const wait = Math.max(...this.keys(name, ip).map(([k, max]) => this.wait(k, max, now)));
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(name: string, ip: string, now: number): void {
    if (this.buckets.size > 1000) this.sweep(now);
    for (const [k] of this.keys(name, ip)) this.buckets.set(k, [...this.recent(k, now), now]);
  }

  /** A correct password clears this name's failures from this address only. */
  succeed(name: string, ip: string): void {
    this.buckets.delete(this.keys(name, ip)[0][0]);
  }

  /** Drops buckets whose failures have all aged out. Live counters are never evicted. */
  private sweep(now: number): void {
    for (const [k, times] of this.buckets) if (times.every((t) => t <= now - LOGIN_WINDOW)) this.buckets.delete(k);
  }

  private keys(name: string, ip: string): [string, number][] {
    // Keys are clipped: a member name is at most 24 characters, so a longer one can never match and
    // clipping it changes nothing, while attacker-sized strings can't fill memory.
    const n = name.trim().toLowerCase().slice(0, 32);
    ip = ip.slice(0, 64);
    return [
      [`ni:${n}|${ip}`, LOGIN_MAX_PER_NAME_AND_IP],
      [`i:${ip}`, LOGIN_MAX_PER_IP],
      [`n:${n}`, LOGIN_MAX_PER_NAME],
    ];
  }

  private wait(key: string, max: number, now: number): number {
    const times = this.recent(key, now);
    return times.length >= max ? times[0] + LOGIN_WINDOW - now : 0;
  }

  private recent(key: string, now: number): number[] {
    return (this.buckets.get(key) ?? []).filter((t) => t > now - LOGIN_WINDOW);
  }
}
