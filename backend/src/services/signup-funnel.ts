/**
 * Sign-ups from outside, in a shape the whole workplace may read — the answer
 * behind `agentbuilt signups`.
 *
 * WHY IT EXISTS. Growth could not tell whether any post worked: the roster
 * lives on the backend host, behind a key the Growth room does not hold and
 * should not (the owner agreed on 2026-10-08 that Growth gets the numbers,
 * not the key). This is the roster with every name, email and handle taken
 * out: each account is a `rosterCode`, and a Platform agent can say who is
 * behind one when the owner asks.
 *
 * Every answer carries the whole week-by-week history, so nobody has to read
 * it on a Monday for the week to be counted: a read a month late shows the
 * same weeks a punctual one would have.
 *
 * Outside people only, exactly as the script's funnel line counts them —
 * the admin and the team's own accounts would flatter every stage.
 */

import { ROSTER_STAGES, type RosterPerson, type RosterStage } from './sqlite/sqlite-user-roster.js';

export interface SignupAccount {
  code: string;
  /** `email` today; `anonymous_totp` is the browser door from before email. */
  via: string;
  joinedAt?: string;
  /** `t.co`, `google.com`, `direct` — absent when the account brought no record. */
  from?: string;
  firstPage?: string;
  stage: RosterStage;
  stageAt?: string;
  lastSeenAt?: string;
}

export interface SignupWeek {
  /** The Monday the week starts on (UTC), `2026-09-07`. */
  weekOf: string;
  signups: number;
  /** Of that week's sign-ups, how many have reached at least each step. */
  reached: Record<RosterStage, number>;
}

export interface SignupFunnel {
  /** When this was read, ISO. */
  at: string;
  /** Accounts from outside. */
  outside: number;
  stages: Array<{ stage: RosterStage; reached: number; standing: number }>;
  /** Newest first. */
  accounts: SignupAccount[];
  /** Oldest first, from the week of the first outside sign-up to this one. */
  weeks: SignupWeek[];
  /**
   * Where they came from, most sign-ups first, with how far each source's
   * people got. Only accounts that brought a record (since 2026-10-09);
   * `unrecorded` counts the rest.
   */
  sources: Array<{ from: string; signups: number; reached: Record<RosterStage, number> }>;
  unrecorded: number;
}

/** A year of weeks is plenty for a reader, and keeps the answer bounded. */
const MAX_WEEKS = 52;
const DAY_MS = 86_400_000;

/** The Monday (UTC) of the week an instant falls in, as `YYYY-MM-DD`. */
export function weekOf(isoTime: string): string {
  const date = new Date(`${isoTime.slice(0, 10)}T00:00:00.000Z`);
  return new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

export function signupFunnel(people: RosterPerson[], now = new Date()): SignupFunnel {
  const outside = people.filter((person) => !person.kind);
  const rank = (stage: RosterStage) => ROSTER_STAGES.indexOf(stage);
  const reached = (group: RosterPerson[]) => Object.fromEntries(ROSTER_STAGES
    .map((stage) => [stage, group.filter((person) => rank(person.stage) >= rank(stage)).length])) as Record<RosterStage, number>;

  const joinedWeeks = outside.flatMap((person) => (person.joinedAt ? [weekOf(person.joinedAt)] : []));
  const thisWeek = weekOf(now.toISOString());
  const weeks: SignupWeek[] = [];
  for (let week = joinedWeeks.sort()[0] ?? thisWeek; week <= thisWeek;
    week = new Date(Date.parse(week) + 7 * DAY_MS).toISOString().slice(0, 10)) {
    const joined = outside.filter((person) => person.joinedAt && weekOf(person.joinedAt) === week);
    weeks.push({ weekOf: week, signups: joined.length, reached: reached(joined) });
  }

  const bySource = new Map<string, RosterPerson[]>();
  for (const person of outside.filter((entry) => entry.from)) {
    bySource.set(person.from, [...(bySource.get(person.from) ?? []), person]);
  }

  const everyone = reached(outside);
  return {
    at: now.toISOString(),
    outside: outside.length,
    stages: ROSTER_STAGES.map((stage) => ({
      stage,
      reached: everyone[stage],
      standing: outside.filter((person) => person.stage === stage).length,
    })),
    accounts: [...outside]
      .sort((a, b) => (b.joinedAt ?? '').localeCompare(a.joinedAt ?? ''))
      .map((person) => ({
        code: person.code,
        via: person.via,
        ...(person.joinedAt ? { joinedAt: person.joinedAt } : {}),
        ...(person.from ? { from: person.from, firstPage: person.firstPage } : {}),
        stage: person.stage,
        ...(person.stageAt ? { stageAt: person.stageAt } : {}),
        ...(person.lastSeenAt ? { lastSeenAt: person.lastSeenAt } : {}),
      })),
    weeks: weeks.slice(-MAX_WEEKS),
    sources: [...bySource]
      .map(([from, group]) => ({ from, signups: group.length, reached: reached(group) }))
      .sort((a, b) => b.signups - a.signups || a.from.localeCompare(b.from)),
    unrecorded: outside.filter((person) => !person.from).length,
  };
}
