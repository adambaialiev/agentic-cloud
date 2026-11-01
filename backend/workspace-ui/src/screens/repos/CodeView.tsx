/**
 * A file's text, with the line numbers beside it.
 *
 * NO SYNTAX HIGHLIGHTING, and that is a deliberate difference from the legacy
 * page rather than an omission. The legacy page fetches highlight.js from
 * cdnjs at the moment a code file is opened, which its own Content-Security-
 * Policy allows (`script-src 'self' https://cdnjs.cloudflare.com …`). The
 * React shell's policy is `script-src 'self'` with no inline hashes and no
 * third-party origin — a property the shell was given on purpose and the
 * reason its loader refuses a build that grew an inline script. Colouring a
 * listing is not worth widening that, and bundling a highlighter would put
 * ~100 KB on every reader who never opens a file. The text, the numbers, the
 * wrap rule and Copy are all here; only the colours are not.
 *
 * Built as elements, never as markup: the bytes are somebody's file.
 */

import { PROSE_EXT } from './repo-nav.js';

export function CodeView({ content, ext }: { content: string; ext: string }) {
  const lines = content.split('\n');
  // Files usually end in a newline; that last empty line is not worth a number.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  // Prose — logs, CSV, raw markdown — wraps and takes no gutter: its lines
  // are sentences, and a number against each one says nothing.
  const wrap = PROSE_EXT.has(ext);
  return (
    <div className={wrap ? 'code wrap' : 'code'} style={wrap ? { gridTemplateColumns: '1fr' } : undefined}>
      {wrap ? null : <div className="gutter">{lines.map((_, at) => at + 1).join('\n')}</div>}
      <pre className="lines">{lines.join('\n')}</pre>
    </div>
  );
}
