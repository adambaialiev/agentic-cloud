import { describe, expect, it } from 'vitest';
import { loadCiVerdicts, type PublishOutcome } from '../../services/ci-verdicts.js';

/**
 * Note #1161: the words around a check live in ONE file,
 * infra/ci-runner/ci-verdicts.mjs, which an own cloud's OrgCiService loads.
 * Our own dispatcher still carries its own copy in lane-a.mjs until a change
 * of its own switches it (its self-update installs a fixed list of files).
 * Until then, this fails the build the moment the two answer differently.
 */
const laneA = () => import('../../../../infra/ci-runner/lane-a.mjs') as Promise<{
  publishVerdict: (outcome: PublishOutcome, site: string) => unknown;
  usablePublish: (publish: unknown) => unknown;
}>;

const OUTCOMES: PublishOutcome[] = [
  { kind: 'reported', exitCode: 0, publish: { exitCode: 0, logTail: 'live' } },
  { kind: 'reported', exitCode: 0, publish: { exitCode: 78, logTail: 'no deploy.sh' } },
  { kind: 'reported', exitCode: 0, publish: { exitCode: 3, logTail: 'boom' } },
  { kind: 'reported', exitCode: 0 },
  { kind: 'reported', exitCode: 1 },
  { kind: 'cancelled' },
  { kind: 'timeout' },
  { kind: 'lost' },
];

const GRANTS: unknown[] = [
  null,
  'x',
  { token: 't', site: 'docs-site', apiUrl: 'https://api.example.test' },
  { token: '', site: 'docs-site', apiUrl: 'https://api.example.test' },
  { token: 't', site: 'Bad Site', apiUrl: 'https://api.example.test' },
  { token: 't', site: 'docs-site', apiUrl: 'ftp://x' },
];

describe('ci-verdicts.mjs — one set of words for both controllers', () => {
  it('loads in a checkout, as the backend build loads it beside dist', async () => {
    const verdicts = await loadCiVerdicts();
    expect(verdicts.publishVerdict({ kind: 'reported', exitCode: 0, publish: { exitCode: 0, logTail: '' } }, 'docs-site'))
      .toEqual({ state: 'success', description: 'Published docs-site', logTail: '' });
  });

  it('answers exactly as our own dispatcher (lane-a.mjs) does, for every outcome and grant', async () => {
    const shared = await loadCiVerdicts();
    const dispatcher = await laneA();
    for (const outcome of OUTCOMES) {
      expect(shared.publishVerdict(outcome, 'docs-site'), JSON.stringify(outcome))
        .toEqual(dispatcher.publishVerdict(outcome, 'docs-site'));
    }
    for (const grant of GRANTS) {
      expect(shared.usablePublish(grant), JSON.stringify(grant)).toEqual(dispatcher.usablePublish(grant));
    }
  });
});
