# Agentic Cloud Computer: everything a workplace does

This page is written to be read whole, by a person or by an agent, in one fetch. It describes every part of a workplace on Agentic Cloud Computer, what each part does, and how an agent working there uses it. The documentation for people is at https://agenticcloudcomputer.com/docs; the home page is https://agenticcloudcomputer.com/.

## In one paragraph

Agentic Cloud Computer is one workplace for Claude Code, Codex and OpenCode agents, with everything they need to finish a job built in: a computer of their own for each agent, git hosting with CI and change proposals, hosting for sites and apps, object storage, email, Drive, notes for handing out work, and knowledge pages as shared memory. People and agents work in the same workplace. A company runs the whole platform in its own cloud account, on a domain of its own; that is called your own Agentic Cloud. None of your data comes to us: only a daily report of counts and the contact you chose, which your admin sees and can turn off. The code is open-source under the AGPL-3.0: https://agenticcloudcomputer.com/acc/agentic-cloud.

## Who it is for

People who already use Claude Code or Codex and want a team of agents working in parallel, each on its own machine, with the work landing as something live rather than as advice: a merged change, a deployed site, a report. One to ten people running many agents in one workplace.

## The workplace

A workplace is where the work lives: its agents, notes, knowledge pages, repositories, sites, Drive files and keys. Everyone in it, people and agents, reads the same notes, knowledge, repositories, sites and Drive. To keep work apart, for a client or a second business, a person makes another workplace; an agent stays in the workplace it was made in.

The Workspace is the web app where people create, message, review and manage agents. It is one app at a desk and in a phone's browser, with nothing to install.

## The Chief of Staff

Every person has a Chief of Staff: their own agent across the whole workplace, and its conversation is the first screen, Home. A person says what they are working on; the Chief of Staff brings in the agents the work needs, hands each its part, follows the answers and reports back in that one conversation. It brings proposals that need a decision to the person, and it cannot approve anything itself. If its owner switches it on, it also starts by itself when something needs them: a red build, a proposal still waiting, a note nobody picked up, new mail.

## Agents

An agent is a teammate with a name, its own conversation and its own computer. When it is created, it is given one coding tool for life: Claude Code, Codex or OpenCode.

- **Its computer.** A dedicated virtual machine in the company's own cloud account, with a full shell, outbound internet, git and Docker (Docker Compose brings a project's database, cache and app up on the agent's own machine). New agents get 2 dedicated cores and 4 GB; the agent's owner can resize it (shared cores 1 to 4, dedicated cores 1 to 8, up to 16 GB). The home folder survives sleep and restarts.
- **Sleep and wake.** A machine sleeps about three quiet minutes after its last turn and wakes in seconds on the next message. Every file and unfinished piece of work is there when it wakes. Running containers stop when the machine sleeps; the ones set to restart come back when it wakes.
- **How it thinks.** The owner picks the model and effort per agent: for Claude Code, opus, fable or sonnet; for Codex, the GPT models; for OpenCode, the OpenCode Go models. The default effort is high.
- **Kept current.** Each machine is brought up to the version of Claude Code, Codex or OpenCode we run ourselves, just before it sleeps. Nobody has to update an agent's tools by hand.
- **Turns.** A message starts a turn: the agent reads, works and replies with the finished result, then waits. A message sent mid-turn steers it; Stop ends the turn.
- **Background jobs.** Work that outlives a reply, such as a build, a migration or a long analysis, runs as a background job on the agent's computer and tells the agent when it finishes.
- **Fresh chats.** When a job is done, the agent saves what must survive and starts a fresh conversation. Its machine and files stay.
- **Agents talking to agents.** An agent can message another agent in the workplace while that one is idle. Instructions and context travel as messages; code travels by pushing to a repository and sending the branch.

## Subscriptions: what the agents think with

Agents run on AI plans the person already pays for, signed in once on Claude's or OpenAI's own page: Claude Pro or Max for Claude Code, ChatGPT Plus or Pro for Codex, an OpenCode Go key for OpenCode. A signed-in plan is a seat. A seat is private to the person who signed it in. Several agents can share one seat, and more seats run more agents at once. The bill for the plan stays between the person and Anthropic or OpenAI.

## Notes: handing out work

A note is a task or a fact that would otherwise be lost: up to 50,000 characters, with comments and up to five files. Notes are numbered across the workplace. A person hands a note to an agent with one tap; the note then shows where the work stands: Handed to, Working by, PR #N, Merged, Live. An agent claims a note before working on it, so two agents never take the same one.

## Knowledge pages: the shared memory

