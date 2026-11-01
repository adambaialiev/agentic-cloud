import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TermsOfService from './TermsOfService';
import PrivacyPolicy from './PrivacyPolicy';

describe('Terms of Service', () => {
  it('describes the Workspace-native, browser-only product', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/one shared\s+Workspace/);
    // The sign-in the product actually has since the email identities landed:
    // an address and a password, confirmed by email, with the authenticator as
    // an OPTIONAL second factor. The previous text described the retired
    // username + rotating-code flow as the only way in.
    expect(body).toMatch(/sign up in a browser by choosing your own address on our mail domain and a\s+password/);
    expect(body).toMatch(/may add an authenticator app as a second factor/);
    expect(body).toMatch(/updates appear there,\s+with optional browser alerts/);
    expect(body).not.toMatch(/username and a rotating\s+authenticator code/);
    expect(body).not.toMatch(/factory bot|Telegram|bot accounts/i);
  });

  it('describes a free product and separate customer provider accounts', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/their own Claude or ChatGPT plan/);
    expect(body).toMatch(/We do not buy, hold or resell model access/);
    // Note #664 (2026-09-25): a new workplace brings no cloud account; its
    // machines and sites run on ours, free, within per-workplace limits.
    expect(body).toMatch(/Agent machines and the sites your\s+agents deploy run on our own Fly.io account, at no charge to you/);
    expect(body).toMatch(/per-workplace limits the Workspace shows/);
    expect(body).not.toMatch(/organisation’s own Fly.io account|on Fly’s bill|scoped token/);
    expect(body).toMatch(/Agentic Cloud Computer is free to use/);
    expect(body).toMatch(/do not\s+charge you, accept payments, collect payment details, operate checkout or offer a paid\s+tier/);
    expect(body).toMatch(/third-party provider charges are separate from this\s+free service/);
    // /refunds is retired; what that page was for has to survive inside the
    // Terms rather than vanish with it.
    expect(body).toMatch(/there is no platform payment to refund/);
    expect(body).toMatch(/belongs with the\s+provider that billed you/);
    expect(body).toMatch(/was not collected by this service/);
    expect(body).toMatch(/Nothing here limits a stronger right the law gives you/);
    expect(body).not.toMatch(/\/refunds|Payments and refunds page/);
    expect(body).not.toMatch(/Paddle|merchant of record|\$\s?\d|one small server/i);
  });

  it('states the approval gate as a control, not a promise of correctness', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/an agent cannot merge\s+it, approve it, complete the deletion of a site or repository, or widen access to a\s+saved secret/);
    expect(body).toMatch(/you are responsible for what you\s+approve/);
  });

  it('does not overpromise portability of platform-held records', () => {
    render(<TermsOfService />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Workspace records.*recent conversation rows, notes, proposals and\s+encrypted credentials/s);
    expect(body).toMatch(/platform-hosted Workspace\s+records do not automatically move/);
    // What a deletion takes, now that the machines are ours (note #664).
    expect(body).toMatch(/Deleting a workplace destroys its agent machines and sites on the cloud/);
    expect(body).not.toMatch(/Work\s+already running in an account you control remains there/);
    expect(body).not.toMatch(/everything.*keeps running.*never on our infrastructure/is);
  });
});

describe('Privacy Policy', () => {
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
    expect(body).toMatch(/sign up and sign in to the Workspace in a browser with your own address on our mail\s+domain and a password/);
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
    expect(body).toMatch(/stores no card, platform invoice or subscription billing record/);
    expect(body).not.toMatch(/Paddle/);
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
