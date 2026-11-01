import { describe, expect, it } from 'vitest';
import { CHAT_TOUCH_QUERY, chatEnterSends, type ComposerPress } from './chat-compose.js';

/**
 * What a press in the chat box means (note #291). The composer's own tests
 * drive the real box through React; these hold the rule itself, where every
 * case is one line and the ones that matter are the ones nobody types on
 * purpose — an IME candidate being chosen, a phone with no Shift key.
 */

const press = (over: Partial<ComposerPress> = {}): ComposerPress => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
  ...over,
});

describe('chatEnterSends', () => {
  it('sends on a plain Enter, and only where there is a keyboard', () => {
    expect(chatEnterSends(press(), true)).toBe(true);
    // A touch keyboard's Enter IS the newline key, and has no Shift beside it.
    expect(chatEnterSends(press(), false)).toBe(false);
  });

  it('leaves Shift+Enter to the browser — that is the new line the note asks for', () => {
    expect(chatEnterSends(press({ shiftKey: true }), true)).toBe(false);
  });

  it('leaves every other modifier alone as well', () => {
    for (const held of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(chatEnterSends(press({ [held]: true }), true), held).toBe(false);
    }
  });

  it('never sends on an Enter that is finishing an IME word', () => {
    // The browser that says so outright…
    expect(chatEnterSends(press({ isComposing: true }), true)).toBe(false);
    // …and Safari, which commits the candidate with `isComposing` already
    // false and only the 229 keyCode left to say what the press was.
    expect(chatEnterSends(press({ keyCode: 229 }), true)).toBe(false);
  });

  it('is deaf to every other key', () => {
    for (const key of ['a', 'Escape', 'Tab', 'Backspace', ' ']) {
      expect(chatEnterSends(press({ key }), true), key).toBe(false);
    }
  });
});

describe('CHAT_TOUCH_QUERY', () => {
  it('recognises the finger, and lets every other window keep Enter', () => {
    // The negative test on purpose: a window with no pointing device reports
    // `pointer: none`, and a keyboard-only desk must not lose the key.
    expect(CHAT_TOUCH_QUERY).toBe('(pointer: coarse)');
  });
});
