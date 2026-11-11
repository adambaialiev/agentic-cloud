import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The backend image (infra/backend-image/Dockerfile, built for every copy
 * release) copies only NAMED files from outside backend/ into its context.
 * The backend build (`npm run build`) copies files from ../cli and ../infra
 * beside dist. A file the build needs and the image does not bring in fails
 * the release build, not any check before it — note #1161 nearly shipped
 * infra/ci-runner/ci-verdicts.mjs that way.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('backend image build context', () => {
  it('brings in every file the backend build copies from outside backend/', () => {
    const build = JSON.parse(read('../../../package.json')).scripts.build as string;
    const dockerfile = read('../../../../infra/backend-image/Dockerfile');
    const outside = [...build.matchAll(/cp \.\.\/(\S+)/g)].map((match) => match[1]);
    expect(outside).toContain('infra/ci-runner/ci-verdicts.mjs');
    for (const file of outside) {
      expect(dockerfile, `${file} is copied by the build but not into the image`).toMatch(
        new RegExp(`^COPY ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm'),
      );
    }
  });
});
