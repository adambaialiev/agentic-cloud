import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentRecapPrompt,
  buildClaudeRecapCommand,
  buildCodexRecapCommand,
  buildOpenCodeRecapCommand,
  agentRecapTextOfOpenCode,
  capAgentRecapMessages,
  composeSeedAgentRecap,
  normalizeAgentRecapText,
  parseAgentRecapOutput,
  parseAgentRecapResult,
  runAgentRecapSummarizer,
  TELEGRAM_AGENT_RECAP_MAX_LENGTH,
  TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH,
} from '../../services/agent-recap.js';
import { quoteShellArg } from '../../utils/shell-quote.js';

/**
 * The recap summarizer (agent-row-recap-design). Everything here is the
 * contract's edges: the model's output is untrusted text, the command runs on
 * a real machine over SSH, and every failure must come out as undefined —
 * silence — because a stale recap beats a broken row.
 */

describe('capAgentRecapMessages', () => {
  it('keeps the FIRST message and the newest tail — the request always survives', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'agent' as const, text: `m${i}`,
    }));
    messages[0] = { role: 'owner' as const, text: 'the request' } as never;
    const capped = capAgentRecapMessages(messages);
    expect(capped).toHaveLength(6);
    expect(capped[0]!.text).toBe('the request');
    expect(capped.at(-1)!.text).toBe('m9');
  });

  it('cuts an oversized message instead of dropping it', () => {
    const [only] = capAgentRecapMessages([{ role: 'owner', text: 'x'.repeat(5000) }]);
    expect(only!.text.length).toBeLessThanOrEqual(3001);
    expect(only!.text.endsWith('…')).toBe(true);
  });
});

describe('normalizeAgentRecapText', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(normalizeAgentRecapText('  keeps the\n shop\tsite  ')).toBe('keeps the shop site');
  });

  it('caps at a word boundary with an ellipsis — a cut, never a rejection', () => {
    const long = 'word '.repeat(200);
    const capped = normalizeAgentRecapText(long)!;
    expect(capped.length).toBeLessThanOrEqual(TELEGRAM_AGENT_RECAP_STORE_MAX_LENGTH);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped).not.toMatch(/wor…$/);
  });

  // Note #67: the store cap and the row's size are different numbers, and
  // storing at the row's size was the bug — the agent screen's "recap, whole"
  // had nothing whole to show. A recap that overran its brief is kept, and it
  // is kept UNCUT: no ellipsis, because nothing was thrown away.
  it('keeps a recap that overran the row brief, whole', () => {
    const over = 'a'.repeat(TELEGRAM_AGENT_RECAP_MAX_LENGTH + 60);
    expect(normalizeAgentRecapText(over)).toBe(over);
  });

  // And the clause most likely to be over the edge is the one that matters
  // most: what waits on the owner.
  it('keeps the clause that says something waits on the owner', () => {
    const recap = `${'Works on the platform. '.repeat(11)}Waiting on your approval.`;
    expect(recap.length).toBeGreaterThan(TELEGRAM_AGENT_RECAP_MAX_LENGTH);
    expect(normalizeAgentRecapText(recap)).toContain('Waiting on your approval.');
  });

  it('answers undefined for nothing usable', () => {
    expect(normalizeAgentRecapText('  \u0000 \n ')).toBeUndefined();
  });
});

describe('parseAgentRecapOutput', () => {
  it('reads clean JSON', () => {
    expect(parseAgentRecapOutput('{"recap":"keeps the shop site"}')).toBe('keeps the shop site');
  });

  it('fishes the JSON out of prose and fences — models wrap answers', () => {
    const stdout = 'Here is the recap:\n```json\n{"recap":"runs the tutor"}\n```\nHope that helps!';
    expect(parseAgentRecapOutput(stdout)).toBe('runs the tutor');
  });

  it('prefers the LAST candidate — earlier ones are the model quoting its instructions', () => {
    const stdout = '{"recap":"..."} means the shape. Final: {"recap":"the real one"}';
    expect(parseAgentRecapOutput(stdout)).toBe('the real one');
  });

  it('answers undefined for garbage, empty output, and JSON without the key', () => {
    for (const bad of ['', 'no json here', '{"other":"x"}', '{"recap": 42}', '{broken']) {
      expect(parseAgentRecapOutput(bad)).toBeUndefined();
    }
  });
});

