import { DAY, HOUR } from '../time.ts';

export const MAX_MEMBERS = 50;
export const WEEKLY_ALLOWANCE = 1000;
export const ALLOWANCE_CAP = 5000;
export const INVITE_TTL = 7 * DAY;
export const RESET_TTL = HOUR;

export const MIN_BOND = 50;
export const CHALLENGE_WINDOW = 24 * HOUR;
export const PROPOSAL_DEADLINE = 7 * DAY;
export const JURY_WINDOW = 72 * HOUR;
export const DISPUTES_PER_WEEK = 3;
export const JURY_SIZE = 5;
export const SMALL_JURY_SIZE = 3;
export const SMALL_GROUP = 12;
export const QUORUM = 3;

export const MIN_CLOSE_DELAY = HOUR;
export const MAX_CLOSE_DELAY = 365 * DAY;

/** The checklist every market creator must tick. Stored verbatim as the attestation. */
export const ATTESTATIONS = [
  { key: 'no_harm', text: "It is not about anyone's death, injury or illness." },
  { key: 'no_crime', text: 'It is not about anyone committing an illegal act.' },
  { key: 'no_minors', text: 'It is not about anyone under 18.' },
] as const;

export type Side = 'YES' | 'NO';
export type Outcome = Side | 'VOID';
export const OUTCOMES: readonly Outcome[] = ['YES', 'NO', 'VOID'];

/** A rule was broken. The message is safe to show to the member. */
export class RuleError extends Error {
  name = 'RuleError';
}

export function rule(ok: unknown, message: string): asserts ok {
  if (!ok) throw new RuleError(message);
}

// Points are play points only. Free text that talks about real money is rejected.
const MONEY_TALK = /\p{Sc}|\b(owes?|owed|settle up|venmo|paypal|zelle|cash ?app|revolut|wallet|payment)\b/iu;

export function cleanText(value: string, label: string, min: number, max: number): string {
  const v = value.trim();
  rule(v.length >= min, `${label} must be at least ${min} characters.`);
  rule(v.length <= max, `${label} must be at most ${max} characters.`);
  rule(!MONEY_TALK.test(v), `${label}: keep it about play points. No currency symbols or payment talk (see House Rules).`);
  return v;
}

export function parseOutcome(v: unknown): Outcome {
  rule(v === 'YES' || v === 'NO' || v === 'VOID', 'Choose YES, NO or VOID.');
  return v;
}

export function parseSide(v: unknown): Side {
  rule(v === 'YES' || v === 'NO', 'Choose YES or NO.');
  return v;
}
