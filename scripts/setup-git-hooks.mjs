import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const gitDir = resolve(repoRoot, '.git');
const hookPath = resolve(repoRoot, '.githooks', 'pre-commit');
const resolvedToolsPath = resolve(repoRoot, '.githooks', '.resolved-tools.sh');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (!existsSync(gitDir)) {
  process.exit(0);
}

if (existsSync(hookPath)) {
  chmodSync(hookPath, 0o755);
}

const fallbackNpmCliPath = resolve(
  dirname(process.execPath),
  '..',
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const npmCliPath = [process.env.npm_execpath, fallbackNpmCliPath].find(
  (candidate) => candidate && existsSync(candidate),
);

writeFileSync(
  resolvedToolsPath,
  [
    '#!/bin/sh',
    `NODE_BIN=${shellQuote(process.execPath)}`,
    `NPM_CLI_JS=${shellQuote(npmCliPath ?? '')}`,
    '',
  ].join('\n'),
);

const currentHookPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (currentHookPath.status === 0 && currentHookPath.stdout.trim() === '.githooks') {
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
