import { describe, expect, it } from 'vitest';
import { resolveAgentbuiltApiUrl } from '../../config/agentbuilt.js';

describe('agentbuilt public API URL', () => {
  it('uses the dedicated URL and removes trailing slashes', () => {
    expect(resolveAgentbuiltApiUrl(' https://api.example.com/// ', 'https://old.example.com/hook'))
      .toBe('https://api.example.com');
  });

  it('keeps provisioning agents on hosts still carrying the retired webhook setting', () => {
    expect(resolveAgentbuiltApiUrl(undefined, 'https://api.example.com/api/webhooks/telegram'))
      .toBe('https://api.example.com');
  });

  it('does not turn an invalid legacy value into machine configuration', () => {
    expect(resolveAgentbuiltApiUrl(undefined, 'not a URL')).toBe('');
    expect(resolveAgentbuiltApiUrl(undefined, undefined)).toBe('');
  });
});
