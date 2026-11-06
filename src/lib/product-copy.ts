/**
 * The answers the front page gives, in one place.
 *
 * The rule this file exists to keep: copy lives in exactly one place. On
 * 2026-08-29 the site dropped every price of ours and the outreach messages
 * went on quoting a launch price for hours, because the same offer had been
 * written down twice — and a prospect who reads one and then opens the other
 * catches it in one click. The entry pages answer the same questions a reader
 * arrives with, so they quote these strings rather than paraphrasing them:
 * change an answer here and every surface that makes the claim changes with it.
 *
 * No page renders all of them since the landing's FAQ came off (2026-10-08):
 * each entry page picks the few its own reader is actually asking.
 */
export interface Faq {
  key: string;
  question: string;
  answer: string;
  /** The chapter of the documentation that says the rest: an address under /docs. */
  docs: string;
}

export const FAQS: Faq[] = [
  {
    key: 'what',
    question: 'What do I actually get?',
    answer:
      'A team of Claude Code, Codex and OpenCode agents, each with a name and a job, and everything they need already built in: git, hosting, storage, email, Drive, notes and memory. The agents read the notes and knowledge pages before a job and write back what they learned. A change to protected code waits for a person to approve it. When an agent is replaced, what was written down stays with the team.',
    docs: '/docs/agents',
  },
  {
    key: 'different',
    question: 'How is it different from running Claude Code or Codex myself?',
    answer:
      'The same official CLIs, with everything around them already there: git, hosting, storage, email, notes and memory. Many work at once, they share what the team wrote down, and a change to protected code waits for your yes, or merges itself once you turn on auto-merge.',
    docs: '/docs/agents#the-machine',
  },
  {
    key: 'chief',
    question: 'What is the Chief of Staff?',
    answer:
      'Your own agent for the whole workplace, and the first screen you see. Tell it what you want done and it brings agents in, hands the work out and brings back what needs your decision. It cannot approve anything. That stays with you.',
    docs: '/docs/talking-to-agents#your-chief-of-staff',
  },
  {
    key: 'chief-alone',
    question: 'Does the Chief of Staff act on its own?',
    answer:
      'Only when you switch it on. Then it notices a red build, a proposal still waiting, a report nobody answered or a note nobody picked up, and tells you when it matters. Without asking, it may do only the few things you choose. During your quiet hours it waits unless a build breaks. Each turn it starts runs on your own plan.',
    docs: '/docs/talking-to-agents#your-chief-of-staff',
  },
  {
    key: 'inside-company',
    question: 'Can a team inside a bigger company use it?',
    answer:
      'Yes. It runs in your company’s own cloud account, on your own domain. Your code, messages, files, email and keys all stay on your side. Your agent sets it up with one command: our clean run on 29 October took 13 min 24 s from a new cloud account to ready. The certificates came in under a minute that time; one has taken over an hour before. Your agents run on your own Claude or ChatGPT plans, and the code is ordinary git that can move to your company’s GitHub whenever you like.',
    docs: '/docs/workplace-and-people#one-workplace',
  },
  {
    key: 'needs',
    question: 'What do I need before I start?',
    answer:
      'Your company’s own cloud account and a domain for it. Nothing from us: no key, no licence. Your agent sets it up with one command: our clean run on 29 October took 13 min 24 s from a new cloud account to ready. The certificates came in under a minute that time; one has taken over an hour before. Then each person connects an AI subscription — a Claude plan, which the official Claude Code uses, or a ChatGPT plan, which the official Codex CLI uses — and it stays theirs.',
    docs: '/docs/getting-started',
  },
  {
    key: 'cost',
    question: 'What does it cost?',
    answer:
      'Your own Agentic Cloud is free for now: no licence, no key and no charge from us. Your cloud provider bills your account directly for what it runs, your Claude or ChatGPT plan is billed by Anthropic or OpenAI, and any other service you connect bills you directly.',
    docs: '/docs/your-cloud-and-subscriptions#what-you-pay',
  },
  {
    key: 'breaking',
    question: 'What stops an agent from breaking something?',
    answer:
      'Changes to protected code come back as proposals with the exact change and its checks. An agent cannot merge code, approve a proposal, complete a deletion or widen access to a secret; those decisions stay with a person.',
    docs: '/docs/repositories-and-proposals#the-proposal-loop',
  },
  {
    key: 'keys',
    question: 'How does an agent use my API keys without seeing them in a chat?',
    answer:
      'You save a key once, in the Workspace’s Secrets section, with a line on what it is for. The value goes straight into storage. When an agent works, the key is placed in its machine’s environment, so the command that needs it reads the value while the agent works with the name, and the value is stripped from its transcript and activity. A key belongs to the workplace it was saved in, so an agent in another workplace cannot use it.',
    docs: '/docs/secrets#how-agents-use-it',
  },
  {
    key: 'team-keys',
    question: 'Can my teammates see my keys?',
    answer:
      'Nobody else sees a key you keep private to your own agent, not even an admin. A key saved for the workplace shows members its name, what it is for and a masked preview; only an admin can copy its value, replace it or delete it, and it reaches admins’ agents only until an admin opens it to every agent. Every value is encrypted at rest.',
    docs: '/docs/secrets#who-sees-what',
  },
  {
    key: 'who-sees-what',
    question: 'Who on my team can see what?',
    answer:
      'Code, notes, knowledge pages, Drive and sites belong to the whole workplace. Your conversations with your agents and your subscription are yours alone, and only you approve your agents’ proposals: an admin cannot read those conversations, use your plan or decide for you.',
    docs: '/docs/workplace-and-people#agents-are-personal',
  },
  {
    key: 'github',
    question: 'Can my agents work on our GitHub repositories?',
    answer:
      'Yes. Save a token for your GitHub or GitLab in Secrets and an agent works there, with your history, collaborators and checks where they are. Or keep the code here: ordinary git you can clone, or move to GitHub any day.',
    docs: '/docs/repositories-and-proposals#where-code-lives',
  },
  {
    key: 'seats',
    question: 'How do subscriptions work?',
    answer:
      'Your agents run the official Claude Code and Codex CLIs, unmodified, on machines of their own in your cloud account. Sign in to your Claude or ChatGPT plan once and it becomes a seat: the plan is used by the official CLI, and the bill stays between you and Anthropic or OpenAI. Every agent on it runs on that plan, several agents can share one seat, and a seat is yours alone: no teammate, admin included, can see or use it. Each seat shows how much of its five-hour and weekly windows is spent, with a mark where an even pace would be by now. More seats run more agents at once.',
    docs: '/docs/your-cloud-and-subscriptions#seats',
  },
  {
    key: 'models',
    question: 'Which models can my agents use?',
    answer:
      'The ones Claude Code and Codex offer: Opus, Fable or Sonnet on Claude Code, OpenAI’s GPT models on Codex. Pick the model and how hard it thinks per agent, and change it any time.',
    docs: '/docs/agents#the-agents-screen',
  },
  {
    key: 'teammates',
    question: 'Can my teammates use it?',
    answer:
      'Yes. An admin shares an invite link and approves each person who asks to join. Nobody gets in by signing up, and someone you remove is signed out at once.',
    docs: '/docs/workplace-and-people#inviting-people',
  },
  {
    key: 'where',
    question: 'Where does the work actually happen?',
    answer:
      'On a machine of its own per agent, in your company’s cloud account. The machine sleeps after about three quiet minutes and wakes in seconds when there is work. It keeps its files and unfinished work between turns, so tomorrow starts where today stopped.',
    docs: '/docs/agents#sleep-and-wake',
  },
];

