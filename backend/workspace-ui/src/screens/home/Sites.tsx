/**
 * Home's Sites card: what the agents have published, next to what they
 * build it from — the only screen where a live site can be seen at all.
 * Hidden on an account with none. A site's own icon is used only once it
 * has loaded once, so a poll never flips a row back to the globe.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceSiteCost, WorkspaceSiteRow } from '../../../../src/shared/workspace-api.js';
import { TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SITE_STATE, alwaysOnWords, estimateFootnote, presetName, rowCost, siteIsLive, sitesOf, spareDisksLine } from '../sites/site-words.js';
import type { SiteCostsRead } from '../sites/site-costs.js';
import { PressableRow } from './PressableRow.js';
import { RowFace } from '../../ui/FaceDoor.js';

const loadedSiteIcons = new Set<string>();

function SiteMark({ site }: { site: WorkspaceSiteRow }) {
  const live = siteIsLive(site);
  const iconUrl = live && site.iconUrl ? site.iconUrl : null;
  const [proven, setProven] = useState(() => Boolean(iconUrl && loadedSiteIcons.has(iconUrl)));
  const [failed, setFailed] = useState(false);
  // Grey like the Workplace window's rows (Adam, 3 Nov 2026).
  const globe = <TypeIcon glyph="globe" />;
  if (!iconUrl || failed) return globe;
  return (
    <>
      {proven ? null : globe}
      <img
        className="favicon"
        alt=""
        src={iconUrl}
        hidden={!proven}
        onLoad={() => { loadedSiteIcons.add(iconUrl); setProven(true); }}
        onError={() => setFailed(true)}
      />
    </>
  );
}

/** One site as the card lists it. Its own component so a surface that shows a
 *  single site (the landing's moving row) draws the same row, not a copy. */
export function SiteRow({ site, costs }: {
  site: WorkspaceSiteRow;
  /** On the Sites screen (note #993): the row says its preset by name and its
   *  monthly estimate in place of the bare "site" / "app", and any spare
   *  disks its app holds. Elsewhere (the landing's illustrations) it does not. */
  costs?: SiteCostsRead;
}) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  const live = siteIsLive(site);
  const words = SITE_STATE[site.status];
  const when = site.lastDeployAt || site.createdAt;
  const cost: WorkspaceSiteCost | undefined = costs?.answer?.sites.find((entry) => entry.name === site.name);
  const spare = cost?.read ? cost.spareDisks ?? [] : [];
  return (
    <PressableRow className="crow open" onPress={() => navigate(toFor({ kind: 'site', id: site.name, orgId: org?.orgId })!)}>
      <SiteMark site={site} />
      <div className="main">
        <div className="name">{site.name}</div>
        <div className={`cline${live ? '' : ' wrap'}`}>
          {live
            ? (
              <>
                {/* The agent that deployed it, and the door onto
                    it (note #640) — a teammate's as readily as
                    one of the reader's own. */}
                {site.agentAvatarUrl
                  ? <RowFace agentId={site.agentId} avatarUrl={site.agentAvatarUrl} />
                  : null}
                {site.agentName ? <span className="ctext">{site.agentName}</span> : null}
                {when && relative(when) ? <span className="cwhen">{site.agentName ? ' · ' : ''}updated {relative(when)}</span> : null}
              </>
            )
            : <span className="ctext">{words ? words.line : 'Not serving right now.'}</span>}
        </div>
        {spare.length
          ? <div className="cline sitespare"><span className="ctext">{spareDisksLine(spare, costs?.answer?.hosted === true)}</span></div>
          : null}
      </div>
      {words ? <span className={`badge${words.warn ? ' warn' : ''}`}>{words.label}</span> : null}
      {costs
        ? (
          <div className="cside stack siteprice">
            <span className="sitepreset">{presetName(site.preset)}</span>
            <span className="sitecost">{rowCost(cost, costs.loading)}</span>
          </div>
        )
        : <div className="cside">{site.kind === 'service' ? 'app' : 'site'}</div>}
    </PressableRow>
  );
}

/** `screen`: the Sites screen (note #960) — no heading and no footer
 *  explaining the list: the screen's title and its line under it say both. */
export function Sites({ screen = false, costs }: { screen?: boolean; costs?: SiteCostsRead } = {}) {
  const { state } = useWorkspace();
  const sites = sitesOf(state);
  if (screen) return <SitesOnScreen sites={sites} costs={costs ?? { answer: null, failed: false, loading: true }} />;
  if (sites.length === 0) {
    return (
      <>
        <h2 className="homehead" id="sitesHead" hidden>Sites</h2>
        <div className="card" id="sitesCard" hidden />
      </>
    );
  }
  const withUrl = sites.find((s) => s.url);
  return (
    <>
      <h2 className="homehead" id="sitesHead">Sites</h2>
      <div className="card" id="sitesCard">
        <div id="sites">
          {sites.map((site) => <SiteRow key={site.name} site={site} />)}
          {withUrl ? <div className="quota">Each site is at its own name · {String(withUrl.url).replace(/^https?:\/\/[^.]+\./, '')}</div> : null}
        </div>
      </div>
    </>
  );
}

/**
 * The Sites screen's list (note #993): every row with its preset and its
 * estimate, the line that says sites never sleep — once, above the rows,
 * where an owner reads it — and the footnote that says what the figures are.
 * The hosted wording differs only in who pays; the figures are the same.
 */
function SitesOnScreen({ sites, costs }: { sites: WorkspaceSiteRow[]; costs: SiteCostsRead }) {
  // Who pays is in the answer; until it is in hand the line says only what
  // is true everywhere, so it never flips from one payer to the other.
  const always = alwaysOnWords(costs.answer ? costs.answer.hosted : null);
  return (
    <>
      {sites.length
        ? (
          <div className="sitesalways" id="sitesAlwaysOn">
            <strong>{always.lead}</strong> {always.rest}
          </div>
        )
        : null}
      <div className="card" id="sitesCard">
        <div id="sites">
          {sites.length === 0
            ? <div className="empty">No sites yet. Ask any agent to deploy one.</div>
            : sites.map((site) => <SiteRow key={site.name} site={site} costs={costs} />)}
          {sites.length && costs.answer
            ? <div className="quota" id="sitesEstimateNote">{estimateFootnote(costs.answer)}</div>
            : null}
          {sites.length && costs.failed
            ? <div className="quota" id="sitesEstimateNote">The costs could not be read just now.</div>
            : null}
        </div>
      </div>
    </>
  );
}
