import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { htmlReplyNeedsFrame, htmlReplyParts, htmlToPlainText, isHtmlReply, replyPlainText } from '../../shared/agent-html.js';
import { recapHtmlStates, type RecapMessage } from '../../shared/workspace-recap-chat.js';
import { REPLY_FRAME_CONTENT_SECURITY_POLICY, replyFrameRoutes } from '../../routes/reply-frame.js';
import { WORKSPACE_AGENT_INSTRUCTIONS, quietLine } from '../../services/workspace-recap-chat.js';

describe('HTML replies (note #1186): which reply is HTML, and its plain words', () => {
  it('reads a reply that opens with a tag as HTML, and every Markdown reply as Markdown', () => {
    expect(isHtmlReply('<p>Done.</p>')).toBe(true);
    expect(isHtmlReply('  \n<div class="x">a</div>')).toBe(true);
    expect(isHtmlReply('<!-- plan --><h3>Plan</h3>')).toBe(true);
    expect(isHtmlReply('<br/>')).toBe(true);
    expect(isHtmlReply('**Done.** The `<div>` is gone.')).toBe(false);
    expect(isHtmlReply('Done — see <a href="x">here</a>')).toBe(false);
    expect(isHtmlReply('<https://example.com> is live')).toBe(false);
    expect(isHtmlReply('<adam@example.com> wrote')).toBe(false);
    expect(isHtmlReply('< not a tag')).toBe(false);
    expect(isHtmlReply('')).toBe(false);
    expect(isHtmlReply(undefined)).toBe(false);
  });

  it('takes a Markdown lead-in before an HTML block that asks, as Claude Code writes it (note #1191), but never HTML shown in a code fence or a block that only tells', () => {
    const real = "It's live. My next message is a **real** reply.\n\n<p>Six decisions.</p>\n<form data-reply=\"Open\">\n<label><input type=\"radio\" name=\"a\" value=\"yes\" checked> Yes</label>\n<button type=\"submit\">Send</button></form>";
    expect(htmlReplyParts(real)).toEqual({ lead: "It's live. My next message is a **real** reply.", html: real.slice(real.indexOf('<p>')) });
    expect(isHtmlReply(real)).toBe(true);
    expect(replyPlainText(real)).toBe("It's live. My next message is a **real** reply.\n\nSix decisions.\n\nYes\n\n[Send]");
    expect(isHtmlReply('Here is the form I would use:\n\n```html\n<form><button>Go</button></form>\n```')).toBe(false);
    expect(isHtmlReply('A table:\n\n<table><tr><td>1</td></tr></table>')).toBe(false);
    expect(isHtmlReply('Indented code:\n\n    <form><button>Go</button></form>')).toBe(false);
    expect(htmlReplyParts('<p>From the first character.</p>')).toEqual({ lead: '', html: '<p>From the first character.</p>' });
  });

  it('sends only what runs or asks to the frame; words are drawn natively', () => {
    expect(htmlReplyNeedsFrame('<p>Hi <a href="/workspace/notes/1">note</a></p><ul><li>a</li></ul>')).toBe(false);
    expect(htmlReplyNeedsFrame('<p>x</p><button data-reply="yes">Yes</button>')).toBe(true);
    expect(htmlReplyNeedsFrame('<form><input name="a"></form>')).toBe(true);
    expect(htmlReplyNeedsFrame('<script>1</script>')).toBe(true);
    expect(htmlReplyNeedsFrame('<p style="color:red">x</p>')).toBe(true);
    expect(htmlReplyNeedsFrame('<p onclick="x()">x</p>')).toBe(true);
    expect(htmlReplyNeedsFrame('<div data-reply="go">Go</div>')).toBe(true);
  });

  it('turns HTML into readable lines: blocks, list items, buttons, entities; no script, style or drawing', () => {
    const html = '<h3>Two things</h3><p>The page is <b>live</b> &amp; fast&nbsp;now.</p><ul><li>One</li><li>Two</li></ul>'
      + '<script>alert(1)</script><style>p{}</style><svg><text>chart</text></svg>'
      + '<form><label>Name <input name="n"></label><button data-reply="ok">Send it</button></form><p>&#8212; Nina &rarr;</p>';
    expect(htmlToPlainText(html)).toBe('Two things\n\nThe page is live & fast now.\n\n- One\n- Two\n\nName\n[Send it]\n\n— Nina →');
    expect(replyPlainText('**Markdown** stays')).toBe('**Markdown** stays');
    expect(replyPlainText('<p>QUIET</p>')).toBe('QUIET');
    expect(quietLine(replyPlainText('<p>QUIET — nothing new</p>'))).toBe('nothing new');
  });
});

