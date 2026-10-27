import { MINUTE } from './time.ts';

export const LOGIN_WINDOW = 15 * MINUTE;
export const LOGIN_MAX_PER_NAME = 5;
export const LOGIN_MAX_PER_IP = 20;
export const LOGIN_MAX_TOTAL = 60;

/**
 * Counts failed logins in a sliding window: per member name, per client address, and across
 * everyone. The address comes from the Cf-Connecting-Ip header set by the fronting proxy;
 * without it the per-address limit is skipped. Per-name limits stop guessing at one account, per-address
 * limits stop one client from sweeping many names, and the global cap is a backstop.
 * In memory: a restart clears it, which is fine for a single-instance app.
 */
export class LoginLimiter {
  private buckets = new Map<string, number[]>();
  private all: number[] = [];

  /** Seconds until another attempt is allowed, or 0 if the attempt may go ahead. */
  retryAfter(name: string, ip: string | undefined, now: number): number {
    const waits = [
      this.wait(`n:${name.trim().toLowerCase()}`, LOGIN_MAX_PER_NAME, now),
      ip ? this.wait(`i:${ip}`, LOGIN_MAX_PER_IP, now) : 0,
      this.wait('', LOGIN_MAX_TOTAL, now),
    ];
    const wait = Math.max(...waits);
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(name: string, ip: string | undefined, now: number): void {
    if (this.buckets.size > 5000) this.buckets.clear(); // bounded memory against made-up names
    for (const k of [`n:${name.trim().toLowerCase()}`, ip ? `i:${ip}` : '']) {
      if (k) this.buckets.set(k, [...this.recent(this.buckets.get(k), now), now]);
    }
    this.all = [...this.recent(this.all, now), now];
  }

  succeed(name: string): void {
    this.buckets.delete(`n:${name.trim().toLowerCase()}`);
  }

  private wait(key: string, max: number, now: number): number {
    const times = this.recent(key ? this.buckets.get(key) : this.all, now);
    return times.length >= max ? times[0] + LOGIN_WINDOW - now : 0;
  }

  private recent(times: number[] | undefined, now: number): number[] {
    return (times ?? []).filter((t) => t > now - LOGIN_WINDOW);
  }
}
