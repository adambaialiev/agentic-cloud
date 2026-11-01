import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentDraftKey, directDraftKey, DRAFTS_KEPT, forgetDrafts, recallDraft, recapDraftKey, rememberDraft,
} from './draft-memory.js';

/** The store behind note #515: what a composer left behind, and what it is
 *  deliberately not allowed to leave behind. */
describe('the draft memory', () => {
  beforeEach(() => { forgetDrafts(); });

  it('hands one conversation its own words back and never another’s', () => {
    rememberDraft(agentDraftKey('felix'), 'half a thought');
    expect(recallDraft(agentDraftKey('felix'))).toBe('half a thought');
    // A conversation nobody has typed in opens empty, rather than on the
    // last one the reader was in.
    expect(recallDraft(agentDraftKey('ruby'))).toBe('');
  });

  it('keeps the three kinds of conversation apart', () => {
    rememberDraft(agentDraftKey('felix'), 'to Felix');
    rememberDraft(recapDraftKey('felix'), 'to the Workspace Agent');
    rememberDraft(directDraftKey('o1', 'felix'), 'to a person');
    expect(recallDraft(agentDraftKey('felix'))).toBe('to Felix');
    expect(recallDraft(recapDraftKey('felix'))).toBe('to the Workspace Agent');
    expect(recallDraft(directDraftKey('o1', 'felix'))).toBe('to a person');
    // A private conversation is named by its workplace as well as its thread,
    // exactly as the screen is keyed.
    expect(recallDraft(directDraftKey('o2', 'felix'))).toBe('');
  });

  it('forgets a box that was cleared, and one the send emptied', () => {
    const key = agentDraftKey('felix');
    rememberDraft(key, 'half a thought');
    rememberDraft(key, '');
    expect(recallDraft(key)).toBe('');
    rememberDraft(key, '   \n ');
    // Spaces are not a message: the send button refuses them, so nothing is
    // waiting here either.
    expect(recallDraft(key)).toBe('');
  });

  it('keeps the words exactly, spaces and lines and all', () => {
    const key = agentDraftKey('felix');
    rememberDraft(key, 'first line\nsecond line ');
    expect(recallDraft(key)).toBe('first line\nsecond line ');
  });

  it('drops the conversations left longest ago rather than growing forever', () => {
    for (let n = 0; n <= DRAFTS_KEPT; n += 1) rememberDraft(agentDraftKey(`a${n}`), `draft ${n}`);
    expect(recallDraft(agentDraftKey('a0'))).toBe('');
    expect(recallDraft(agentDraftKey('a1'))).toBe('draft 1');
    expect(recallDraft(agentDraftKey(`a${DRAFTS_KEPT}`))).toBe(`draft ${DRAFTS_KEPT}`);
  });

  it('counts a draft typed in again as the freshest, not the oldest', () => {
    rememberDraft(agentDraftKey('felix'), 'first');
    for (let n = 1; n < DRAFTS_KEPT; n += 1) rememberDraft(agentDraftKey(`a${n}`), `draft ${n}`);
    rememberDraft(agentDraftKey('felix'), 'still typing');
    rememberDraft(agentDraftKey('last'), 'one more');
    expect(recallDraft(agentDraftKey('felix'))).toBe('still typing');
    expect(recallDraft(agentDraftKey('a1'))).toBe('');
  });

  it('gives up everything when the person does', () => {
    rememberDraft(agentDraftKey('felix'), 'half a thought');
    forgetDrafts();
    expect(recallDraft(agentDraftKey('felix'))).toBe('');
  });
});
