import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GitCommitStatusState } from '../types/git-commit-status.js';

/**
 * The shared words around a check (infra/ci-runner/ci-verdicts.mjs, note
 * #1161), loaded from where the build puts them. Our own dispatcher imports
 * the same file (lane-a.mjs, since note #1166); ci-verdicts.test.ts fails if
 * it ever carries a copy again.
 */
export type PublishOutcome =
  | { kind: 'reported'; exitCode: number; publish?: { exitCode: number; logTail: string } }
  | { kind: 'cancelled' }
  | { kind: 'timeout' | 'lost' };

export interface CiVerdictsModule {
  usablePublish(publish: unknown): { token: string; site: string; apiUrl: string } | null;
  publishVerdict(outcome: PublishOutcome, site: string): { state: GitCommitStatusState; description: string; logTail: string };
}

let loaded: Promise<CiVerdictsModule> | null = null;

export function loadCiVerdicts(): Promise<CiVerdictsModule> {
  if (!loaded) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.CI_VERDICTS_PATH,
      path.resolve(here, '../ci-verdicts.mjs'), // the build: dist/services → dist/ci-verdicts.mjs
      path.resolve(here, '../../../infra/ci-runner/ci-verdicts.mjs'), // a checkout: src/services → infra
    ].filter((file): file is string => Boolean(file));
    const file = candidates.find((candidate) => existsSync(candidate));
    loaded = file
      ? import(pathToFileURL(file).href) as Promise<CiVerdictsModule>
      : Promise.reject(new Error('ci-verdicts.mjs is not in this backend build'));
    // A failed load is not cached: the next caller tries again.
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}
