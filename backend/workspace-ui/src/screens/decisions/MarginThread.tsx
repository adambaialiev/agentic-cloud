/**
 * The margin (notes #64/#66): remarks NEWEST FIRST, and — while the thread is
 * open to writing — the box to add one.
 *
 * A remark is how anyone says something ABOUT a document without rewriting it:
 * an agent's "I called, they are closed Mondays", and the user's own reply,
 * under the words rather than over them. It is words on the document and
 * nothing else — writing one starts no agent at all (note #518), not even the
 * one that opened the proposal. An agent finds the thread when it next reads
 * the document, and a person who needs an answer now asks that agent in its
 * own chat.
 *
 * The newest remark leads (note #32). A thread is not a conversation to read
 * from the beginning — it is a series of reports ON the document, where the
 * last one is the state and the ones above it are how it got there. The store
 * appends, so the array arrives oldest-first and reversing it is exact.
 *
 * A comment is semantic HTML and goes through the same node-by-node allowlist
 * a knowledge page does: useful markup renders, while scripts, handlers and
 * unsafe URLs never become live DOM.
 */

import { useMemo, useState } from 'react';
import type {
  WorkspaceCommentPostAnswer,
  WorkspaceMarginComment,
} from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { useSession } from '../../session/useSession.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { Icon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { MAX_COMMENT_LENGTH } from './margin.js';
import { agentSignature, formerAgentSignature, runtimeLine } from './proposal-words.js';

export interface MarginThreadProps {
  /** Section ids, so the shared stylesheet dresses this margin as itself. */
  ids: { head: string; card: string; box: string };
  comments: readonly WorkspaceMarginComment[];
  /** A live note, an undecided proposal, a live page. */
  canWrite: boolean;
  /** Where a comment POSTs. */
  path: string;
  /** The fresh thread, after one lands. */
  onPosted: (comments: WorkspaceMarginComment[]) => void;
  /** What a face opens, when anything — by id, because the agent behind it
   *  may be a teammate's and stand in no fleet this reader holds. */
  onAgentId?: (agentId: string) => void;
  onPerson?: (comment: WorkspaceMarginComment) => void;
  /** A sentence for the reader when a write is refused. The margin has
   *  nothing else to say: a remark that lands starts nobody. */
  onSay: (sentence: string) => void;
}

/** The dot every faceless person wears. */
function PersonDot() {
  return <Icon name="user" size={11} className="face dot" />;
}

function CommentFace({ comment, onAgentId, onPerson }: {
  comment: WorkspaceMarginComment;
  onAgentId?: (agentId: string) => void;
  onPerson?: (comment: WorkspaceMarginComment) => void;
}) {
  // The face is a door onto the agent that made the remark (note #58) — the
  // reader's own, or a teammate's, which has a read-only screen of its own
  // since note #640. The backend sends `agentId` exactly when the door
  // exists, so an agent the workplace has forgotten stays a picture.
  if (comment.agentAvatarUrl) {
    const face = <img className="face" src={comment.agentAvatarUrl} alt="" />;
    if (!comment.agentId || !onAgentId) return face;
    const agentId = comment.agentId;
    return (
      <button
        className="facebtn"
        type="button"
        aria-label={comment.agentName ? `Open ${comment.agentName}` : 'Open this agent'}
        onClick={() => onAgentId(agentId)}
      >
        {face}
      </button>
    );
  }
  if (!comment.byPerson) return null;
  // A PERSON's remark (note #64): their own face — or the dot — and a door to
  // their page where the screen has one to offer, the rule every face follows.
  const face = comment.userPhotoUrl
    ? <img className="face" src={comment.userPhotoUrl} alt="" />
    : <PersonDot />;
  if (!onPerson || !comment.authorUserId) return face;
  return (
    <button
      className="facebtn"
      type="button"
      aria-label={comment.userName ? `Open ${comment.userName}` : 'Open this member'}
      onClick={() => onPerson(comment)}
    >
      {face}
    </button>
  );
}