describe('The reply frame (note #1186): closed off, one way out', () => {
  it('serves a static document under a policy with no network, no forms posted, no frames and its own sandbox', async () => {
    const app = express().use('/workspace', replyFrameRoutes());
    const server = app.listen(0);
    await new Promise((ready) => server.once('listening', ready));
    const got = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/reply-frame`);
    const res = { status: got.status, text: await got.text(), headers: Object.fromEntries(got.headers.entries()) };
    server.close();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBe(REPLY_FRAME_CONTENT_SECURITY_POLICY);
    for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", 'img-src data: blob:', 'sandbox allow-scripts allow-forms']) {
      expect(csp).toContain(rule);
    }
    expect(csp).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation|https:/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    // The inner frame gets no more than scripts and forms; the bridge posts
    // only to its parent, and the outer passes up only its own frame's words.
    expect(res.text).toContain("frame.setAttribute('sandbox','allow-scripts allow-forms')");
    expect(res.text).toContain('e.source!==frame.contentWindow');
    expect(res.text).toContain('agentbuilt={reply:reply');
    expect(res.text).not.toMatch(/fetch\(|XMLHttpRequest|document\.cookie|localStorage/);
  });
});

describe('Answer states (notes #1186, #1189): one answer per reply, live until answered or a fresh chat', () => {
  const at = '2026-11-16T22:00:00.000Z';
  const row = (id: string, role: RecapMessage['role'], text: string, extra: Partial<RecapMessage> = {}): RecapMessage => ({ id, role, text, at, ...extra });
  it('keeps every unanswered HTML reply since the fresh chat live, an answered one answered, one before the fresh chat old, never a Markdown reply', () => {
    const messages = [
      row('z', 'assistant', '<button data-reply="before">before</button>'),
      row('y', 'action', '', { kind: 'new-chat-divider' }),
      row('a', 'owner', 'Plan the week'),
      row('b', 'assistant', '<p>Pick one</p><button data-reply="A">A</button>'),
      row('c', 'owner', 'A', { answerTo: 'b' }),
      row('d', 'assistant', '**Markdown** reply'),
      row('e', 'assistant', '<form><input name="x"></form>'),
      row('f', 'assistant', '<p>newest</p><button data-reply="go">Go</button>'),
      row('g', 'assistant', '<p>event</p>', { hidden: true }),
    ];
    const states = recapHtmlStates(messages);
    expect([...states.entries()]).toEqual([[0, 'old'], [3, 'answered'], [6, 'live'], [7, 'live'], [8, 'live']]);
  });
});

describe('What the Chief of Staff is told (note #1186)', () => {
  it('writes HTML that starts with a tag, asks with data-reply, a form or agentbuilt.reply, and keeps everything else plain', () => {
    expect(WORKSPACE_AGENT_INSTRUCTIONS).not.toContain('plain text with Markdown');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('in HTML (note #1186)');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('<button data-reply=\\"Merge it\\">Merge</button>'.replace(/\\"/g, '"'));
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('agentbuilt.reply(text)');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('via: "your-html-reply"');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('answersReply');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).not.toContain('only your newest reply can be answered');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('<a href="/workspace/...">title</a>');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('no network at all');
    expect(WORKSPACE_AGENT_INSTRUCTIONS).toContain('stays plain words');
    void vi;
  });
});
