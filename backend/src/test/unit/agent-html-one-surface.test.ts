import { describe, expect, it } from 'vitest';
import { replyFrameDocument } from '../../routes/reply-frame.js';
import { progressLineSeqs } from '../../shared/agent-html.js';

/**
 * Note #1193 (Adam, 18 Nov 2026): an agent's reply is one HTML interface, and
 * the short lines it writes while it works are kept "as quiet plain lines".
 */
describe('which plain lines were written while the agent worked (note #1193)', () => {
  const row = (seq: number, role: string, text: string, more: object = {}) => ({ seq, role, text, ...more });

  it('takes the plain lines before the HTML reply of the same turn, and nothing after it', () => {
    const quiet = progressLineSeqs([
      row(1, 'owner', 'Ship it'),
      row(2, 'agent', 'Reading the note first.'),
      row(3, 'agent', 'Tests pass; opening the proposal.'),
      row(4, 'agent', '<h3>Shipped</h3><button data-reply="Thanks">Thanks</button>'),
      row(5, 'agent', 'One more thing, in plain words.'),
    ]);
    expect([...quiet]).toEqual([2, 3]);
  });

  it('leaves a turn that never answers in HTML exactly as it was: every old Markdown conversation', () => {
    expect(progressLineSeqs([
      row(1, 'owner', 'Ship it'),
      row(2, 'agent', 'Reading the note first.'),
      row(3, 'agent', '**Done.** It is live.'),
      row(4, 'owner', 'Thanks'),
      row(5, 'agent', 'Any time.'),
    ]).size).toBe(0);
  });

  it('ends a run at the person\'s words, a platform row and a fresh chat, and skips file rows', () => {
    const quiet = progressLineSeqs([
      row(1, 'agent', 'A full Markdown reply from an earlier turn.'),
      row(2, 'owner', 'Next'),
      row(3, 'agent', 'Looking.'),
      row(4, 'platform', 'Change #12 is ready for your decision'),
      row(5, 'agent', 'Waiting on you.'),
      row(6, 'platform', '------', { kind: 'new-chat-divider' }),
      row(7, 'agent', 'Checking the build.'),
      row(8, 'agent', '', { file: { id: 'f1' } }),
      row(9, 'agent', 'See the picture.', { files: [{ id: 'f2' }] }),
      row(10, 'agent', 'It is live.\n\n<form><button>OK</button></form>'),
    ]);
    // 1, 3 and 5 were cut off from any HTML reply; 8 and 9 carry files.
    expect([...quiet]).toEqual([7]);
  });
});

describe('the reply frame says when the person touched it (note #1193)', () => {
  it('posts one word, with nothing about what was touched, and the outer frame passes only that word up', () => {
    const page = replyFrameDocument();
    // Inside the agent's page: the first tap, key or change, once.
    expect(page).toContain("function touch(){if(touched)return;touched=true;post({t:'touched'})}");
    expect(page).toContain("['pointerdown','keydown','input','change'].forEach(function(n){document.addEventListener(n,touch,true)})");
    // The outer frame builds its own message: nothing the page added rides it.
    expect(page).toContain("else if(d.t==='touched'){up({t:'touched'})}");
  });
});