/** One remark: the face, the signature line, the words. */
function MarginComment({ comment, canEdit, path, onEdited, onSay, onAgentId, onPerson }: {
  comment: WorkspaceMarginComment;
  /** The reader's own live remark: theirs to correct, and theirs to take
   *  back. Nobody else's words carry either door. */
  canEdit: boolean;
  path: string;
  onEdited: (comments: WorkspaceMarginComment[]) => void;
  onSay: (sentence: string) => void;
  onAgentId?: (agentId: string) => void;
  onPerson?: (comment: WorkspaceMarginComment) => void;
}) {
  // The parenthetical is the HUMAN driving that agent (note #57). An agent
  // the org no longer has says so (note #705): signed by its driver alone,
  // the remark read as that person's own words.
  const when = comment.createdAt ? relative(comment.createdAt) : '';
  const notes = useNoteRefs();
  const signed = comment.formerAgent
    ? formerAgentSignature(comment.agentName, comment.userName)
    : agentSignature(comment.agentName, comment.userName);
  const runtime = runtimeLine(comment.agentRuntime);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.editableText ?? '');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { api } = useSession();

  /** Save in place and repaint from the server's whole thread. An edit starts
   *  nobody: changing old words must not wake an agent a second time. */
  const save = async (): Promise<boolean> => {
    const said = text.trim();
    if (!said || saving || !comment.id) return false;
    setSaving(true);
    try {
      const answer = await api.api<WorkspaceCommentPostAnswer>(
        `${path}/${encodeURIComponent(comment.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: said }),
        },
      );
      onEdited(answer.comments ?? []);
      setSaving(false);
      setEditing(false);
      return true;
    } catch (error) {
      setSaving(false);
      onSay(error instanceof WorkspaceApiError ? error.message : String(error));
      return false;
    }
  };

  /** Take the remark out of the thread and repaint from what the server has
   *  left. Like the edit, this starts nobody: the words simply stop being
   *  there, for every reader of the document. */
  const remove = async (): Promise<void> => {
    if (removing || !comment.id) return;
    setRemoving(true);
    try {
      const answer = await api.api<WorkspaceCommentPostAnswer>(
        `${path}/${encodeURIComponent(comment.id)}`,
        { method: 'DELETE' },
      );
      // The thread the server answers with is the whole of it, this remark
      // gone. No `setRemoving(false)`: this component is on its way out.
      onEdited(answer.comments ?? []);
    } catch (error) {
      setRemoving(false);
      onSay(error instanceof WorkspaceApiError ? error.message : String(error));
    }
  };

  return (
    <div className="ncmt">
      <div className="who">
        <CommentFace comment={comment} onAgentId={onAgentId} onPerson={onPerson} />
        <div className="commentby">
          <div>{[signed, when, comment.editedAt ? 'edited' : ''].filter(Boolean).join(' · ')}</div>
          {runtime ? <div className="cruntime commentruntime">{runtime}</div> : null}
        </div>
        {canEdit && !editing ? (
          <button
            className="cmteditopen"
            type="button"
            aria-label="Edit your comment"
            onClick={() => { setText(comment.editableText ?? ''); setEditing(true); }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {asking ? (
        // The margin is read by everyone the document is, so the question
        // says whose loss it is — and says plainly that there is no way back.
        <AskToConfirm
          title="Delete your comment?"
          message="It goes from this thread for everyone who reads it, and this cannot be undone."
          verb="Delete"
          danger
          onAnswer={(confirmed) => { setAsking(false); if (confirmed) void remove(); }}
        />
      ) : null}
      {editing ? (
        <form className="cmteditform" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <VoiceField
            onTranscript={(value) => setText(value)}
            review={{
              value: text,
              onChange: setText,
              maxLength: MAX_COMMENT_LENGTH,
              sending: saving,
              onSend: save,
              words: {
                review: 'Review your changes', record: 'Voice comment', back: 'Back to the comment',
                field: 'Your comment', placeholder: 'Edit your comment…',
                hint: 'Make any changes before you save.',
                commit: 'Save', committing: 'Saving…', icon: 'send',
                failed: 'The comment could not be saved. Your words are still here. Try again.',
              },
            }}
          >
            <textarea
              className="prose"
              rows={3}
              maxLength={MAX_COMMENT_LENGTH}
              aria-label="Edit comment"
              disabled={saving}
              value={text}
              onChange={(event) => setText(event.target.value)}
              autoFocus
            />
          </VoiceField>
          <div className="cmteditactions">
            {/* Delete lives HERE, behind Edit, not on the resting row (note
                #647, the owner's follow-up): the thread reads as a thread,
                with one quiet word on the reader's own remark, and taking it
                back is something done from inside the remark rather than a
                red word sitting on every one of them. Bare and red, set apart
                on the left, because it is the one act here with no way back. */}
            <button
              className="btn danger bare cmtdelete"
              type="button"
              aria-label="Delete your comment"
              disabled={saving || removing}
              onClick={() => setAsking(true)}
            >
              Delete
            </button>
            <button className="btn ghost" type="button" disabled={saving || removing} onClick={() => setEditing(false)}>Cancel</button>
            <button className="formcommit" type="submit" disabled={saving || removing}>Save</button>
          </div>
        </form>
      ) : (
        <KnowledgeHtml source={comment.text} extraClass="ctext" plainWhenBare noteRefs={notes} />
      )}
    </div>
  );
}

/**
 * The way IN to a margin: one accent row, which becomes the box on a tap.
 * Collapsed by default so a thread reads as a thread, not as a form — the
 * same trade the note list's "Write a note" row makes. What is typed is plain
 * text; the server does the markup.
 */
function Composer({ path, onPosted, onSay, cardTop }: {
  path: string;
  onPosted: (comments: WorkspaceMarginComment[]) => void;
  onSay: (sentence: string) => void;
  cardTop: boolean;
}) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Every remark is written as the workplace's (note #843): the write was
  // scoped to the room the document belonged to, while there were rooms.

  /**
   * Answers whether the remark landed, so the full-screen voice review can
   * close on a post and keep the words in the box on a refusal.
   *
   * What goes up is the words and nothing else, and what comes back is the
   * thread. A comment starts no agent (note #518), so there is no delivery to
   * report and no roster to refresh — an `@` in the words is a character the
   * person typed, which the server stores as prose.
   */
  const post = async (): Promise<boolean> => {
    const said = text.trim();
    if (!said || sending) return false;
    setSending(true);
    try {
      const answer = await api.api<WorkspaceCommentPostAnswer>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: said }),
      });
      setText('');
      setSending(false);
      // The fresh thread replaces the whole section — remark on top, box
      // collapsed again — so what the reader sees is what the server holds.
      setOpen(false);
      onPosted(answer.comments ?? []);
      return true;
    } catch (error) {
      setSending(false);
      onSay(error instanceof WorkspaceApiError ? error.message : String(error));
      return false;
    }
  };

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    void post();
  };

  if (!open) {
    return (
      <div className={cardTop ? 'cardtop' : undefined}>
        <button className="addrow" type="button" onClick={() => setOpen(true)}>
          Write a comment
        </button>
      </div>
    );
  }
  return (
    <div className={cardTop ? 'cardtop' : undefined}>
      <form className="cmtform" onSubmit={submit}>
        <VoiceField
          onTranscript={(value) => setText(value)}
          review={{
            value: text,
            onChange: setText,
            maxLength: MAX_COMMENT_LENGTH,
            sending,
            onSend: post,
            words: {
              review: 'Review comment', record: 'Voice comment', back: 'Back to the document',
              field: 'Your comment', placeholder: 'Write a comment…',
              hint: 'Make any changes before you post.',
              commit: 'Post comment', committing: 'Posting…', icon: 'send',
              failed: 'The comment could not be posted. Your words are still here. Try again.',
            },
          }}
        >
          <textarea
            className="prose"
            rows={2}
            maxLength={MAX_COMMENT_LENGTH}
            placeholder="Write a comment…"
            aria-label="Write a comment"
            disabled={sending}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </VoiceField>
        <button className="btn cmtsend" type="submit" disabled={sending}>Send</button>
      </form>
    </div>
  );
}

export function MarginThread(props: MarginThreadProps) {
  const { ids, comments, canWrite, path, onPosted, onAgentId, onPerson, onSay } = props;

  const newestFirst = useMemo(() => [...comments].reverse(), [comments]);
  // Nothing at all when there is nothing to read AND nothing to write: an
  // empty thread with no box to fill is a heading standing over nothing.
  const bare = newestFirst.length === 0 && !canWrite;
  return (
    <>
      <h2 id={ids.head} hidden={bare}>Comments</h2>
      <div className="card" id={ids.card} hidden={bare}>
        <div id={ids.box}>
          {newestFirst.map((comment, at) => (
            <MarginComment
              comment={comment}
              canEdit={canWrite && comment.self === true && Boolean(comment.id)}
              path={path}
              onEdited={onPosted}
              onSay={onSay}
              key={comment.id ?? `${comment.createdAt}:${at}`}
              onAgentId={onAgentId}
              onPerson={onPerson}
            />
          ))}
        </div>
        {canWrite ? (
          <Composer
            path={path}
            onPosted={onPosted}
            onSay={onSay}
            cardTop={newestFirst.length === 0}
          />
        ) : null}
      </div>
    </>
  );
}
