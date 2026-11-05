/**
 * One site (`/sites/:name?org=&room=`): where it answers, who deployed it
 * and who last changed what it serves, and the delete — behind typing its
 * name — with an agent's pending deletion request when there is one.
 * Painted from the state read; a site that leaves it sends the reader Home.
 *
 * Said ONCE each, and nothing explained that the page does not need (note
 * #575). The title already says what the site is and whether it is serving,
 * so the kind row is for a site that is not live, and one agent that both put
 * the site there and last deployed it is one row. No paragraphs: who can
 * reach a site (the whole workplace, note #566) is the rule for every site,
 * not a fact about this one, and what deleting costs is spelled out where it
 * is decided, in the type-the-name gate below.
 */

import { toFor } from '../../routes.js';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceSiteCost, WorkspaceSiteCostsAnswer, WorkspaceSiteRow } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { AskByTyping } from '../../ui/Ask.js';
import { errorMessage, openExternal } from '../../ui/format.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { askedOf } from '../../ui/ask-words.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SITE_STATE, alwaysOnWords, disksSize, estimateFootnote, machineShape, perMonth, presetName, siteIsLive, sitesOf } from './site-words.js';
import { useSiteCosts, type SiteCostsRead } from './site-costs.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { FaceDoor } from '../../ui/FaceDoor.js';

