import type { WorkspaceAppCatalogueEntry } from '../../backend/src/shared/workspace-api';
import { AppCard } from '../../backend/workspace-ui/src/screens/apps/AppsScreen';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HOUR, ago } from './live/fixture';
import track from '../assets/landing/apps/app-track.webp';
import bench from '../assets/landing/apps/app-bench.webp';
import docs from '../assets/landing/apps/app-docs.webp';

/**
 * The app catalogue (note #756), live: the catalogue's own `AppCard`, three
 * of Northstar's public apps as /apps lists them, newest first. The pictures
 * are 1280×800 renders of each app's first screen, the size the CLI takes
 * them at; the source pages are in Growth's ~/growth/catalogue/mock. On a
 * phone only the first two stand (`.landing-apps`), so the panel stays one
 * screen tall.
 */

const JAMES = { name: 'James', photoUrl: FACES.jamesPerson };

const APPS: WorkspaceAppCatalogueEntry[] = [
  {
    name: 'track',
    url: 'https://track.agents.northstar.com',
    line: 'Follow your delivery van live, with the minutes until it reaches your door.',
    builder: JAMES,
    pictureUrl: track,
    publishedAt: ago(3 * HOUR), createdAt: ago(4 * DAY),
  },
  {
    name: 'routing',
    url: 'https://routing.agents.northstar.com',
    line: 'A full day’s routes for 40 vans in 38 seconds: the benchmark, run live.',
    builder: JAMES,
    pictureUrl: bench,
    publishedAt: ago(1 * DAY), createdAt: ago(6 * DAY),
  },
  {
    name: 'northstar-docs',
    url: 'https://northstar-docs.agents.northstar.com',
    line: 'Plug your fleet into Northstar’s routing API, one call per day of stops.',
    builder: JAMES,
    pictureUrl: docs,
    publishedAt: ago(4 * DAY), createdAt: ago(8 * DAY),
  },
];

export default function LiveApps({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="wide"
      className={`landing-apps ${className}`}
      says="The app catalogue: three of Northstar's apps, each with its picture, its name, one line on what it does, who built it, and its link — a live van tracker, the routing benchmark and the API docs."
    >
      <LiveWorkspace>
        <div className="appgrid">
          {APPS.map((app) => <AppCard key={app.name} app={app} />)}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
