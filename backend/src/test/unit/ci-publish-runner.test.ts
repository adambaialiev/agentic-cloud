import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The runner half of publishing on approval (`agentbuilt repo publish`):
 * lane-a.mjs turns the backend's publish grant into env and the run's outcome
 * into a deploy/<site> verdict, and runner-agent.sh runs the repository's
 * deploy.sh only after ci.sh passed. The two lane-a.mjs functions are
 * imported as the daemon imports them; runner-agent.sh is read as text.
 */
const RUNNER = fileURLToPath(new URL('../../../../infra/ci-runner/runner-agent.sh', import.meta.url));

type Grant = { token: string; site: string; apiUrl: string } | null;
type Verdict = { state: string; description: string; logTail: string };
// Since note #1166 lane-a.mjs imports both from ci-verdicts.mjs (shared with
// an own cloud's backend) and re-exports them; tested through lane-a.mjs, as
// the daemon reaches them.
const { usablePublish, publishVerdict } = await (import('../../../../infra/ci-runner/lane-a.mjs') as Promise<{
  usablePublish: (grant: unknown) => Grant;
  publishVerdict: (outcome: Record<string, unknown>, site: string) => Verdict;
}>);

describe('usablePublish — a daemon never trusts even a friend with env injection', () => {
  it('passes a well-formed grant through', () => {
    expect(usablePublish({ token: 'cdt1.x.y', site: 'startup-game', apiUrl: 'https://api.example.test', expiresAt: 't' }))
      .toEqual({ token: 'cdt1.x.y', site: 'startup-game', apiUrl: 'https://api.example.test' });
  });

  it('drops anything that would make a strange context or a strange env', () => {
    expect(usablePublish(undefined)).toBeNull();
    expect(usablePublish({ token: '', site: 'a', apiUrl: 'https://x' })).toBeNull();
    // The site becomes a status context: `deploy/../ci/checks` must never be one.
    expect(usablePublish({ token: 't', site: '../ci/checks', apiUrl: 'https://x' })).toBeNull();
    expect(usablePublish({ token: 't', site: 'Prod', apiUrl: 'https://x' })).toBeNull();
    expect(usablePublish({ token: 't', site: 'ok', apiUrl: 'file:///etc/passwd' })).toBeNull();
  });
});

describe('publishVerdict — the deploy/<site> check says what actually happened', () => {
  const reported = (exitCode: number, publish?: { exitCode: number; logTail: string }) => ({
    kind: 'reported', exitCode, ...(publish ? { publish } : {}),
  });

  it('a publish that ran is green or red on its OWN exit, never the tests’', () => {
    expect(publishVerdict(reported(0, { exitCode: 0, logTail: 'Deployed.' }), 'game'))
      .toEqual({ state: 'success', description: 'Published game', logTail: 'Deployed.' });
    const failed = publishVerdict(reported(0, { exitCode: 3, logTail: 'boom' }), 'game');
    expect(failed.state).toBe('failure');
    expect(failed.description).toContain('exit 3');
    expect(failed.logTail).toBe('boom');
  });

  it('no deploy.sh yet is grey, and says what to commit', () => {
    const none = publishVerdict(reported(0, { exitCode: 78, logTail: '' }), 'game');
    expect(none.state).toBe('skipped');
    expect(none.description).toContain('.agentbuilt/deploy.sh');
  });

  it('failed checks publish nothing, and the check says the live site is unchanged', () => {
    const v = publishVerdict(reported(1), 'game');
    expect(v.state).toBe('skipped');
    expect(v.description).toContain('still serves the last approved change');
  });

  it('a pass that lost its publish step is an error, not a quiet success', () => {
    expect(publishVerdict(reported(0), 'game').state).toBe('error');
  });

  it('a newer merge supersedes; a machine that died never published', () => {
    expect(publishVerdict({ kind: 'cancelled' }, 'game').state).toBe('superseded');
    expect(publishVerdict({ kind: 'timeout' }, 'game').state).toBe('error');
    expect(publishVerdict({ kind: 'died', state: 'stopped' }, 'game').state).toBe('error');
  });

  it('every description fits the status document', () => {
    const long = 'x'.repeat(63);
    for (const outcome of [reported(0), reported(1), reported(0, { exitCode: 9, logTail: '' }), { kind: 'timeout' }]) {
      expect(publishVerdict(outcome, long).description.length).toBeLessThanOrEqual(140);
    }
  });
});

describe('runner-agent.sh — deploy.sh runs only after ci.sh passed, and ci.sh never holds the key', () => {
  const runner = readFileSync(RUNNER, 'utf8');

  it('takes the key out of the environment before anything from the repository runs', () => {
    const unset = runner.indexOf('unset CI_PUBLISH_TOKEN');
    expect(unset).toBeGreaterThan(0);
    expect(unset).toBeLessThan(runner.indexOf('bash .agentbuilt/ci.sh'));
    expect(unset).toBeLessThan(runner.lastIndexOf('\nrun\n'));
  });

  it('publishes only on a passing run that carries a key, after ci.sh', () => {
    const ci = runner.indexOf('bash .agentbuilt/ci.sh');
    const gate = runner.indexOf('if [[ "$ci_exit" -eq 0 && -n "$PUBLISH_TOKEN" ]]; then');
    expect(gate).toBeGreaterThan(ci);
    expect(runner.slice(gate, gate + 120)).toContain('publish');
  });

  it('hands deploy.sh the key under the CLI’s own name, and masks it out of both logs', () => {
    expect(runner).toContain('AGENTBUILT_TOKEN="$PUBLISH_TOKEN" AGENTBUILT_SITE="$site"');
    expect(runner).toContain('[masked:AGENTBUILT_TOKEN]');
    expect(runner).toContain('masked_tail_b64 "$PUBLISH_LOG"');
    expect(runner).toContain('masked_tail_b64 "$LOG"');
  });
});
