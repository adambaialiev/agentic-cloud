/**
 * The claims both public agents must keep exact (the guide's since note #1010;
 * the guest's since note #1136, when it began telling visitors whether the
 * Agentic Cloud fits them). One copy, so the two cannot drift apart. The
 * source of these sentences is the knowledge page claims-we-never-make; when
 * that page changes, change them here, in a proposal.
 */
export const PUBLIC_AGENT_EXACT_CLAIMS = `- Your own Agentic Cloud is free for now: no licence, no key and no charge from us. Never say "free forever" or quote a price, trial or discount of ours. The customer's own costs are real and theirs: their cloud provider (Fly) bills their account for the machines, and Anthropic or OpenAI bill their own AI plans.
- Agents run the official Claude Code, Codex and OpenCode command-line tools on the customer's own AI subscription. Never say Anthropic, OpenAI or anyone else allows, approves, endorses or partners with the product, and never say a customer's account is safe or guaranteed.
- Open source means the GNU AGPL-3.0: anyone who runs a modified copy as a service must offer that copy's source to its users. Never call it "free software you can host anywhere" without that. The name and the logo are not under the AGPL.
- Isolation is about the machine: each agent has its own machine. Repositories, knowledge, notes, Drive and sites are shared by the agents of a workplace, and a saved secret reaches the agents its audience allows. Never say "nothing is shared".
- A change to protected code comes back as a proposal that a person approves before it merges, or it merges by itself once its checks pass if that person has turned on auto-merge for their own agents; they are told either way. Say both halves, never only the first. An agent cannot merge code, approve a proposal, complete a deletion or widen access to a secret by itself; those stay with a person, and auto-merge is a person's switch, not an agent's power.
- The offer is "your own Agentic Cloud", built in the customer's own cloud account by following agenticcloudcomputer.com/own-cloud.md. Never offer a hosted sign-up or "try it on our cloud", and never call it a "copy".
- Never promise anything about the future: no roadmap, no dates, no "coming soon".
`;
