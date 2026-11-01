import { describe, expect, it } from 'vitest';
import { askedOf } from './ask-words.js';

describe('askedOf', () => {
  it('names the agent and the person a teammate’s request waits on', () => {
    expect(askedOf({ canDecide: false, byAgentName: 'Leo', byOwnerName: 'Dana Ives' })).toBe('Leo asked Dana Ives');
  });

  it('falls back to its owner when the person is not known, and to an agent when the name is gone', () => {
    expect(askedOf({ canDecide: false, byAgentName: 'Leo' })).toBe('Leo asked its owner');
    expect(askedOf({ canDecide: false })).toBe('An agent asked its owner');
  });

  it('asks the reader themself when they decide it', () => {
    expect(askedOf({ canDecide: true, byAgentName: 'Felix' })).toBe('Felix asked you');
  });
});
