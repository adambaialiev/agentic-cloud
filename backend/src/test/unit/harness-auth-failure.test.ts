import { describe, expect, it } from 'vitest';
import {
  claudeUsageLimitResetAtSeconds,
  isClaudeAuthFailureText,
  isClaudeModelLimitText,
  isClaudeUsageLimitText,
  isCodexAuthFailureText,
  isCodexUsageLimitText,
  usageLimitCooldownSeconds,
} from '../../agent/harness-auth-failure.js';

describe('harness auth-failure classification', () => {
  it('recognizes the ways the Claude CLI reports its own dead sign-in', () => {
    for (const text of [
      'Invalid API key · Please run /login',
      'Error: OAuth token is expired. Please run /login again.',
      'OAuth token revoked',
      'Credentials are invalid',
      'not logged in to Claude',
      // The API's own phrasing, forwarded verbatim by the CLI — what a turn
      // sees when the shared grant rotates out from under it (note #104).
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      'API Error: 401 OAuth token has expired.',
    ]) {
      expect(isClaudeAuthFailureText(text), text).toBe(true);
    }
  });

  it('recognizes the ways the Codex CLI reports its own dead sign-in', () => {
    for (const text of [
      'Not logged in. Run `codex login` to authenticate.',
      'Codex turn failed: auth token is expired',
      'token refresh failed: invalid_grant',
      'Please reauthenticate with ChatGPT',
      '401 Unauthorized from https://api.openai.com',
    ]) {
      expect(isCodexAuthFailureText(text), text).toBe(true);
    }
  });

  it('does NOT classify ordinary work failures that merely mention auth-flavored words', () => {
    // Turn output from CODING work legitimately contains these — a false
    // positive pauses the user's whole fleet on that CLI.
    for (const text of [
      'FAIL src/auth/login.test.ts — expected 401 Unauthorized, received 200',
      'npm ERR! 404 Not Found - GET https://registry.npmjs.org/left-pad',
      'Built the login page with an OAuth token input field as requested.',
      'error: failed to push some refs (authentication may be required for the remote)',
      'Claude exited with code 1. Output tail:\nSyntaxError: unexpected token',
      // Auth-flavored prose about tokens, not a CLI reporting its own death.
      'Remember to rotate your OAuth access tokens regularly; a revoked one stops working.',
      '',
    ]) {
      expect(isClaudeAuthFailureText(text), text).toBe(false);
      expect(isCodexAuthFailureText(text), text).toBe(false);
    }
  });
});

