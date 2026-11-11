import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The backend image (infra/backend-image/Dockerfile, built for every copy
 * release) copies only NAMED files from outside backend/ into its context.
 * The backend build (`npm run build`) copies files from ../cli and ../infra
 * beside dist. A file the build needs and the image does not bring in fails
 * the release build, not any check before it — note #1161 nearly shipped
 * infra/ci-runner/ci-verdicts.mjs that way, and release 2026.11.11.0 failed
 * on the .dockerignore allowlist, which this test now reads too.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('backend image build context', () => {
  it('brings in every file the backend build copies from outside backend/', () => {
    const build = JSON.parse(read('../../../package.json')).scripts.build as string;
    const dockerfile = read('../../../../infra/backend-image/Dockerfile');
    // The context is an allowlist (.dockerignore): a COPY of a file not
    // listed there fails at build time too, as release 2026.11.11.0 did.
    const allowed = read('../../../../.dockerignore').split('\n').filter((line) => line.startsWith('!')).map((line) => line.slice(1).trim());
    const outside = [...build.matchAll(/cp \.\.\/(\S+)/g)].map((match) => match[1]);
    expect(outside).toContain('infra/ci-runner/ci-verdicts.mjs');
    for (const file of outside) {
      expect(dockerfile, `${file} is copied by the build but not into the image`).toMatch(
        new RegExp(`^COPY ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm'),
      );
      expect(allowed.some((entry) => file === entry || file.startsWith(`${entry}/`)),
        `${file} is copied into the image but .dockerignore leaves it out of the build context`).toBe(true);
    }
  });
});
