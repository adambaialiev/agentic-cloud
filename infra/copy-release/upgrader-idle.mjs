#!/usr/bin/env node
/**
 * Wait until the test copy's upgrader app holds no upgrade machine (note
 * #1061), so the gate's next step is not refused as "an upgrade is already
 * running" by the machine the step before it just finished on.
 *
 * The upgrader's machine is made with auto_destroy: when its run ends it
 * stops, and Fly removes it a little later. In between it is listed as
 * `stopped`, and the installer counts every machine not yet destroyed as an
 * upgrade under way, which is right for a person starting a second upgrade
 * by hand. On 7 Nov 2026 the gate's second drill started inside that gap and
 * was refused after 0 s, so 2026.11.07.0 was built and not offered.
 *
 * This waits up to --wait seconds (default 120) for the app to empty. A
 * machine still `stopped` after that has finished its run (the step before
 * returned), so it is destroyed. Anything started, starting or created is
 * left alone, and the wait fails: that IS an upgrade under way.
 *
 *   FLY_API_TOKEN=… node infra/copy-release/upgrader-idle.mjs <prefix> [--wait 120]
 */
import process from 'node:process';

const API = process.env.FLY_MACHINES_API || 'https://api.machines.dev/v1';

export async function upgraderIdle({ app, token, waitMs = 120_000, pollMs = 3_000, fetchImpl = fetch, log = console.log, now = Date.now, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  const call = async (method, path) => {
    const answer = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    if (method === 'GET' && answer.status === 404) return [];
    if (!answer.ok) throw new Error(`Fly ${method} ${path.split('?')[0]}: ${answer.status}`);
    const text = await answer.text();
    return text ? JSON.parse(text) : null;
  };
  const live = async () => ((await call('GET', `/apps/${app}/machines`)) ?? []).filter((machine) => machine.state !== 'destroyed');
  const until = now() + waitMs;
  let left = await live();
  while (left.length && now() < until) {
    await sleep(pollMs);
    left = await live();
  }
  if (!left.length) return { idle: true, destroyed: [] };
  const busy = left.filter((machine) => machine.state !== 'stopped');
  if (busy.length) {
    log(`   ${app} still has ${busy.map((m) => `${m.id} (${m.state})`).join(', ')}: an upgrade is under way.`);
    return { idle: false, destroyed: [] };
  }
  for (const machine of left) {
    await call('DELETE', `/apps/${app}/machines/${machine.id}?force=true`);
    log(`   ${app}: removed finished machine ${machine.id}, still listed as stopped after ${Math.round(waitMs / 1000)} s.`);
  }
  return { idle: true, destroyed: left.map((machine) => machine.id) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prefix = process.argv[2];
  const at = process.argv.indexOf('--wait');
  const waitMs = (at > 0 ? Number(process.argv[at + 1]) : 120) * 1000;
  const token = process.env.FLY_API_TOKEN ?? '';
  if (!prefix || !token || !Number.isFinite(waitMs)) {
    console.error('usage: FLY_API_TOKEN=… node upgrader-idle.mjs <prefix> [--wait seconds]');
    process.exit(2);
  }
  const result = await upgraderIdle({ app: `${prefix}-upgrader`, token, waitMs });
  process.exit(result.idle ? 0 : 1);
}
