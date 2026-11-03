/**
 * The Workplace window as an index (note #960, Adam, 3 Nov 2026: "workplace
 * ui should be improved"). It stacked about twelve shelves inline and
 * scrolled for four screens, most of them with no heading; Direct messages,
 * Mail and Drive were already the right shape — a row, a name, one line, a
 * chevron that opens a screen of its own — so every shelf is that row now,
 * in three groups, and each opens its own screen. What the reader came to
 * the window for at a glance (how much is running, who is doing what) stays
 * drawn in full above it (`WorkplacePanel`).
 *
 * The one setting that stays a control here is the reader's own auto-merge
 * (note #944): a switch, exactly as it was, beside the work it acts on. The
 * line under each row is a count or a state; the row explains nothing.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Icon, TypeIcon, type IconName, type IconTint } from '../../ui/icons.js';
import { CHIEF_OF_STAFF } from '../../ui/chief-of-staff.js';
import { SeatStrip } from '../../ui/SeatStrip.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { secretsOf } from '../secrets/secret-words.js';
import { sitesOf } from '../sites/site-words.js';
import { bucketsOf } from '../storage/bucket-words.js';
import { AutoMerge } from './AutoMerge.js';
import { MailDoor, MessageDoor } from './HumanMessages.js';
import {
  counted, notesLine, repositoriesLine, sitesLine, storageLine,
} from './workplace-index-words.js';

/** One row of the index: the Direct messages door's own shape. */
export function IndexRow({ id, to, glyph, tint, name, line }: {
  id: string;
  to: string;
  glyph: IconName;
  tint?: IconTint;
  name: string;
  line: ReactNode;
}) {
  return (
    <Link className="crow open indexrow" id={id} to={to}>
      <TypeIcon glyph={glyph} tint={tint} />
      <div className="main">
        <div className="name plain">{name}</div>
        <div className="cline">{line}</div>
      </div>
      <Icon name="chev" size={18} />
    </Link>
  );
}

export function WorkplaceIndex({ orgId, agentState }: { orgId: string; agentState: string | null }) {
  const { state } = useWorkspace();
  const notes = state?.notes ?? null;
  const unclaimed = (notes ?? []).filter((note) => note.work?.state === 'unclaimed').length;
  const repos = state?.repos ?? null;
  const sites = sitesOf(state);
  const buckets = bucketsOf(state);
  const secrets = secretsOf(state);
  const knowledge = state?.knowledge ?? null;
  const messages = Boolean(state?.messagesAvailable);
  const address = state?.user?.account.mailbox?.address ?? '';
  const scope = { orgId };
  return (
    <>
      {messages || address
        ? (
          <>
            <h2 className="indexhead" id="humanMessagesHead">Messages</h2>
            <div className="card" id="humanMessagesCard">
              {messages ? <MessageDoor key={orgId} orgId={orgId} /> : null}
              {address ? <MailDoor address={address} /> : null}
            </div>
          </>
        )
        : null}
      <h2 className="indexhead" id="workplaceWorkHead">Work</h2>
      <div className="card" id="workplaceWorkCard">
        {notes
          ? <IndexRow id="indexNotes" to={toFor({ kind: 'notes', ...scope })!} glyph="note" tint="note" name="Notes" line={notesLine(notes.length, unclaimed)} />
          : null}
        {state?.driveAvailable
          ? <IndexRow id="indexDrive" to={toFor({ kind: 'drive', ...scope })!} glyph="drive" name="Drive" line="Files for the whole workplace" />
          : null}
        <IndexRow id="indexRepositories" to={toFor({ kind: 'repositories', ...scope })!} glyph="git" tint="code" name="Repositories" line={repositoriesLine(repos ? repos.length : null, state?.quota)} />
        {knowledge
          ? <IndexRow id="indexKnowledge" to={toFor({ kind: 'knowledgeList', ...scope })!} glyph="bulb" tint="doc" name="Knowledge" line={knowledge.length ? counted(knowledge.length, 'page') : 'None yet'} />
          : null}
        {sites.length
          ? <IndexRow id="indexSites" to={toFor({ kind: 'sites', ...scope })!} glyph="globe" tint="dir" name="Sites" line={sitesLine(sites.map((site) => site.url ?? ''))} />
          : null}
        {buckets.length
          ? <IndexRow id="indexStorage" to={toFor({ kind: 'storage', ...scope })!} glyph="database" name="Storage" line={storageLine(buckets)} />
          : null}
      </div>
      {/* The reader's own auto-merge (note #944): what happens to their
          agents' proposals, right under the work those proposals change. */}
      <AutoMerge />
      {/* The reader's own sign-ins stay plates, not a row (note #960): how
          full each one is is a glance, like the people above, and each plate
          is the door to its own page. */}
      <h2 className="indexhead" id="seatsHomeHead">Subscriptions</h2>
      <SeatStrip ids={{ section: 'seatsHomeSection', row: 'seatsHome' }} addIcon={false} />
      <h2 className="indexhead" id="workplaceSettingsHead">Settings</h2>
      <div className="card" id="workplaceSettingsCard">
        {secrets
          ? <IndexRow id="indexSecrets" to={toFor({ kind: 'secrets', ...scope })!} glyph="key" tint="secret" name="Secrets" line={secrets.length ? counted(secrets.length, 'secret') : 'None yet'} />
          : null}
        <IndexRow id="indexChiefOfStaff" to={toFor({ kind: 'chiefOfStaff', ...scope })!} glyph="bot" name={CHIEF_OF_STAFF} line={agentState ?? ''} />
      </div>
    </>
  );
}
