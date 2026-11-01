import { describe, expect, it } from 'vitest';
import { escapeTelegramHtml } from '../../utils/telegram-text.js';

describe('telegram text utilities', () => {
  it('escapes dynamic text for Telegram HTML', () => {
    expect(escapeTelegramHtml('Use <deploy> & review > output')).toBe(
      'Use &lt;deploy&gt; &amp; review &gt; output',
    );
  });
});
