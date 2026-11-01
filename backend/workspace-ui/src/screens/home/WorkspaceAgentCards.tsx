/**
 * What is true of the Workspace Agent itself, as cards (note #439): its
 * state, its machine, its reach, what it runs on with the two update
 * buttons, and its context window with the explicit reset ask. Since
 * 2026-10-10 these stand at the foot of the overview's Workplace half, under
 * the agent's own header, rather than on a screen of their own: the
 * conversation is Home, the overview is the agent's details, and the
 * workplace's halves are what that screen is for.
 *
 * `useWorkspaceAgentDetails` is the read behind them and behind the header's
 * runtime line, so the two can never disagree about what the agent thinks
 * with. It polls only while a request is running, as the old screen did:
 * context is measured at the end of a turn, and without the last read the
 * screen would stay one turn behind.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RecapChatAnswer } from '../../../../src/shared/workspace-recap-chat.js';
import type { WorkspaceAgentVersionAnswer } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { useBanner } from '../../chrome/useBanner.js';
import { jsonBody } from '../../api/client.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { ContextUsageRow } from '../../ui/ContextUsageRow.js';
import { contextPercent } from '../../ui/context-heat.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { heldWorkspaceAgent, holdWorkspaceAgent } from '../agent/agent-cache.js';
import type { WorkspaceAgentDetails } from './workspace-agent-details.js';
import { machineSizeParts } from '../agent/machine-words.js';
import { MachinePicker } from '../agent/MachinePicker.js';
import { cliNote, cliRidesImage, docsNote, imageNote } from '../agent/agent-facts.js';
import { BusyLockButton, CardRow } from '../agent/VersionRows.js';
import { agentStateLine } from './agent-words.js';
import { ProactiveCards } from './ProactiveCards.js';

/** One fact, in the shape the agent's own screen uses for the same job. */
function Fact({ label, value, note, onPress }: { label: string; value: string; note?: string; onPress?: () => void }) {
  return (
    <div className="drow">
      <div className="k">{label}</div>
      {onPress
        ? <button className="v person act machinevalue" type="button" onClick={onPress}><span>{value}</span></button>
        : <div className="v">{value}</div>}
      {note ? <div className="v dim">{note}</div> : null}
    </div>
  );
}

// The door onto the agent's own room's notes (note #487) stood among these
// cards until rooms left the product (note #843): its notes are the
// workplace's, in the Workplace window's Notes.

