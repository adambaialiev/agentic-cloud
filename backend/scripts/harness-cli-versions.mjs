#!/usr/bin/env node
// Pin the harness CLI versions the fleet converges onto — and keep the machine
// image in step with the pin.
//
//   npm --prefix backend run cli:versions                          # status (default)
//   npm --prefix backend run cli:versions -- bump                  # pin both to npm latest
//   npm --prefix backend run cli:versions -- bump --only claude
//   npm --prefix backend run cli:versions -- bump --skip-image     # pin only, no rebuild
//   npm --prefix backend run cli:versions -- set --claude 2.1.219
//   npm --prefix backend run cli:versions -- set --codex 0.48.0
//   npm --prefix backend run cli:versions -- set --opencode 1.19.3
//
// Two mechanisms hang off the same config doc (config/harnessCliVersions),
// covering both ends of a machine's life:
//
//   - pins (`claude`/`codex`/`opencode`): read by HarnessCliUpdater — before an idle
//     machine is stopped, its installed CLI is compared against the pin and
//     `npm install -g <pkg>@<pin>` runs if they differ. Existing machines.
//   - image (`image`): NEW machines boot the baked image, so an image built
//     from older pins means every new machine starts behind. After writing
//     pins, bump/set ask CI to rebuild — POST /dispatch to the ci-runner
//     daemon, HMAC-signed with its webhook secret — and record what they asked
//     for. CI owns the rest: it reads the pin back out of the backend, bakes
//     it, smoke-tests the boot, pushes, and repoints FLY_MACHINE_IMAGE itself.
//
// So one `bump` moves the whole fleet: existing machines converge on their
// next idle cycle, new machines boot the pin from their first moment.
//
// This script is the ONLY writer; the backend never bumps the pin on its own.
// Rollback = `set` an older version — which rebuilds the image to match, so
// new machines roll back too.
//
// It used to dispatch the fly-machine-image GitHub Actions workflow, which has
// not run since Actions froze on 2026-07-30: a bump reported success while
// reaching no NEW machine at all. The runner is where CI lives now.
//
// Needs: SQLITE_DB_PATH; and IA_CI_WEBHOOK_SECRET to sign the rebuild
// request (or pass --skip-image).
import dotenv from 'dotenv';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');

// Mirrors backend/src/services/harness-cli-versions.ts — keep in sync. (The
// backend reads only the claude/codex/opencode fields; `image` is this
// script's own bookkeeping and is ignored there.)
const VERSIONS_COLLECTION = 'config';
const VERSIONS_DOCUMENT = 'harnessCliVersions';
const CLI_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
};
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// The CI runner (infra/ci-runner) owns the image build end to end — build,
// smoke test, push, and the set-machine-image repoint on prod. This script's
// job is to ASK for one, not to orchestrate it.
const CI_RUNNER_HOST = process.env.IA_CI_RUNNER_HOST || (() => { throw new Error('Set IA_CI_RUNNER_HOST to the CI runner host'); })();
const CI_RUNNER_PORT = process.env.IA_CI_RUNNER_PORT || '8787';
const CI_DISPATCH_URL = `http://${CI_RUNNER_HOST}:${CI_RUNNER_PORT}/dispatch`;

