/**
 * The Chief of Staff on its own (note #716): event turns and standing
 * permissions, on its details in the Workplace window.
 *
 * One switch says whether it starts by itself when something needs the
 * person; under it, while it is on, the three waits that make an event and
 * the quiet hours. The second card is the person's standing permissions —
 * what it may do in such a turn without asking — and the third lists its
 * newest event turns, quiet ones included, so the person can see what it
 * noticed and what came of it. Everything here is the person's own; nothing
 * on it is a teammate's.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  EVENT_THRESHOLD_CHOICES,
  WORKSPACE_AGENT_PERMISSIONS,
  WORKSPACE_AGENT_PERMISSION_WORDS,
  type WorkspaceAgentEventTurnSummary,
  type WorkspaceAgentPermission,
  type WorkspaceAgentProactive,
  type WorkspaceAgentProactiveAnswer,
} from '../../../../src/shared/workspace-agent-proactive.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';

/** The reader's own time zone, sent with every save so quiet hours mean their night. */
function browserZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

function hoursWords(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`;
}
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

function quietWords(settings: Pick<WorkspaceAgentProactive, 'quietFrom' | 'quietTo'>): string {
  return settings.quietFrom === settings.quietTo ? 'no quiet hours' : `quiet ${clock(settings.quietFrom)}–${clock(settings.quietTo)}`;
}

function outcomeWords(turn: WorkspaceAgentEventTurnSummary): string {
  switch (turn.outcome) {
    case 'told': return 'Told you in its chat';
    case 'quiet': return turn.summary ? `Kept quiet: ${turn.summary}` : 'Kept quiet';
    case 'failed': return 'Could not run';
    default: return 'Looking into it now';
  }
}

function SwitchRow({ id, title, meta, on, busy, onToggle }: { id: string; title: string; meta: string; on: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button className="row open" id={id} type="button" role="switch" aria-checked={on} disabled={busy} onClick={onToggle}>
      <div className="main">
        <div className="name plain">{title}</div>
        <div className="meta">{meta}</div>
      </div>
      <span className={`lbswitch${on ? ' on' : ''}`} aria-hidden="true"><span /></span>
    </button>
  );
}

function ChoiceRow({ id, label, value, choices, words, busy, onChoose }: {
  id: string; label: string; value: number; choices: readonly number[]; words: (value: number) => string; busy: boolean; onChoose: (value: number) => void;
}) {
  return (
    <label className="row proactivechoice" htmlFor={id}>
      <div className="main"><div className="name plain">{label}</div></div>
      <select id={id} value={value} disabled={busy} onChange={(event) => onChoose(Number(event.target.value))}>
        {choices.map((choice) => <option key={choice} value={choice}>{words(choice)}</option>)}
      </select>
    </label>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function ProactiveCards({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const banner = useBanner();
  const [answer, setAnswer] = useState<WorkspaceAgentProactiveAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      setAnswer(await api.api<WorkspaceAgentProactiveAnswer>('api/recap/agent/proactive', undefined, { org: orgId }));
    } catch {
      // The section simply does not draw: nothing here is worth a failed read on screen.
    }
  }, [api, orgId]);
  useEffect(() => { void read(); }, [read]);

  const save = async (change: Partial<Omit<WorkspaceAgentProactive, 'thresholds' | 'permissions'>> & {
    thresholds?: Partial<WorkspaceAgentProactive['thresholds']>;
    permissions?: Partial<Record<WorkspaceAgentPermission, boolean>>;
  }, said?: (next: WorkspaceAgentProactive) => string) => {
    setBusy(true);
    try {
      const zone = browserZone();
      const written = await api.api<WorkspaceAgentProactiveAnswer>(
        'api/recap/agent/proactive',
        jsonBody({ ...change, ...(zone ? { timeZone: zone } : {}) }, 'PUT'),
        { org: orgId },
      );
      setAnswer(written);
      if (said) banner.show(said(written.settings), true);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!answer) return null;
  const { settings, recent } = answer;
  return (
    <>
      <h2 id="recapProactiveHead">On its own</h2>
      <div className="card" id="recapProactiveCard">
        <SwitchRow
          id="recapEventTurns"
          title="Start by itself when something needs you"
          meta={!settings.events ? 'Off · it runs only when you write or an agent answers it'
            : settings.quietFrom === settings.quietTo ? 'On · at any hour' : `On · ${quietWords(settings)}, except red checks and failed turns`}
          on={settings.events}
          busy={busy}
          onToggle={() => { void save({ events: !settings.events }, (next) => next.events ? 'Chief of Staff will start by itself when something needs you.' : 'Chief of Staff runs only when you write again.'); }}
        />
        {settings.events ? (
          <>
            <ChoiceRow id="recapWaitProposal" label="A proposal waits for you" value={settings.thresholds.proposalHours} choices={EVENT_THRESHOLD_CHOICES} words={hoursWords} busy={busy} onChoose={(proposalHours) => { void save({ thresholds: { proposalHours } }); }} />
            <ChoiceRow id="recapWaitReport" label="A report goes unanswered" value={settings.thresholds.reportHours} choices={EVENT_THRESHOLD_CHOICES} words={hoursWords} busy={busy} onChoose={(reportHours) => { void save({ thresholds: { reportHours } }); }} />
            <ChoiceRow id="recapWaitNote" label="A note stays unclaimed" value={settings.thresholds.noteHours} choices={EVENT_THRESHOLD_CHOICES} words={hoursWords} busy={busy} onChoose={(noteHours) => { void save({ thresholds: { noteHours } }); }} />
            <ChoiceRow id="recapQuietFrom" label="Quiet from" value={settings.quietFrom} choices={HOURS} words={clock} busy={busy} onChoose={(quietFrom) => { void save({ quietFrom }); }} />
            <ChoiceRow id="recapQuietTo" label="Quiet until" value={settings.quietTo} choices={HOURS} words={clock} busy={busy} onChoose={(quietTo) => { void save({ quietTo }); }} />
          </>
        ) : null}
      </div>
      <div className="hintblock" id="recapProactiveHint">
        {settings.events
          ? `It also starts when checks go red, a turn fails, an agent it waited for goes silent, or a letter arrives. Each cause wakes it at most once a day, and it writes to you here only when something needs you. Times are ${settings.timeZone.replace(/_/g, ' ')}.`
          : 'When on, it notices red checks, proposals waiting for you, reports nobody answered, unclaimed notes, failed turns and new letters — and tells you only when something needs you.'}
      </div>
      {settings.events ? (
        <>
          <h2 id="recapPermissionsHead">Without asking, it may</h2>
          <div className="card" id="recapPermissionsCard">
            {WORKSPACE_AGENT_PERMISSIONS.map((permission) => (
              <SwitchRow
                key={permission}
                id={`recapPermission-${permission}`}
                title={WORKSPACE_AGENT_PERMISSION_WORDS[permission].title}
                meta={WORKSPACE_AGENT_PERMISSION_WORDS[permission].detail}
                on={settings.permissions[permission]}
                busy={busy}
                onToggle={() => { void save({ permissions: { [permission]: !settings.permissions[permission] } }); }}
              />
            ))}
          </div>
          <div className="hintblock" id="recapPermissionsHint">
            Only in a turn it started by itself — anything else it would do waits for you. Each use shows in its chat as “On its own: …”.
          </div>
        </>
      ) : null}
      {recent.length ? (
        <>
          <h2 id="recapNoticedHead">Noticed lately</h2>
          <div className="card" id="recapNoticedCard">
            {recent.map((turn) => (
              <div className="row proactivenoticed" key={turn.at}>
                <div className="main">
                  <div className="name plain">{turn.noticed[0]}{turn.noticed.length > 1 ? ` (+${turn.noticed.length - 1} more)` : ''}</div>
                  <div className="meta">{relative(turn.at)} · {outcomeWords(turn)}{turn.actions ? ` · ${turn.actions} action${turn.actions === 1 ? '' : 's'}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
