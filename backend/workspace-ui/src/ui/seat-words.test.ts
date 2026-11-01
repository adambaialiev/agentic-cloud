import { describe, expect, it } from 'vitest';
import { agentsWorkingOnSeat, seatForAgent, seatsEmptyState } from './seat-words.js';

/**
 * The agent→seat join behind a subscription's active indicator (note #326).
 * Its whole job is to say WHICH sign-in a running turn is spending, and the
 * cases that matter are the ones where the answer is not the obvious seat:
 * a pin, a pin naming a seat that is gone, and a second provider.
 */

const claudePrimary = { seatId: 's1', provider: 'claude', selected: true };
const claudeFallback = { seatId: 's2', provider: 'claude', selected: false };
const codex = { seatId: 's3', provider: 'codex', selected: true };
const seats = [claudePrimary, claudeFallback, codex];

describe('seatForAgent', () => {
  it('sends an unpinned agent to the primary seat of its own harness', () => {
    expect(seatForAgent({ cli: 'claude' }, seats)).toBe('s1');
    expect(seatForAgent({ cli: 'codex' }, seats)).toBe('s3');
  });

  it('honours a pin, primary or not', () => {
    expect(seatForAgent({ cli: 'claude', seatId: 's2' }, seats)).toBe('s2');
  });

  it('falls back to the primary when the pin names a seat that is gone', () => {
    expect(seatForAgent({ cli: 'claude', seatId: 'deleted' }, seats)).toBe('s1');
  });

  it('has no answer for a harness with no sign-in here', () => {
    expect(seatForAgent({ cli: 'gemini' }, seats)).toBeNull();
  });
});

describe('agentsWorkingOnSeat', () => {
  const fleet = [
    { cli: 'claude', working: true },
    { cli: 'claude', working: true },
    { cli: 'claude' },
    { cli: 'claude', seatId: 's2', working: true },
    { cli: 'codex', working: true },
  ];

  it('counts only the turns actually running on that seat', () => {
    expect(agentsWorkingOnSeat(claudePrimary, fleet, seats)).toBe(2);
    expect(agentsWorkingOnSeat(claudeFallback, fleet, seats)).toBe(1);
    expect(agentsWorkingOnSeat(codex, fleet, seats)).toBe(1);
  });

  it('is zero for an empty or unread fleet rather than throwing', () => {
    expect(agentsWorkingOnSeat(claudePrimary, null, seats)).toBe(0);
    expect(agentsWorkingOnSeat(claudePrimary, [], seats)).toBe(0);
  });

  it('counts nothing for a harness whose sign-in is not in the list', () => {
    expect(agentsWorkingOnSeat(claudePrimary, [{ cli: 'gemini', working: true }], seats)).toBe(0);
  });
});

/** The zero state of "Your subscriptions" (note #491): what fills the shelf depends
 *  on whether this member already holds a sign-in somewhere else. */
describe('seatsEmptyState', () => {
  it('tells a member with no sign-in at all what one is for', () => {
    const words = seatsEmptyState('Nomad Trading', 0);
    expect(words.title).toBe('Your agents need a subscription');
    expect(words.body).toContain('the agents in Nomad Trading can start work on it');
    expect(words.body).toContain('never see its credentials');
  });

  it('sends a member who holds one elsewhere to the list below, counted', () => {
    expect(seatsEmptyState('Nomad Trading', 1).title).toBe('Nothing assigned here yet');
    expect(seatsEmptyState('Nomad Trading', 1).body).toMatch(/^The sign-in you already hold can work here too/);
    expect(seatsEmptyState('Nomad Trading', 3).body).toMatch(/^The 3 sign-ins you already hold/);
  });
});

describe('OpenCode, the third subscription (note #780)', () => {
  it('is named as itself, and has its own sign-in address', async () => {
    const { providerForSignInSlug, signInSlug, subscriptionName } = await import('./seat-words.js');
    expect(subscriptionName('opencode')).toBe('OpenCode');
    expect(subscriptionName('codex')).toBe('ChatGPT');
    expect(subscriptionName('claude')).toBe('Claude');
    expect(signInSlug('opencode')).toBe('opencode');
    expect(providerForSignInSlug('opencode')).toBe('opencode');
    expect(providerForSignInSlug('chatgpt')).toBe('codex');
    expect(providerForSignInSlug('gemini')).toBeNull();
  });
});
