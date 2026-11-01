/**
 * The first shape of Home, shared by the two reads that precede it.
 *
 * The session read owns the app's first paint; once that answers, the
 * workspace-state read takes over. Keeping the same shape across both means
 * a signed-in reader sees one continuous wait instead of a spinner, a blank
 * Home, then the page assembling itself.
 *
 * The shape is the Chief of Staff's conversation, because that is Home
 * (note #715): its header — the face in its ring, the name, the line saying
 * what it thinks with, and the workplace switch and the reader's picture at
 * the far edge — the pane the conversation lands in, and the message box
 * with the door to the agents and rooms before it. It drew the old Workplace
 * page until note #718, a shape nothing was going to replace it with. The
 * pane holds NO turns: the chat skeleton's rule (note #309) is that held
 * bubbles promise a conversation, and before the read nothing says this
 * reader has had one.
 *
 * Every held row is the real one's box with its fill borrowed, as on the
 * chat's own wait, so nothing moves when the read lands — and the shell is
 * the viewport-tall column every chat screen stands in, which is why it
 * wears the chat's body class for as long as it stands.
 */

import { useLayoutEffect } from 'react';
import { ChatWaitBar } from '../chat/ChatSkeleton.js';

export function HomeLoadingSkeleton({ stage }: { stage: 'app' | 'workplace' }) {
  const label = stage === 'app' ? 'Loading your workspace…' : 'Loading your workplace…';
  // A LAYOUT effect, like the chat screens' own: the real Home adds the
  // class in its layout effect in the same commit this wait leaves, and a
  // passive cleanup here would run after that and take it off again.
  useLayoutEffect(() => {
    document.body.classList.add('agent-chat-open');
    return () => { document.body.classList.remove('agent-chat-open'); };
  }, []);
  return (
    <div
      className="screen home-loading"
      id={stage === 'app' ? 'appLoadingSkeleton' : 'workplaceLoadingSkeleton'}
      aria-busy="true"
    >
      <span className="sr-only" role="status">{label}</span>
      <div className="chathead" aria-hidden="true">
        <div className="chatface">
          <div className="ctxring blank"><span className="skel face" /></div>
        </div>
        <div className="chatwho">
          <h1><span className="skel skel-inline" style={{ width: '112px', height: '15px' }} /></h1>
          {/* As long as the line it holds: model and effort, with no
              harness name before them (note #723). */}
          <div className="sub chatruntime chatwaitruntime">
            <span><span className="skel skel-inline" style={{ width: '96px', height: '10px' }} /></span>
          </div>
        </div>
        <span className="skel home-loading-switch" />
        <span className="skel home-loading-account" />
      </div>
      <div className="chatpane" aria-hidden="true">
        <div className="chatwaitlog" />
      </div>
      <ChatWaitBar agents />
    </div>
  );
}
