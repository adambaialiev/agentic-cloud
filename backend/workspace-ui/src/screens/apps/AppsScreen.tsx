/**
 * The app catalogue — `agenticcloudcomputer.com/apps` (note #756, the
 * owner, 2026-10-15): every site deployed on the platform that is serving
 * and listed, newest first. One card each: the picture, the name, one line
 * on what it does, who built it, and the link. Creation and distribution in
 * one place — a builder's app is found here the moment it is deployed,
 * because the agent that deploys it writes the listing.
 *
 * A public door like a person's page: it stands before the session gate and
 * wears the public chrome, so a stranger reads it without an account.
 * Signed in, it is a Workspace screen under the Workspace's own header with
 * Back. Categories and usage signals wait until the catalogue is big enough
 * to need them (the owner, 2026-10-15).
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { WorkspaceAppCatalogueAnswer, WorkspaceAppCatalogueEntry } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { relative } from '../../ui/time.js';
import { PublicHead } from '../repos/PublicRepoScreen.js';

/** `ember-coffee.agentbuilt.app`, without the scheme — what the card prints under the name. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The maker's name — a door to their public page when they have one. */
function Builder({ builder }: { builder: WorkspaceAppCatalogueEntry['builder'] }) {
  const inner = <><PersonFace photoUrl={builder.photoUrl} /><span className="appwho">{builder.name}</span></>;
  const to = builder.handle ? toFor({ kind: 'person', handle: builder.handle }) : null;
  return to
    ? <Link className="appbuilder" to={to}>{inner}</Link>
    : <span className="appbuilder">{inner}</span>;
}

export function AppCard({ app }: { app: WorkspaceAppCatalogueEntry }) {
  const [broken, setBroken] = useState(false);
  const updated = relative(app.publishedAt);
  return (
    <article className="appcard" data-app={app.name}>
      <a className="appshot" href={app.url} target="_blank" rel="noopener">
        {app.pictureUrl && !broken
          ? <img src={app.pictureUrl} alt={`${app.name}, as it looks`} loading="lazy" onError={() => setBroken(true)} />
          : <span className="appnoshot" aria-hidden="true">{app.name}</span>}
      </a>
      <div className="appwords">
        <h2><a href={app.url} target="_blank" rel="noopener">{app.name}</a></h2>
        {/* When it last changed (the owner, 2026-10-18): a catalogue of
            living apps, so the card says how fresh this one is. */}
        {updated ? <p className="appwhen">Updated {updated}</p> : null}
        <p className="appline">{app.line}</p>
        <div className="appfoot">
          <Builder builder={app.builder} />
          <a className="applink" href={app.url} target="_blank" rel="noopener">{hostOf(app.url)}<span className="arrow" aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>
  );
}

export function AppsScreen() {
  const { api, state } = useSession();
  const [answer, setAnswer] = useState<WorkspaceAppCatalogueAnswer | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void api.api<WorkspaceAppCatalogueAnswer>('api/public/apps')
      .then((next) => { if (current) { setError(''); setAnswer(next); } })
      .catch((caught: unknown) => { if (current) { setAnswer(null); setError(errorMessage(caught)); } });
    return () => { current = false; };
  }, [api]);

  useEffect(() => { document.title = 'Apps — Agentic Cloud Computer'; }, []);

  const count = answer?.apps.length ?? 0;
  return (
    <div id="screenApps" className="screen apps">
      {/* A visitor's header; signed in, the Workspace's own stands over the
          page instead, with Back — as a person's page does. */}
      {state.status === 'signed-in' ? null : <PublicHead />}
      <div className="appstop">
        <h1 id="appsTitle">Apps</h1>
        <p className="sub" id="appsSub">
          {answer
            ? `Built and launched here, newest first${count ? ` · ${count === 1 ? '1 app' : `${count} apps`}` : ''}`
            : 'Built and launched here, newest first'}
        </p>
      </div>
      {error ? (
        <div className="public-repo-error" id="appsError">
          <h1>The catalogue is unavailable</h1>
          <p>{error}</p>
        </div>
      ) : null}
      {!answer && !error ? <div className="public-repo-loading" aria-label="Loading"><span className="skel line" /><span className="skel line two" /></div> : null}
      {answer ? (
        count === 0
          ? <div className="card appsempty" id="appsEmpty">Nothing is listed yet. The first app deployed here appears at the top.</div>
          : (
            <div className="appgrid" id="appsGrid">
              {answer.apps.map((app) => <AppCard key={app.name} app={app} />)}
            </div>
          )
      ) : null}
    </div>
  );
}
