import fs from 'node:fs';
import path from 'node:path';

const TARGET_SUFFIXES = new Set([
  'src/agent/agent-loop.ts',
  'src/agent/background-runner.ts',
  'src/agent/autonomous-scheduler.ts',
]);

const STATEMENT_THRESHOLD = 92;
const BRANCH_THRESHOLD = 88;

const lcovPath = path.resolve(process.cwd(), 'coverage/lcov.info');
if (!fs.existsSync(lcovPath)) {
  console.error(`[coverage] Missing lcov report: ${lcovPath}`);
  process.exit(1);
}

const lcov = fs.readFileSync(lcovPath, 'utf8');
const records = lcov.split('end_of_record');

let statementTotal = 0;
let statementCovered = 0;
let branchTotal = 0;
let branchCovered = 0;

for (const record of records) {
  const lines = record.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) continue;

  const sf = lines.find((line) => line.startsWith('SF:'));
  if (!sf) continue;

  const sourcePath = sf.slice(3).replace(/\\/g, '/');
  const isTarget = [...TARGET_SUFFIXES].some((suffix) => sourcePath.endsWith(suffix));
  if (!isTarget) continue;

  for (const line of lines) {
    if (line.startsWith('DA:')) {
      const [, hitsRaw] = line.slice(3).split(',');
      const hits = Number(hitsRaw ?? '0');
      statementTotal += 1;
      if (hits > 0) statementCovered += 1;
      continue;
    }

    if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      const takenRaw = parts[3];
      branchTotal += 1;
      if (takenRaw !== '-' && Number(takenRaw) > 0) {
        branchCovered += 1;
      }
    }
  }
}

if (statementTotal === 0 || branchTotal === 0) {
  console.error('[coverage] Unable to compute aggregate central coverage from lcov.');
  process.exit(1);
}

const statementPct = (statementCovered / statementTotal) * 100;
const branchPct = (branchCovered / branchTotal) * 100;

console.log(
  `[coverage] Central aggregate: statements ${statementPct.toFixed(2)}% (${statementCovered}/${statementTotal}), `
  + `branches ${branchPct.toFixed(2)}% (${branchCovered}/${branchTotal})`
);

if (statementPct < STATEMENT_THRESHOLD || branchPct < BRANCH_THRESHOLD) {
  console.error(
    `[coverage] Central aggregate gate failed: required statements >= ${STATEMENT_THRESHOLD}% and branches >= ${BRANCH_THRESHOLD}%`
  );
  process.exit(1);
}

console.log('[coverage] Central aggregate gate passed.');
