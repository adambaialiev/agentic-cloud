import { Fragment, useState } from 'react';
import type { WorkspaceChatMessage } from '../../backend/src/shared/workspace-api';
import { chatDayLabel } from '../../backend/workspace-ui/src/screens/chat/chat-notice';
import { ChatMessageRow } from '../../backend/workspace-ui/src/screens/chat/ChatMessageRow';
import { agentRuntimeLine } from '../../backend/workspace-ui/src/screens/home/agent-words';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { AgentName } from '../../backend/workspace-ui/src/ui/AgentName';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import { Svg } from '../../backend/workspace-ui/src/ui/icons';
import { RoomFaces } from '../../backend/workspace-ui/src/ui/RoomFaces';
import { agentSwitchStack } from '../../backend/workspace-ui/src/screens/chat/agent-switch';
import { RUBY, RUBY_ROWS } from './LiveChat';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { HERO_FLEET, useHydrated } from './live/fixture';

/**
 * The same Workspace, in your pocket: ONE phone, at a phone's real width,
 * with the chat screen as the app draws it on a phone — Back, the head with
 * Ruby's face, the transcript filling the shell, and the compose bar at the
 * bottom edge. The four phones this replaced were 242px wide on a desk and
 * 155px on an actual phone, a width no phone has, and the app's layouts
 * broke inside them: names cut to one letter, tables off the edge, every
 * frame clipped mid-sentence.
 *
 * The transcript is the END of Ruby's conversation, the part that happens
 * away from a desk: the card the Workspace wrote when she proposed the
 * change, the next brief typed with a thumb, her acknowledgement, and the
 * live line while she works. The pane is bottom-aligned and clipped at the
 * top, exactly what a chat opened on a phone looks like — the newest words
 * at the composer, the older ones scrolled up under the head.
 *
 * The frame keeps a real phone's proportions (390 × 844) and is zoomed as
 * one object on a desk, so the app inside stays at the size it is on a
 * phone rather than being redrawn narrower.
 *
 * The chat sits INSIDE A BROWSER, because that is where it actually runs on
 * a phone: there is no app to install, you open the address in Safari. So
 * the frame wears what a phone shows around a web page — the status bar
 * above, and the browser's own bar below with the site's address, a reload
 * and the page menu, then the home indicator. Note #155: the owner's own
 * screenshot of the chat on his phone had all of that, and the mockup
 * without it read as a native app we do not have.
 */

export const PHONE_ADDRESS = 'agents.northstar.com';

/**
 * The phone's status bar: the time on the left, the island, signal, wifi and
 * battery on the right. The time is Apple's own 9:41 and never the machine's,
 * and like every clock on a reused screen it is drawn only once hydrated, so
 * the prerender carries no clock at all (entry-server.test).
 */
function StatusBar() {
  const hydrated = useHydrated();
  return (
    <div className="landing-phone-status relative flex h-[54px] flex-none items-end justify-between px-[28px] pb-[10px] type-base font-semibold text-ink" aria-hidden="true">
      <span className="tabular-nums">{hydrated ? '9:41' : ''}</span>
      <span className="absolute left-1/2 top-[11px] h-[36px] w-[124px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-[6px]">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8" /><rect x="5" y="5.5" width="3" height="6.5" rx=".8" /><rect x="10" y="3" width="3" height="9" rx=".8" /><rect x="15" y="0" width="3" height="12" rx=".8" /></svg>
        <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 9.6a1.7 1.7 0 0 1 1.7 1.7L8.5 12l-1.7-.7a1.7 1.7 0 0 1 1.7-1.7Zm0-3.6c1.6 0 3 .6 4.1 1.7l-1.4 1.4a3.8 3.8 0 0 0-5.4 0L4.4 7.7A5.8 5.8 0 0 1 8.5 6Zm0-3.6c2.6 0 5 1 6.8 2.8l-1.4 1.4a7.6 7.6 0 0 0-10.8 0L1.7 5.2A9.6 9.6 0 0 1 8.5 2.4Z" /></svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4" /><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor" /><path d="M25 4.5v4a2 2 0 0 0 0-4Z" fill="currentColor" opacity=".4" /></svg>
      </span>
    </div>
  );
}

