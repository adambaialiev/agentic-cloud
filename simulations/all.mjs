#!/usr/bin/env node
/**
 * Every browser simulation, in order, with a TALLY at the end.
 *
 * It used to `process.exit` on the first failure, which is how nine scenarios
 * came to be reported as one: the first broke on a landing headline that had
 * changed, the run stopped there, and the eight behind it — six of which were
 * also broken, for four unrelated reasons — were simply never run. One failing
 * scenario says nothing about the next, so all of them run and the verdict is
 * a list. A red run still exits non-zero.
 *
 * Eight scenarios: the three that walked the retired username-and-
 * authenticator signup were retired with it (note #531), the first
 * experience came back as `onboarding` on the email signup (note #144), and
 * `first-result` went with the Home setup guide it drove — a founded
 * workplace opens with its team already working, so there is no road left
 * for a guide to walk (2026-09-20).
 *
 * CI runs this suite (note #533): `scripts/run-browser-checks.sh` drives it
 * after its own harnesses, so the tally below is read off a job log rather
 * than a terminal — which is why it is a list and not a first failure.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarios = [
  'onboarding.mjs',
  'returning-signin.mjs',
  'recovery-access.mjs',
  'team-join.mjs',
  'team-join-existing.mjs',
  'handoff-and-approval.mjs',
  'workspace-tour.mjs',
  'mail.mjs',
];

const results = [];
for (const scenario of scenarios) {
  const name = scenario.replace(/\.mjs$/, '');
  console.log(`\n=== ${name} ===`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, scenario)], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      if (signal) reject(new Error(`${scenario} stopped by ${signal}`));
      else resolve(status ?? 1);
    });
  });
  results.push({ name, code });
}

const failed = results.filter((result) => result.code !== 0);
console.log('\n=== tally ===');
for (const result of results) console.log(`${result.code === 0 ? 'passed ' : 'FAILED '} ${result.name}`);
if (!failed.length) {
  console.log(`\nAll ${scenarios.length} browser simulations passed.`);
  process.exit(0);
}
console.log(`\n${failed.length} of ${scenarios.length} failed: ${failed.map((result) => result.name).join(', ')}`);
console.log('Each one printed its own failure above, with a screenshot path.');
process.exit(1);
