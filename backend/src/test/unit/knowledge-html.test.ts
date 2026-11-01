import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_PAGE_MAX_BYTES,
  knowledgePagePath,
  readKnowledgePageMeta,
  validateKnowledgeHtml,
  validateKnowledgePageName,
} from '../../types/knowledge.js';

/**
 * The content rule is load-bearing twice over (docs/agent-knowledge-pages.md):
 * the owner reads these pages rendered INSIDE the Workspace's own styling, and
 * agents read the source on every lookup. So a page carrying its own CSS breaks
 * dark mode, and a page that is mostly `<style>` is a cost every reader pays.
 *
 * These tests are the rule. They also pin the refusals to be USEFUL sentences —
 * an agent that cannot tell why its page bounced writes the same page again.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Deploying the site</title>
  <meta name="description" content="The exact steps, and what to check after.">
</head>
<body>
  <h1>Deploying the site</h1>
  <p>Run the deploy, then <a href="https://example.com/status">check status</a>.</p>
  <table><tr><th>Step</th><td>What it does</td></tr></table>
  <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#333" /></svg>
</body>
</html>`;

describe('knowledge page names', () => {
  it('accepts kebab-case names and rejects the shapes that break paths', () => {
    expect(validateKnowledgePageName('deploy-runbook')).toBeNull();
    expect(validateKnowledgePageName('a1')).toBeNull();
    expect(validateKnowledgePageName('Deploy')).not.toBeNull();
    expect(validateKnowledgePageName('deploy runbook')).not.toBeNull();
    expect(validateKnowledgePageName('../etc/passwd')).not.toBeNull();
    expect(validateKnowledgePageName('a')).not.toBeNull();
  });

  it('says to leave the extension off rather than silently accepting it', () => {
    expect(validateKnowledgePageName('runbook.html')).toMatch(/\.html/);
  });

  it('puts a page where the host expects it', () => {
    expect(knowledgePagePath('deploy-runbook')).toBe('pages/deploy-runbook.html');
  });
});

describe('validateKnowledgeHtml', () => {
  it('accepts a semantic page with a table, a link and inline SVG', () => {
    expect(validateKnowledgeHtml(PAGE)).toBeNull();
  });

  it('refuses script, and says why', () => {
    const error = validateKnowledgeHtml(`${PAGE}<script>alert(1)</script>`);
    expect(error).toMatch(/JavaScript/i);
  });

  it('refuses an event handler attribute — the quiet way to smuggle script in', () => {
    const error = validateKnowledgeHtml('<p onclick="alert(1)">hi</p>');
    expect(error).toMatch(/event handler/i);
  });

  it('refuses author CSS in both of its shapes, pointing at dark mode', () => {
    expect(validateKnowledgeHtml('<style>p{color:red}</style>')).toMatch(/CSS/i);
    expect(validateKnowledgeHtml('<p style="color:red">hi</p>')).toMatch(/dark mode/i);
  });

  it('refuses embedding, external resources and forms', () => {
    expect(validateKnowledgeHtml('<iframe src="https://example.com"></iframe>')).not.toBeNull();
    expect(validateKnowledgeHtml('<link rel="stylesheet" href="https://x/y.css">')).not.toBeNull();
    expect(validateKnowledgeHtml('<form><input name="x"></form>')).not.toBeNull();
    expect(validateKnowledgeHtml('<canvas></canvas>')).toMatch(/SVG/i);
  });

  it('refuses javascript: urls while allowing https, mailto and anchors', () => {
    expect(validateKnowledgeHtml('<a href="javascript:alert(1)">x</a>')).not.toBeNull();
    // Whitespace and case are how this check is dodged; both are normalised.
    expect(validateKnowledgeHtml('<a href="JAVA\tSCRIPT:alert(1)">x</a>')).not.toBeNull();
    expect(validateKnowledgeHtml('<a href="https://example.com">x</a>')).toBeNull();
    expect(validateKnowledgeHtml('<a href="mailto:a@b.c">x</a>')).toBeNull();
    expect(validateKnowledgeHtml('<a href="#section">x</a>')).toBeNull();
  });

  it('allows an inline image and refuses a non-image data url', () => {
    expect(validateKnowledgeHtml('<img src="data:image/png;base64,AAAA" alt="a">')).toBeNull();
    expect(validateKnowledgeHtml('<img src="data:text/html;base64,AAAA" alt="a">')).not.toBeNull();
  });

  it('refuses a page over the size cap', () => {
    const huge = `<title>x</title><p>${'a'.repeat(KNOWLEDGE_PAGE_MAX_BYTES)}</p>`;
    expect(validateKnowledgeHtml(huge)).toMatch(/at most/);
  });

  it('reads a comment without walking into it', () => {
    expect(validateKnowledgeHtml('<!-- <script>alert(1)</script> --><p>hi</p>')).toBeNull();
  });
});

describe('readKnowledgePageMeta', () => {
  it('reads the title and description a listing needs', () => {
    expect(readKnowledgePageMeta(PAGE)).toEqual({
      title: 'Deploying the site',
      description: 'The exact steps, and what to check after.',
    });
  });

  it('insists on a description, because that is what a list shows', () => {
    const result = readKnowledgePageMeta('<title>A page</title><p>hi</p>');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/description/);
  });

  it('insists on a title', () => {
    const result = readKnowledgePageMeta('<meta name="description" content="x"><p>hi</p>');
    expect((result as { error: string }).error).toMatch(/<title>/);
  });

  it('decodes entities and collapses whitespace in both', () => {
    const meta = readKnowledgePageMeta(
      '<title>Ben &amp;\n  Ada</title><meta name=\'description\' content=\'Two &quot;agents&quot;\'>',
    );
    expect(meta).toEqual({ title: 'Ben & Ada', description: 'Two "agents"' });
  });
});
