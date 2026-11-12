import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// backend/src/test/unit → repo root is four levels up.
const ENTRYPOINT = fileURLToPath(new URL('../../../../infra/fly-machine-image/entrypoint.sh', import.meta.url));

describe('fly-machine-image entrypoint.sh', () => {
  it('passes bash -n (no syntax errors)', () => {
    // Throws on a non-zero exit, failing the test with bash's diagnostics.
    expect(() => execFileSync('bash', ['-n', ENTRYPOINT])).not.toThrow();
  });

  it('accepts the public port (PUBLIC_PORT, default 8080) ahead of the fdaa drop', () => {
    const script = readFileSync(ENTRYPOINT, 'utf8');
    // Defaults to 8080 and sanitizes to digits.
    expect(script).toContain('PUBLIC_PORT:-8080');
    // Builds a per-port accept line for the public port and never the SSH ports.
    expect(script).toContain('tcp dport ${public_port} accept');
    // The public accept is spliced into the ruleset BEFORE the tenant drop.
    expect(script).toMatch(/\$\{public_accept\}\$\{exposed_accepts\}\s*ip6 saddr fdaa::\/16 drop/);
  });
});

/**
 * Docker at boot (note #1167): the daemon is started at boot ONLY when a
 * container on the volume carries a restart policy Docker honours at daemon
 * start, and stale runtime files from the previous boot are always cleared.
 * Run against the real function, lifted out of the script, with a stub
 * starter that leaves a mark — asserting on the script's text would only pin
 * what someone typed.
 */
describe('fly-machine-image entrypoint.sh: start_docker_if_asked', () => {
  const script = readFileSync(ENTRYPOINT, 'utf8');
  const fn = /^start_docker_if_asked\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];

  function boot(containers: Array<{ policy?: string; manuallyStopped?: boolean }>, daemonProcess = 'no-such-dockerd-n1167'): { started: boolean; staleGone: boolean; log: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'docker-boot-'));
    try {
      const data = path.join(dir, 'data');
      const run = path.join(dir, 'run');
      mkdirSync(path.join(run, 'docker'), { recursive: true });
      writeFileSync(path.join(run, 'docker.pid'), '6366');
      containers.forEach((c, i) => {
        const cdir = path.join(data, 'docker', 'containers', `c${i}abcdef0123456789`);
        mkdirSync(cdir, { recursive: true });
        writeFileSync(path.join(cdir, 'hostconfig.json'), JSON.stringify(c.policy ? { RestartPolicy: { Name: c.policy } } : {}));
        writeFileSync(path.join(cdir, 'config.v2.json'), JSON.stringify({ HasBeenManuallyStopped: Boolean(c.manuallyStopped) }));
      });
      const mark = path.join(dir, 'started');
      const starter = path.join(dir, 'starter.sh');
      writeFileSync(starter, `#!/bin/sh\ntouch '${mark}'\n`, { mode: 0o755 });
      const log = execFileSync('bash', ['-c', `log() { printf '%s\\n' "$*" >&2; }\n${fn}\nstart_docker_if_asked 2>&1`], {
        env: { PATH: process.env.PATH, DATA_DIR: data, DOCKER_RUN_DIR: run, DOCKERD_STARTER: starter, DOCKERD_PROCESS: daemonProcess },
        encoding: 'utf8',
      });
      // setsid -f returns before the starter runs; give it a moment.
      const until = Date.now() + 3000;
      while (!existsSync(mark) && Date.now() < until && log.includes('starting Docker')) { /* spin */ }
      return {
        started: existsSync(mark),
        staleGone: !existsSync(path.join(run, 'docker.pid')) && !existsSync(path.join(run, 'docker')),
        log,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is in the script', () => {
    expect(fn).toBeTruthy();
    // Called before the agent's boot hooks, so a hook's `docker compose up`
    // queues behind the same daemon rather than racing a second one.
    expect(script.indexOf('\nstart_docker_if_asked\n')).toBeGreaterThan(0);
    expect(script.indexOf('\nstart_docker_if_asked\n')).toBeLessThan(script.indexOf('\nrun_agent_boot_hooks\n'));
  });

  it('starts Docker for an `always` or an `unless-stopped` container nobody stopped', () => {
    expect(boot([{ policy: 'no' }, { policy: 'always' }]).started).toBe(true);
    expect(boot([{ policy: 'unless-stopped' }]).started).toBe(true);
  });

  it('leaves Docker off when nothing asked to come back', () => {
    expect(boot([]).started).toBe(false);
    const noPolicy = boot([{ policy: 'no' }, {}]);
    expect(noPolicy.started).toBe(false);
    expect(noPolicy.log).toContain('Docker starts on first use');
    expect(boot([{ policy: 'on-failure' }]).started).toBe(false);
    // `docker compose stop` sets HasBeenManuallyStopped: stopped on purpose stays stopped.
    expect(boot([{ policy: 'unless-stopped', manuallyStopped: true }]).started).toBe(false);
  });

  it('clears the previous boot\'s pid file and exec-root either way (the rootfs survives a sleep)', () => {
    expect(boot([]).staleGone).toBe(true);
    expect(boot([{ policy: 'always' }]).staleGone).toBe(true);
  });

  it('leaves a daemon that is already running alone — its files are not stale', () => {
    // `bash` is running: it is the shell executing the function.
    const running = boot([{ policy: 'always' }], 'bash');
    expect(running.started).toBe(false);
    expect(running.staleGone).toBe(false);
    expect(running.log).toContain('already running');
  });
});
