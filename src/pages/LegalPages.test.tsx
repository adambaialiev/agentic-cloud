import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TermsOfService from './TermsOfService';
import PrivacyPolicy from './PrivacyPolicy';

describe('Terms of Service', () => {
  // Note #1081 (claims 9, 11 and 44 of the acceptance pass, note #1080).
  it('names the daily report, the coding tools that move without a release, and auto-merge', () => {
    render(<TermsOfService />);
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/nothing upgrades itself/);
    expect(body).toMatch(/One thing moves without a release: since\s+release 2026\.11\.07\.0, the coding tools/);
    expect(body).toMatch(/unless an admin holds a\s+version of their own/);
    expect(body).not.toMatch(/We hold only what you send us/);
    expect(body).toMatch(/the daily report your Agentic\s+Cloud sends us by itself: counts plus the name and email of the contact person/);
    expect(body).toMatch(/The one exception\s+is auto-merge/);
    expect(body).toMatch(/November 8, 2026/);
  });

  it('describes the Workspace, offered as your own Agentic Cloud, plus the invite-only hosted Workspace', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/one shared Workspace for a\s+company’s AI agents/);
    // Note #933 (the owner, 1 Nov 2026): sign-up on our cloud is closed;
    // the offer is your own Agentic Cloud.
    expect(body).toMatch(/We offer it as your own Agentic Cloud/);
    expect(body).toMatch(/new accounts are closed and an\s+account comes only with an invite/);
    // The hosted sign-in the product has: an address here and a password,
    // the authenticator OPTIONAL; never the retired username + code flow.
    expect(body).toMatch(/chooses its own address on our mail domain and a\s+password, and may add an authenticator app as a second factor/);
    expect(body).toMatch(/updates appear there,\s+with optional browser alerts/);
    expect(body).not.toMatch(/username and a rotating\s+authenticator code/);
    expect(body).not.toMatch(/You sign up in a browser/);
    expect(body).not.toMatch(/factory bot|Telegram|bot accounts/i);
    expect(body).not.toMatch(/private copy|your own copy|Get a copy/i);
  });

  // Note #935 (the owner, 1 Nov 2026, 08:56 UTC): "Let's disable licensing
  // for now ... Let's make the product free for now." No licence, price,
  // grace or key promise, on either offer.
  it('says both offers are free for now, with no licence, price or key promise', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/In a Fly.io organization of yours, on a\s+domain of yours/);
    expect(body).toMatch(/Fly bills your organization directly; nothing of ours is on\s+that bill/);
    expect(body).toMatch(/Both are free for now/);
    expect(body).toMatch(/Your own Agentic Cloud and our hosted\s+Workspace are free for now\. We charge nothing, take no payments and collect no payment\s+details\./);
    expect(body).toMatch(/The releases and support by email/);
    expect(body).not.toMatch(/licen[cs]e|update key|grace|in writing|first month/i);
    expect(body).not.toMatch(/\$\s?\d|USD|per person per month|billed yearly|Paddle|merchant of record|Stripe/i);
    expect(body).not.toMatch(/Agentic Cloud Computer is free to use|free service|open.source/i);
  });

  it('keeps provider costs apart from what we bill, and the refund lines', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/their own Claude or ChatGPT plan/);
    expect(body).toMatch(/We do not buy, hold or resell model access/);
    // The hosted Workspace (note #664): machines and sites on ours, free,
    // within per-workplace limits.
    expect(body).toMatch(/Agent machines and the\s+sites your agents deploy run on our own Fly.io account, at no charge to you/);
    expect(body).toMatch(/per-workplace limits the Workspace shows/);
    expect(body).toMatch(/Those charges are theirs,\s+not ours/);
    expect(body).toMatch(/there is no\s+payment of ours to refund/);
    expect(body).toMatch(/belongs with the provider that\s+billed you/);
    expect(body).toMatch(/was not collected by us/);
    expect(body).toMatch(/Nothing\s+here limits a stronger right the law gives you/);
    expect(body).not.toMatch(/\/refunds|Payments and refunds page|one small server/i);
  });

  it('states the approval gate as a control, not a promise of correctness', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/an agent cannot merge\s+it, approve it, complete the deletion of a site or repository, or widen access to a\s+saved secret/);
    expect(body).toMatch(/you are responsible for what you\s+approve/);
  });

  it('says what stays with the customer and does not overpromise portability of hosted records', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/your messages, code, files, mail, keys and logs stay in your Fly\s+organization and never reach us/);
    expect(body).toMatch(/backs its database up daily to a bucket of yours; we hold no copy/);
    expect(body).toMatch(/Workspace\s+records.*recent conversation rows, notes, proposals and encrypted\s+credentials/s);
    expect(body).toMatch(/platform-hosted Workspace records do\s+not automatically move/);
    expect(body).toMatch(/deleting a workplace\s+destroys its agent machines and sites on the cloud/);
    expect(body).not.toMatch(/everything.*keeps running.*never on our infrastructure/is);
  });
});

