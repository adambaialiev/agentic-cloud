import { useState } from 'react';
import type { WorkspaceNoteRow } from '../../backend/src/shared/workspace-api';
import { Notes } from '../../backend/workspace-ui/src/screens/home/Notes';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HOUR, MINUTE, ago } from './live/fixture';

/**
 * Home's notes, live: the app's own `Notes` section, whole. Seven notes fill
 * the glimpse while moving through the states a note passes through — written
 * and waiting, being worked by an agent, turned into a proposal, and landed
 * and live. Every visible row carries the real face of its human or agent
 * author. The times are offsets from now, so the prerendered words and the
 * client's agree.
 */
export default function LiveNotes({ className = '' }: { className?: string }) {
  const [notes] = useState<WorkspaceNoteRow[]>(() => [
    {
      id: 'note_57',
      number: 57,
      title: 'Batch route optimiser for the routing service',
      preview: 'Take a whole day’s stops and the vans on shift, and return every van’s route in one call.',
      createdAt: ago(30 * MINUTE),
      updatedAt: ago(9 * MINUTE),
      byUser: true,
      authorName: 'James',
      authorPhotoUrl: FACES.jamesPerson,
      work: { state: 'unclaimed' },
      comments: 1,
    },
    {
      id: 'note_59',
      number: 59,
      title: 'Weekly kilometres report per depot',
      preview: 'One PDF per depot every Monday, out of the pipeline.',
      createdAt: ago(12 * MINUTE),
      updatedAt: ago(12 * MINUTE),
      byUser: true,
      authorName: 'James',
      authorPhotoUrl: FACES.jamesPerson,
      work: { state: 'unclaimed' },
    },
    {
      id: 'note_58',
      number: 58,
      title: 'Driver app must work with no signal',
      preview: 'Queue the GPS pings offline and sync when the phone is back.',
      createdAt: ago(40 * MINUTE),
      updatedAt: ago(25 * MINUTE),
      byUser: true,
      authorName: 'James',
      authorPhotoUrl: FACES.jamesPerson,
      work: { state: 'working', agentName: 'Ruby', agentId: 'agent_ruby' },
      comments: 2,
    },
    {
      id: 'note_56',
      number: 56,
      title: 'Usage-based invoicing',
      preview: 'Per stop completed, not a flat fee. Stripe has the meters.',
      createdAt: ago(3 * HOUR),
      updatedAt: ago(2 * HOUR),
      byUser: true,
      authorName: 'James',
      authorPhotoUrl: FACES.jamesPerson,
      work: { state: 'proposal', proposalNumber: 44, proposalStatus: 'open' },
    },
    {
      id: 'note_55',
      number: 55,
      title: 'Launch checklist for Friday’s pilot',
      preview: 'Load test at five times traffic, alerts and the rollback rehearsal are done.',
      createdAt: ago(8 * HOUR),
      updatedAt: ago(5 * HOUR),
      agentName: 'Milo',
      agentId: 'agent_milo',
      agentAvatarUrl: FACES.milo,
      userName: 'James',
      work: { state: 'merged', proposalNumber: 40 },
    },
    {
      id: 'note_54',
      number: 54,
      title: 'Pings table partitioned by month',
      preview: 'Runbook written; last week’s queries are 40 times faster.',
      createdAt: ago(2 * DAY),
      updatedAt: ago(1 * DAY),
      agentName: 'Otis',
      agentId: 'agent_otis',
      agentAvatarUrl: FACES.otis,
      userName: 'James',
      work: { state: 'live', proposalNumber: 39 },
    },
    {
      id: 'note_53',
      number: 53,
      title: 'Quotes for the pilot deck',
      preview: 'Use the shorter quote from the Harbour Freight interview.',
      createdAt: ago(3 * DAY),
      updatedAt: ago(2 * DAY),
      byUser: true,
      authorName: 'James',
      authorPhotoUrl: FACES.jamesPerson,
      work: { state: 'unclaimed' },
    },
  ]);
  return (
    <LivePanel
      size="tile"
      className={className}
      says="Notes: seven shared notes filling the card, with human and agent faces; three are waiting, one is being worked by Ruby, one became proposal #44, and others have merged or gone live."
    >
      <LiveWorkspace notes={notes}>
        <Notes onWrite={() => {}} />
      </LiveWorkspace>
    </LivePanel>
  );
}
