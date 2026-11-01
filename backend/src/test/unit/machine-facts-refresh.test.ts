import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `entrypoint.sh` stamps the machine's own facts into the agent's CLAUDE.md and
 * AGENTS.md on every boot. Those files are the agent's INSTRUCTION files: the
 * coding CLI re-reads them each turn, and one changed byte makes it re-send the
 * whole ~48 KB file into the running conversation as "these differ from their
 * earlier copies" — about 12k tokens, every resumed turn, forever in that
 * context window.
 *
 * So the contract this pins is not "the block is written" but "the block is
 * written ONLY when a fact actually changed": a boot that moves nothing must
 * leave the file byte-identical, timestamp included. Machines sleep after 15
 * idle minutes, so the do-nothing boot is the common one.
 *
 * The entrypoint's `--refresh-machine-facts` flag runs exactly that step and
 * exits, so these tests drive the real shell rather than a copy of it.
 */

const entrypoint = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'infra', 'fly-machine-image', 'entrypoint.sh',
);

const FACTS = {
  FLY_APP_NAME: 'ia-cb7da2c8',
  FLY_MACHINE_ID: '17811943f',
  FLY_REGION: 'ams',
  FLY_PRIVATE_IP: 'fdaa:99:600e:a7b:190:d90:30c2:2',
  FLY_IMAGE_REF: 'ghcr.io/x/ia-machine-images:sha-7bb64e75',
  FLY_MACHINE_VERSION: '01M2048MZBQ08TWDBB7QBDJ3MV',
};

function refresh(file: string, facts: Record<string, string> = FACTS): void {
  execFileSync('bash', [entrypoint, '--refresh-machine-facts', file], {
    env: { ...process.env, ...facts },
    stdio: 'pipe',
  });
}

function withHome<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'ia-facts-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BODY = ['# Where you are', 'You are running inside a Fly Firecracker microVM.', ''].join('\n');