describe('Privacy Policy', () => {
  // Note #1013 (Adam, 6 Nov 2026): the home page's guide (note #1010).
  it('says what the home page agent keeps: 90 days, no address, the founder reads it, processed by Claude', () => {
    render(<PrivacyPolicy />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Questions to the agent on our home page\./);
    expect(body).toMatch(/We keep the questions you type and\s+its answers for 90 days, and the founder reads them/);
    expect(body).toMatch(/We store no\s+address, cookie or account with them/);
    expect(body).toMatch(/processed by Anthropic’s Claude, on the\s+founder’s own Claude subscription/);
    expect(body).toMatch(/November 10, 2026/);
  });

  // Note #1139 (Adam, 10 Nov 2026): a guest agent's conversation, with where its visitor came from.
  it('says what a guest agent keeps: the conversation, the country and the link tags, 90 days, never the address', () => {
    render(<PrivacyPolicy />);
    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(body).toMatch(/Guest agents on our home page\./);
    expect(body).toMatch(/We keep that conversation for 90 days, and the founder reads it\./);
    expect(body).toMatch(/your country, as our network provider Cloudflare reports it for the visit \(two letters, never your address or city\)/);
    expect(body).toMatch(/the campaign tags on the link you followed \(such as utm_source\)/);
    expect(body).toMatch(/If that link was in a letter from the founder, we can tell which company it was sent to\./);
    expect(body).toMatch(/We store no address, cookie or account with it/);
  });

  it('says a builder page’s numbers are shown only to its person, and names no Leaderboard (note #824)', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/Leaderboard/);
    expect(body).toMatch(/The numbers on it are shown only to you, signed in/);
    expect(body).toMatch(/never shows what your agents\s+work on, your workplaces or your email/);
    // A builder's page opens each day of the grid (note #208), and all-time
    // totals show (note #209).
    expect(body).toMatch(/90-day activity grid whose days show those same\s+counts for that day/);
    expect(body).toMatch(/your all-time agent\s+working hours and tokens written/);
  });

  it('states the rolling platform chat retention instead of denying storage', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/rolling window of\s+up to 500 chat rows per agent/);
    expect(body).toMatch(/your messages, agent replies and platform notices/);
    expect(body).toMatch(/New rows trim the oldest/);
    expect(body).not.toMatch(/Conversations with your agents — not stored by us/);
    expect(body).not.toMatch(/relay it without keeping a copy/);
  });

  it('states the customer/platform storage split and credentials held', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    // Note #664 (2026-09-25): the machines and sites are on our Fly.io
    // account now, not the customer's, and a workplace deletion takes them.
    expect(body).toMatch(/Agent machines and their disks, and the sites your agents deploy, run on our own Fly.io\s+account/);
    expect(body).toMatch(/Fly.io among them/);
    expect(body).toMatch(/Deleting a workplace also destroys its agent machines and sites on the cloud/);
    expect(body).not.toMatch(/organisation’s own Fly.io account|scoped cloud\s+token/);
    expect(body).toMatch(/platform may also host repositories or media/);
    expect(body).toMatch(/AI sign-in tokens, saved\s+organisation secrets/);
    expect(body).toMatch(/store these encrypted/);
    expect(body).not.toMatch(/nothing of yours|no credentials of yours/i);
  });

  it('states browser access and Workspace-native notifications', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    // Sign-up is closed on our cloud (note #823): an account only through an invite.
    expect(body).toMatch(/New accounts are made only through an invite link from a workplace that has one/);
    expect(body).toMatch(/sign\s+in to the Workspace in a browser with your own address on our mail domain and a password/);
    expect(body).not.toMatch(/sign up and sign in/);
    expect(body).toMatch(/we send a message to such an\s+address to confirm it/);
    expect(body).toMatch(/Completion notices and approval requests are kept as Workspace notification records/);
    expect(body).toMatch(/browser push service processes the minimal title/);
    // What is actually held for an account, in the words of the code that
    // holds it: a password hash, and the authenticator material only if the
    // owner opted into one.
    expect(body).toMatch(/a hash of\s+your password/);
    expect(body).toMatch(/We never store the password itself/);
    expect(body).toMatch(/encrypted\s+authenticator secret and hashed recovery codes/);
    expect(body).not.toMatch(/factory bot|Telegram/i);
  });

  // Two processors the previous policy never named. Both are checkable by the
  // reader: the confirmation email arrives, and the Workspace has a microphone.
  it('names the email and speech-to-text processors it actually uses', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/transactional email provider/);
    expect(body).toMatch(/speech-to-text provider/);
    expect(body).toMatch(/typed messages are\s+not sent to it/);
  });

  it('discloses backup retention and no platform payment record', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/14 daily snapshots/);
    expect(body).toMatch(/one weekly snapshot for up to eight\s+weeks/);
    expect(body).toMatch(/The hosted Workspace is free for now, so\s+for it we store no card, platform invoice or subscription billing record/);
    expect(body).not.toMatch(/Paddle|does not accept payments/);
  });

  // Note #933: what we sell is your own Agentic Cloud, and its data is
  // the customer's (knowledge private-copy, services/copy-health.ts).
  it('says what we hold for your own Agentic Cloud, and the only things that cross', () => {
    render(<PrivacyPolicy />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Your messages, code, files, mail, keys and logs never\s+reach us/);
    expect(body).toMatch(/no access to your Agentic Cloud unless you give it to us/);
    // Note #1081 (claims 8 and 9 of the acceptance pass, note #1080): since
    // release 2026.11.07.0 a copy sends us a daily report by itself, so
    // section 2 names it, the contact it carries, and the two public lists
    // it reads. "Only what you send us" was false from that day.
    expect(body).not.toMatch(/Only what you send us/);
    expect(body).toMatch(/the daily report below, with the name and email of the\s+contact person it carries/);
    expect(body).toMatch(/reaches us in three ways/);
    expect(body).toMatch(/Once a day, about two minutes after every\s+start, and when an admin changes the contact, it sends us a short signed report/);
    expect(body).toMatch(/turns the report off, in the Workspace under Workplace › What we tell Agentic\s+Cloud/);
    expect(body).toMatch(/follow it unless an admin holds a\s+version of their own/);
    expect(body).toMatch(/free for now, so we hold no payment record or card details for it/);
    expect(body).toMatch(/downloads it from our update service, which reads nothing from your Agentic Cloud/);
    expect(body).not.toMatch(/licen[cs]e|update key|renewal/i);
    expect(body).toMatch(/It holds no messages, code,\s+files, mail, keys or names of people, and it reaches us only if an admin sends it/);
    expect(body).not.toMatch(/Agentic Cloud Computer is free to use|private copy/i);
  });
});

