import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_USAGE_ENDPOINT,
  CODEX_USAGE_COMMAND,
  parseCodexAccountUsage,
  parseCodexUsageOutput,
  readCodexProviderUsage,
  readCodexUsageForAuthJson,
} from '../../agent/codex/codex-usage.js';

const RESPONSE = JSON.stringify({
  id: 2,
  result: {
    rateLimits: {
      primary: { usedPercent: 26, windowDurationMins: 10_080, resetsAt: 1_784_969_395 },
      secondary: null,
      planType: 'plus',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    },
  },
});

const ACCOUNT_RESPONSE = {
  rate_limit: {
    primary_window: {
      used_percent: 88,
      limit_window_seconds: 604_800,
      reset_at: 1_788_464_760,
    },
    secondary_window: null,
  },
  plan_type: 'prolite',
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

const AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'access-secret',
    account_id: 'account-123',
    refresh_token: 'refresh-secret',
  },
});

describe('Codex provider usage', () => {
  it('parses dynamic account windows without assuming a 5-hour bucket', () => {
    expect(parseCodexUsageOutput(`noise\n${RESPONSE}\n`, '2026-07-18T00:00:00.000Z')).toEqual({
      windows: {
        primary: {
          id: 'primary',
          usedPercent: 26,
          windowDurationMins: 10_080,
          resetsAt: 1_784_969_395,
        },
      },
      capturedAt: '2026-07-18T00:00:00.000Z',
      planType: 'plus',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    });
  });

  it('parses the direct account response into the same dynamic window shape', () => {
    expect(parseCodexAccountUsage(ACCOUNT_RESPONSE, '2026-08-30T06:00:00.000Z')).toEqual({
      windows: {
        primary: {
          id: 'primary',
          usedPercent: 88,
          windowDurationMins: 10_080,
          resetsAt: 1_788_464_760,
        },
      },
      capturedAt: '2026-08-30T06:00:00.000Z',
      planType: 'prolite',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    });
  });

  it('reads current usage directly from auth.json without exposing its refresh token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ACCOUNT_RESPONSE,
    });
    await expect(readCodexUsageForAuthJson(
      AUTH_JSON,
      fetchImpl as unknown as typeof fetch,
    )).resolves.toMatchObject({ kind: 'ok', snapshot: { planType: 'prolite' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      CODEX_USAGE_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-secret',
          'ChatGPT-Account-Id': 'account-123',
        }),
      }),
    );
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('refresh-secret');
  });

  it('distinguishes a rejected access token from a transient read failure', async () => {
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(readCodexUsageForAuthJson(
      AUTH_JSON,
      rejected as unknown as typeof fetch,
    )).resolves.toEqual({ kind: 'auth_rejected', status: 401 });

    const unavailable = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(readCodexUsageForAuthJson(
      AUTH_JSON,
      unavailable as unknown as typeof fetch,
    )).resolves.toEqual({ kind: 'failed' });
  });

  it('runs the read-only app-server request on the target machine', async () => {
    const execSync = vi.fn().mockResolvedValue({
      stdout: RESPONSE,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    await expect(readCodexProviderUsage({
      sandboxClient: { execSync } as never,
      sandboxId: 'hcloud-sandbox-123',
      sshUser: 'agent',
    })).resolves.toMatchObject({ planType: 'plus' });
    expect(CODEX_USAGE_COMMAND).toContain('account/rateLimits/read');
    expect(execSync).toHaveBeenCalledWith(
      'hcloud-sandbox-123',
      expect.stringContaining('account/rateLimits/read'),
      undefined,
      { timeoutMs: 30_000, sshUser: 'agent' },
    );
  });
});
