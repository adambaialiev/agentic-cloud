import { describe, expect, it } from 'vitest';
import {
  inferContentType,
  resolveAttachmentRenderMode,
  sanitizeStorageSegment,
} from '../../services/session-attachments.js';

describe('attachment storage segments', () => {
  it('normalizes unsafe path characters without changing safe identifiers', () => {
    expect(sanitizeStorageSegment(' user/@bad id ', 'user')).toBe('user_bad_id');
    expect(sanitizeStorageSegment('agent-1.photo', 'agent')).toBe('agent-1.photo');
  });

  it('uses the caller fallback when no safe characters remain', () => {
    expect(sanitizeStorageSegment('///', 'attachment')).toBe('attachment');
  });
});

/**
 * What a file is allowed to be DRAWN as, which is decided entirely by the type
 * inferred when it was stored. The case that matters is the one with no claim
 * at all: `agentbuilt … attach` sends the bytes as the whole request body, so
 * the only header it can honestly set is `application/octet-stream`. Taken as
 * an override, that made every screenshot an agent pushed unrenderable, while
 * the same file picked in the Workspace came through as an image — the same
 * picture drawing differently depending only on who attached it (Owner, note
 * #22, off a photo of proposal #167 showing a PNG as a grey document row).
 */
describe('attachments: what type a file is stored as', () => {
  it('lets the name speak when the upload claimed nothing', () => {
    expect(inferContentType('kpage-files.png', 'application/octet-stream')).toBe('image/png');
    expect(inferContentType('shot.JPG', 'application/octet-stream')).toBe('image/jpeg');
  });

  it('is the same answer as sending no header at all', () => {
    // The two are the same statement — "I do not know" — so they must not
    // produce different files on two screens.
    expect(inferContentType('kpage-files.png', 'application/octet-stream'))
      .toBe(inferContentType('kpage-files.png'));
  });

  it('still believes a real claim over the name', () => {
    // A browser upload knows what it picked, and a name can lie.
    expect(inferContentType('report.png', 'application/pdf')).toBe('application/pdf');
    expect(inferContentType('notes.txt', 'text/markdown; charset=utf-8'))
      .toBe('text/markdown; charset=utf-8');
  });

  it('leaves a file it cannot place as the generic blob', () => {
    expect(inferContentType('backup.sqlite3', 'application/octet-stream')).toBe('application/octet-stream');
    expect(inferContentType('no-extension', 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('ignores a header that is not a content type', () => {
    expect(inferContentType('kpage-files.png', 'not a type')).toBe('image/png');
    expect(inferContentType('kpage-files.png', '')).toBe('image/png');
  });

  it('carries an agent-pushed screenshot all the way to “draw it”', () => {
    // The end of the chain the bug broke: attached by an agent, and the screen
    // is now allowed to render it.
    const stored = inferContentType('kpage-files.png', 'application/octet-stream');
    expect(resolveAttachmentRenderMode(stored).renderAs).toBe('image');
  });

  it('keeps SVG out of the image branch however it arrives', () => {
    // Deliberate, and the same call the note screen already made: an SVG is a
    // document that can carry script, so it stays a row you tap rather than
    // something a screen draws inline.
    const stored = inferContentType('diagram.svg', 'application/octet-stream');
    expect(stored).toBe('image/svg+xml');
    expect(resolveAttachmentRenderMode(stored).renderAs).toBe('download');
  });
});