describe('usage-limit classifiers (platform credential cooldown)', () => {
  it('classifies the limit-exhaustion phrasing the CLIs report verbatim', () => {
    expect(isClaudeUsageLimitText('Claude usage limit reached ∙ resets 3pm')).toBe(true);
    expect(isClaudeUsageLimitText('5-hour limit reached')).toBe(true);
    expect(isClaudeUsageLimitText("You've reached your usage limit.")).toBe(true);
    expect(isCodexUsageLimitText("You've hit your usage limit. Upgrade to Pro or try again later.")).toBe(true);
    expect(isCodexUsageLimitText('Usage limit reached — wait for your limits to reset.')).toBe(true);
  });

  // Verbatim from production, 2026-09-15 → 2026-10-17 (note #772): none of
  // these benched the seat that said them before.
  it("classifies Claude Code 2.1.300's own limit lines", () => {
    for (const text of [
      "You've hit your session limit · resets 5pm (UTC)",
      "You've reached your Fable limit. Switch to another model to continue.",
      "You're out of usage credits. Switch to another model to continue.",
      "You're out of usage credits. /model to switch models.",
      "You've hit your team's shared budget. Switch to another model to continue.",
      "You've hit your monthly spend limit. /model to switch models.",
      'Fable 5 requires usage credits. Switch to another model to continue.',
      'Your org is out of usage · add funds to continue',
      "Your seat type doesn't include usage credits",
      'Claude turn failed: You’ve reached your Fable limit. Switch to another model to continue.',
    ]) {
      expect(isClaudeUsageLimitText(text), text).toBe(true);
    }
    expect(isCodexUsageLimitText(
      'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 6:12 PM.',
    )).toBe(true);
  });

  // Claude Code 2.1.312 renamed the 5-hour window from "session limit" to
  // "5-hour limit". Built as in the 2.1.316 binary (the fleet pin since
  // 2026-10-31, note #929): `You've hit your ${limitName}` + ` · resets ${time}`,
  // optionally + ` · progress saved`.
  it("classifies Claude Code 2.1.316's renamed window lines as whole-subscription limits", () => {
    for (const text of [
      "You've hit your 5-hour limit · resets 5pm (UTC)",
      "You've hit your 5-hour limit · resets 5pm (UTC) · progress saved",
      "You've hit your weekly limit · resets Nov 3, 5pm (UTC)",
    ]) {
      expect(isClaudeUsageLimitText(text), text).toBe(true);
      expect(isClaudeModelLimitText(text), text).toBe(false);
    }
  });

  it('tells a limit on one model from a limit on the whole subscription', () => {
    expect(isClaudeModelLimitText("You've reached your Fable limit. Switch to another model to continue.")).toBe(true);
    expect(isClaudeModelLimitText("You're out of usage credits. Switch to another model to continue.")).toBe(true);
    expect(isClaudeModelLimitText("You're out of usage credits. /model to switch models.")).toBe(true);
    expect(isClaudeModelLimitText('Fable 5 requires usage credits.')).toBe(true);
    expect(isClaudeModelLimitText("You've hit your session limit · resets 5pm (UTC)")).toBe(false);
    expect(isClaudeModelLimitText("You've reached your usage limit.")).toBe(false);
    // Not a limit line at all, whatever it suggests.
    expect(isClaudeModelLimitText('Tests pass. Switch to another model to continue the review?')).toBe(false);
  });

  it('does NOT classify ordinary work output mentioning limits', () => {
    for (const text of [
      'Raised the API rate limit config from 100 to 500 requests.',
      'test_limits.py::test_usage passed',
      'Set usage limit alerts in the billing dashboard as requested.',
      'Added a check: once you have reached your quota, the API returns 429.',
      'The free tier is out of usage for this month, per the dashboard.',
      '',
    ]) {
      expect(isClaudeUsageLimitText(text), text).toBe(false);
      expect(isCodexUsageLimitText(text), text).toBe(false);
    }
  });
});

describe('usage-limit reset parsing and cooldown sizing', () => {
  it("extracts the epoch Anthropic glues into the 429 text (any window's phrasing)", () => {
    // Real 429 body shape the CLI forwards verbatim: message|epoch-seconds.
    expect(claudeUsageLimitResetAtSeconds('Claude AI usage limit reached|1754514000')).toBe(1_754_514_000);
    expect(claudeUsageLimitResetAtSeconds('Claude turn failed: Claude AI usage limit reached|1754514000')).toBe(1_754_514_000);
    expect(claudeUsageLimitResetAtSeconds('Weekly limit reached|1754514000')).toBe(1_754_514_000);
  });

  it('refuses text without the pipe-epoch: bare messages, ms timestamps, unrelated digits', () => {
    expect(claudeUsageLimitResetAtSeconds('Claude usage limit reached ∙ resets 3pm')).toBeUndefined();
    // 13 digits is milliseconds — not the documented seconds form.
    expect(claudeUsageLimitResetAtSeconds('Claude AI usage limit reached|1754514000123')).toBeUndefined();
    expect(claudeUsageLimitResetAtSeconds('processed 1754514000 rows')).toBeUndefined();
    expect(claudeUsageLimitResetAtSeconds(undefined)).toBeUndefined();
  });

  it('sizes the cooldown to the reset (plus slack), capped at eight days', () => {
    const nowMs = Date.parse('2026-08-06T18:00:00.000Z');
    const inTwoDays = nowMs / 1000 + 2 * 24 * 3600;
    expect(usageLimitCooldownSeconds(inTwoDays, nowMs)).toBe(2 * 24 * 3600 + 60);
    // A garbage far-future timestamp costs at most one weekly cycle.
    expect(usageLimitCooldownSeconds(nowMs / 1000 + 365 * 24 * 3600, nowMs)).toBe(8 * 24 * 3600);
  });

  it('returns undefined for stale or absent resets so the caller keeps its default cooldown', () => {
    const nowMs = Date.parse('2026-08-06T18:00:00.000Z');
    expect(usageLimitCooldownSeconds(nowMs / 1000 - 10, nowMs)).toBeUndefined();
    expect(usageLimitCooldownSeconds(nowMs / 1000, nowMs)).toBeUndefined();
    expect(usageLimitCooldownSeconds(undefined, nowMs)).toBeUndefined();
  });
});
