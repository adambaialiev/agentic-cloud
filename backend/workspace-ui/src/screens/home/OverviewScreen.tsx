/**
 * A personal workspace's Home: one column. A personal account has no
 * workplace, so no Chief of Staff and no Workplace to put in a window (note
 * #715) — it draws every shelf at once, under the reader's own picture.
 * This was the overview's (and before 2026-10-10, Home's) no-workplace
 * branch; a workplace's overview became Home's Workplace window
 * (`HomeSheet`).
 *
 * The section ids and their sibling order are deliberate: the hidden-sibling
 * chain in the stylesheet that drops the first heading's margin here names
 * every node standing before the shelves. Two hidden nodes of the rooms
 * stood among them, and left with the rooms (note #843).
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { NoteComposer } from '../notes/NoteComposer.js';
import { AddSecretForm } from '../secrets/AddSecretForm.js';
import { PersonalPanel } from './HomePanels.js';
import { HomeTabs } from './HomeTabs.js';

export function OverviewScreen() {
  const location = useLocation();
  const landed = (location.state as { banner?: string } | null)?.banner ?? '';
  // The leaves its shelves open — no address of their own, the whole screen.
  const [writing, setWriting] = useState(false);
  const [addingSecret, setAddingSecret] = useState(false);

  if (writing) return <NoteComposer onClose={() => setWriting(false)} />;
  if (addingSecret) return <AddSecretForm onClose={() => setAddingSecret(false)} onSaved={() => setAddingSecret(false)} />;
  return (
    <div className="screen" id="screenOverview">
      {/* The one arrival with no screen of its own to say it (redeeming an
          invitation). */}
      {landed ? <div className="card authpanel" role="status" id="homeBanner">{landed}</div> : null}
      <HomeTabs />
      <div id="homeWorkplace" hidden />
      <PersonalPanel
        leaves={{
          onWrite: () => setWriting(true),
          onAddSecret: () => setAddingSecret(true),
        }}
      />
    </div>
  );
}
