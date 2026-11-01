/**
 * Choosing your own address on the mail domain (note #509). One field, used
 * where a person picks a name: on the signup form and in Settings for every
 * account that existed before addresses did.
 *
 * The field answers while it is typed — free, taken, or not a name we can
 * make — because the alternative is a form that refuses after the password
 * is filled in. The grammar it checks with is the server's own
 * (`shared/workspace-mail.ts`); only "is it free" needs asking.
 */

import { useEffect, useState } from 'react';
import {
  MAIL_DOMAIN,
  MAIL_LOCAL_MAX,
  mailLocalHint,
  mailLocalProblem,
  normalizeMailLocal,
  type WorkspaceMailAddressAvailability,
} from '../../../src/shared/workspace-mail.js';
import type { WorkspaceApi } from '../api/client.js';

export type MailAddressStatus = 'empty' | 'checking' | 'free' | 'taken' | 'invalid';

const CHECK_DELAY_MS = 400;

export function MailAddressField({ api, id, value, onChange, onStatus, autoFocus, disabled }: {
  api: WorkspaceApi;
  id: string;
  value: string;
  onChange: (value: string) => void;
  onStatus?: (status: MailAddressStatus) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const local = normalizeMailLocal(value);
  const problem = local ? mailLocalProblem(local) : null;
  const [status, setStatus] = useState<MailAddressStatus>('empty');

  useEffect(() => {
    const settle = (next: MailAddressStatus) => { setStatus(next); onStatus?.(next); };
    if (!value.trim()) { settle('empty'); return; }
    if (!local || problem) { settle('invalid'); return; }
    settle('checking');
    let cancelled = false;
    // One question per pause in the typing, not one per keystroke.
    const timer = window.setTimeout(() => {
      api.authApi<WorkspaceMailAddressAvailability>(`auth/email/address?local=${encodeURIComponent(local)}`)
        .then((answer) => {
          if (cancelled) return;
          settle(answer.available ? 'free' : answer.problem ? 'invalid' : 'taken');
        })
        // A check that could not be made is not a refusal: the server decides
        // when the form is sent, and it will say so then.
        .catch(() => { if (!cancelled) settle('free'); });
    }, CHECK_DELAY_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // onStatus is a parent callback; re-running on its identity would restart
    // every check on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, value, local, problem]);

  const note = status === 'invalid'
    ? (problem ? mailLocalHint(problem) : `An address here ends in @${MAIL_DOMAIN}.`)
    : status === 'taken' ? 'That name is taken. Try another.'
      : status === 'checking' ? 'Checking…'
        : status === 'free' ? `${local}@${MAIL_DOMAIN} is yours.`
          : `Choose the name before the @ — people will write to it.`;

  return (
    <div className="authfield mailfield">
      <label className="mailfieldlabel" htmlFor={id}>Choose your address</label>
      <div className="mailinput">
        <input
          id={id}
          name="mailbox"
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAIL_LOCAL_MAX + MAIL_DOMAIN.length + 1}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="maildomain" aria-hidden="true">@{MAIL_DOMAIN}</span>
      </div>
      <span
        className={`mailnote${status === 'free' ? ' ok' : status === 'taken' || status === 'invalid' ? ' bad' : ''}`}
        id={`${id}Note`}
        aria-live="polite"
      >
        {note}
      </span>
    </div>
  );
}