function loadEnvFiles() {
  for (const envPath of [
    path.join(backendRoot, '.env.local'),
    path.join(backendRoot, '.env'),
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
  ]) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

function printUsage() {
  console.log(`
Usage:
  npm --prefix backend run cli:versions                    Show pins, image state, npm latest.
  npm --prefix backend run cli:versions -- bump            Pin all CLIs to npm latest,
                                                           then rebuild+deploy the machine
                                                           image if it is behind the pins.
  npm --prefix backend run cli:versions -- bump --only claude|codex|opencode
  npm --prefix backend run cli:versions -- bump --skip-deploy   Build the image but do NOT
                                                           repoint prod (no SSH, no restart).
  npm --prefix backend run cli:versions -- set --claude <version> [--codex <version>] [--opencode <version>]

Existing machines pick a new pin up on their next idle cycle (pre-sleep update).
New machines boot the rebuilt image. Rollback: \`set\` an older version.
`.trim());
}

/**
 * The pin doc lives in the backend's SQLite file. This shim exposes the three
 * document calls the script makes; `set({merge:true})` and `update` both
 * become a top-level merge, which matches how they are used here. Needs
 * `dist/` built (run on the prod host, or `npm run build` locally first).
 */
async function initializeSqliteStore(sqlitePath) {
  const { openSqliteDb, serializeDoc, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const sqlite = openSqliteDb(sqlitePath);
  const docId = `${VERSIONS_COLLECTION}/${VERSIONS_DOCUMENT}`;
  const read = () => {
    const row = sqlite.prepare('SELECT doc FROM config_docs WHERE doc_id = ?').get(docId);
    return row ? deserializeDoc(row.doc) : undefined;
  };
  const write = (doc) => sqlite.prepare(
    'INSERT INTO config_docs (doc_id, doc) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET doc = excluded.doc',
  ).run(docId, serializeDoc(doc));
  const docHandle = {
    get: async () => ({ data: () => read() }),
    set: async (updates) => write({ ...(read() ?? {}), ...updates }),
    update: async (updates) => write({ ...(read() ?? {}), ...updates }),
  };
  return { collection: () => ({ doc: () => docHandle }) };
}

/** npm registry lookup — no local npm involved, `latest` read explicitly. */
async function fetchNpmVersion(pkg, versionOrTag) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${encodeURIComponent(versionOrTag)}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${pkg}@${versionOrTag}`);
  }
  const data = await response.json();
  return typeof data?.version === 'string' ? data.version : undefined;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') options.only = argv[++i];
    else if (arg === '--claude') options.claude = argv[++i];
    else if (arg === '--codex') options.codex = argv[++i];
    else if (arg === '--opencode') options.opencode = argv[++i];
    // --skip-deploy meant "build but don't repoint"; CI does both or neither
    // now, so the old flag maps onto skipping the whole rebuild. Still accepted:
    // it is in muscle memory and the intent carries.
    else if (arg === '--skip-image' || arg === '--skip-deploy') options.skipImage = true;
    else if (arg === '--force-image') options.forceImage = true;
    else if (!arg.startsWith('-') && options.command === undefined) options.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.command ??= 'status';
  return options;
}

async function readDoc(db) {
  const snapshot = await db.collection(VERSIONS_COLLECTION).doc(VERSIONS_DOCUMENT).get();
  return snapshot.data() ?? {};
}

function validPins(doc) {
  const pins = {};
  for (const cli of Object.keys(CLI_PACKAGES)) {
    if (VERSION_PATTERN.test(doc[cli] ?? '')) pins[cli] = doc[cli];
  }
  return pins;
}

/**
 * Whether the image we last asked CI to build was built from these pins.
 *
 * This used to be answered by the TAG (`cli-<claude>-<codex>`, built to
 * be self-describing). CI names images `sha-<commit>` now, which says nothing
 * about their CLIs, so the doc records the pins themselves and the comparison
 * reads them directly. More honest anyway: the tag was a claim about contents;
 * this is the contents.
 */
function imagePinsMatch(image, pins) {
  return Object.keys(CLI_PACKAGES).every((cli) => (image?.[cli] ?? null) === (pins[cli] ?? null));
}

async function writePins(db, pins) {
  await db.collection(VERSIONS_COLLECTION).doc(VERSIONS_DOCUMENT).set({
    ...pins,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

// ── Image rebuild ───────────────────────────────────────────────────────────

/**
 * Ask CI to rebuild the machine image from the current pins.
 *
 * A bump writes the database, not the repo — there is no commit for a webhook
 * to fire on, and the image job's path filter would skip it even if there were.
 * /dispatch is the way in: same HMAC, same secret and same header as the GitHub
 * webhook the daemon already verifies, so there is nothing new to rotate.
 *
 * Records what it ASKED for, not what shipped — this returns as soon as the job
 * is queued. If the build then fails, the doc still says we asked, and
 * `--force-image` is the retry. Live machines are unaffected either way: they
 * converge on the pin at their next idle cycle, which is a separate mechanism.
 */
async function requestImageBuild(db, options) {
  const doc = await readDoc(db);
  const pins = validPins(doc);
  if (Object.keys(pins).length === 0) {
    console.log('image: no pins set — nothing to build against.');
    return;
  }
  if (options.skipImage) {
    console.log('--skip-image: pins are live, no rebuild asked for. New machines keep the current image.');
    return;
  }
  if (!options.forceImage && imagePinsMatch(doc.image, pins)) {
    console.log('image: already built from these pins — nothing to rebuild. (--force-image to rebuild anyway.)');
    return;
  }
  const secret = process.env.IA_CI_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // A warning, not a throw: the pins are already written and every existing
    // machine will converge on them regardless. Failing here would report the
    // bump as failed when the half that reaches the fleet already worked.
    console.warn('IA_CI_WEBHOOK_SECRET is not set — pins are LIVE, but no image rebuild was requested.');
    console.warn(`New machines keep the current image until one is. See infra/ci-runner/README.md → ${CI_DISPATCH_URL}`);
    return;
  }
  const body = JSON.stringify({ kind: 'machine-image', ref: 'main' });
  const response = await fetch(CI_DISPATCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
  });
  const outcome = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(`CI refused the rebuild request (HTTP ${response.status}): ${outcome}`);
  }
  console.log(`image rebuild queued on the CI runner: ${outcome}`);
  console.log('CI bakes these pins, smoke-tests the boot, pushes, and repoints prod itself.');
  // Replaces the whole map rather than merging: a stale field from the previous
  // image must not survive onto this one.
  await db.collection(VERSIONS_COLLECTION).doc(VERSIONS_DOCUMENT).update({
    image: { ...pins, requestedAt: new Date().toISOString() },
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

async function showStatus(db) {
  const doc = await readDoc(db);
  const pins = validPins(doc);
  for (const [cli, pkg] of Object.entries(CLI_PACKAGES)) {
    const latest = await fetchNpmVersion(pkg, 'latest');
    const pin = pins[cli];
    const marker = !pin ? '(no pin — machines stay as-built)'
      : pin === latest ? '(current)'
      : `(npm latest: ${latest})`;
    console.log(`${cli.padEnd(6)} pinned: ${pin ?? '—'} ${marker}`);
  }
  const image = doc.image;
  if (!image?.requestedAt) {
    console.log('image : no rebuild recorded — next bump asks CI for one');
  } else if (imagePinsMatch(image, pins)) {
    console.log(`image : rebuild asked for at ${image.requestedAt} with these pins`);
  } else {
    console.log('image : BEHIND pins — run bump (or bump --force-image to retry)');
  }
  if (doc.updatedAt) {
    console.log(`last updated: ${doc.updatedAt}`);
  }
}

async function bump(db, options) {
  const only = options.only;
  if (only && !CLI_PACKAGES[only]) {
    throw new Error(`--only must be one of: ${Object.keys(CLI_PACKAGES).join(', ')}`);
  }
  const pins = {};
  for (const [cli, pkg] of Object.entries(CLI_PACKAGES)) {
    if (only && cli !== only) continue;
    const latest = await fetchNpmVersion(pkg, 'latest');
    if (!latest || !VERSION_PATTERN.test(latest)) {
      throw new Error(`Could not resolve npm latest for ${pkg} (got: ${latest ?? 'nothing'})`);
    }
    pins[cli] = latest;
  }
  await writePins(db, pins);
  for (const [cli, version] of Object.entries(pins)) {
    console.log(`pinned ${cli} → ${version}`);
  }
  console.log('Existing machines update on their next idle cycle.');
  await requestImageBuild(db, options);
}

async function setExplicit(db, options) {
  const pins = {};
  for (const cli of Object.keys(CLI_PACKAGES)) {
    const requested = options[cli];
    if (requested === undefined) continue;
    if (!VERSION_PATTERN.test(requested)) {
      throw new Error(`Invalid ${cli} version "${requested}" — exact versions only (e.g. 2.1.219).`);
    }
    // Refuse to pin a version the registry doesn't have: the fleet would
    // otherwise fail every install until the pin is fixed.
    const resolved = await fetchNpmVersion(CLI_PACKAGES[cli], requested);
    if (resolved !== requested) {
      throw new Error(`${CLI_PACKAGES[cli]}@${requested} does not exist on the npm registry.`);
    }
    pins[cli] = requested;
  }
  if (Object.keys(pins).length === 0) {
    throw new Error('set requires --claude, --codex and/or --opencode <version>.');
  }
  await writePins(db, pins);
  for (const [cli, version] of Object.entries(pins)) {
    console.log(`pinned ${cli} → ${version}`);
  }
  console.log('Existing machines update on their next idle cycle.');
  await requestImageBuild(db, options);
}

async function main() {
  loadEnvFiles();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const db = await initializeSqliteStore(sqlitePath);
  if (options.command === 'status') {
    await showStatus(db);
  } else if (options.command === 'bump') {
    await bump(db, options);
  } else if (options.command === 'set') {
    await setExplicit(db, options);
  } else {
    printUsage();
    throw new Error(`Unknown command: ${options.command}`);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