export function WorkspaceAgentCards({ orgId, details }: { orgId: string; details: WorkspaceAgentDetails }) {
  const { api } = useSession();
  const banner = useBanner();
  const { data, error, read, resetAsked, setResetAsked, setData } = details;
  const [held] = useState(() => heldWorkspaceAgent(orgId));
  const [machinePicking, setMachinePicking] = useState(false);
  const [version, setVersion] = useState<WorkspaceAgentVersionAnswer | null>(held.version ?? null);
  const [asking, setAsking] = useState(false);
  const [updating, setUpdating] = useState<'cli' | 'machine' | null>(null);

  // The version card is the room agent's own read, keyed by the record id
  // the details read hands over once a first request has reserved one. It is
  // read on arrival and after an update, never polled: nothing on it moves by
  // itself while the screen is open.
  const agentId = data?.agentId;
  const readVersion = useCallback(async () => {
    if (!agentId) return;
    try {
      const next = await api.api<WorkspaceAgentVersionAnswer>(`api/agents/${encodeURIComponent(agentId)}/version`, undefined, { org: orgId });
      holdWorkspaceAgent(orgId, { version: next });
      setVersion(next);
    } catch {
      // A failed refresh leaves the rows that were true a moment ago.
    }
  }, [api, agentId, orgId]);
  useEffect(() => { void readVersion(); }, [readVersion]);
  const startUpdate = async (which: 'cli' | 'machine') => {
    if (!agentId) return;
    setUpdating(which);
    try {
      await api.api(`api/agents/${encodeURIComponent(agentId)}/${which === 'cli' ? 'update-cli' : 'update-machine'}`, { method: 'POST' }, { org: orgId });
      banner.show('Updated — all set.', true);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      await readVersion();
      setUpdating(null);
    }
  };

  const state = agentStateLine(data?.agent);
  const machine = data?.machine ? machineSizeParts(data.machine).join(' · ') : '';
  const active = data?.agent.lastActiveAt ? relative(data.agent.lastActiveAt) : '';

  // The same explicit reset as a room agent's details screen: ask through
  // the conversation so the agent can preserve durable notes first, then its
  // own `agentbuilt chat new` clears the native session and context reading.
  const askReset = async () => {
    setResetAsked(true);
    try {
      const answer = await api.api<RecapChatAnswer>(
        'api/recap/chat',
        jsonBody({ clientId: crypto.randomUUID(), text: 'reset chat' }),
        { org: orgId },
      );
      setData((current) => current ? { ...current, agent: { ...current.agent, working: answer.working } } : current);
      banner.show('Chief of Staff will reset its chat — the answer lands in its chat.', true);
    } catch (error) {
      setResetAsked(false);
      banner.show(errorMessage(error));
    }
  };

  if (machinePicking && data?.agentId) {
    return (
      <MachinePicker
        agent={{ id: data.agentId, name: data.agent.name }}
        busy={data.agent.working}
        orgId={orgId}
        onClose={() => setMachinePicking(false)}
        onWritten={() => { void read(); }}
      />
    );
  }
  return (
    <section id="recapAgentSection">
      <h2 className="homehead" id="recapAgentHead">About this agent</h2>
      {/* What it IS, in the words the person would use about it — this is the
          one agent whose job is not visible from a repository. */}
      <div className="hintblock" id="recapAgentAbout">
        Your own agent across this whole workplace, and the one you talk to on
        Home. It has a durable machine, can work with files and code, use the
        web, run services — and it brings agents in, hands work out and
        follows it up for you.
      </div>
      <div className="card" id="recapAgentFacts">
        <Fact label="State" value={state.text} />
        {active ? <Fact label="Last request" value={active} /> : null}
        {machine
          ? <Fact label="Machine" value={machine} note="It sleeps when nothing is running and wakes on your next message." onPress={data?.agentId ? () => setMachinePicking(true) : undefined} />
          : <Fact label="Machine" value="Not reserved yet" note="Its machine is built the first time you send it a message." />}
        <Fact
          label="Reach"
          value="This whole workplace"
          note="Private to you: nobody else in the workplace sees this conversation."
        />
      </div>
      <ProactiveCards orgId={orgId} />
      {version
        ? (
          <div className="card" id="recapAgentVersion">
            <CardRow glyph="terminal" title={version.cliLabel} meta={cliNote(version)} />
            {version.cliUpdateAvailable && !cliRidesImage(version)
              ? <BusyLockButton label={`Update ${version.cliLabel}`} busy={Boolean(data?.agent.working) || updating !== null} running={updating === 'cli'} onPress={() => { void startUpdate('cli'); }} />
              : null}
            {version.image
              ? (
                <>
                  <CardRow glyph="drive" title="Machine software" meta={imageNote(version.image)} />
                  {version.image.canUpdate
                    ? <BusyLockButton label="Update machine software" busy={Boolean(data?.agent.working) || updating !== null} running={updating === 'machine'} onPress={() => setAsking(true)} />
                    : null}
                </>
              )
              : null}
            <CardRow glyph="filetext" title={version.docs.file} meta={docsNote(version.docs)} />
            <div className="hintblock busyhint" hidden={!data?.agent.working}>
              Chief of Staff is busy with a request right now — updates unlock when it finishes.
            </div>
          </div>
        )
        : null}
      {data?.agent.context
        ? (
          <div className="card" id="recapAgentContext">
            <ContextUsageRow context={data.agent.context} busy={data.agent.working} />
            {contextPercent(data.agent.context) ? (
              <button
                className="addrow busylock contextreset"
                type="button"
                disabled={data.agent.working || resetAsked}
                style={data.agent.working || resetAsked ? { opacity: '.55' } : undefined}
                data-running={resetAsked ? '1' : undefined}
                onClick={() => { void askReset(); }}
              >
                {resetAsked ? 'Asked — it will answer in its chat' : 'Ask agent to reset chat'}
              </button>
            ) : null}
          </div>
        )
        : null}
      {error && !data ? <p className="hintblock" role="alert">Could not read this agent. Retrying…</p> : null}
      {asking
        ? (
          <AskToConfirm
            title="Update the machine software?"
            message="It restarts the machine — running apps stop for a minute, files are kept."
            verb="Update"
            onAnswer={(confirmed) => { setAsking(false); if (confirmed) void startUpdate('machine'); }}
          />
        )
        : null}
    </section>
  );
}
