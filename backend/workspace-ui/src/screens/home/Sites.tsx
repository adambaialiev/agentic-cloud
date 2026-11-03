/**
 * Home's Sites card: what the agents have published, next to what they
 * build it from — the only screen where a live site can be seen at all.
 * Hidden on an account with none. A site's own icon is used only once it
 * has loaded once, so a poll never flips a row back to the globe.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceSiteRow } from '../../../../src/shared/workspace-api.js';
import { TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SITE_STATE, siteIsLive, sitesOf } from '../sites/site-words.js';
import { PressableRow } from './PressableRow.js';
import { RowFace } from '../../ui/FaceDoor.js';

const loadedSiteIcons = new Set<string>();

function SiteMark({ site }: { site: WorkspaceSiteRow }) {
  const live = siteIsLive(site);
  const iconUrl = live && site.iconUrl ? site.iconUrl : null;
  const [proven, setProven] = useState(() => Boolean(iconUrl && loadedSiteIcons.has(iconUrl)));
  const [failed, setFailed] = useState(false);
  const globe = <TypeIcon glyph="globe" tint={live ? 'dir' : ''} />;
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
export function SiteRow({ site }: { site: WorkspaceSiteRow }) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  const live = siteIsLive(site);
  const words = SITE_STATE[site.status];
  const when = site.lastDeployAt || site.createdAt;
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
      </div>
      {words ? <span className={`badge${words.warn ? ' warn' : ''}`}>{words.label}</span> : null}
      <div className="cside">{site.kind === 'service' ? 'app' : 'site'}</div>
    </PressableRow>
  );
}

/** `screen`: the Sites screen (note #960) — no heading and no footer
 *  explaining the list: the screen's title and its line under it say both. */
export function Sites({ screen = false }: { screen?: boolean } = {}) {
  const { state } = useWorkspace();
  const sites = sitesOf(state);
  if (screen) {
    return (
      <div className="card" id="sitesCard">
        <div id="sites">
          {sites.length === 0
            ? <div className="empty">No sites yet. Ask any agent to deploy one.</div>
            : sites.map((site) => <SiteRow key={site.name} site={site} />)}
        </div>
      </div>
    );
  }
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