describe('entrypoint machine-facts refresh', () => {
  it('stamps the machine facts, keeping everything outside the markers', () => {
    withHome((dir) => {
      const file = path.join(dir, 'CLAUDE.md');
      writeFileSync(file, [
        '<!-- MACHINE-FACTS:START -->',
        '- App: unknown',
        '<!-- MACHINE-FACTS:END -->',
        BODY,
        'My own note nobody may touch.',
      ].join('\n'));

      refresh(file);
      const after = readFileSync(file, 'utf8');

      expect(after).toContain('- App: ia-cb7da2c8');
      expect(after).toContain('- Machine ID: 17811943f');
      expect(after).toMatch(/- Facts generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
      expect(after).toContain('My own note nobody may touch.');
      expect(after.indexOf('<!-- MACHINE-FACTS:START -->')).toBe(0);
    });
  });

  /**
   * NOTE #393: agents could read their app, region and image but never their
   * SHAPE. Cores and memory come from the guest itself (nproc, /proc/meminfo)
   * — so they cannot disagree with the machine — and only the dedicated/shared
   * word is injected, because Fly throttles shared vCPUs on the host and the
   * guest sees nothing of it. The numbers are the test host's here; what is
   * pinned is that the lines are there and say what they mean.
   */
  it('says how many cores and how much memory the machine has', () => {
    withHome((dir) => {
      const file = path.join(dir, 'CLAUDE.md');
      const write = () => writeFileSync(file, ['<!-- MACHINE-FACTS:START -->', '<!-- MACHINE-FACTS:END -->', BODY].join('\n'));

      write();
      refresh(file, { ...FACTS, CPU_KIND: 'performance' });
      expect(readFileSync(file, 'utf8')).toMatch(/- CPU: \d+ dedicated cores?\n- RAM: \d+ [GM]B\n/);

      write();
      refresh(file, { ...FACTS, CPU_KIND: 'shared' });
      expect(readFileSync(file, 'utf8')).toMatch(/- CPU: \d+ shared cores?\n/);

      // A machine the backend has not written config to since this shipped
      // has no CPU_KIND: say the cores, leave the kind off, guess nothing.
      write();
      refresh(file);
      expect(readFileSync(file, 'utf8')).toMatch(/- CPU: \d+ cores?\n/);
    });
  });

  /**
   * A resize is the one moment the shape moves under a machine, and it lands
   * as a changed CPU_KIND on the next boot. That HAS to re-stamp: an agent
   * moved onto dedicated cores whose file still says "shared" reads its own
   * speed wrong for as long as the file stands.
   */
  it('re-stamps when the machine is moved to another rung', () => {
    withHome((dir) => {
      const file = path.join(dir, 'CLAUDE.md');
      writeFileSync(file, ['<!-- MACHINE-FACTS:START -->', '<!-- MACHINE-FACTS:END -->', BODY].join('\n'));

      refresh(file, { ...FACTS, CPU_KIND: 'shared' });
      const stamped = readFileSync(file, 'utf8');
      refresh(file, { ...FACTS, CPU_KIND: 'shared' });
      expect(readFileSync(file, 'utf8')).toBe(stamped);

      refresh(file, { ...FACTS, CPU_KIND: 'performance' });
      expect(readFileSync(file, 'utf8')).toContain(' dedicated core');
    });
  });

  it('leaves the file byte-identical when the boot changed no fact', () => {
    withHome((dir) => {
      const file = path.join(dir, 'CLAUDE.md');
      writeFileSync(file, ['<!-- MACHINE-FACTS:START -->', '<!-- MACHINE-FACTS:END -->', BODY].join('\n'));

      refresh(file);
      const stamped = readFileSync(file, 'utf8');
      const mtime = statSync(file).mtimeMs;

      refresh(file);

      // Not "the same facts" — the same BYTES, timestamp included. Anything
      // else and the CLI re-sends the whole instruction file next turn.
      expect(readFileSync(file, 'utf8')).toBe(stamped);
      expect(statSync(file).mtimeMs).toBe(mtime);
    });
  });

  it('keeps an old timestamp while the facts hold, and re-stamps when one moves', () => {
    withHome((dir) => {
      const file = path.join(dir, 'CLAUDE.md');
      const stamped = (extra: Record<string, string> = {}) => {
        writeFileSync(file, ['<!-- MACHINE-FACTS:START -->', '<!-- MACHINE-FACTS:END -->', BODY].join('\n'));
        refresh(file, { ...FACTS, ...extra });
        // Back-date the stamp so a later refresh in the same second is still
        // legible as a rewrite.
        writeFileSync(file, readFileSync(file, 'utf8').replace(/- Facts generated at: .+/, '- Facts generated at: 2026-01-01T00:00:00Z'));
      };

      stamped();
      refresh(file);
      // The machine has booted again on the same host: the stamp is old and
      // stays old, because saying "these facts are from January" is true and
      // rewriting it would cost the agent its whole instruction file again.
      expect(readFileSync(file, 'utf8')).toContain('- Facts generated at: 2026-01-01T00:00:00Z');

      // A machine moved to another host: new id, new address, new stamp.
      refresh(file, { ...FACTS, FLY_MACHINE_ID: '48ed1a9b2', FLY_PRIVATE_IP: 'fdaa:99:600e:a7b:1:2:3:4' });
      const after = readFileSync(file, 'utf8');
      expect(after).toContain('- Machine ID: 48ed1a9b2');
      expect(after).toContain('- Private 6PN IPv6: fdaa:99:600e:a7b:1:2:3:4');
      expect(after).not.toContain('2026-01-01T00:00:00Z');
      expect(after).toContain('You are running inside a Fly Firecracker microVM.');
    });
  });

  it('appends a block when the markers are gone, and skips a file that is not there', () => {
    withHome((dir) => {
      const file = path.join(dir, 'AGENTS.md');
      writeFileSync(file, 'Everything I wrote after deleting the block.\n');

      refresh(file);
      const after = readFileSync(file, 'utf8');
      expect(after).toContain('Everything I wrote after deleting the block.');
      expect(after).toContain('- App: ia-cb7da2c8');
      expect(after.indexOf('Everything I wrote')).toBeLessThan(after.indexOf('MACHINE-FACTS:START'));

      // A second boot has markers now, and the same facts: nothing moves.
      const stamped = readFileSync(file, 'utf8');
      refresh(file);
      expect(readFileSync(file, 'utf8')).toBe(stamped);

      // The user removed the file on purpose; boot must not recreate it.
      expect(() => refresh(path.join(dir, 'GONE.md'))).not.toThrow();
    });
  });
});
