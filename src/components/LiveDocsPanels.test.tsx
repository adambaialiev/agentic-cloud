import React from 'react';
import { render as renderBare } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LiveClaudeSignIn, LiveFirstGreeting, LiveFirstPlan, LiveFirstSignIn, LiveSignIn, LiveSignUp } from './LiveSetup';
import LiveSettings from './LiveSettings';
import { LiveAddSecret, LiveJobs, LiveMailCompose, LiveNewAgent } from './LiveForms';

/**
 * The panels the documentation adds to the landing's set: the screens
 * before Home, Settings, and the forms. Each is the app's own component
 * on fixture data (or, for the two the app cannot mount outside its gate,
 * the app's own classes), so what is pinned here is that the panel draws
 * the words the chapter beside it says are on the screen.
 */

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

describe('the documentation’s own live panels', () => {
  it.each([
    // The box beside the form says a subscription is all that comes next
    // (in your own Agentic Cloud the computers were connected at install).
    ['sign-up', <LiveSignUp />, ['Create your Workspace.', 'First name', 'Last name', 'Password', 'Confirm password', 'Create account', 'After you create your account', 'Sign in Codex or Claude', 'Nothing else']],
    ['sign-in', <LiveSignIn />, ['Your Workspace, anywhere.', 'Sign in', 'Forgot your password?']],
    // The first run (note #726): the greeting, the ask and the plan, in the
    // Chief of Staff's own chat; the words are shared/first-run.ts's.
    ['first greeting', <LiveFirstGreeting />, ['Chief of Staff', 'I run your agents. Tell me what you\'re working on, and I\'ll put a team on it.']],
    ['first sign-in ask', <LiveFirstSignIn />, ['Put a waitlist page live for my meal planner idea.', 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.', 'Claude', 'Claude Pro or Max subscription', 'Codex', 'ChatGPT Plus or Pro subscription', 'You sign in on Claude\'s or OpenAI\'s own page, and your password never touches us.']],
    ['first plan', <LiveFirstPlan />, ['Your Claude plan is signed in.', 'Brought in Juno.', 'Brought in Ivy.', 'Here’s the plan.', 'They’re starting now. I’ll tell you when the page is up.', 'Computer being built…', 'Starting…']],
    ['Claude sign-in', <LiveClaudeSignIn />, ['Sign in to Claude', 'Open and approve', 'Open the Claude sign-in', 'You sign in on Anthropic’s own page, and your password never touches us.', 'Paste the code it gives you', 'Finish sign-in']],
    ['settings', <LiveSettings />, ['Settings', 'Name', 'James Okafor', 'Picture', 'Your address', 'james@agents.northstar.com', 'Access', 'Password', 'Recovery email', 'Authenticator security', 'This browser', 'Sign out']],
    ['mail compose', <LiveMailCompose />, ['New message', 'To', 'Subject', 'Message', 'Send message']],
    ['add secret', <LiveAddSecret />, ['Add a secret', 'Name', 'Value', 'Whose agents get it', 'Admins’ agents only', 'Every agent in the workplace', 'Save for the workplace']],
    ['new agent', <LiveNewAgent />, ['New agent', 'What should it run?', 'Claude Code', 'Runs on your Claude subscription', 'Codex', 'Cancel']],
  ] as const)('draws %s with the words the chapter names', (_name, ui, words) => {
    const { unmount } = render(ui);
    const body = text();
    for (const word of words) expect(body, word).toContain(word);
    const panel = document.querySelector('.ws-live')!;
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.previousElementSibling?.className).toBe('sr-only');
    unmount();
  });

  // Note #1081 (claim 41 of the acceptance pass): the docs describe your own
  // Agentic Cloud, so the sign-up picture is drawn as one draws it, never
  // with our hosted platform's domain and its "no cloud account" line.
  it('draws the sign-up page as your own Agentic Cloud draws it', () => {
    const { unmount } = render(<LiveSignUp />);
    const body = text();
    expect(body).toContain('@agents.northstar.com');
    expect(body).toContain('Your agents’ computers run in your company’s own cloud account, which pays for them. It was connected when your Agentic Cloud was installed.');
    expect(body).not.toMatch(/agenticcloudcomputer\.com|no cloud account to connect|run on the cloud, free/);
    unmount();
  });

  it('draws the background jobs head in the page and the cards once hydrated', () => {
    // jsdom hydrates at once, so the cards are there; the frame is what the
    // prerender carries either way.
    const { unmount } = render(<LiveJobs />);
    const body = text();
    for (const word of ['Background jobs', 'Ruby', 'Running', 'Recently finished', 'Finished', 'Timed out', 'Job ID']) expect(body, word).toContain(word);
    unmount();
  });
});
