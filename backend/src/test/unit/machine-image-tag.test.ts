import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  machineImageMatchesPins,
  machineImageTag,
  parseMachineImageTag,
} from '../../services/machine-image-tag.js';

/**
 * Note #1052: the agent image's tag names the commit AND the three pinned CLIs,
 * so a pin bump rebuilt at an unchanged commit is a new tag, the roller's
 * string comparison offers it to every sleeping machine, and the status
 * script reads "behind the pins" off the live tag.
 */
const COMMIT = '0477944f1b34c0ffee0000000000000000000000';
const PINS = { claude: '2.1.316', codex: '0.166.0', opencode: '1.19.5' };
const TAG = 'sha-0477944f1b34-c2.1.316-x0.166.0-o1.19.5';

const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));
const runJob = readFileSync(RUN_JOB, 'utf8');

/** A top-level function of run-job.sh, lifted whole. */
function liftFn(name: string): string {
  const start = runJob.indexOf(`\n${name}() {`);
  const end = runJob.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in run-job.sh`);
  return runJob.slice(start + 1, end + 3);
}

function bash(script: string, path?: string): { code: number; out: string; err: string } {
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...(path ? { PATH: `${path}:${process.env.PATH}` } : {}) },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe('machineImageTag', () => {
  it('names the commit and all three pins', () => {
    expect(machineImageTag(COMMIT, PINS)).toBe(TAG);
  });

  it('is a different tag for the same commit after a pin bump — the case trap 2 was', () => {
    const bumped = machineImageTag(COMMIT, { ...PINS, codex: '0.167.0' });
    expect(bumped).toBe('sha-0477944f1b34-c2.1.316-x0.167.0-o1.19.5');
    expect(bumped).not.toBe(TAG);
  });

  it('writes semver build metadata with _ (no + in an OCI tag)', () => {
    expect(machineImageTag(COMMIT, { ...PINS, claude: '2.1.316+build.7' }))
      .toBe('sha-0477944f1b34-c2.1.316_build.7-x0.166.0-o1.19.5');
  });

  it('refuses to make a tag without a real commit or a valid pin for every CLI', () => {
    expect(machineImageTag('main', PINS)).toBeUndefined();
    expect(machineImageTag('0477944', PINS)).toBeUndefined();
    expect(machineImageTag(COMMIT, { ...PINS, opencode: undefined })).toBeUndefined();
    expect(machineImageTag(COMMIT, { ...PINS, claude: 'latest' })).toBeUndefined();
  });
});

describe('parseMachineImageTag', () => {
  it('reads the commit and pins back off a tag or a whole ref', () => {
    const want = { commit: '0477944f1b34', pins: PINS };
    expect(parseMachineImageTag(TAG)).toEqual(want);
    expect(parseMachineImageTag(`ghcr.io/acme/ia-machine-images:${TAG}`)).toEqual(want);
    expect(parseMachineImageTag(`registry.fly.io/ia-machine-images:${TAG}`)).toEqual(want);
  });

  it('round-trips pre-release and build-metadata versions', () => {
    const pins = { claude: '2.2.0-beta.1', codex: '0.170.0-alpha.3', opencode: '1.20.0+linux.x64' };
    const tag = machineImageTag(COMMIT, pins);
    expect(parseMachineImageTag(tag)).toEqual({ commit: '0477944f1b34', pins });
  });

  it('says nothing about a tag that does not name its pins', () => {
    for (const ref of [
      'ghcr.io/acme/ia-machine-images:sha-0477944f1b34', // before note #1052
      'ghcr.io/acme/ia-machine-images:sha-7efd000230f6-r2', // a hand retag
      'ghcr.io/acme/ia-machine-images:git-host-sha-0fcbcadd8900',
      'registry.fly.io/ia-machine-images:cli-2.1.223-fb2',
      '',
      undefined,
    ]) {
      expect(parseMachineImageTag(ref), String(ref)).toBeUndefined();
    }
  });
});

describe('machineImageMatchesPins', () => {
  it('a hand retag of a pinned tag never reads as up to date', () => {
    // `-r2` on the end reads as a pre-release of the OpenCode pin — ambiguous by
    // nature, so the guarantee is the safe one: it is never "current".
    expect(machineImageMatchesPins(`ghcr.io/acme/ia-machine-images:${TAG}-r2`, PINS)).toBe(false);
  });

  it('matches only when the tag bakes exactly the pins', () => {
    expect(machineImageMatchesPins(`ghcr.io/acme/ia-machine-images:${TAG}`, PINS)).toBe(true);
    expect(machineImageMatchesPins(TAG, { ...PINS, claude: '2.1.317' })).toBe(false);
    expect(machineImageMatchesPins(TAG, { claude: PINS.claude, codex: PINS.codex })).toBe(false);
  });

  it('never calls an image whose tag names no pins up to date', () => {
    expect(machineImageMatchesPins('ghcr.io/acme/ia-machine-images:sha-0477944f1b34', PINS)).toBe(false);
    expect(machineImageMatchesPins(undefined, PINS)).toBe(false);
  });
});

describe('run-job.sh machine_image_label (the CI side of the same tag)', () => {
  const fn = liftFn('machine_image_label');
  const label = (...args: string[]) => bash(`${fn}\nmachine_image_label ${args.map((a) => `'${a}'`).join(' ')}`);

  it.each([
    [PINS],
    [{ ...PINS, codex: '0.167.0' }],
    [{ claude: '2.2.0-beta.1', codex: '0.170.0-alpha.3', opencode: '1.20.0+linux.x64' }],
  ])('agrees with machineImageTag for %j', (pins) => {
    const r = label(COMMIT, pins.claude, pins.codex, pins.opencode);
    expect(r.code).toBe(0);
    expect(r.out).toBe(machineImageTag(COMMIT, pins));
  });

  it('fails rather than produce a tag from a bad commit', () => {
    const r = label('not-a-sha', PINS.claude, PINS.codex, PINS.opencode);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });

  it('is what the machine-image job tags with, after the pins are read and before anything is built', () => {
    const job = runJob.slice(runJob.indexOf('\n  machine-image)'), runJob.indexOf('\n  git-host-image)'));
    expect(job).not.toContain('LABEL="sha-${SHA:0:12}"');
    const pinsRead = job.indexOf('OPENCODE_VERSION="$(pin_version opencode)"');
    const labelled = job.indexOf('LABEL="$(machine_image_label "$SHA" "$CLAUDE_VERSION" "$CODEX_VERSION" "$OPENCODE_VERSION")"');
    const checked = job.indexOf('ghcr_tag_state "$GHCR_OWNER/ia-machine-images" "$LABEL"');
    const builder = job.indexOf('builder_up');
    const built = job.indexOf('\n    docker build \\');
    expect(pinsRead).toBeGreaterThan(-1);
    expect(labelled).toBeGreaterThan(pinsRead);
    expect(checked).toBeGreaterThan(labelled);
    expect(builder).toBeGreaterThan(checked);
    expect(built).toBeGreaterThan(builder);
  });

  it('a published tag is repointed, never rebuilt or pushed over', () => {
    const job = runJob.slice(runJob.indexOf('\n  machine-image)'), runJob.indexOf('\n  git-host-image)'));
    const present = job.slice(job.indexOf('if [ "$TAG_STATE" = present ]; then'), job.indexOf('builder_up'));
    expect(present).toContain(`/usr/local/bin/set-machine-image '$PUBLIC_IMAGE_REF'`);
    expect(present).toContain('exit 0');
    expect(present).not.toContain('docker push');
  });
});

describe('run-job.sh ghcr_tag_state', () => {
  // json_get is a one-line function; take its line.
  const jsonGet = runJob.split('\n').find((l) => l.startsWith('json_get() {'));
  const fn = `${jsonGet}\n${liftFn('ghcr_tag_state')}`;

  function withCurl(manifestCode: string, tokenOk = true) {
    const dir = mkdtempSync(join(tmpdir(), 'ghcr-tag-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'case "$*" in',
      `  *ghcr.io/token*) ${tokenOk ? `echo '{"token":"t0k"}'` : 'exit 22'} ;;`,
      `  *manifests*) case "$*" in *"Bearer t0k"*) printf '%s' '${manifestCode}' ;; *) printf 401 ;; esac ;;`,
      'esac',
    ].join('\n'));
    chmodSync(join(bin, 'curl'), 0o755);
    return bash(`${fn}\nghcr_tag_state acme/ia-machine-images '${TAG}'`, bin);
  }

  it('reads present, absent, and refuses to guess', () => {
    expect(withCurl('200')).toMatchObject({ code: 0, out: 'present\n' });
    expect(withCurl('404')).toMatchObject({ code: 0, out: 'absent\n' });
    expect(withCurl('500').code).toBe(1);
    expect(withCurl('200', false).code).toBe(1);
  });
});
