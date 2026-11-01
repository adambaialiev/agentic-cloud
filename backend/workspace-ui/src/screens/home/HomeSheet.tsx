/**
 * Home's Workplace window (note #715): the agents picker's shell (`Sheet`),
 * with the overview's workplace half inside — what belongs to the workplace
 * and says the same thing in every room, then the Chief of Staff's own
 * cards. The Chief of Staff's face and name in Home's header open it (the
 * owner, 2026-10-11). Rooms are not here: a room is a tab of the agents
 * picker by the message box, in every conversation (`AgentSwitch`).
 *
 * The window draws itself and its one way out; Home keeps whether it
 * stands (`HomeScreen`), because the window is a browser entry of Home's
 * own address (`home-sheet.ts`): Escape, Close, the dim and the browser's
 * Back all ask Home to take it down.
 */

import { useEffect, useRef } from 'react';
import { Svg } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { WorkplacePanel } from './HomePanels.js';

export function HomeSheet({ leaving, still, onGone, onClose }: {
  leaving: boolean;
  still: boolean;
  onGone: () => void;
  onClose: () => void;
}) {
  const { state } = useWorkspace();
  const card = useRef<HTMLDivElement>(null);
  const orgId = state?.org?.orgId ?? null;

  // The card takes the focus, not the first control in it: a window that
  // opens with a door under the focus is one reflex Enter away from a walk
  // nobody asked for (the agents picker's rule).
  useEffect(() => { card.current?.focus(); }, []);

  return (
    <Sheet
      id="homeSheet"
      className="homesheet"
      labelledBy="homeSheetTitle"
      leaving={leaving}
      still={still}
      onGone={onGone}
      onDim={onClose}
      onEscape={onClose}
      cardRef={card}
    >
      <div className="agentsheethead homesheethead">
        <h2 className="homesheettitle" id="homeSheetTitle">Workplace</h2>
        <button className="agentsheetclose" id="homeSheetClose" type="button" aria-label="Close" onClick={onClose}>
          <Svg name="x" size={18} />
        </button>
      </div>
      <div className="agentsheetlist homesheetbody" id="homeSheetBody" data-level="workplace">
        {orgId ? <WorkplacePanel orgId={orgId} /> : null}
      </div>
    </Sheet>
  );
}
