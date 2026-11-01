// What each channel actually produced.
//
// The backend has recorded first-touch and last-touch attribution on every
// profile since it was written, and nothing has ever read it back — there is
// no admin surface, so the numbers exist only inside the database. That makes
// a campaign unfalsifiable: you can spend a week on a launch and have no way
// to say whether it worked. This is the read side.
//
// Run it where the database is (ia-backend):
//   node scripts/attribution-report.mjs [--db /var/lib/infinite-agents/backend.db]
//
// Read-only, and it selects only the attribution, agent and billing fields —
// never the whole doc, which holds tokens.

import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB = '/var/lib/infinite-agents/backend.db';

const dbPath = (() => {
  const flag = process.argv.indexOf('--db');
  return flag !== -1 ? process.argv[flag + 1] : DEFAULT_DB;
})();

const db = new DatabaseSync(dbPath, { readOnly: true });

// One row per user: where they came from, whether they got as far as creating
// an agent, and whether they pay. json_extract rather than a doc dump so no
// credential is ever pulled into the process.
const rows = db.prepare(`
  SELECT
    json_extract(doc, '$.telegram.attribution.firstTouch.utmSource')   AS source,
    json_extract(doc, '$.telegram.attribution.firstTouch.utmCampaign') AS campaign,
    json_extract(doc, '$.telegram.attribution.firstTouch.utmContent')  AS placement,
    json_extract(doc, '$.telegram.attribution.firstTouch.ref')         AS ref,
    json_extract(doc, '$.telegram.attribution.lastTouch.utmSource')    AS lastSource,
    json_extract(doc, '$.billing.status')                              AS billingStatus,
    (
      SELECT count(*) FROM json_each(json_extract(doc, '$.telegram.agents'))
    ) AS agentCount
  FROM users
`).all();

const PAYING = new Set(['active', 'trialing', 'past_due']);

function tally(keyOf) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row) ?? '(none)';
    const bucket = buckets.get(key) ?? { arrived: 0, activated: 0, paid: 0 };
    bucket.arrived += 1;
    if ((row.agentCount ?? 0) > 0) bucket.activated += 1;
    if (PAYING.has(String(row.billingStatus))) bucket.paid += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].sort((a, b) => b[1].arrived - a[1].arrived);
}

function print(title, buckets) {
  console.log(`\n${title}`);
  console.log('  ' + 'KEY'.padEnd(24) + 'ARRIVED'.padStart(8) + 'ACTIVATED'.padStart(11) + 'PAID'.padStart(6));
  for (const [key, bucket] of buckets) {
    console.log(
      '  '
      + String(key).slice(0, 23).padEnd(24)
      + String(bucket.arrived).padStart(8)
      + String(bucket.activated).padStart(11)
      + String(bucket.paid).padStart(6),
    );
  }
}

const activated = rows.filter((row) => (row.agentCount ?? 0) > 0).length;
const attributed = rows.filter((row) => row.source).length;

console.log(`Attribution — ${rows.length} users, ${activated} with an agent, ${attributed} attributed`);

if (attributed === 0) {
  // The state this script was written in. Worth saying plainly rather than
  // printing an empty table that reads like "no traffic".
  console.log(
    '\nNo user carries a campaign yet. Either no tracked link has been used,\n'
    + 'or the CTAs are still bare t.me links — check that the deployed site\n'
    + 'renders hrefs with ?start=utm_… before concluding a channel failed.',
  );
}

print('By first-touch source (which channel earned the signup)', tally((row) => row.source));
print('By campaign', tally((row) => row.campaign));
print('By placement (which button closed it)', tally((row) => row.placement));

const referred = rows.filter((row) => row.ref);
if (referred.length > 0) {
  // Only the users who were actually referred: a "(none)" row here would be
  // everyone else, which says nothing about the referral programme.
  print('By referrer', tally((row) => row.ref).filter(([key]) => key !== '(none)'));
}

// First touch is the credit; last touch says what brought them back. They
// differ only for people who arrived more than once, which is worth knowing.
const returned = rows.filter((row) => row.source && row.lastSource && row.source !== row.lastSource);
if (returned.length > 0) {
  console.log(`\n${returned.length} user(s) first found us via one channel and came back through another.`);
}

db.close();
