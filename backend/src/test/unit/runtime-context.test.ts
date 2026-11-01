import { describe, expect, it } from 'vitest';
import {
  buildCurrentDateTimePromptSection,
  buildRuntimeContextPromptSection,
  buildTelegramIdentityPromptSection,
  mergeRuntimeContext,
  normalizeRuntimeContext,
} from '../../utils/runtime-context.js';

describe('runtime-context utils', () => {
  it('normalizes only valid client-provided fields', () => {
    const context = normalizeRuntimeContext({
      timeZone: 'America/Los_Angeles',
      developmentRoot: ' /root ',
      writeProtectedPaths: [
        '/root/test-visible.mjs',
        'relative/ignored.txt',
        '/root/test-visible.mjs',
      ],
      telegramUser: {
        username: ' @alice ',
        firstName: ' Alice ',
        lastName: '   ',
        languageCode: ' en ',
      },
    });

    expect(context).toEqual({
      timeZone: 'America/Los_Angeles',
      developmentRoot: '/root',
      writeProtectedPaths: ['/root/test-visible.mjs'],
      telegramUser: {
        username: 'alice',
        firstName: 'Alice',
        languageCode: 'en',
      },
    });
  });

  it('merges runtime context using the latest known timezone and unions protected paths', () => {
    const merged = mergeRuntimeContext(
      {
        timeZone: 'UTC',
        developmentRoot: '/root',
        writeProtectedPaths: ['/root/test-visible.mjs'],
        telegramUser: {
          username: 'alice',
          firstName: 'Alice',
        },
      },
      {
        timeZone: 'America/Los_Angeles',
        developmentRoot: '/root',
        writeProtectedPaths: ['/root/README.md', '/root/test-visible.mjs'],
        telegramUser: {
          lastName: 'Ng',
          languageCode: 'en',
        },
      },
    );

    expect(merged).toEqual({
      timeZone: 'America/Los_Angeles',
      developmentRoot: '/root',
      writeProtectedPaths: ['/root/test-visible.mjs', '/root/README.md'],
      telegramUser: {
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Ng',
        languageCode: 'en',
      },
    });
  });

  it('allows an authoritative empty managed-server context to clear stale servers', () => {
    const normalized = normalizeRuntimeContext({
      managedServers: {
        servers: [],
      },
    });

    expect(normalized).toEqual({
      managedServers: {
        servers: [],
      },
    });

    const merged = mergeRuntimeContext(
      {
        timeZone: 'UTC',
        developmentRoot: '/root',
        managedServers: {
          defaultDevelopmentServerId: 101,
          servers: [
            {
              serverId: 101,
              name: 'dev-sandbox-1',
              purpose: 'default_sandbox',
              isDefaultDevelopment: true,
              status: 'active',
            },
          ],
        },
      },
      {
        managedServers: {
          servers: [],
        },
      },
    );

    expect(merged).toEqual({
      timeZone: 'UTC',
      developmentRoot: '/root',
      managedServers: {
        servers: [],
      },
    });
  });

  it('keeps managed servers with colliding provider-local ids when record ids differ', () => {
    const normalized = normalizeRuntimeContext({
      managedServers: {
        servers: [
          {
            recordId: 'hcloud_',
            serverId: 42,
            provider: 'hetzner',
            name: 'do-server',
            purpose: 'general',
            status: 'active',
          },
          {
            recordId: 'hcloud_42',
            serverId: 42,
            provider: 'hetzner',
            name: 'hetzner-server',
            purpose: 'general',
            status: 'active',
          },
        ],
      },
    });

    expect(normalized?.managedServers?.servers).toEqual([
      expect.objectContaining({
        recordId: 'hcloud_',
        serverId: 42,
        provider: 'hetzner',
      }),
      expect.objectContaining({
        recordId: 'hcloud_42',
        serverId: 42,
        provider: 'hetzner',
      }),
    ]);
  });

  it('drops legacy managed-server preparation metadata from runtime context', () => {
    const normalized = normalizeRuntimeContext({
      managedServers: {
        defaultDevelopmentServerId: 101,
        servers: [
          {
            serverId: 101,
            name: 'dev-sandbox-1',
            purpose: 'default_sandbox',
            isDefaultDevelopment: true,
            status: 'active',
            environmentPrepared: false,
            codexPrepared: true,
            codexVersion: '0.130.0',
            claudePrepared: false,
            preparationStatus: 'pending',
            preparationSummary: 'Preparing baseline development tooling.',
            preparationError: 'stale failure',
            preparedAt: '2026-04-29T11:30:00.000Z',
          },
        ],
      },
    } as any);

    expect(normalized).toEqual({
      managedServers: {
        servers: [
          {
            serverId: 101,
            name: 'dev-sandbox-1',
            purpose: 'general',
            status: 'active',
          },
        ],
      },
    });
  });

  it('renders a stable runtime context prompt section without the volatile timestamp', () => {
    const promptSection = buildRuntimeContextPromptSection(
      {
        timeZone: 'America/New_York',
        developmentRoot: '/root',
        writeProtectedPaths: ['/root/test-visible.mjs', '/root/README.md'],
        telegramUser: {
          username: 'alice',
          firstName: 'Alice',
          languageCode: 'en',
        },
        managedServers: {
          defaultDevelopmentServerId: 101,
          servers: [
            {
              serverId: 101,
              name: 'dev-sandbox-1',
              purpose: 'default_sandbox',
              isDefaultDevelopment: true,
              status: 'active',
              region: 'nbg1',
              size: 's-2vcpu-2gb-intel',
              publicAddress: '203.0.113.10',
            },
          ],
        },
      },
    );

    expect(promptSection).toContain('User timezone: America/New_York');
    expect(promptSection).toContain('Development server root: /root');
    expect(promptSection).toContain('Telegram username: @alice');
    expect(promptSection).toContain('Telegram first name: Alice');
    expect(promptSection).toContain('Telegram language code: en');
    expect(promptSection).toContain('Protected write paths:');
    expect(promptSection).toContain('/root/test-visible.mjs');
    expect(promptSection).toContain('/root/README.md');
    expect(promptSection).toContain('Do not edit, replace, or patch protected runtime files.');
    expect(promptSection).toContain('Tracked managed servers: 1');
    expect(promptSection).not.toContain('Default development server id:');
    expect(promptSection).toContain('dev-sandbox-1 (#101)');
    expect(promptSection).toContain('purpose=general');
    expect(promptSection).not.toContain('default_development=yes');
    expect(promptSection).not.toContain('environment_prepared=');
    expect(promptSection).not.toContain('codex_prepared=');
    expect(promptSection).not.toContain('claude_prepared=');
    expect(promptSection).not.toContain('preparation_status=');
    expect(promptSection).not.toContain('preparation_summary=');
    expect(promptSection).toContain('Fresh-server apt safety');
    expect(promptSection).toContain('NEVER run `apt-get upgrade` or `apt upgrade`');
    expect(promptSection).not.toContain('preparation_error=');
    expect(promptSection).toContain('`rg`, `git`, `gh`, `curl`, `jq`, `unzip`');
    expect(promptSection).toContain('separately supplied current datetime');
    expect(promptSection).not.toContain('User location:');
  });


  it('explicitly tells the agent when no managed servers exist yet', () => {
    const promptSection = buildRuntimeContextPromptSection({
      timeZone: 'America/New_York',
    });

    expect(promptSection).toContain('Tracked managed servers: 0');
    expect(promptSection).toContain('No managed development server exists yet.');
    expect(promptSection).toContain('Development work that needs a server should create or select one before using development-runtime tools');
  });

  it('renders an explicitly empty managed-server context as no servers', () => {
    const promptSection = buildRuntimeContextPromptSection({
      timeZone: 'America/New_York',
      developmentRoot: '/root',
      managedServers: {
        servers: [],
      },
    });

    expect(promptSection).toContain('Tracked managed servers: 0');
    expect(promptSection).toContain('No managed development server exists yet.');
    expect(promptSection).not.toContain('Development server root: /root');
    expect(promptSection).not.toContain('Managed server state');
  });

  it('renders the volatile current datetime section separately', () => {
    const promptSection = buildCurrentDateTimePromptSection(
      {
        timeZone: 'America/New_York',
      },
      new Date('2026-03-11T12:00:00.000Z'),
    );

    expect(promptSection).toContain('## Current Time');
    expect(promptSection).toContain('Current datetime:');
    expect(promptSection).toContain('America/New_York');
    expect(promptSection).toContain('authoritative reference for relative dates/times');
  });

  it('renders a dedicated user identity section only when that context exists', () => {
    const promptSection = buildTelegramIdentityPromptSection({
      telegramUser: {
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Ng',
        languageCode: 'en',
      },
    });

    expect(promptSection).toContain('## User Identity');
    expect(promptSection).toContain('Telegram username: @alice');
    expect(promptSection).toContain('Telegram first name: Alice');
    expect(promptSection).toContain('Telegram last name: Ng');
    expect(promptSection).toContain('Telegram language code: en');
  });
});
