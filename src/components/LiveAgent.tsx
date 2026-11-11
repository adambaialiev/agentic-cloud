import { useState } from 'react';
import { machineLine } from '../../backend/workspace-ui/src/screens/agent/agent-facts';
import { machineSizeWords } from '../../backend/workspace-ui/src/screens/agent/machine-words';
import { agentRuntimeLine } from '../../backend/workspace-ui/src/screens/home/agent-words';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { AgentName } from '../../backend/workspace-ui/src/ui/AgentName';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import { ContextUsageRow } from '../../backend/workspace-ui/src/ui/ContextUsageRow';
import { TypeIcon } from '../../backend/workspace-ui/src/ui/icons';
import { elapsed, useNow } from '../../backend/workspace-ui/src/ui/time';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FLEET, MINUTE, ago, useHydrated } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * One agent, and the computer it owns — the top of the agent's own screen,
 * drawn big.
 *
 * The capture this replaces showed the whole agent screen at a third of its
 * size: two dozen facts nobody could read. The owner's word for it was "too
 * heavy, too detailed, too small — make it more to the face", and the face
 * IS the point: an agent with a name, what it thinks with, and the machine
 * it runs on, awake, with its processor and memory.
 *
 * The head is the app's own head (`.phead`, the agent's mark id so the ring
 * and face take the size the agent screen gives them) around the app's own
 * face, ring and name; the words are the app's own word functions, so the
 * machine reads exactly as the agent screen reads it. The screen's header
 * component itself portals into the persistent chrome, which a landing panel
 * has none of, so the four lines of its markup are copied here.
 */

const RUBY = FLEET[0]!;
const MACHINE = { awake: true, region: '', cpuKind: 'performance', cpus: 4, memoryMb: 8192 };
const RUNNING_FOR_MS = 4 * MINUTE + 12_000;

/** The agent screen's software card, as `cliNote`, `imageNote` and `docsNote`
 *  word it when everything is current. */
const SOFTWARE: { glyph: 'terminal' | 'drive' | 'filetext'; title: string; meta: string }[] = [
  { glyph: 'terminal', title: 'Claude Code', meta: '2.1.4 · up to date' },
  { glyph: 'drive', title: 'Machine software', meta: 'Up to date' },
  { glyph: 'filetext', title: 'CLAUDE.md', meta: 'v12 · up to date' },
];

export default function LiveAgent({
  className = '',
  size = 'face',
  showSoftware = size === 'tile',
}: {
  className?: string;
  size?: 'face' | 'tile';
  showSoftware?: boolean;
}) {
  const hydrated = useHydrated();
  const [startedAt] = useState(() => new Date(Date.now() - RUNNING_FOR_MS).toISOString());
  const now = useNow(hydrated);
  return (
    <LivePanel
      size={size}
      className={className}
      says="Ruby’s own screen: her face, what she runs on, and her machine — awake, with four dedicated cores and eight gigabytes — with the job she is on right now."
    >
      <LiveWorkspace>
        <div className="screen" id="screenAgent">
          <div className="phead">
            <div className="pmark" id="agentInfoHead">
              <ContextRing context={RUBY.context}><AgentFace agent={RUBY} /></ContextRing>
            </div>
            <div className="pname">
              <PanelTitle id="agentInfoTitle"><AgentName agent={RUBY} /></PanelTitle>
              <div className="sub" id="agentInfoSub">{agentRuntimeLine(RUBY)}</div>
              <div className="sub" id="agentInfoMachine"><span>{machineSizeWords(RUBY.machineSize!)}</span></div>
            </div>
          </div>
          <div className="asays" id="agentInfoAbout">{RUBY.recap}</div>
          <div className="card" id="agentFacts">
            <div className="drow">
              <div className="k">Machine</div>
              <div className="v person act machinevalue">{machineLine(MACHINE)}</div>
            </div>
            <div className="drow">
              <div className="k">Now</div>
              <div className="v">
                {RUBY.now}
                {hydrated ? <span className="dim"> · {elapsed(startedAt, now)}</span> : null}
              </div>
            </div>
          </div>
          {showSoftware ? (
            /* The next card of the real screen (the owner, 2026-09-12: the
               ownership tile stopped at the facts and stood half empty): what
               the agent runs — the CLI and its version, the machine software,
               the instructions file — in the screen's own row shape, and the
               app's own context-usage row. The close-up and the compact team
               anatomy example stop at the facts instead. */
            <div className="card" id="agentInfoCard">
              {SOFTWARE.map((row) => (
                <div className="crow" key={row.title}>
                  <TypeIcon glyph={row.glyph} />
                  <div className="main">
                    <div className="name plain">{row.title}</div>
                    <div className="cline wrap"><span className="ctext">{row.meta}</span></div>
                  </div>
                </div>
              ))}
              {/* The fixture's context stamp is a fixed date; the row says WHEN it was
                  read, so it gets an offset from now, like every other clock here. */}
              <ContextUsageRow context={RUBY.context ? { ...RUBY.context, at: ago(4 * MINUTE) } : null} busy={false} />
            </div>
          ) : null}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
