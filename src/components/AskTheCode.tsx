import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Screen, H2 } from './landing-kit';
import { NEW_TAB, useNewTab } from '../lib/new-tab';
import {
  ASK_GIVE_UP_MS,
  ASK_MAX_CHARS,
  ASK_POLL_MS,
  askQuestion,
  isPending,
  readQuestion,
  readStatus,
  visitId,
  type AskAgent,
  type AskQuestionState,
} from '../lib/ask-api';

/* ── Ask an agent that reads the code (note #1010) ─────────────────────────
   Adam, 5 Nov 2026: "in the landing page we should put an agent that should
   be able to answer questions about our product. it should be able to read
   the source code." His decisions (18:46 and 19:02 UTC): a visible Claude
   Code agent on Sonnet, sealed, reading only the public repository; anyone
   may ask, signed out; one fresh conversation per visit; every conversation
   saved where he reads it; a full home page screen with three questions to
   tap. The design and the mock-ups are on note #1010; the route contract is
   its section 10 (src/lib/ask-api.ts). Every word below is the design's. */

export const ASK_HEADING = 'Ask an agent that reads the code.';
export const ASK_AGENT_LINE = 'Claude Code on Sonnet · reads the public code and docs';
export const ASK_QUESTIONS = [
  'Does every agent get its own computer?',
  'What happens when my Claude plan runs out?',
  'Can my team run it in our own cloud?',
] as const;
export const ASK_PLACEHOLDER = 'Ask about Agentic Cloud Computer';
export const ASK_PLACEHOLDER_PHONE = 'Ask about the product';
/* The one line of fine print on the page (design, open point 4, kept by
   Adam): the visitor should know they are read. */
export const ASK_FINE_PRINT = 'The founder reads every conversation, to learn what people ask. Nothing about you is kept beyond what you type.';
export const ASK_MARGIN_REST = 'The open-source code and the docs, fresh from each release. Every answer lists the files it came from.';
export const ASK_FAILED = 'Something went wrong on our side, and that question was not counted. Ask it again in a minute.';
export const ASK_BUSY = 'A few questions are ahead of yours. Ask again in a minute.';

/* The public repository's own file view: ?path=<path>&file=1 (the licence
   link of note #959 used the same shape). */
export const ASK_REPO_URL = 'https://agenticcloudcomputer.com/acc/agentic-cloud';
export function repoFileUrl(path: string): string {
  return `${ASK_REPO_URL}?path=${path.split('/').map(encodeURIComponent).join('/')}&file=1`;
}
const DOCS_URL = 'https://agenticcloudcomputer.com/docs';
const FOUNDER_MAILTO = 'mailto:adam@agenticcloudcomputer.com';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
export function aheadLine(position: number): string {
  const word = NUMBER_WORDS[position] ?? String(position);
  return `${word} question${position === 1 ? '' : 's'} ahead of yours · about a minute`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** An ISO time as the visitor's own HH:MM. */
export function localTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/* ── The answer's Markdown, read strictly ────────────────────────────────
   Paragraphs, "- " lists, `code`, **bold** and links to our own address
   only. No raw HTML ever reaches the page: everything is text nodes. */
const SAFE_LINK = /^https:\/\/agenticcloudcomputer\.com(\/|$)/;

function inline(text: string, newTab: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push(<code key={key++} className="rounded bg-panel-soft px-1 py-px font-mono text-[0.88em]">{match[1]}</code>);
    } else if (match[2] !== undefined) {
      out.push(<strong key={key++} className="font-semibold">{match[2]}</strong>);
    } else if (SAFE_LINK.test(match[4])) {
      out.push(
        <a key={key++} href={match[4]} {...(newTab ? NEW_TAB : {})} className="underline decoration-white/35 underline-offset-2 hover:decoration-white">
          {match[3]}
        </a>,
      );
    } else {
      out.push(match[3]);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AnswerText({ text }: { text: string }) {
  const newTab = useNewTab();
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^\s*[-*] /.test(line))) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*[-*] /, ''), newTab)}</li>)}
            </ul>
          );
        }
        return <p key={index}>{inline(lines.join(' ').replace(/^#+\s*/, ''), newTab)}</p>;
      })}
    </>
  );
}

/* ── The conversation ────────────────────────────────────────────────── */

type Turn = {
  question: string;
  state: AskQuestionState;
  questionId?: string;
  position: number;
  files: string[];
  answer?: string;
  startedAt: number;
};

type Gate =
  | { kind: 'limited'; until?: string }
  | { kind: 'resting'; until?: string }
  | { kind: 'busy' };

