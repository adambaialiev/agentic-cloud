/**
 * The words around a check that BOTH controllers must say the same way
 * (note #1161): our own dispatcher (daemon.mjs + lane-a.mjs) and an own
 * cloud's OrgCiService (backend/src/services/org-ci.ts). Pure functions, no
 * imports, no environment: the backend copies this file beside its dist at
 * build (backend/package.json) and loads it there; the dispatcher imports it
 * from lane-a.mjs (since note #1166), and its self-update installs it into
 * /opt/ia-ci beside lane-a.mjs (run-job.sh SELF_FILES). Keep it free of
 * imports: a new file it needed would have to reach the dispatcher first.
 * backend/src/test/unit/ci-verdicts.test.ts fails if lane-a.mjs carries a
 * copy again.
 */

const PUBLISH_SITE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A publish grant as the backend hands it out, or null when unusable. */
export function usablePublish(publish) {
  if (!publish || typeof publish !== 'object') return null;
  const { token, site, apiUrl } = publish;
  if (typeof token !== 'string' || !token || typeof site !== 'string' || !PUBLISH_SITE.test(site)) return null;
  if (typeof apiUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(apiUrl)) return null;
  return { token, site, apiUrl };
}

/**
 * The deploy/<site> verdict of a run that carried a publish key. Its own
 * check, so a failed publish is never mistaken for failed tests, and a
 * passing suite is never mistaken for a site that went live.
 *
 * outcome: { kind: 'reported', exitCode, publish?: { exitCode, logTail } }
 *        | { kind: 'cancelled' } | { kind: anything else } (timeout, lost)
 */
export function publishVerdict(outcome, site) {
  const words = (text) => text.slice(0, 140);
  if (outcome.kind === 'reported') {
    const step = outcome.publish;
    if (!step) {
      // The runner publishes only after ci.sh exits 0, so no step means the
      // checks did not pass (or never ran) — except a 0 with no step, which
      // is a runner that lost it.
      return outcome.exitCode === 0
        ? { state: 'error', description: words(`The checks passed but the publish step did not report — ${site} was not published`), logTail: '' }
        : { state: 'skipped', description: words(`Not published — the checks did not pass, so ${site} still serves the last approved change`), logTail: '' };
    }
    if (step.exitCode === 0) {
      return { state: 'success', description: words(`Published ${site}`), logTail: step.logTail };
    }
    if (step.exitCode === 78) {
      return { state: 'skipped', description: words('Not published — commit a .agentbuilt/deploy.sh to publish on approval'), logTail: step.logTail };
    }
    return {
      state: 'failure',
      description: words(`Publishing ${site} failed (exit ${step.exitCode}) — read this check's log`),
      logTail: step.logTail,
    };
  }
  if (outcome.kind === 'cancelled') {
    return { state: 'superseded', description: words('Not published — a newer approved change publishes instead'), logTail: '' };
  }
  return { state: 'error', description: words(`Not published — the job ended before it could publish ${site}`), logTail: '' };
}
