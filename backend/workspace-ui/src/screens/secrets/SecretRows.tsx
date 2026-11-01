/**
 * The pieces every secrets list shares: a name that wraps at its
 * underscores, one row, the search field over a long list, the door Home
 * shows instead of a long list, and the empty state.
 */

import { Fragment, useState } from 'react';
import type { WorkspaceSecretRow } from '../../../../src/shared/workspace-api.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { joinNames, reachesWords } from './secret-words.js';

/** `as` because the same name is a row's label, a card's heading and — inside
 *  the one header — the screen's own title, where a block element inside the
 *  `h1` would be markup no parser is promised. */
export function SecretName({ name, className = 'name', as: Tag = 'div' }: { name: string; className?: string; as?: 'div' | 'span' }) {
  const parts = String(name).split('_');
  return (
    <Tag className={className}>
      {parts.map((part, index) => (
        <Fragment key={index}>{index < parts.length - 1 ? <>{part}_<wbr /></> : part}</Fragment>
      ))}
    </Tag>
  );
}

export function SecretRow({ secret, onOpen }: { secret: WorkspaceSecretRow; onOpen: () => void }) {
  return (
    <button className="crow open" type="button" onClick={onOpen}>
      <div className="main">
        <SecretName name={secret.name} />
        {secret.description ? <div className="desc">{secret.description}</div> : <div className="desc missing">No description yet</div>}
        {secret.scope === 'shared' && secret.audience
          ? <div className="reach"><Icon name={secret.audience === 'everyone' ? 'user' : 'lock'} size={13} /><span>{reachesWords(secret)}</span></div>
          : null}
        {secret.shadowedBy?.length
          ? <div className="shadow"><Icon name="shadow" size={13} /><span>{joinNames(secret.shadowedBy)}{secret.shadowedBy.length > 1 ? ' use their own instead' : ' uses its own instead'}</span></div>
          : null}
      </div>
      <div className="cside">{secret.updatedAt ? relative(secret.updatedAt) : ''}</div>
    </button>
  );
}

export function SecretsList({ secrets, searchable, onOpen }: { secrets: WorkspaceSecretRow[]; searchable: boolean; onOpen: (secret: WorkspaceSecretRow) => void }) {
  const [filter, setFilter] = useState('');
  const needle = searchable ? filter.trim().toLowerCase() : '';
  const shown = needle ? secrets.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle)) : secrets;
  return (
    <>
      {searchable
        ? (
          <div className="filter">
            <Icon name="search" size={16} />
            <VoiceField onTranscript={setFilter}>
              <input type="search" placeholder="Search secrets" aria-label="Search secrets" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </VoiceField>
          </div>
        )
        : null}
      <div>
        {shown.length === 0
          ? <div className="empty">Nothing matches “{filter.trim()}”.</div>
          : shown.map((secret) => <SecretRow key={`${secret.scope}/${secret.agentId ?? ''}/${secret.name}`} secret={secret} onOpen={() => onOpen(secret)} />)}
      </div>
    </>
  );
}

export function SecretsDoorRow({ secrets, onOpen }: { secrets: WorkspaceSecretRow[]; onOpen: () => void }) {
  const times = secrets.map((s) => s.updatedAt).filter((t): t is string => Boolean(t)).sort();
  return (
    <button className="crow open" type="button" onClick={onOpen}>
      <TypeIcon glyph="key" tint={'secret' as never} />
      <div className="main"><div className="name plain">{secrets.length} secrets</div></div>
      {times.length ? <div className="cside">{relative(times[times.length - 1]!)}</div> : null}
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

export function SecretsEmpty({ canAddShared, canAddPrivate = canAddShared }: { canAddShared: boolean; canAddPrivate?: boolean }) {
  return (
    <div className="empty roomempty">
      <div className="roomemptymark ft-secret" aria-hidden="true"><TypeIcon glyph="key" tint={'secret' as never} /></div>
      <div className="roomemptycopy">
        <div className="roomemptytitle">{canAddShared ? 'Connect tools safely' : 'No shared secrets yet'}</div>
        <div className="roomemptybody">{canAddShared
          ? 'Save a key once so the workplace’s agents can use it without exposing it in chat. Add the first secret below.'
          : canAddPrivate
            ? 'Workplace admins add the keys the workplace shares. You can save a key for one of your own agents below — it is never handed to anyone else’s.'
            : 'Workplace admins add credentials that the workplace’s agents can use without exposing their values in chat.'}</div>
      </div>
    </div>
  );
}