/** The browser's bar under the page: back, the address with a reload, and the page menu; the home indicator beneath. */
function BrowserBar() {
  return (
    <div className="landing-phone-browser flex-none bg-panel-soft px-[16px] pt-[10px] pb-[8px]" aria-label="The phone's browser, with the address of the Workspace">
      <div className="flex items-center gap-[8px]">
        <span className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full bg-panel text-ink" aria-hidden="true">
          <Svg name="back" size={20} />
        </span>
        <span className="flex h-[44px] min-w-0 flex-1 items-center gap-[6px] rounded-full bg-panel px-[10px] type-sm text-ink">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="2" y="3" width="14" height="10" rx="2" /><path d="M6 16h6M9 13v3" /></svg>
          <span className="min-w-0 flex-1 truncate text-center">{PHONE_ADDRESS}</span>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9" /><path d="M14.7 2.8v3.4h-3.4" /></svg>
        </span>
        <span className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full bg-panel text-ink" aria-hidden="true">
          <svg width="20" height="6" viewBox="0 0 20 6" fill="currentColor"><circle cx="3" cy="3" r="2.2" /><circle cx="10" cy="3" r="2.2" /><circle cx="17" cy="3" r="2.2" /></svg>
        </span>
      </div>
      <div className="mx-auto mt-[12px] h-[5px] w-[134px] rounded-full bg-ink opacity-80" aria-hidden="true" />
    </div>
  );
}

const PHONE = { width: 390, height: 844 };

function Screen() {
  const hydrated = useHydrated();
  const [rows] = useState<WorkspaceChatMessage[]>(() => RUBY_ROWS().slice(1));
  let lastDay = '';
  return (
    <div className="screen ws-phonescreen" id="screenAgentChat">
      <div className="chathead">
        <button className="back" type="button" tabIndex={-1}><Svg name="back" size={20} />Back</button>
        <div className="chatface" id="agentChatFace">
          <ContextRing context={RUBY.context}><AgentFace agent={RUBY} /></ContextRing>
        </div>
        <div className="chatwho">
          <div className="chatnamedoor">
            <h1 id="agentChatTitle"><AgentName agent={RUBY} /></h1>
          </div>
          <div className="sub chatruntime" id="agentChatStatus"><span>{agentRuntimeLine(RUBY)}</span></div>
        </div>
      </div>
      <div className="chatpane" id="agentChatScroll">
        <div id="agentChatLog">
          {hydrated
            ? rows.map((row) => {
              const day = new Date(row.at).toDateString();
              const divider = day !== lastDay ? chatDayLabel(row.at) : '';
              lastDay = day;
              return (
                <Fragment key={row.seq}>
                  {divider ? <div className="chatday">{divider}</div> : null}
                  <ChatMessageRow
                    row={row}
                    agentId={RUBY.id}
                    onOpenProposal={() => {}}
                    onOpenFile={() => {}}
                    onPictureLoaded={() => {}}
                  />
                </Fragment>
              );
            })
            : null}
        </div>
        <div className="chatlive" id="agentChatLive">
          <div className="chatmsg agent">
            <span className="tdots"><i /><i /><i /></span>
            <span className="activity" id="agentChatActivity">Bash: npm test -- offline-queue</span>
          </div>
          <button className="chatstop" type="button" tabIndex={-1} aria-label="Stop"><Svg name="stop" size={18} /></button>
        </div>
      </div>
      <form className="chatbar" onSubmit={(event) => event.preventDefault()}>
        <div className="row">
          {/* The composer as the app draws it: the stack of the OTHER agents'
              faces at the left, the door to switching mid-conversation
              (AgentSwitch, note #581), and the mic inside the box (VoiceField).
              Three faces: the hero's fleet minus Ruby, whose chat this is. */}
          <button className="chatagents" type="button" tabIndex={-1} aria-label="Your agents">
            <RoomFaces agents={agentSwitchStack(HERO_FLEET, RUBY.id)} counted={false} />
          </button>
          <div className="chatinput">
            <button className="chatattach" type="button" tabIndex={-1} aria-label="Attach files"><Svg name="attach" size={20} /></button>
            <div className="voicefield">
              <textarea id="agentChatText" rows={1} placeholder="Message" readOnly value="" />
              <button className="voicebtn" type="button" tabIndex={-1} aria-label="Dictate"><Svg name="mic" size={18} /></button>
            </div>
          </div>
          <button className="chatsend" type="submit" aria-label="Send" disabled><Svg name="send" size={19} /></button>
        </div>
      </form>
    </div>
  );
}

export default function LivePhone({ className = '' }: { className?: string }) {
  return (
    <figure className={`landing-phone mx-auto w-full ${className}`} style={{ maxWidth: PHONE.width + 20 }}>
      <div className="rounded-[44px] bg-panel-soft p-[10px]">
        <div className="overflow-hidden rounded-[34px] bg-panel" style={{ aspectRatio: `${PHONE.width} / ${PHONE.height}` }}>
          <div className="relative flex h-full flex-col">
            <StatusBar />
            <LivePanel
              size="phone"
              className="flex min-h-0 flex-1 flex-col"
              says="The Workspace conversation on a phone, open in its browser."
            >
              <LiveWorkspace><Screen /></LiveWorkspace>
            </LivePanel>
            <BrowserBar />
          </div>
        </div>
      </div>
    </figure>
  );
}
