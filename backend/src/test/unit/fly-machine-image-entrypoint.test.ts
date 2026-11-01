import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
