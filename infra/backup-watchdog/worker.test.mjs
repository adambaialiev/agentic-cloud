// node --test infra/backup-watchdog/worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, describe } from './worker.js';

const H = 3600_000;
const now = new Date('2026-11-06T18:00:00Z');
function bucket(objects) {
  return {
    async list({ prefix, cursor, limit }) {
      const all = objects.filter((o) => o.key.startsWith(prefix));
      const start = Number(cursor ?? 0);
      const page = all.slice(start, start + Math.min(limit, 2));
      return { objects: page, truncated: start + 2 < all.length, cursor: String(start + 2) };
    },
  };
}
const env = (objects) => ({ BACKUPS: bucket(objects), DB_MAX_AGE_HOURS: '8', GIT_MAX_AGE_HOURS: '72', MEDIA_MAX_AGE_HOURS: '0' });

test('fresh backups are fresh, across pages', async () => {
  const r = await check(env([
    { key: 'db/a', uploaded: new Date(now - 30 * H) },
    { key: 'db/b', uploaded: new Date(now - 20 * H) },
    { key: 'db/c', uploaded: new Date(now - 2 * H) },
    { key: 'git/ns/repo/2026-11-05.bundle', uploaded: new Date(now - 24 * H) },
  ]), now);
  assert.deepEqual(r.map((x) => [x.name, x.ok, x.count]), [['database', true, 3], ['repo bundles', true, 1]]);
  assert.match(describe(r, 'b'), /all fresh/);
});

test('a stale database and an empty prefix are both alarms', async () => {
  const r = await check(env([{ key: 'db/a', uploaded: new Date(now - 9 * H) }]), now);
  assert.deepEqual(r.map((x) => x.ok), [false, false]);
  const text = describe(r, 'acc-platform-backups');
  assert.match(text, /stale/);
  assert.match(text, /database: newest 9 h old/);
  assert.match(text, /repo bundles: NOTHING under git\//);
});
