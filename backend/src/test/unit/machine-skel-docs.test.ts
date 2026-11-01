import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The machine image ships the same starter home twice — `~/CLAUDE.md` for the
 * Claude CLI and `~/AGENTS.md` for Codex — as two real files kept in sync by
 * hand. Nothing but this test notices when an edit lands in one and not the
 * other, and the failure mode is silent.
 *
 * These files are the FIRST-BOOT seed only. `entrypoint.sh` writes them behind
 * a sentinel on the volume and skips them on every later boot, image rolls
 * included — so what ships here reaches a machine once and never again.
 *
 * They are therefore a STUB, deliberately. The identity pass creates both files
 * itself when they are missing (facts markers included) and replaces everything
 * below the machine-facts block on every version bump, so the seed is overwritten
 * within seconds of a machine existing. It used to be generated from the live
 * template so the two could not drift; that is machinery for keeping a copy in
 * step with text nobody reads. What is left here is what a machine needs in the
 * window before its first identity write lands: the facts markers for
 * `entrypoint.sh` to stamp, and the handful of physics that has never changed.
 *
 * So: anything that CAN change belongs in the platform docs
 * (`buildTelegramAgentPlatformDocs`), which reach every machine that already
 * exists. Adding it here instead ships it to new machines only.
 */

const skelDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'infra', 'fly-machine-image', 'skel',
);

const read = (name: string) => readFileSync(path.join(skelDir, name), 'utf8');

describe('machine skel docs', () => {
  it('ships identical CLAUDE.md and AGENTS.md', () => {
    expect(read('AGENTS.md')).toBe(read('CLAUDE.md'));
  });

  it('keeps the essentials a machine needs before its platform block lands', () => {
    const doc = read('CLAUDE.md');
    expect(doc).toContain('MACHINE-FACTS:START');
    // Losing the user's work, publishing nothing, killing your own server, and
    // burning a turn on docker: the four mistakes that are expensive to make
    // once and cheap to prevent in four lines.
    expect(doc).toContain('/home/agent');
    expect(doc).toContain('0.0.0.0:8080');
    expect(doc).toContain('tmux');
    // A raw tmux session is only a turn-lifetime fallback; saying merely
    // "anything durable goes in tmux" loses finite work when the VM idles.
    expect(doc).toContain('not machine sleep');
    expect(doc).toContain('pre-platform fallback');
    expect(doc).toContain('~/.boot.d/*.sh');
    expect(doc).toMatch(/[Dd]ocker does not work/);
  });

  it('says plainly who owns this file, now that the platform overwrites it', () => {
    // The old wording invited agents to edit here. It is replaced wholesale on
    // every platform update, so that invitation would now quietly eat their
    // work — SCRATCHPAD.md is the file that is actually theirs.
    const doc = read('CLAUDE.md');
    expect(doc).toMatch(/NOT yours to edit/);
    expect(doc).toMatch(/`~\/SCRATCHPAD\.md` is yours/);
    expect(doc).not.toMatch(/this file is \*\*yours to edit\*\*/i);
  });

  it('leaves the capability docs to the platform block instead of restating them', () => {
    // Every one of these is maintained text that changes. Restating it here
    // means the seeded copy can contradict the live one on a machine that has
    // not had its first identity write yet.
    const doc = read('CLAUDE.md');
    for (const maintained of [
      'agentbuilt repo create',
      'agentbuilt pr create',
      'agentbuilt pr list',
      'agentbuilt secret',
      'agentbuilt deploy',
      '--unprotected',
      'add it in their Workspace',
      'recycled',
    ]) {
      expect(doc, `"${maintained}" belongs in the identity block, not the skel`).not.toContain(maintained);
    }
  });

  it('stays a stub, and never claims to be a version of the platform docs', () => {
    const doc = read('CLAUDE.md');
    // The stamp means "the platform wrote this text, and it was current at vN".
    // A seeded copy carrying one would answer `grep platform-docs ~/CLAUDE.md`
    // with a version this machine was never actually given — worse than the
    // silence that correctly means "no platform docs yet".
    expect(doc).not.toContain('platform-docs:');
    // Not a real limit, a smell test: this file is the pre-write stub. If it is
    // growing, the text belongs in the platform docs, where it reaches the
    // machines that already exist.
    expect(doc.length).toBeLessThan(2000);
  });
});
