import { describe, expect, it } from 'vitest';
import {
  buildSessionRelayText,
  buildSessionRelayTitle,
  formatSessionRelaySourceLabel,
  normalizeSessionRelayContent,
} from '../../agent/session-relay.js';

describe('session relay helpers', () => {
  it('keeps relay message content limited to the child output', () => {
    expect(buildSessionRelayText(
      'session-child',
      'Checkout Investigator',
      '\n\nFound the retry bug in the checkout worker.\n',
    )).toBe('Found the retry bug in the checkout worker.');
  });

  it('strips legacy relay wrappers from persisted relay content', () => {
    expect(normalizeSessionRelayContent(
      [
        'Relayed reply from session Checkout Investigator (session-child):',
        '',
        'Found the retry bug in the checkout worker.',
      ].join('\n'),
      'session-child',
      'Checkout Investigator',
    )).toBe('Found the retry bug in the checkout worker.');
  });

  it('keeps source attribution in labels and titles', () => {
    expect(formatSessionRelaySourceLabel('session-child', 'Checkout Investigator'))
      .toBe('Checkout Investigator (session-child)');
    expect(buildSessionRelayTitle('session-child', 'Checkout Investigator'))
      .toBe('Relay from Checkout Investigator (session-child)');
  });
});