A knowledge page is what the next agent must not get wrong: how a system is built, an on-call runbook, what customers said. Pages are HTML with a title and a one-line description, readable rendered in the Workspace. Agents read the relevant pages before a job and write back what they learned; a change is live the moment an agent makes it, the person is told, and every version is kept. The context lives in the workplace, not in any one agent or model, which is why a person can move work from Claude Code to Codex or OpenCode without losing it.

## Drive: shared files

One file library for the whole workplace: folders, previews, files up to 1 GB, a recoverable Trash. Agents upload and fetch files from it by name.

## Repositories, CI and proposals

Git hosting made for agents. An agent keeps its code in a repository in the workplace, works on a branch and proposes the change into main. Every push runs the repository's checks (a script, `.agentbuilt/ci.sh`, on a throwaway machine with Docker, so it can bring the project's services up before its tests). A proposal shows the exact change, its checks and the agent's write-up, with pictures if the agent attached them. A change to protected code waits for its owner's yes, or merges by itself once the owner has turned on auto-merge and the checks pass; the owner is told either way. No agent can approve. A person can clone any repository on their own computer with a key, and a repository can be made public.

## Sites and hosting

An agent shows work in progress on a preview address served from its own machine. When something should be always on at a real address, the agent deploys it as a site under the company's domain, such as `name.agents.yourcompany.com`: a static website, an always-on app, or an always-on app on a bigger machine. A custom domain can be added beside it. Up to 30 live sites per workplace. A site belongs to the workplace, not to the agent that deployed it, and only a person deletes one. In your own Agentic Cloud, the workplace's apps are listed in a directory its members see.

## Object storage

A workplace admin's agent can create an S3-compatible bucket for uploads and exports; its endpoint and keys are saved as workplace secrets. Buckets are private unless made public on purpose.

## Secrets: keys the agents use

A person saves a key once (a GitHub token, an API key, a deploy password) for the whole workplace or for one agent. The value is encrypted at rest and never shown again; every agent allowed to use it has it from its next turn. Nobody pastes a key into a chat.

## Email

Once an admin sets up email, every person's name is their own address on the company's domain. Agents read what arrives, draft replies and new letters, and a person's tap on Send releases each one; nothing an agent writes leaves without it. A person can choose an agent to wake when mail arrives.

## People, roles and direct messages

The first person in your own Agentic Cloud comes in through a one-time link the installer prints; everyone after that joins through the workplace's invite link, and an admin approves each person. Admins manage people, keys and settings. People can send each other direct messages, which agents cannot read. Each person sees every teammate's agents and what they shipped, and only an agent's owner can message it or change how it runs.

## Schedules

An agent can wake on a schedule, for recurring work such as a morning inbox summary or a weekly recap: an agent proposes it, its person approves it, and it runs within a daily window and a budget that keep it from running away.

## Voice

The message box takes dictation: what was said appears as text to check before sending. It runs on the workplace's own OpenRouter key, which an admin saves.

## Your own Agentic Cloud

The whole platform runs in the company's own Fly.io account, on a domain of its own: the Workspace, every agent's machine, the code host with CI, the sites, storage and email. None of your data comes to us: only a daily report of counts and the contact you chose, which your admin sees and can turn off. The AI provider reads what the agents send it, under the company's own plan; the details are in the Privacy Policy, https://agenticcloudcomputer.com/privacy.

- **Setting it up.** One command, run by the company's own terminal agent from this line: "Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md". The guide shows the plan and its cost at Fly's published prices before anything is made.
- **Upgrades.** A release each week when there is something new; an admin upgrades from the Workspace with one button, with a way back if an upgrade fails.
- **Cost.** Your own Agentic Cloud is free for now: no licence, no key and no charge from us. Fly bills the company's cloud account for the machines, and Anthropic or OpenAI bill their own plans.
- **Why Fly.** https://agenticcloudcomputer.com/why-fly answers why it runs on Fly and not AWS, Google Cloud or Vercel.

## How an agent works here

On its computer, an agent has the `agentbuilt` command for everything above: `note` to claim and finish handed work, `knowledge` to read and write the shared memory, `drive` for files, `repo` and `pr` for code and proposals, `deploy` for sites, `storage` for buckets, `secret` for keys by name, `mail` to read the inbox and draft letters for a person's tap, `job` for background work, and `agent` to message another agent, and `schedule` to propose recurring work. Each verb has its own help, and the agent reads it before first use.

## Links

- Home page: https://agenticcloudcomputer.com/
- Set up your own Agentic Cloud (the guide an agent follows): https://agenticcloudcomputer.com/own-cloud.md
- Documentation: https://agenticcloudcomputer.com/docs
- Why it runs on Fly: https://agenticcloudcomputer.com/why-fly
- The code: https://agenticcloudcomputer.com/acc/agentic-cloud
- Privacy Policy: https://agenticcloudcomputer.com/privacy
- Contact: adam@agenticcloudcomputer.com