/** The chosen answers, in the order asked for. Throws on an unknown key so a
 *  renamed question cannot silently drop a FAQ from a page. */
export function faqsFor(keys: string[]): Faq[] {
  return keys.map((key) => {
    const faq = FAQS.find((entry) => entry.key === key);
    if (!faq) throw new Error(`Unknown FAQ key: ${key}`);
    return faq;
  });
}

/** The site-wide footer line, one telling of the pitch for every page that is
 *  not the landing itself. */
export const FOOTER_PITCH = 'Claude Code, Codex and OpenCode agents, with everything they need built in.';

/** The lead the product page opens on, and that the home page's product
 *  section, the title, the metas, the social card and llms.txt carry (note
 *  #787, the owner, 2026-10-25). Until then: "Give Claude Code a team, and a
 *  cloud to work in." (note #182). Never "a cloud computer", "beyond the
 *  laptop" or "works with your laptop closed": Claude Code and Codex do that
 *  themselves now, so it is no reason to choose us. */
export const PRODUCT_HEADLINE = 'Everything an agent needs to finish the job.';

/* "Free, on the plan you already pay for." until note #822 (the owner,
   2026-10-28): only the private copy is offered, and a copy was then free
   only in its one-month trial or for a design partner, so the line says where
   it runs instead. Since note #935 (2026-11-01) your own Agentic Cloud is free
   for now, with no licence and no key (claims-we-never-make). */
export const BUILT_IN_LINE =
  'Git with CI/CD, hosting, storage, email, Drive, notes and memory, built in for Claude Code, Codex and OpenCode agents. In your own cloud account, on the plan you already pay for.';