describe('Legal pages', () => {
  it('dates every document that states terms', () => {
    for (const Page of [TermsOfService, PrivacyPolicy]) {
      const { unmount } = render(<Page />);
      expect(screen.getByText(/^Effective /)).toBeTruthy();
      unmount();
    }
  });

  // The site has been four different colours in three weeks, and each time
  // the legal pages were the surface left behind: near-black with an amber
  // accent from a landing that no longer existed, then light while the product
  // went dark, then dark while the landing went paper-light. A customer who
  // follows the footer from the front page must not be able to wonder whose
  // site they landed on, so these pages stand on the landing's own ground and
  // nothing here picks a colour of its own.
  it('stands on the landing page’s surface, not a palette of its own', () => {
    for (const Page of [TermsOfService, PrivacyPolicy]) {
      const { container, unmount } = render(<Page />);
      const main = container.querySelector('main')!;

      // The landing's own <main>: the app's background, its white text.
      expect(main.className).toContain('bg-panel');
      expect(main.className).toContain('text-white');
      // And the class that decides what those two tokens MEAN. Without it the
      // page renders the dark stage in src/index.css while the front page
      // renders the Workspace's paper palette — the drift of 2026-09-14, and
      // invisible to every assertion above, because the class names match.
      expect(main.className).toContain('landing-page');

      // The front page sets no type in a face the site does not otherwise
      // use. The mono eyebrow and mono date line here were the last furniture
      // of the design before it.
      expect(container.querySelector('style')).toBeNull();
      expect(container.querySelector('.fl-mono')).toBeNull();

      // No token from the light half of the palette survives anywhere on the
      // page — that is the whole failure mode, and it always arrives one
      // element at a time rather than as a wholesale revert.
      const light = ['bg-canvas', 'text-ink', 'text-prose', 'text-faint', 'bg-white'];
      const offenders = [...container.querySelectorAll('*')].flatMap((el) =>
        light.filter((token) =>
          el.className && typeof el.className === 'string'
            ? new RegExp(`(?:^|\\s)${token}(?![a-z-])`).test(el.className)
            : false,
        ),
      );
      expect([...new Set(offenders)]).toEqual([]);

      unmount();
    }
  });

  it('does not publish an individual operator identity or location', () => {
    const personalMarkers = ['Sadd' + 'am', 'Bai' + 'aliev', 'Kyr' + 'gyz Republic', 'Bish' + 'kek'];
    for (const Page of [TermsOfService, PrivacyPolicy]) {
      const { unmount } = render(<Page />);
      const body = document.body.textContent ?? '';
      for (const marker of personalMarkers) expect(body).not.toContain(marker);
      unmount();
    }
  });
});
