// The backups' watchdog, OFF Fly (note #1032).
//
// The platform's control plane and the jobs that make its backups all run on
// Fly. The backups themselves land in Cloudflare R2. If Fly stops, so does the
// backend's own backup monitor, and nothing on Fly can say so. This Worker
// runs on Cloudflare, reads the backups bucket directly, and tells the ops
// Telegram chat when the newest database archive (or the newest repo bundle)
// is older than it should be. It holds no key to Fly and writes nothing to the
// bucket: its R2 binding is the only access it has, and it only lists.
//
// Thresholds (vars, hours): DB_MAX_AGE_HOURS (8 — backups run every 6),
// GIT_MAX_AGE_HOURS (72 — a bundle is only written when a repo changed, and
// the platform's own repo changes daily), MEDIA_MAX_AGE_HOURS (0 = not
// checked: media is mirrored only when there is new media).
//
// It alerts at most once per run, runs every 6 hours, and on Mondays at the
// first run says it is still watching, so its own silence is noticeable.

const HOUR = 3600_000;

async function newestUnder(bucket, prefix) {
  let cursor;
  let newest = null;
  let count = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      count += 1;
      if (!newest || object.uploaded > newest.uploaded) newest = object;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { newest, count };
}

export async function check(env, now = new Date()) {
  const rules = [
    { name: 'database', prefix: 'db/', maxHours: Number(env.DB_MAX_AGE_HOURS ?? 8) },
    { name: 'repo bundles', prefix: 'git/', maxHours: Number(env.GIT_MAX_AGE_HOURS ?? 72) },
    { name: 'media mirror', prefix: 'media/', maxHours: Number(env.MEDIA_MAX_AGE_HOURS ?? 0) },
  ].filter((rule) => rule.maxHours > 0);
  const results = [];
  for (const rule of rules) {
    const { newest, count } = await newestUnder(env.BACKUPS, rule.prefix);
    const ageHours = newest ? (now.getTime() - newest.uploaded.getTime()) / HOUR : null;
    results.push({
      name: rule.name,
      prefix: rule.prefix,
      count,
      newest: newest ? newest.key : null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      maxHours: rule.maxHours,
      ok: ageHours !== null && ageHours <= rule.maxHours,
    });
  }
  return results;
}

export function describe(results, bucketName) {
  const stale = results.filter((r) => !r.ok);
  const line = (r) => r.newest
    ? `${r.name}: newest ${r.ageHours} h old (limit ${r.maxHours} h), ${r.count} objects`
    : `${r.name}: NOTHING under ${r.prefix}`;
  if (stale.length) {
    return `⚠️ backups in R2 (${bucketName}) are stale\n${stale.map(line).join('\n')}\n\nWatched from Cloudflare, off Fly.`;
  }
  return `👀 backup watchdog: all fresh in ${bucketName}\n${results.map(line).join('\n')}`;
}

async function tell(env, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_OPS_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_OPS_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`telegram answered ${response.status}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const now = new Date(event.scheduledTime);
      const results = await check(env, now);
      const stale = results.some((r) => !r.ok);
      // Still watching: the first run of each Monday (UTC) says so.
      const weekly = now.getUTCDay() === 1 && now.getUTCHours() < 6;
      if (stale || weekly) await tell(env, describe(results, env.BUCKET_NAME));
    })());
  },

  // A hand check: GET with the watchdog key returns the verdict, sends nothing
  // unless ?notify=1. No key, no answer.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.WATCHDOG_KEY || request.headers.get('x-watchdog-key') !== env.WATCHDOG_KEY) {
      return new Response('not found', { status: 404 });
    }
    const results = await check(env);
    if (url.searchParams.get('notify') === '1') await tell(env, describe(results, env.BUCKET_NAME));
    return Response.json({ bucket: env.BUCKET_NAME, results });
  },
};
