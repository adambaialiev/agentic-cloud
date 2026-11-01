import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTelegramAgentCliDefaultsScript,
  CODEX_MODEL_CONTEXT_WINDOW,
  CODEX_PROJECT_DOC_MAX_BYTES,
} from '../../services/agent-service.js';

/**
 * The operator defaults for the baked CLIs ship in the image skeleton, which is
 * seeded once per volume and never re-run — so before this script there was no
 * way to change one on a machine that already existed. It rides the identity
 * write, and like the docs script all of its correctness lives in the shell:
 * these tests RUN it against real files in a temp $HOME and read back what it
 * did.
 *
 * The contract: operator keys and identifiable lifecycle hooks end up set,
 * while everything else in the agent's own files survives.
 */

const HOME_PREFIX = 'ia-cli-defaults-';

interface Result {
  settings: string | undefined;
  codex: string | undefined;
  userCodexHooks: string | undefined;
  managedCodexHooks: string | undefined;
  codexHookInstaller: string | undefined;
  unparsed: string | undefined;
}

function runOn(
  seed: { settings?: string; codex?: string; codexHooks?: string },
  times = 1,
): Result {
  const home = mkdtempSync(path.join(tmpdir(), HOME_PREFIX));
  const root = home;
  const systemRoot = path.join(home, 'system-root');
  const shimDir = path.join(home, 'bin');
  try {
    mkdirSync(shimDir, { mode: 0o700 });
    const sudoShim = path.join(shimDir, 'sudo');
    writeFileSync(sudoShim, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '[ "${1:-}" = install ] || exit 96',
      'shift',
      'mapped=()',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    /etc/codex*) mapped+=("$AGENTBUILT_TEST_SYSTEM_ROOT$arg") ;;',
      '    *) mapped+=("$arg") ;;',
      '  esac',
      'done',
      'exec /usr/bin/install "${mapped[@]}"',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(sudoShim, 0o700);
    if (seed.settings !== undefined) {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      writeFileSync(path.join(home, '.claude', 'settings.json'), seed.settings);
    }
    if (seed.codex !== undefined) {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      writeFileSync(path.join(home, '.codex', 'config.toml'), seed.codex);
    }
    if (seed.codexHooks !== undefined) {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      writeFileSync(path.join(home, '.codex', 'hooks.json'), seed.codexHooks);
    }
    for (let run = 0; run < times; run++) {
      execFileSync('bash', ['-c', buildTelegramAgentCliDefaultsScript()], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${shimDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
          AGENTBUILT_TEST_SYSTEM_ROOT: systemRoot,
        },
      });
    }
    const read = (...parts: string[]) => {
      const file = path.join(home, ...parts);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };
    return {
      settings: read('.claude', 'settings.json'),
      codex: read('.codex', 'config.toml'),
      userCodexHooks: read('.codex', 'hooks.json'),
      managedCodexHooks: existsSync(path.join(systemRoot, 'etc', 'codex', 'hooks.json'))
        ? readFileSync(path.join(systemRoot, 'etc', 'codex', 'hooks.json'), 'utf8')
        : undefined,
      codexHookInstaller: read('.boot.d', '15-codex-managed-hooks.sh'),
      unparsed: read('.claude', 'settings.json.unparsed'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const parse = (raw: string | undefined) => JSON.parse(raw ?? '{}') as Record<string, never>;

const platformHooks = (harness: 'claude' | 'codex') => ({
  PreToolUse: [{
    matcher: '^Bash$',
    hooks: [{
      type: 'command',
      command: `/usr/local/bin/agentbuilt __harness-hook ${harness}`,
      timeout: 5,
    }],
  }],
  PostToolUse: [{
    matcher: harness === 'claude' ? '^(Bash|TaskStop)$' : '^Bash$',
    hooks: [{
      type: 'command',
      command: `/usr/local/bin/agentbuilt __harness-hook ${harness}`,
      timeout: 5,
    }],
  }],
  ...(harness === 'claude' ? {
    PostToolUseFailure: [{
      matcher: '^Bash$',
      hooks: [{
        type: 'command',
        command: '/usr/local/bin/agentbuilt __harness-hook claude',
        timeout: 5,
      }],
    }],
  } : {}),
  SessionStart: [{
    hooks: [{
      type: 'command',
      command: `/usr/local/bin/agentbuilt __harness-hook ${harness}`,
      timeout: 5,
    }],
  }],
  SessionEnd: [{
    hooks: [{
      type: 'command',
      command: `/usr/local/bin/agentbuilt __harness-hook ${harness}`,
      timeout: harness === 'codex' ? 3 : 5,
    }],
  }],
});

describe('agent CLI defaults script', () => {
  it('creates every settings file on a machine that has none', () => {
    const {
      settings, codex, userCodexHooks, managedCodexHooks, codexHookInstaller,
    } = runOn({});
    expect(parse(settings)).toEqual({
      includeCoAuthoredBy: false,
      attribution: { includeCoAuthoredBy: false },
      env: { DISABLE_AUTOUPDATER: '1' },
      hooks: platformHooks('claude'),
    });
    expect(userCodexHooks).toBeUndefined();
    expect(parse(managedCodexHooks)).toEqual({ hooks: platformHooks('codex') });
    expect(codexHookInstaller).toContain('sudo install -m 0644');
    expect(codex).toContain('check_for_update_on_startup = false');
  });

  it('merges into the agent\'s own settings instead of replacing them', () => {
    // This file is also where an agent keeps permissions, hooks and its model
    // choice. Overwriting it to fix an operator default would eat all of that,
    // which is the reason this is a merge and not a `cat >`.
    const { settings } = runOn({
      settings: JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(npm test)'] },
        env: { MY_TOKEN_PATH: '/home/agent/.token' },
        attribution: { somethingElse: true },
        hooks: {
          PreToolUse: [{
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: '/home/agent/my-check.sh' }],
          }],
          Stop: [{ hooks: [{ type: 'command', command: '/home/agent/review.sh' }] }],
        },
      }, null, 2),
    });
    expect(parse(settings)).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      env: { MY_TOKEN_PATH: '/home/agent/.token', DISABLE_AUTOUPDATER: '1' },
      attribution: { somethingElse: true, includeCoAuthoredBy: false },
      includeCoAuthoredBy: false,
      hooks: {
        PreToolUse: [
          {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: '/home/agent/my-check.sh' }],
          },
          ...platformHooks('claude').PreToolUse,
        ],
        Stop: [{ hooks: [{ type: 'command', command: '/home/agent/review.sh' }] }],
        PostToolUse: platformHooks('claude').PostToolUse,
        PostToolUseFailure: platformHooks('claude').PostToolUseFailure,
        SessionStart: platformHooks('claude').SessionStart,
        SessionEnd: platformHooks('claude').SessionEnd,
      },
    });
  });

  it('leaves user Codex hooks untouched and installs the operator hook as managed', () => {
    const mine = JSON.stringify({
      description: 'mine',
      hooks: {
        PreToolUse: [{
          matcher: '^Bash$',
          hooks: [{ type: 'command', command: '/home/agent/my-codex-check.sh' }],
        }],
      },
    }, null, 2);
    const { userCodexHooks, managedCodexHooks } = runOn({ codexHooks: mine });
    expect(userCodexHooks).toBe(mine);
    expect(parse(managedCodexHooks)).toEqual({ hooks: platformHooks('codex') });
  });

  it('overrides the operator keys even when the agent set them the other way', () => {
    const { settings } = runOn({
      settings: JSON.stringify({ includeCoAuthoredBy: true, env: { DISABLE_AUTOUPDATER: '0' } }),
    });
    const parsed = parse(settings) as unknown as {
      includeCoAuthoredBy: boolean;
      env: { DISABLE_AUTOUPDATER: string };
    };
    expect(parsed.includeCoAuthoredBy).toBe(false);
    expect(parsed.env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('keeps a copy of an unparseable settings file rather than discarding it', () => {
    const broken = '{ this is not json';
    const { settings, unparsed } = runOn({ settings: broken });
    expect(unparsed).toBe(broken);
    expect(parse(settings)).toEqual({
      includeCoAuthoredBy: false,
      attribution: { includeCoAuthoredBy: false },
      env: { DISABLE_AUTOUPDATER: '1' },
      hooks: platformHooks('claude'),
    });
  });

  it('does not rewrite even an unparseable user Codex hooks file', () => {
    const broken = '{ not hooks json';
    const { userCodexHooks, managedCodexHooks } = runOn({ codexHooks: broken });
    expect(userCodexHooks).toBe(broken);
    expect(parse(managedCodexHooks)).toEqual({ hooks: platformHooks('codex') });
  });

  it('puts EVERY Codex key ABOVE any table header, where it is still top-level', () => {
    // A bare key appended after `[tui]` belongs to that table and does nothing.
    // The whole point of the prepend, and invisible in review.
    const { codex } = runOn({ codex: '[tui]\ntheme = "dark"\n' });
    const lines = (codex ?? '').split('\n');
    const header = lines.indexOf('[tui]');
    for (const key of ['check_for_update_on_startup', 'project_doc_max_bytes', 'model_context_window']) {
      const at = lines.findIndex((line) => line.startsWith(`${key} =`));
      expect(at, `${key} is missing`).toBeGreaterThanOrEqual(0);
      expect(at, `${key} landed inside [tui]`).toBeLessThan(header);
    }
    expect(codex).toContain('theme = "dark"');
  });

  it('rewrites a Codex key in place when it is already there', () => {
    const { codex } = runOn({ codex: '# mine\ncheck_for_update_on_startup = true\nmodel = "gpt-5"\n' });
    expect(codex).toContain('check_for_update_on_startup = false');
    expect(codex).not.toContain('= true');
    expect(codex).toContain('# mine');
    expect(codex).toContain('model = "gpt-5"');
    // Rewritten, not added a second time. A duplicate top-level key is a TOML
    // parse error, which would take Codex out on its next start.
    expect((codex ?? '').match(/check_for_update_on_startup/g)).toHaveLength(1);
  });

  it('raises an existing project_doc_max_bytes rather than leaving it low', () => {
    // The case that matters on a real machine: Codex's own default is applied
    // when the key is ABSENT, but an operator or agent may also have written a
    // small one. Either way the machine ends up on ours.
    const { codex } = runOn({ codex: 'project_doc_max_bytes = 32768\n[tui]\ntheme = "dark"\n' });
    expect(codex).toContain(`project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`);
    expect(codex).not.toContain('32768');
    expect((codex ?? '').match(/project_doc_max_bytes/g)).toHaveLength(1);
  });

  it('raises the Codex context window off the model default', () => {
    // Codex budgets a turn against the model's `context_window` (272,000 on the
    // gpt-5.6 family) unless this key says otherwise, while the same catalog
    // entry gives `max_context_window = 872000`. Without the key an agent works
    // in under a third of its model's window and nothing reports it.
    const { codex } = runOn({});
    expect(codex).toContain(`model_context_window = ${CODEX_MODEL_CONTEXT_WINDOW}`);
  });

  it('raises an existing model_context_window rather than leaving it at the default', () => {
    // Codex clamps the request to each model's own maximum, so overwriting a
    // smaller hand-written value cannot ask for more than the model gives.
    const { codex } = runOn({ codex: 'model_context_window = 272000\n[tui]\ntheme = "dark"\n' });
    expect(codex).toContain(`model_context_window = ${CODEX_MODEL_CONTEXT_WINDOW}`);
    expect(codex).not.toContain('272000');
    expect((codex ?? '').match(/model_context_window/g)).toHaveLength(1);
  });

  it('is idempotent — the identity write runs it again on every bump', () => {
    const seed = { settings: JSON.stringify({ model: 'opus' }), codex: '[tui]\ntheme = "dark"\n' };
    const once = runOn(seed);
    const twice = runOn(seed, 3);
    expect(twice.settings).toBe(once.settings);
    expect(twice.codex).toBe(once.codex);
    expect(twice.managedCodexHooks).toBe(once.managedCodexHooks);
    expect(twice.codexHookInstaller).toBe(once.codexHookInstaller);
  });
});

describe('image skeleton CLI defaults', () => {
  const imageDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..',
    'infra', 'fly-machine-image',
  );
  const skelDir = path.join(imageDir, 'skel');

  it('seeds the same defaults this script converges', () => {
    // Two copies of one decision: the skeleton seeds a new volume before any
    // identity write can reach it, and this script maintains every machine
    // after. They are pinned by MEANING rather than by text — the seed is JSON
    // and TOML a human edits, not generated output.
    const seeded = JSON.parse(
      readFileSync(path.join(skelDir, '.claude', 'settings.json'), 'utf8'),
    ) as {
      includeCoAuthoredBy: boolean;
      attribution: { includeCoAuthoredBy: boolean };
      env: { DISABLE_AUTOUPDATER: string };
      hooks: ReturnType<typeof platformHooks>;
    };
    const converged = JSON.parse(runOn({}).settings ?? '{}') as typeof seeded;

    expect(seeded.includeCoAuthoredBy).toBe(converged.includeCoAuthoredBy);
    expect(seeded.attribution.includeCoAuthoredBy).toBe(converged.attribution.includeCoAuthoredBy);
    expect(seeded.env.DISABLE_AUTOUPDATER).toBe(converged.env.DISABLE_AUTOUPDATER);
    expect(seeded.hooks).toEqual(converged.hooks);

    const seededCodexHooks = JSON.parse(
      readFileSync(path.join(imageDir, 'codex-managed-hooks.json'), 'utf8'),
    ) as { hooks: ReturnType<typeof platformHooks> };
    expect(seededCodexHooks.hooks).toEqual(platformHooks('codex'));

    const seededCodex = readFileSync(path.join(skelDir, '.codex', 'config.toml'), 'utf8');
    expect(seededCodex).toContain('check_for_update_on_startup = false');
    expect(seededCodex).toContain(`project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`);
    expect(seededCodex).toContain(`model_context_window = ${CODEX_MODEL_CONTEXT_WINDOW}`);
  });
});
