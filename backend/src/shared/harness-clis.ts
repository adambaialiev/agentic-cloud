/**
 * The harness CLIs this product runs, and what each is called where a person
 * reads it. SHARED between the backend and the Workspace: three harnesses
 * since note #780 (OpenCode beside Claude Code and Codex), and every place
 * that used to say `cli === 'claude' ? 'Claude Code' : 'Codex'` would have
 * quietly called the third one Codex. Nothing here may import from outside
 * `shared/`.
 */

/** Creation order of the choices; storage may still hold a retired value (see isSupportedAgentCli). */
export const HARNESS_CLIS = ['codex', 'claude', 'opencode'] as const;

export type HarnessCli = (typeof HARNESS_CLIS)[number];

export function isHarnessCli(value: string | null | undefined): value is HarnessCli {
  return (HARNESS_CLIS as readonly string[]).includes(value ?? '');
}

/** The harness as a product: "Claude Code", "Codex", "OpenCode". A value this product does not run keeps its own word. */
export function harnessName(cli: string): string {
  if (cli === 'claude') return 'Claude Code';
  if (cli === 'codex') return 'Codex';
  if (cli === 'opencode') return 'OpenCode';
  return cli;
}

/** The subscription a harness runs on: "Claude", "ChatGPT", "OpenCode". */
export function subscriptionName(provider: string): string {
  if (provider === 'codex') return 'ChatGPT';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'claude') return 'Claude';
  return provider;
}

/**
 * Said where a sign-in's usage would be, when there is no reading of it. An
 * OpenCode key reads none at all: Go and Zen show usage only in the OpenCode
 * console, to a signed-in person, and no endpoint answers a key with it
 * (checked 2026-10-20, note #780). What the platform CAN say is the limit
 * itself, when a turn meets it.
 */
export const OPENCODE_USAGE_NOTICE = 'OpenCode keeps this subscription’s usage in its own console at opencode.ai, so it can’t be read here. When a limit is reached, your agent says so and when it frees up.';

export function seatNoReadingNotice(provider: string): string {
  if (provider === 'codex') return 'Usage appears after this subscription completes its first message.';
  if (provider === 'opencode') return OPENCODE_USAGE_NOTICE;
  return 'No reading yet.';
}