function ExternalArrow() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="ml-1 inline h-3.5 w-3.5" fill="none">
      <path d="M7 13l6-6M8 6.5h5.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WallLink({ href, children }: { href: string; children: string }) {
  const newTab = useNewTab();
  return (
    <a
      href={href}
      {...(newTab ? NEW_TAB : {})}
      className="inline-flex items-center border-b border-white/15 pb-1 type-sm font-semibold text-hint transition-colors hover:border-white/40 hover:text-white sm:type-base focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
      <ExternalArrow />
    </a>
  );
}

function Wall({ title, line, links }: { title: string; line: string; links: Array<[string, string]> }) {
  return (
    <div data-ask-wall className="rounded-2xl bg-panel-soft p-5 sm:p-6">
      <p className="type-md-sm font-semibold text-white">{title}</p>
      <p className="mt-1 type-base text-hint">{line}</p>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
        {links.map(([label, href]) => <WallLink key={label} href={href}>{label}</WallLink>)}
      </div>
    </div>
  );
}

function FileList({ files, reading = false }: { files: string[]; reading?: boolean }) {
  const newTab = useNewTab();
  return (
    <ol className="grid gap-2.5">
      {files.map((path, index) => {
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
        const now = reading && index === files.length - 1;
        return (
          <li key={path} className="grid grid-cols-[18px_minmax(0,1fr)] items-baseline gap-1.5">
            <span className="type-xs tabular-nums text-hint/70">{index + 1}</span>
            <span className="min-w-0">
              <a
                href={repoFileUrl(path)}
                {...(newTab ? NEW_TAB : {})}
                className={`break-words font-mono type-sm leading-snug underline underline-offset-[3px] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${now ? 'text-hint no-underline' : 'text-white decoration-white/25 hover:decoration-white'}`}
              >
                {name}
                {newTab ? <span className="sr-only"> in {folder || 'the repository'} (opens in a new tab)</span> : null}
              </a>
              {folder ? <span aria-hidden="true" className="block break-words font-mono type-xs leading-snug text-hint/80">{folder}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Dots() {
  return (
    <span aria-hidden="true" className="ask-dots mr-1 inline-flex gap-1.5">
      <span className="h-2 w-2 rounded-full bg-white" />
      <span className="h-2 w-2 rounded-full bg-white/40" />
      <span className="h-2 w-2 rounded-full bg-white/15" />
    </span>
  );
}

function pendingLine(turn: Turn, seconds: number): string {
  if (turn.state === 'queued' && turn.position > 0) return aheadLine(turn.position);
  if (turn.state === 'waking') return 'Waking up · about ten seconds';
  return `Reading the code · ${clock(seconds)} · answers take up to a minute`;
}

export function AskTheCode() {
  const [agent, setAgent] = useState<AskAgent | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [gate, setGate] = useState<Gate | null>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /* The phone's shorter placeholder, read after hydration (the prerendered
     page carries the desk's). */
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 639px)') : null;
    if (!query) return undefined;
    const read = () => setPhone(query.matches);
    read();
    query.addEventListener?.('change', read);
    return () => query.removeEventListener?.('change', read);
  }, []);

  const current = turns[turns.length - 1];
  const pending = current ? isPending(current.state) : false;

  /* On load: the agent's face and name, and whether it rests. */
  useEffect(() => {
    const abort = new AbortController();
    readStatus(abort.signal)
      .then((status) => {
        setAgent(status.agent);
        if (status.state === 'resting' || !status.agent) setGate({ kind: 'resting', until: status.until ?? undefined });
      })
      .catch(() => { /* Unreachable: the page stays at rest; a question will say what is wrong. */ });
    return () => abort.abort();
  }, []);

  /* The clock in "Reading the code · 0:14", only while something is pending. */
  useEffect(() => {
    if (!pending) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [pending]);

  const update = useCallback((patch: Partial<Turn>) => {
    setTurns((list) => list.map((turn, i) => (i === list.length - 1 ? { ...turn, ...patch } : turn)));
  }, []);

  /* Poll the pending question every 1.5 s; give up at 180 s. */
  const questionId = pending ? current?.questionId : undefined;
  const startedAt = current?.startedAt ?? 0;
  useEffect(() => {
    if (!questionId) return undefined;
    const abort = new AbortController();
    let timer = 0;
    const poll = async () => {
      if (Date.now() - startedAt > ASK_GIVE_UP_MS) {
        update({ state: 'failed' });
        return;
      }
      try {
        const read = await readQuestion(questionId, abort.signal);
        if (abort.signal.aborted) return;
        if (read.state === 'resting') {
          /* The plan ran short mid-turn: not counted, and the visitor sees
             the resting box rather than an error. */
          setTurns((list) => list.slice(0, -1));
          setGate({ kind: 'resting', until: read.until ?? undefined });
          return;
        }
        update({ state: read.state, position: read.position ?? 0, files: read.files ?? [], answer: read.answer ?? undefined });
        if (isPending(read.state)) timer = window.setTimeout(poll, ASK_POLL_MS);
      } catch {
        if (abort.signal.aborted) return;
        timer = window.setTimeout(poll, ASK_POLL_MS);
      }
    };
    timer = window.setTimeout(poll, ASK_POLL_MS);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [questionId, startedAt, update]);

  const ask = async (raw: string) => {
    const question = raw.trim().slice(0, ASK_MAX_CHARS);
    if (!question || pending || sending || (gate && gate.kind !== 'busy')) return;
    setSending(true);
    setGate(null);
    const startedAt = Date.now();
    setNow(startedAt);
    try {
      const reply = await askQuestion(visitId(), question);
      if (reply.state === 'limited' || reply.state === 'resting') {
        setGate({ kind: reply.state, until: reply.until ?? undefined });
        if (reply.state === 'limited') setDraft(question);
        return;
      }
      if (reply.state === 'busy') {
        setGate({ kind: 'busy' });
        setDraft(question);
        return;
      }
      setDraft('');
      setTurns((list) => [...list, { question, state: 'queued', questionId: reply.questionId, position: reply.position ?? 0, files: [], startedAt }]);
    } catch {
      setTurns((list) => [...list, { question, state: 'failed', position: 0, files: [], startedAt }]);
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  const name = agent?.name ?? null;
  const resting = gate?.kind === 'resting';
  const limited = gate?.kind === 'limited';
  const seconds = current ? (now - current.startedAt) / 1000 : 0;
  const earlier = turns.slice(0, -1);
  const showQuestions = !resting && !limited && (turns.length === 0 || current?.state === 'declined');
  const answeredFiles = current && (current.state === 'answered') ? current.files : [];

  const marginTitle = current && pending && current.files.length > 0 ? 'Reading' : current?.state === 'answered' && current.files.length > 0 ? 'It read' : 'What it reads';
  const marginFiles = marginTitle === 'What it reads' ? [] : current!.files;

  return (
    <Screen id="ask" label="Ask an agent">
      <h2 className={`[text-wrap:balance] ${H2}`}>{ASK_HEADING}</h2>

      {/* The visible agent (decision 1): its face, its name, what it is. */}
      <div data-ask-agent className={`mt-5 flex items-center gap-3 type-sm text-hint sm:mt-7 sm:type-base ${resting ? 'grayscale' : ''}`}>
        {agent?.avatarUrl ? (
          <img src={agent.avatarUrl} alt="" width={32} height={32} className={`h-8 w-8 shrink-0 rounded-full object-cover ${resting ? 'opacity-55' : ''}`} />
        ) : (
          <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full bg-panel-soft" />
        )}
        <span>
          {name ? <><b className="font-semibold text-white">{name}</b> · </> : null}
          {ASK_AGENT_LINE}
        </span>
      </div>

      <div className="mt-5 grid gap-14 sm:mt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div data-ask-talk className="flex min-w-0 flex-col lg:min-h-[300px]">
          {/* Earlier questions of this visit, folded to their first line. */}
          {earlier.length > 0 ? (
            <div className="mb-6 grid gap-2 border-b border-hint/16 pb-5">
              {earlier.map((turn, index) => (
                <details key={index} className="group">
                  <summary className="cursor-pointer list-none type-base font-semibold text-hint marker:hidden hover:text-white">
                    <span className="line-clamp-1">{turn.question}</span>
                  </summary>
                  {turn.answer ? <div className="mt-2 max-w-[38em] space-y-3 type-base text-white"><AnswerText text={turn.answer} /></div> : null}
                </details>
              ))}
            </div>
          ) : null}

          <div aria-live="polite" className="min-w-0">
            {current && !resting ? (
              <Fragment>
                <p data-ask-question className="max-w-[34em] break-words type-md-sm font-semibold text-white sm:type-md">{current.question}</p>
                {pending ? (
                  <>
                    <p data-ask-pending className="mt-4 flex items-center gap-2.5 type-sm text-hint sm:type-base">
                      <Dots />
                      {pendingLine(current, seconds)}
                    </p>
                    {current.files.length > 0 ? (
                      <p className="mt-2 type-sm text-hint lg:hidden">
                        Opening <code className="font-mono type-xs text-white">{current.files[current.files.length - 1].split('/').pop()}</code>
                      </p>
                    ) : null}
                  </>
                ) : null}
                {current.state === 'answered' && current.answer ? (
                  <div data-ask-answer className="mt-3.5 max-w-[38em] space-y-3 type-base leading-relaxed text-white sm:type-md-sm sm:leading-relaxed">
                    <AnswerText text={current.answer} />
                  </div>
                ) : null}
                {current.state === 'declined' ? (
                  <div data-ask-declined className="mt-3.5 max-w-[38em] space-y-3 type-base leading-relaxed text-hint sm:type-md-sm sm:leading-relaxed">
                    <AnswerText text={current.answer || 'I only answer questions about Agentic Cloud Computer.'} />
                  </div>
                ) : null}
                {current.state === 'failed' ? (
                  <p data-ask-failed className="mt-3.5 max-w-[38em] type-base text-hint sm:type-md-sm">{ASK_FAILED}</p>
                ) : null}
                {answeredFiles.length > 0 ? (
                  <div data-ask-readlist className="mt-5 border-t border-hint/16 pt-4 type-sm text-hint lg:hidden">
                    <p className="mb-2 font-semibold text-white">It read {answeredFiles.length} file{answeredFiles.length === 1 ? '' : 's'}</p>
                    <FileList files={answeredFiles} />
                  </div>
                ) : null}
              </Fragment>
            ) : null}
          </div>

          {showQuestions ? (
            <div data-ask-questions className={`flex flex-col items-stretch gap-2.5 sm:flex-row sm:flex-wrap sm:items-start ${current ? 'mt-4' : 'mt-1'}`}>
              {ASK_QUESTIONS.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => void ask(question)}
                  disabled={sending}
                  className="inline-flex min-h-11 items-center rounded-[22px] border border-white/30 px-[18px] py-2 text-left type-sm font-medium text-white transition-colors hover:border-white hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:rounded-full sm:py-0 sm:type-base"
                >
                  {question}
                </button>
              ))}
            </div>
          ) : null}

          <div className={`mt-auto ${resting ? 'pt-1' : 'pt-7'}`}>
            {resting ? (
              <Wall
                title={`${name ?? 'The agent'} is resting ${localTime(gate?.until) ? `until ${localTime(gate?.until)}` : 'for now'}.`}
                line="It answers again then. Everything it reads is open, so you can read it yourself."
                links={[['Read the code', ASK_REPO_URL], ['Read the docs', DOCS_URL], ['Write to the founder', FOUNDER_MAILTO]]}
              />
            ) : limited ? (
              <Wall
                title="That’s ten questions this hour."
                line={`You can ask again${localTime(gate?.until) ? ` at ${localTime(gate?.until)}` : ' within the hour'}. The code is open in the meantime.`}
                links={[['Read the code', ASK_REPO_URL], ['Write to the founder', FOUNDER_MAILTO]]}
              />
            ) : (
              <>
                {gate?.kind === 'busy' ? <p data-ask-busy role="status" className="mb-3 type-sm text-hint">{ASK_BUSY}</p> : null}
                <form onSubmit={submit} className="flex min-h-14 items-center gap-3 rounded-2xl bg-panel-soft py-2 pl-4 pr-2 sm:min-h-[60px] sm:pl-5">
                  <label htmlFor="ask-input" className="sr-only">Your question about Agentic Cloud Computer</label>
                  <input
                    id="ask-input"
                    ref={input}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={ASK_MAX_CHARS}
                    autoComplete="off"
                    enterKeyHint="send"
                    aria-describedby="ask-fine-print"
                    placeholder={phone ? ASK_PLACEHOLDER_PHONE : ASK_PLACEHOLDER}
                    className="ask-input min-w-0 flex-1 bg-transparent type-base text-white placeholder:text-hint focus:outline-none sm:type-md-sm"
                  />
                  <button
                    type="submit"
                    disabled={pending || sending}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-xl bg-white px-4 type-sm font-semibold text-panel transition-colors hover:bg-white/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-hint/35 sm:px-[22px]"
                  >
                    Ask
                  </button>
                </form>
                <p id="ask-fine-print" className="mt-2.5 type-xs text-hint">{ASK_FINE_PRINT}</p>
              </>
            )}
          </div>
        </div>

        {/* The margin on a desk: what it reads at rest, the files as it opens
            them, then what it read, each linked to the public code. */}
        <aside data-ask-margin aria-label="Files it read" className="hidden border-l border-hint/16 pl-6 type-sm text-hint lg:block">
          <p className="mb-3 type-sm font-semibold text-white">{marginTitle}</p>
          {marginFiles.length > 0 ? (
            <FileList files={marginFiles} reading={pending} />
          ) : (
            <p className="leading-relaxed">{ASK_MARGIN_REST}</p>
          )}
        </aside>
      </div>
    </Screen>
  );
}