export function SiteScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const costs = useSiteCosts();
  const site: WorkspaceSiteRow | undefined = sitesOf(state).find((entry) => entry.name === id);
  const org = state?.org ?? null;
  const canManage = !org || org.role === 'admin';

  if (!site) {
    return (
      <div className="screen" id="screenSite">
        <ScreenTitle titleId="siteTitle" title={id} />
        <div className="card" id="siteCard"><div className="empty">{state ? 'This site is not on this account any more.' : 'Loading…'}</div></div>
      </div>
    );
  }

  const live = siteIsLive(site);
  const stateWords = SITE_STATE[site.status];
  const ask = site.deleteAsk;
  const when = site.lastDeployAt || site.createdAt;
  // The same agent usually both put the site there and deployed what it
  // serves now. Two rows for one hand is the page repeating itself, so the
  // second row is kept for the case it exists to answer: somebody else
  // changed what is live. `lastDeployedBy` carries the room in brackets.
  const lastHand = site.lastDeployedBy ? site.lastDeployedBy.replace(/\s*\([^()]*\)\s*$/, '') : '';
  const sameHand = !site.lastDeployedBy || (Boolean(site.agentName) && lastHand === site.agentName);
  // Published by CI on an approved change, as that agent: say which
  // repository, or "deployed it" reads as a hand that never touched it.
  const via = site.lastDeployVia ? ` · on approval in ${site.lastDeployVia}` : '';

  return (
    <div className="screen" id="screenSite">
      <ScreenTitle
        titleId="siteTitle"
        title={site.name}
        subId="siteSub"
        sub={live ? (site.kind === 'service' ? 'An app, running.' : 'A site, live.') : (stateWords ? stateWords.line : 'Not serving right now.')}
      />
      <div className="card" id="siteCard">
        {live
          ? (
            <button className="crow open" type="button" onClick={() => openExternal(site.url!)}>
              <TypeIcon glyph="globe" tint="dir" />
              <div className="main"><div className="name plain">{String(site.url).replace(/^https?:\/\//, '')}</div></div>
              <Icon name="chev" size={17} className="icon chev" />
            </button>
          )
          : null}
        {!live
          ? (
            <div className="crow" id="siteKind">
              <TypeIcon glyph={site.kind === 'service' ? 'box' : 'filetext'} />
              <div className="main">
                <div className="name plain">{site.kind === 'service' ? 'An always-on app' : 'A website'}</div>
              </div>
            </div>
          )
          : null}
        {site.agentName
          ? (
            <div className="crow">
              {site.agentAvatarUrl
                ? (
                  <span className="faces">
                    <FaceDoor agentId={site.agentId} agentName={site.agentName} avatarUrl={site.agentAvatarUrl} />
                  </span>
                )
                : <TypeIcon glyph="user" />}
              <div className="main">
                <div className="name plain">{site.agentName}</div>
                <div className="cline">{sameHand ? `Deployed it${when && relative(when) ? ` · updated ${relative(when)}` : ''}${via}` : 'Deployed it first'}</div>
              </div>
            </div>
          )
          : null}
        {site.lastDeployedBy && !sameHand
          ? (
            <div className="crow" id="siteLastDeploy">
              {/* Whoever's agent it was, its face and its door (2026-09-23) —
                  the same as the row above; the clock stands in only where
                  there is no picture to draw. */}
              {site.lastDeployer?.agentAvatarUrl
                ? (
                  <span className="faces">
                    <FaceDoor agentId={site.lastDeployer.agentId} agentName={site.lastDeployer.agentName} avatarUrl={site.lastDeployer.agentAvatarUrl} />
                  </span>
                )
                : <TypeIcon glyph="clock" />}
              <div className="main">
                <div className="name plain">{site.lastDeployedBy}</div>
                <div className="cline">Last deployed it{site.lastDeployAt && relative(site.lastDeployAt) ? ` · ${relative(site.lastDeployAt)}` : ''}{via}</div>
              </div>
            </div>
          )
          : null}
      </div>
      <SiteCostCard site={site} costs={costs} />
      {canManage || ask
        ? (
          <div id="siteDanger">
            {ask
              ? <div className="asked">{`${askedOf(ask)} to delete this site${ask.at && relative(ask.at) ? ` · ${relative(ask.at)}` : ''}`}</div>
              : null}
            <div className="site-danger-actions">
              {!ask || ask.canDecide !== false
                ? <button className="btn danger bare" type="button" disabled={busy} onClick={() => setAsking(true)}>{busy ? 'Deleting…' : 'Delete this site'}</button>
                : null}
              {ask && ask.canDecide !== false
                ? (
                  <button className="btn ghost bare" type="button" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      await api.api(`api/sites/${encodeURIComponent(site.name)}/keep`, { method: 'POST' });
                      banner.show(`Kept ${site.name} — the agent has been told.`, true);
                      await reload();
                    } catch (error) { banner.show(errorMessage(error)); }
                    setBusy(false);
                  }}>
                    Keep it
                  </button>
                )
                : null}
            </div>
            {/* Nothing under the button: what deleting costs is said where it
                is decided, in the gate below, and saying it twice was the
                complaint (note #575). The one line kept is the one that
                explains an absence — why there is no button to press. */}
            {ask && ask.canDecide === false
              ? <div className="hintblock">Only the owner of the agent that made this request can decide it. Destructive workplace actions also require that owner to be an admin.</div>
              : null}
          </div>
        )
        : null}
      {asking
        ? (
          <AskByTyping
            name={site.name}
            lines={[
              'It stops serving straight away, and the slot it was using goes back to your plan.',
              'The address stays yours — an agent can deploy to this name again, and nobody else can take it.',
              'What it is serving now is gone unless an agent deploys it again.',
            ]}
            verb="Delete"
            onAnswer={async (confirmed) => {
              setAsking(false);
              if (!confirmed) return;
              setBusy(true);
              try {
                await api.api(`api/sites/${encodeURIComponent(site.name)}`, { method: 'DELETE' });
                banner.show(`Deleted ${site.name} — the slot is back on your plan.`, true);
                navigate(toFor({ kind: 'sites', orgId: state?.org?.orgId })!, { replace: true });
                await reload().catch(() => {});
              } catch (error) { banner.show(errorMessage(error)); setBusy(false); }
            }}
          />
        )
        : null}
    </div>
  );
}

/**
 * What this site is and what it costs, in full (note #993): its preset, the
 * machine's shape as Fly reports it, every disk — spare ones called out,
 * because they bill and nothing else shows them — and the estimate, said to
 * be one. Never a guessed figure: a machine that cannot be read says so.
 */