// Note #707: the same answer says whether the work is FINISHED, and that
// verdict offers the owner a fresh chat — so only a literal true counts.
describe('parseAgentRecapResult', () => {
  it('reads the finished verdict beside the text', () => {
    expect(parseAgentRecapResult('{"recap":"Shipped the pricing page.","finished":true}'))
      .toEqual({ text: 'Shipped the pricing page.', finished: true });
    expect(parseAgentRecapResult('{"recap":"Waiting on your approval.","finished":false}'))
      .toEqual({ text: 'Waiting on your approval.', finished: false });
  });

  it('never reads a missing, quoted or mistyped verdict as finished', () => {
    for (const stdout of [
      '{"recap":"x"}',
      '{"recap":"x","finished":"true"}',
      '{"recap":"x","finished":"yes"}',
      '{"recap":"x","finished":1}',
    ]) {
      expect(parseAgentRecapResult(stdout)).toEqual({ text: 'x', finished: false });
    }
  });

  it('is silence when there is no usable text, whatever the verdict says', () => {
    expect(parseAgentRecapResult('{"recap":"  ","finished":true}')).toBeUndefined();
    expect(parseAgentRecapResult('{"finished":true}')).toBeUndefined();
  });
});

describe('composeSeedAgentRecap', () => {
  it('uses only the last task the agent named, never its retired description', () => {
    expect(composeSeedAgentRecap({
      about: 'Prices the ladders',
      tasks: [
        { text: 'Read the site again' },
        { text: 'rewrote the pricing hero — #36', byAgent: true },
      ],
    })).toBe('rewrote the pricing hero — #36');
  });

  it('ignores an about-only legacy record and answers undefined without an authored task', () => {
    expect(composeSeedAgentRecap({ about: 'Prices the ladders' })).toBeUndefined();
    expect(composeSeedAgentRecap({ tasks: [{ text: 'shipped it', byAgent: true }] })).toBe('shipped it');
    // A platform-written task line is the user's request, not a report — it
    // never seeds the recap.
    expect(composeSeedAgentRecap({ tasks: [{ text: 'Was the CLI released?' }] })).toBeUndefined();
    expect(composeSeedAgentRecap({})).toBeUndefined();
  });
});

