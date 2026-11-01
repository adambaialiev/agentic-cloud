import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, lstatSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTelegramAgentDocsScript } from '../../services/agent-service.js';

/**
 * The identity pass is the ONLY channel that reaches a machine that already
 * exists — the skel is seeded once, on first boot, and skipped forever after.
 * So this script is what makes a docs change land fleet-wide, and all of its
 * correctness lives in the shell. Asserting on the generated string would only
 * pin what someone typed; these tests RUN it against real files and read back
 * what it did.
 *
 * The contract: everything below the machine-facts block is replaced. The facts
 * block itself is written by `entrypoint.sh` on every boot and must survive
 * verbatim — it is the one part of the file this process does not own.
 */

const IDENTITY = [
  '<!-- agent-identity:begin -->',
  '## Who you are',
  'Your name is **Stella**.',
  '<!-- agent-identity:end -->',
].join('\n');

function runOn(claudeMd: string): { claude: string; agents: string; superseded?: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
  try {
    writeFileSync(path.join(home, 'CLAUDE.md'), claudeMd);
    writeFileSync(path.join(home, 'AGENTS.md'), claudeMd);
    execFileSync('bash', ['-c', buildTelegramAgentDocsScript(IDENTITY)], {
      env: { ...process.env, HOME: home },
    });
    const supersededPath = path.join(home, 'CLAUDE.md.superseded');
    return {
      claude: readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'),
      agents: readFileSync(path.join(home, 'AGENTS.md'), 'utf8'),
      ...(existsSync(supersededPath)
        ? { superseded: readFileSync(supersededPath, 'utf8') }
        : {}),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const FACTS = [
  '<!-- MACHINE-FACTS:START -->',
  '- App: ia-cb7da2c8',
  '- Region: ams',
  '<!-- MACHINE-FACTS:END -->',
].join('\n');

describe('agent docs script', () => {
  it('replaces everything below the facts block, which itself survives verbatim', () => {
    // A machine as they all look today: current facts, then platform prose
    // frozen since whatever image it was built from.
    const before = [
      FACTS,
      '',
      '# Networking and exposure (accurate today)',
      'Port 3000 is your public port.',
      '',
      IDENTITY,
    ].join('\n');

    const { claude } = runOn(before);

    // The facts are the machine's own truth, written fresh on every boot.
    expect(claude).toContain('- App: ia-cb7da2c8');
    expect(claude).toContain('- Region: ams');
    expect(claude.indexOf('<!-- MACHINE-FACTS:START -->')).toBe(0);
    // The stale prose is gone — that is the entire point.
    expect(claude).not.toContain('Port 3000 is your public port.');
    expect(claude).not.toContain('accurate today');
    expect(claude).toContain('0.0.0.0:8080');
    expect(claude).toContain('## Who you are');
  });

  it('keeps one snapshot of what it replaced, and only the first time', () => {
    const original = [FACTS, '', '# My own rules', 'never deploy on a Friday'].join('\n');
    const { superseded } = runOn(original);

    // Cheap insurance for anything an agent kept here under the old
    // "this file is yours to edit" wording.
    expect(superseded).toBe(original);

    // Running again must not overwrite that snapshot with our own output —
    // otherwise the second write destroys what the first one saved.
    const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
    try {
      writeFileSync(path.join(home, 'CLAUDE.md'), original);
      const script = buildTelegramAgentDocsScript(IDENTITY);
      execFileSync('bash', ['-c', script], { env: { ...process.env, HOME: home } });
      execFileSync('bash', ['-c', script], { env: { ...process.env, HOME: home } });
      expect(readFileSync(path.join(home, 'CLAUDE.md.superseded'), 'utf8')).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes a facts placeholder when the machine has none yet', () => {
    const { claude } = runOn('# nothing but my own notes\n');

    expect(claude.indexOf('<!-- MACHINE-FACTS:START -->')).toBe(0);
    expect(claude).toContain('<!-- MACHINE-FACTS:END -->');
    // The next boot fills it in; until then the file is still complete.
    expect(claude).toContain('regenerated every boot');
    expect(claude).toContain('## Who you are');
  });

  it('stamps the version into the file, so a machine can be asked directly', () => {
    // Otherwise the only record of which docs a machine carries is its row in
    // the database — and if the two disagree, the row wins and the machine
    // keeps stale docs forever, because no rewrite is ever attempted.
    const { claude } = runOn([FACTS, '', '# old prose'].join('\n'));
    expect(claude).toMatch(/<!-- platform-docs: v\d+ -->/);
  });

  it('is idempotent — running it twice leaves the file byte-identical', () => {
    const once = runOn([FACTS, '', '# old prose'].join('\n')).claude;
    const twice = runOn(once).claude;
    expect(twice).toBe(once);
  });

  it('writes CLAUDE.md and AGENTS.md identically, so Codex agents are not missed', () => {
    const { claude, agents } = runOn([FACTS, '', '# old prose'].join('\n'));
    expect(agents).toBe(claude);
  });

  it('snapshots each file to its OWN .superseded, and the prose names neither', () => {
    // The two files hold different prose here — a Codex agent that kept notes
    // in AGENTS.md and never touched CLAUDE.md. Each snapshot must hold what
    // ITS file held, or the pointer sends that agent to the wrong one.
    const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
    try {
      writeFileSync(path.join(home, 'CLAUDE.md'), [FACTS, '', '# untouched'].join('\n'));
      writeFileSync(path.join(home, 'AGENTS.md'), [FACTS, '', '# my own hard-won notes'].join('\n'));
      execFileSync('bash', ['-c', buildTelegramAgentDocsScript(IDENTITY)], {
        env: { ...process.env, HOME: home },
      });

      expect(readFileSync(path.join(home, 'AGENTS.md.superseded'), 'utf8')).toContain('my own hard-won notes');
      expect(readFileSync(path.join(home, 'CLAUDE.md.superseded'), 'utf8')).toContain('untouched');

      // And the sentence that points at the snapshot must not name a file:
      // ONE body is written to both, so any filename in it is wrong in one of
      // them. It describes the path instead.
      const written = readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
      expect(written).toContain('.superseded');
      expect(written).not.toContain('CLAUDE.md.superseded');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('renames NOTES.md to SCRATCHPAD.md once, leaving the old path working', () => {
    // The v66 rename: the agent's private file surrenders the word "notes" to
    // the shared quick notes. Content must survive the move, and every old
    // reference the agent wrote for itself must keep landing in the same file.
    const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
    try {
      writeFileSync(path.join(home, 'CLAUDE.md'), [FACTS, '', '# old prose'].join('\n'));
      writeFileSync(path.join(home, 'NOTES.md'), 'never deploy on a Friday\n');
      const script = buildTelegramAgentDocsScript(IDENTITY);
      execFileSync('bash', ['-c', script], { env: { ...process.env, HOME: home } });

      expect(readFileSync(path.join(home, 'SCRATCHPAD.md'), 'utf8')).toBe('never deploy on a Friday\n');
      expect(lstatSync(path.join(home, 'NOTES.md')).isSymbolicLink()).toBe(true);
      // A write through the old name reaches the renamed file, not a fork.
      writeFileSync(path.join(home, 'NOTES.md'), 'appended through the old path\n');
      expect(readFileSync(path.join(home, 'SCRATCHPAD.md'), 'utf8')).toBe('appended through the old path\n');

      // The next identity write must not migrate again — the symlink is not a
      // real NOTES.md, and SCRATCHPAD.md already exists.
      execFileSync('bash', ['-c', script], { env: { ...process.env, HOME: home } });
      expect(lstatSync(path.join(home, 'NOTES.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(home, 'SCRATCHPAD.md'), 'utf8')).toBe('appended through the old path\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves an agent that already has BOTH files alone', () => {
    // Two real files means agent-authored state this script cannot safely
    // merge; renaming either would destroy one of them.
    const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
    try {
      writeFileSync(path.join(home, 'CLAUDE.md'), [FACTS, '', '# old prose'].join('\n'));
      writeFileSync(path.join(home, 'NOTES.md'), 'old notes\n');
      writeFileSync(path.join(home, 'SCRATCHPAD.md'), 'already mine\n');
      execFileSync('bash', ['-c', buildTelegramAgentDocsScript(IDENTITY)], {
        env: { ...process.env, HOME: home },
      });

      expect(readFileSync(path.join(home, 'NOTES.md'), 'utf8')).toBe('old notes\n');
      expect(readFileSync(path.join(home, 'SCRATCHPAD.md'), 'utf8')).toBe('already mine\n');
      expect(lstatSync(path.join(home, 'NOTES.md')).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates nothing on a machine that never had a NOTES.md', () => {
    // Fresh machines get the new name in their docs and no legacy link — the
    // old name lingers only where history warrants it.
    const home = mkdtempSync(path.join(tmpdir(), 'ia-docs-'));
    try {
      writeFileSync(path.join(home, 'CLAUDE.md'), [FACTS, '', '# old prose'].join('\n'));
      execFileSync('bash', ['-c', buildTelegramAgentDocsScript(IDENTITY)], {
        env: { ...process.env, HOME: home },
      });
      expect(existsSync(path.join(home, 'NOTES.md'))).toBe(false);
      expect(existsSync(path.join(home, 'SCRATCHPAD.md'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('treats the docs as data, not as shell', () => {
    // The prose is markdown written by whoever edits the template next. If any
    // of it were interpolated into the script, a backtick would execute.
    const { claude } = runOn([FACTS, '`whoami`', '$(id -u)', 's/a/b/'].join('\n'));
    expect(claude).toContain('# Where you are');
    expect(claude).not.toContain('$(id -u)');
  });
});
