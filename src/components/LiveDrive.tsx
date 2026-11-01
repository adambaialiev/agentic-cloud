import type { DriveItem } from '../../backend/src/shared/drive';
import { DriveItems } from '../../backend/workspace-ui/src/screens/drive/DriveItems';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { HOUR, ORG, ago } from './live/fixture';

/**
 * Drive, live: the Drive screen's own list, over the files the fixture team
 * works from — the 2,000-stop sample Ruby benchmarked the optimiser on, the
 * tunnel recording her offline queue is tested against, the pilot contract
 * Milo read the billing terms from, and the folder the interviews went into.
 *
 * The list rather than the screen, and the reason is the prerender: the
 * screen reads its listing in an effect, which never runs on the build
 * machine, so mounted whole it shipped as an empty card until hydration.
 * `DriveItems` is the part of the screen that only draws, handed its rows.
 */
const ITEMS: DriveItem[] = ([
  { kind: 'folder', name: 'Dispatcher interviews', sizeBytes: 0 },
  { kind: 'file', name: 'monday-2000-stops.csv', sizeBytes: 3_250_585 },
  { kind: 'file', name: 'tunnel-gps-recording.csv', sizeBytes: 43_201_331 },
  { kind: 'file', name: 'pilot-contract-harbour-freight.pdf', sizeBytes: 1_258_291 },
] as const).map((item, index) => ({
  ...item,
  id: `drive_${index}`,
  parentId: null,
  contentType: '',
  createdAt: ago((index + 2) * HOUR),
  updatedAt: ago((index + 1) * HOUR),
}));

export default function LiveDrive({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="tile"
      className={className}
      says="Drive: a folder, Dispatcher interviews, then monday-2000-stops.csv, tunnel-gps-recording.csv and pilot-contract-harbour-freight.pdf, each with its size."
    >
      <LiveWorkspace>
        <DriveItems items={ITEMS} orgId={ORG.orgId} onManage={() => {}} empty="This folder is empty." />
      </LiveWorkspace>
    </LivePanel>
  );
}