describe('recap commands', () => {
  it('claude: hard-required model and effort, no tools, token as env prefix', () => {
    const command = buildClaudeRecapCommand('the prompt', 'tok-123');
    expect(command).toContain("CLAUDE_CODE_OAUTH_TOKEN='tok-123' claude -p");
    expect(command).toContain("--model 'sonnet'");
    expect(command).toContain("--effort 'xhigh'");
    expect(command).toContain("--disallowed-tools '*'");
    expect(command).toContain('--output-format text');
    // Without a token the machine's own credentials answer.
    expect(buildClaudeRecapCommand('p')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('codex: hard-required model and effort, read-only sandbox, last-message file', () => {
    const command = buildCodexRecapCommand('the prompt');
    expect(command).toContain("--model 'gpt-5.6-terra'");
    expect(command).toContain("-c 'model_reasoning_effort=xhigh'");
    expect(command).toContain('--sandbox read-only');
    expect(command).toContain('--output-last-message');
  });

  it('opencode: Go\'s fast model, every tool denied, its session deleted, its status kept (note #780)', () => {
    const command = buildOpenCodeRecapCommand('the prompt', 'sk-oc-key');
    expect(command).toContain("--model 'opencode-go/glm-5.3-flash' --variant 'high' --title 'Recap'");
    expect(command).toContain(`OPENCODE_PERMISSION='{"*":"deny"}'`);
    expect(command).toContain("OPENCODE_API_KEY='sk-oc-key'");
    // A turn's plugin is not written for a recap, and does not act in one.
    expect(command).not.toContain('plugins');
    expect(command).toContain("AGENTBUILT_OPENCODE_TURN='0'");
    expect(command).toContain('opencode session delete "$SID"');
    expect(command).toContain('< /dev/null');
    expect(command).toMatch(/exit "\$STATUS"$/);
    expect(buildOpenCodeRecapCommand('p')).not.toContain('OPENCODE_API_KEY');
  });

  it('opencode: the answer is read out of the text lines of the stream', () => {
    const stdout = [
      '{"type":"step_start","sessionID":"ses_a","part":{}}',
      '{"type":"text","sessionID":"ses_a","part":{"text":"{\\"recap\\":\\"Fixed it.\\",\\"finished\\":true}"}}',
      '{"type":"step_finish","sessionID":"ses_a","part":{"tokens":{"input":1}}}',
    ].join('\n');
    expect(agentRecapTextOfOpenCode(stdout)).toBe('{"recap":"Fixed it.","finished":true}');
  });

  it('both CLIs read stdin from /dev/null — without it the summarizer hangs', () => {
    // `claude -p` and `codex exec` both consume stdin when it is not a
    // terminal (codex appends it to the prompt as a <stdin> block), and the
    // exec channel's stdin is a pipe nobody fills. Codex shipped without the
    // redirect and every Codex agent's row silently stopped updating: the
    // call blocked until the 180s timeout, and a timeout is silence.
    expect(buildCodexRecapCommand('p')).toContain('< /dev/null');
    expect(buildClaudeRecapCommand('p')).toContain('< /dev/null');
  });

  it('shell-quotes the prompt so conversation text cannot become shell', () => {
    // `$( )` and backticks are inert inside single quotes; the attack surface
    // is an embedded single quote breaking out. Which escape spelling does
    // that belongs to quoteShellArg, whose own test proves it against a real
    // shell — what matters here is that the prompt goes through it at all.
    const prompt = "it's `$(rm -rf /)` o'clock";
    expect(buildClaudeRecapCommand(prompt)).toContain(quoteShellArg(prompt));
  });
});

describe('buildAgentRecapPrompt', () => {
  it('asks for a brief latest-work update without repeating the agent description', () => {
    const prompt = buildAgentRecapPrompt({
      previousRecap: 'Keeps the shop site',
      messages: [{ role: 'owner', text: 'fix the backup' }, { role: 'agent', text: 'fixed and verified' }],
    });
    expect(prompt).toContain('"Keeps the shop site"');
    expect(prompt).toContain('[owner] fix the backup');
    expect(prompt).toContain('[agent] fixed and verified');
    expect(prompt).toContain(String(TELEGRAM_AGENT_RECAP_MAX_LENGTH));
    expect(prompt).toContain('language the owner writes in');
    expect(prompt).toContain('Write exactly two short, direct sentences');
    expect(prompt).toContain('normally 30 words or fewer in all');
    expect(prompt).toContain('The second says where it stands now');
    expect(prompt).toContain('Do NOT describe the agent\'s standing role');
    expect(prompt).toContain('Never say that nothing is waiting');
    expect(prompt).toContain('previous recap is context, not a prefix');
    expect(prompt).not.toContain('what this agent is FOR');
    expect(TELEGRAM_AGENT_RECAP_MAX_LENGTH).toBe(240);
    // First recap ever: said plainly, not an empty string the model mirrors.
    expect(buildAgentRecapPrompt({ previousRecap: undefined, messages: [] })).toContain('(none yet)');
  });

  // Note #121: a workflow receipt is not a useful recap. Someone scanning the
  // fleet has not read this agent's turn, so an identifier or a vague pronoun
  // cannot stand in for the page, bug, or deliverable that actually changed.
  it('asks for a self-contained outcome instead of opaque workflow bookkeeping', () => {
    const prompt = buildAgentRecapPrompt({
      previousRecap: 'PR #341 merged.',
      messages: [
        { role: 'owner', text: 'Fix the divider on the file card.' },
        { role: 'agent', text: 'PR #349 is ready and tests passed.' },
      ],
    });

    expect(prompt).toContain('self-contained for a reader who did not see the conversation');
    expect(prompt).toContain('name the concrete page, feature, bug, decision, or deliverable');
    expect(prompt).toContain('Workflow bookkeeping is not the work');
    expect(prompt).toContain('State what changed; add an ID or verification only if space remains');
    expect(prompt).toContain('Keep it about this agent\'s work');
    expect(prompt).toContain('Avoid vague references');
  });

  it('a cited PR, note or page number carries what it is about, in parentheses (note #559)', () => {
    const prompt = buildAgentRecapPrompt({
      previousRecap: 'PR #1014 and knowledge page #248 both live for note #555; conversation cleared.',
      messages: [{ role: 'owner', text: 'pick up the note' }],
    });
    expect(prompt).toContain('A number alone tells a person nothing');
    expect(prompt).toContain('Never let a PR, note, or knowledge-page number stand for the work');
    expect(prompt).toContain('put what it is about in parentheses right after it');
    expect(prompt).toContain('"PR #1015 (last-reply age on agent screens) merged"');
    expect(prompt).toContain('or leave the number out and name the thing itself');
  });

  // Note #143: a mid-turn checkpoint summarizes half a turn, and the model
  // must know that — a summarizer that reads unfinished work as finished
  // writes a claim on the row that the turn may yet walk back.
  it('a mid-turn checkpoint says the turn is still running; a final run does not', () => {
    const messages = [{ role: 'owner' as const, text: 'fix the backup' }];
    const midTurn = buildAgentRecapPrompt({ previousRecap: undefined, messages, turnInProgress: true });
    expect(midTurn).toContain('STILL RUNNING');
    expect(midTurn).toContain('still in progress — the agent is working right now');
    expect(midTurn).toContain('never present unfinished work as finished');

    const finalRun = buildAgentRecapPrompt({ previousRecap: undefined, messages });
    expect(finalRun).not.toContain('STILL RUNNING');
    expect(finalRun).toContain('The conversation turn to fold in:');
  });

  // Note #707: the room offers a fresh chat to the agents this verdict calls
  // finished, so a doubt has to land on false — a wrong true is a lost chat.
  it('asks whether the work is finished, and says a doubt is not finished', () => {
    const messages = [{ role: 'owner' as const, text: 'fix the backup' }];
    const prompt = buildAgentRecapPrompt({ previousRecap: undefined, messages });
    expect(prompt).toContain('{"recap":"...","finished":false}');
    expect(prompt).toContain('true ONLY when the work your recap describes is done and nothing about it is still waiting');
    expect(prompt).toContain('no approval, review, decision, check, build, deploy or background job');
    expect(prompt).toContain('false whenever you are unsure');
    expect(prompt).not.toContain('so "finished" is false');
    expect(buildAgentRecapPrompt({ previousRecap: undefined, messages, turnInProgress: true }))
      .toContain('This turn is STILL RUNNING, so "finished" is false.');
  });

  /**
   * Note #367. A reset turn's transcript is the ceremony and nothing else, so
   * the "replace the previous recap when this turn has a newer useful state"
   * rule hands the row to the housekeeping and drops the work. Two live rows
   * showed it: "Reset the chat at owner's request; no work left in progress."
   */
  it('a turn that ended in a fresh chat carries the work forward instead of reporting the reset', () => {
    const messages = [
      { role: 'owner' as const, text: 'reset chat' },
      { role: 'agent' as const, text: 'I\u2019m starting us a fresh chat \u2014 everything important is saved.' },
    ];
    const afterReset = buildAgentRecapPrompt({
      previousRecap: 'Shipped the pricing page.',
      messages,
      chatReset: true,
    });
    expect(afterReset).toContain('THE CONVERSATION WAS CLEARED');
    expect(afterReset).toContain('housekeeping, not work');
    expect(afterReset).toContain('never let it become the whole recap');
    expect(afterReset).toContain('carry the WORK forward');
    // The previous recap is still the context it has to keep.
    expect(afterReset).toContain('"Shipped the pricing page."');
    expect(afterReset).toContain('the last one before the chat was cleared');
    // An agent with nothing to carry says the one true thing and stops.
    expect(afterReset).toContain('If the previous recap is empty and this turn did no other work');

    const ordinary = buildAgentRecapPrompt({ previousRecap: 'Shipped the pricing page.', messages });
    expect(ordinary).not.toContain('CONVERSATION WAS CLEARED');
    expect(ordinary).toContain('The conversation turn to fold in:');
  });
});

describe('runAgentRecapSummarizer', () => {
  const base = {
    sandboxId: 'fly-server-x',
    sshUser: 'agent',
    previousRecap: undefined,
    messages: [{ role: 'owner' as const, text: 'hello' }],
  };

  it('runs the CLI on the machine and returns the parsed recap', async () => {
    const execSync = vi.fn().mockResolvedValue({
      stdout: '{"recap":"keeps the shop site"}', stderr: '', exitCode: 0, timedOut: false,
    });
    const recap = await runAgentRecapSummarizer({
      ...base, sandboxClient: { execSync }, cli: 'claude', claudeOauthToken: 'tok',
    });
    expect(recap).toEqual({ text: 'keeps the shop site', finished: false });
    const [sandboxId, command, , options] = execSync.mock.calls[0]!;
    expect(sandboxId).toBe('fly-server-x');
    expect(String(command)).toContain('claude -p');
    expect(options).toMatchObject({ sshUser: 'agent' });
  });

  it('carries a finished verdict through, except for a turn still running', async () => {
    const execSync = vi.fn().mockResolvedValue({
      stdout: '{"recap":"Shipped the pricing page.","finished":true}', stderr: '', exitCode: 0, timedOut: false,
    });
    expect(await runAgentRecapSummarizer({ ...base, sandboxClient: { execSync }, cli: 'codex' }))
      .toEqual({ text: 'Shipped the pricing page.', finished: true });
    // The model was told a running turn is never finished; it is not trusted to obey.
    expect(await runAgentRecapSummarizer({ ...base, sandboxClient: { execSync }, cli: 'codex', turnInProgress: true }))
      .toEqual({ text: 'Shipped the pricing page.', finished: false });
  });

  it('kimi is out of scope by decision — no call is even attempted', async () => {
    const execSync = vi.fn();
    const recap = await runAgentRecapSummarizer({ ...base, sandboxClient: { execSync }, cli: 'kimi' });
    expect(recap).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it('every failure is silence: non-zero exit, timeout, thrown exec', async () => {
    for (const result of [
      { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false },
      { stdout: '{"recap":"late"}', stderr: '', exitCode: 0, timedOut: true },
    ]) {
      const execSync = vi.fn().mockResolvedValue(result);
      expect(await runAgentRecapSummarizer({ ...base, sandboxClient: { execSync }, cli: 'codex' }))
        .toBeUndefined();
    }
    const throwing = vi.fn().mockRejectedValue(new Error('ssh lost'));
    expect(await runAgentRecapSummarizer({ ...base, sandboxClient: { execSync: throwing }, cli: 'codex' }))
      .toBeUndefined();
  });
});
