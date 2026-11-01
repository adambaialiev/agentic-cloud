/**
 * The first ten minutes of a new workplace, in the Chief of Staff's chat
 * (note #726, Rosa's design, the owner's five decisions of 2026-10-11).
 *
 * After Create account the person lands on Home — the Chief of Staff's
 * conversation — and stays there. No plan is signed in yet, so there is
 * nothing to think with: the first two lines the Chief of Staff says are
 * FIXED TEXT the platform writes (the owner's decision 2), and the Claude or
 * ChatGPT sign-in is asked for inside the chat only once the person has
 * said what they are working on. When the plan lands, the Chief of Staff's
 * first real turn starts by itself on what they wrote.
 *
 * Every line here is shown exactly as written; the wording is Rosa's
 * (Growth), and a change to it is hers to make.
 */

/** The greeting, the first time Home opens on a new workplace. */
export function firstRunGreeting(firstName: string | undefined): string {
  const name = firstName?.trim();
  return name
    ? `Hi ${name}, I'm your Chief of Staff. Tell me what you're working on, and I'll put a team of agents on it.`
    : 'Hi, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.';
}

/** The three starter answers under the greeting; a tap sends the text as the person's message. */
export const FIRST_RUN_STARTERS: readonly string[] = [
  'Put a waitlist page live for my idea.',
  'Look at my website and tell me what to fix first.',
  'Set up a team for my startup.',
];

/**
 * The sign-in ask, answering their first message while no plan is signed in.
 * It reads right whatever they wrote — even "hi" or a question — so it does
 * not promise to "set that up".
 */
export const FIRST_RUN_SIGNIN_ASK = 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.';

/** Another message before the sign-in: the card stays where it is. */
export const FIRST_RUN_SIGNIN_AGAIN = 'I\'ve kept that too. Sign in your plan above, and I\'ll start on all of it.';

/** The line under the picker card: the claims-we-never-make wording for both plans. */
export const FIRST_RUN_SIGNIN_WHERE = 'You sign in on Claude\'s or OpenAI\'s own page, and your password never touches us.';

/** The receipt row once the plan is in. */
export function firstRunSeatReceipt(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? 'Your Claude plan is signed in.' : 'Your ChatGPT plan is signed in.';
}

/** The setup line while the Chief of Staff's computer is built; "Thinking…" follows it. */
export const CHIEF_OF_STAFF_SETUP_PHASE = 'Getting your Chief of Staff ready…';

/** The receipt row for an agent the platform brought in on the Chief of Staff's behalf. */
export const agentBroughtInReceipt = (name: string) => `Brought in ${name}.`;

/**
 * The hello for a person who JOINS a workplace that already exists (note
 * #820): fixed text the platform writes the first time their Home opens,
 * by their first name, naming the workplace and saying what is already in
 * it — every agent and what it last did, and the newest
 * notes. No starter answers: those are for an empty workplace. The same
 * words on our platform and in a private copy.
 */
export interface JoinerWelcomeAgent { name: string; owner?: string; doing?: string }
export interface JoinerWelcomeFacts {
  firstName?: string;
  workplace: string;
  /** Every agent in ONE list, busiest first (note #843). */
  agents: JoinerWelcomeAgent[];
  /** Newest first; `href` opens the note in the Workspace. */
  notes: Array<{ title: string; href: string }>;
}
/** How much of a big workplace the hello names before it says "and N more". */
export const JOINER_WELCOME_LIMITS = { agents: 6, notes: 3, doing: 160 } as const;
/**
 * Members who joined before the hello shipped keep the old empty-chat words,
 * as workplaces made before note #726 kept theirs: "welcome" to somebody who
 * has been there for weeks would read wrong.
 */
export const JOINER_WELCOME_SINCE = '2026-10-28T00:00:00.000Z';

// Words that land inside Markdown: a stray star or bracket must not become markup.
const plain = (text: string) => text.replace(/[*_`[\]]/g, '').replace(/\s+/g, ' ').trim();
/** One line of what an agent did: the first sentence of its row's recap, kept short. */
export function joinerDoingLine(recap: string): string {
  const text = plain(recap.split('\n').map((line) => line.replace(/^\s*[-•]\s*/, '')).find((line) => line.trim()) ?? '');
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
  const max = JOINER_WELCOME_LIMITS.doing;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[\s,;:]+$/, '')}…`;
}

export function joinerWelcome(facts: JoinerWelcomeFacts): string {
  const name = facts.firstName?.trim();
  const workplace = plain(facts.workplace) || 'this workplace';
  const hello = `${name ? `Hi ${name}` : 'Hi'}, welcome to ${workplace}. I'm your Chief of Staff here.`;
  if (!facts.agents.length && !facts.notes.length) {
    return `${hello} Nothing has been built here yet. Tell me what you're working on, and I'll put a team of agents on it.`;
  }
  const parts = [`${hello} Here's what's already going on.`];
  const { agents: agentMax, notes: noteMax } = JOINER_WELCOME_LIMITS;
  if (facts.agents.length) {
    const lines = facts.agents.slice(0, agentMax).map((agent) => {
      const who = agent.owner ? `**${plain(agent.name)}**, ${plain(agent.owner)}'s agent` : `**${plain(agent.name)}**`;
      return `- ${who}: ${agent.doing ? agent.doing : 'nothing yet.'}`;
    });
    const more = facts.agents.length - agentMax;
    if (more > 0) lines.push(`- and ${more} more ${more === 1 ? 'agent' : 'agents'}`);
    parts.push(['**Agents**', ...lines].join('\n'));
  }
  if (facts.notes.length) {
    parts.push(['**Latest notes**', ...facts.notes.slice(0, noteMax).map((note) => `- [${plain(note.title) || 'Untitled note'}](${note.href})`)].join('\n'));
  }
  parts.push('Ask me about any of it, or tell me what you\'d like to work on.');
  return parts.join('\n\n');
}
