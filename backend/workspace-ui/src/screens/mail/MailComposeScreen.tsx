/**
 * Writing to somebody who has not written first (note #509, slice 5).
 *
 * One of the two screens in the mail service that names a recipient (the
 * other is Forward). Deliberately narrower than the mail app anybody is used
 * to — one To, up to three Cc boxes, up to five files since slice 12, plain
 * words, no Bcc — and that narrowness is the abuse control the server also
 * enforces, not a shortcut taken here: a message reaches four people at most,
 * so it is never a list. So the form offers the doors it has and no others.
 *
 * It is drawn IN PLACE over the list, the way the reply composer is drawn
 * over the message it answers: a half-written message is not a destination,
 * and Back from it should return to the mail you were looking at rather than
 * to whatever came before this screen.
 */

import { useCallback, useState } from 'react';
import type { WorkspaceMailMessageSummary, WorkspaceMailSendAnswer } from '../../../../src/shared/workspace-mail.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useSession } from '../../session/useSession.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { MAIL_REPLY_MAX } from './mail-words.js';
import { MailCcField, MailFilesField } from './MailOutgoing.js';
import { mailCcAddresses, mailPost, type MailPick } from './mail-outgoing.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function MailComposeScreen({ address, to: startTo = '', subject: startSubject = '', onClose, onSent }: {
  /** The address this will come from — the reader's own. */
  address: string;
  /** Who it is to, when the door it was opened from already knows — a
   *  person's own screen (note #626). Still an ordinary field. */
  to?: string;
  /** What it is about, when the door knows that too (note #1058). Still an ordinary field. */
  subject?: string;
  onClose: () => void;
  onSent: (message: WorkspaceMailMessageSummary) => void;
}) {
  const { api } = useSession();
  const [to, setTo] = useState(startTo);
  const [subject, setSubject] = useState(startSubject);
  const [text, setText] = useState('');
  const [cc, setCc] = useState<string[]>([]);
  const [picked, setPicked] = useState<MailPick[]>([]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState('');
  useBackClaim(onClose);

  const ready = Boolean(to.trim()) && Boolean(text.trim());

  const send = useCallback(async (): Promise<boolean> => {
    if (!to.trim() || !text.trim() || sending) return false;
    setSending(true); setFailed('');
    try {
      const copies = mailCcAddresses(cc);
      const answer = await mailPost<WorkspaceMailSendAnswer>(
        api, 'api/mail/send', { to, subject, text, ...(copies.length ? { cc: copies } : {}) }, picked.map(({ file }) => file),
      );
      onSent(answer.message);
      onClose();
      return true;
    } catch (error) {
      // Same rule as the reply composer: what somebody wrote stays in the box.
      // A refused address and a refused send are both worth another attempt,
      // and neither is worth losing the words over.
      setFailed(errorMessage(error));
      setSending(false);
      return false;
    }
  }, [api, cc, onClose, onSent, picked, sending, subject, text, to]);

  return <div className="screen" id="screenMailCompose">
    <ScreenTitle title="New message" sub={address ? `from ${address}` : undefined} />
    <div className="mailcompose">
      <label className="drow frow">
        <div className="head"><div className="k">To</div></div>
        <input
          id="mailToField"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.com"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <MailCcField cc={cc} onChange={setCc} />
      <label className="drow frow">
        <div className="head"><div className="k">Subject</div></div>
        <input
          id="mailSubjectField"
          className="prose"
          type="text"
          placeholder="What it is about"
          maxLength={200}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>
      <label className="drow frow">
        <div className="head">
          <div className="k">Message</div>
          <div className="count" id="mailComposeCount">
            {text.length ? `${text.length} character${text.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <VoiceField
          onTranscript={setText}
          review={{
            value: text,
            onChange: setText,
            autoGrow: true,
            maxLength: MAIL_REPLY_MAX,
            sending,
            onSend: send,
            words: {
              review: 'Review your message',
              record: 'Dictate a message',
              back: 'Back to writing',
              field: 'Your message',
              placeholder: 'Write your message',
              hint: 'Make any changes before you send.',
              commit: 'Send message',
              committing: 'Sending…',
              icon: 'send',
              failed: 'The message could not be sent. Your words are still here. Try again.',
            },
          }}
        >
          <textarea
            id="mailComposeText"
            className="prose"
            placeholder="Write your message"
            rows={7}
            maxLength={MAIL_REPLY_MAX}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </VoiceField>
      </label>
      <MailFilesField picked={picked} onPicked={setPicked} />
      {failed ? <div className="autherror" role="alert">{failed}</div> : null}
      <div className="authactions">
        <button className="formcommit" id="mailComposeSend" type="button" disabled={sending || !ready}
          onClick={() => { void send(); }}>{sending ? 'Sending…' : 'Send message'}</button>
      </div>
    </div>
  </div>;
}
