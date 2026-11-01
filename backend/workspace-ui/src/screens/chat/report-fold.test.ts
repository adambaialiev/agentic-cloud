import { describe, expect, it } from 'vitest';
import { foldsReport, reportPreview, REPORT_FOLD_CHARS } from './report-fold.js';

describe('an agent\'s report, folded (note #744)', () => {
  it('previews the words a reader sees, without the Markdown that draws them', () => {
    expect(reportPreview('[Note #209](/workspace/notes/209) is **done**.\n\n- PR #1365 is `green`\n- ## Next: *tests*\n\n```\ncode\n```\n> quoted'))
      .toBe('Note #209 is done. PR #1365 is green Next: tests quoted');
  });

  it('folds a long report or one in paragraphs, and leaves a line or two alone', () => {
    expect(foldsReport('Back button fix is pushed; checks are running.')).toBe(false);
    expect(foldsReport('x'.repeat(REPORT_FOLD_CHARS))).toBe(false);
    expect(foldsReport('x'.repeat(REPORT_FOLD_CHARS + 1))).toBe(true);
    expect(foldsReport('Done.\n\nPR #12 is up.')).toBe(true);
  });
});