function SiteCostCard({ site, costs }: { site: WorkspaceSiteRow; costs: SiteCostsRead }) {
  const cost: WorkspaceSiteCost | undefined = costs.answer?.sites.find((entry) => entry.name === site.name);
  const answer: WorkspaceSiteCostsAnswer | null = costs.answer;
  const hosted = answer ? answer.hosted : null;
  const always = alwaysOnWords(hosted);
  const preset = presetName(site.preset);
  const machine = cost?.read ? cost.machine : undefined;
  const disks = cost?.read ? cost.disks ?? [] : [];
  const spare = cost?.read ? cost.spareDisks ?? [] : [];
  const spareUsd = spare.reduce((sum, disk) => sum + disk.monthlyUsd, 0);
  const mountedUsd = disks.reduce((sum, disk) => sum + disk.monthlyUsd, 0);
  const unread = !cost
    ? (costs.loading ? 'Reading its machine…' : 'Its machine could not be read just now, so there is no estimate.')
    : !cost.read
      ? (cost.reason === 'no-machine' ? 'It has no machine right now, so there is no estimate.' : 'Its machine could not be read just now, so there is no estimate.')
      : null;
  return (
    <>
      <h2 className="indexhead" id="siteCostHead">Running it</h2>
      <div className="card" id="siteCost">
        <div className="crow" id="sitePreset">
          <TypeIcon glyph="box" />
          <div className="main">
            <div className="name plain">{preset}</div>
            <div className="cline wrap">
              <span className="ctext">
                {machine
                  ? `${machineShape(machine)} · ${machine.running ? 'always on, never sleeps' : 'stopped: only its disks bill'}`
                  : cost?.built === false ? 'Nothing built yet, so it costs nothing.' : 'Always on, never sleeps'}
              </span>
            </div>
          </div>
          {machine ? <div className="cside">{perMonth(machine.monthlyUsd)}</div> : null}
        </div>
        {disks.length
          ? (
            <div className="crow" id="siteDisk">
              <TypeIcon glyph="database" />
              <div className="main">
                <div className="name plain">{`Disk · ${disksSize(disks)}`}</div>
                <div className="cline"><span className="ctext">Mounted by its machine</span></div>
              </div>
              <div className="cside">{perMonth(mountedUsd)}</div>
            </div>
          )
          : null}
        {spare.length
          ? (
            <div className="crow" id="siteSpareDisks">
              <TypeIcon glyph="database" />
              <div className="main">
                <div className="name plain">{`${spare.length} spare disk${spare.length === 1 ? '' : 's'} · ${disksSize(spare)}`}</div>
                <div className="cline wrap"><span className="ctext">No machine mounts {spare.length === 1 ? 'it' : 'them'}, and {spare.length === 1 ? 'it' : 'they'} {hosted ? (spare.length === 1 ? 'costs' : 'cost') : (spare.length === 1 ? 'is billed' : 'are billed')} all the same</span></div>
              </div>
              <div className="cside">{perMonth(spareUsd)}</div>
            </div>
          )
          : null}
        {cost?.read && cost.built !== false
          ? (
            <div className="crow" id="siteEstimate">
              <TypeIcon glyph="card" />
              <div className="main">
                <div className="name plain">{`Estimate · ${perMonth(cost.monthlyUsd ?? 0)}`}</div>
                <div className="cline wrap">
                  <span className="ctext">
                    {hosted ? 'Machine plus disks, paid by Agentic Cloud: not billed to you' : 'Machine plus disks, on your cloud bill'}
                    {machine && !machine.running && machine.runningMonthlyUsd ? ` · ${perMonth(machine.runningMonthlyUsd + (cost.disksMonthlyUsd ?? 0))} once it runs again` : ''}
                  </span>
                </div>
              </div>
            </div>
          )
          : null}
        {unread && cost?.built !== false
          ? <div className="crow" id="siteEstimate"><TypeIcon glyph="card" /><div className="main"><div className="cline wrap"><span className="ctext">{unread}</span></div></div></div>
          : null}
        <div className="quota" id="siteAlwaysOn">
          <strong>{always.lead}</strong> {always.rest}{answer ? ` ${estimateFootnote(answer)}` : ''}
        </div>
      </div>
    </>
  );
}
