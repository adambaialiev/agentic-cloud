import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `agentbuilt help <topic>` — the rules that left the instruction file.
 *
 * Note #702: every machine's CLAUDE.md / AGENTS.md had grown to 70 KB, read
 * into every turn of every agent, and the two largest sections (repositories,
 * knowledge-and-notes) were moved into the CLI in identity v153 so an agent
 * reads them the first time it touches that area instead of on every turn.
 *
 * The rules did not stop mattering by moving. The sentences pinned here are
 * the ones agent-service.test.ts used to pin in the instruction file — each
 * one written after an agent got it wrong in production — so this is where
 * their removal fails now. Run through the real CLI file the backend ships,
 * exactly as the note-cli tests do, because a topic that throws on render is
 * a topic nobody reads.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

function runCli(args: string[], home = '/nonexistent-agentbuilt-help-test'): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // No API url and no token on purpose: help must answer offline, on a
    // machine whose config is missing or whose backend is down.
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('agentbuilt help <topic>', () => {
  it('lists the topics on the bare help page, before the commands', async () => {
    const { status, stdout } = await runCli(['help']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help repos');
    expect(stdout).toContain('agentbuilt help knowledge');
    expect(stdout).toContain('agentbuilt help notes');
    for (const topic of ['hosting', 'mail', 'secrets', 'agents', 'chat']) expect(stdout).toContain(`agentbuilt help ${topic}`);
    // Read before the first command of that area, not after a refusal.
    expect(stdout).toContain('read BEFORE your first command of that area');
    expect(stdout.indexOf('agentbuilt help repos')).toBeLessThan(stdout.indexOf('Commands:'));
  });

  it('refuses an unknown topic by naming the ones there are', async () => {
    const { status, stderr } = await runCli(['help', 'drive']);
    expect(status).toBe(1);
    expect(stderr).toContain('no help topic "drive"');
    expect(stderr).toContain('repos, knowledge, notes, hosting, mail, secrets, agents, chat');
  });

  it('repos: the proposal gates, in the words that were written after each failure', async () => {
    const { status, stdout } = await runCli(['help', 'repos']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help repos — Repositories and proposals');
    // Wait for checks (v30), and the runnable chain that ends on the invitation.
    expect(stdout).toContain('WAIT FOR CHECKS BEFORE YOU PROPOSE');
    expect(stdout).toContain('agentbuilt repo checks --wait && agentbuilt pr create');
    expect(stdout).toContain('&& agentbuilt pr ready');
    expect(stdout).toContain('`pr ready` is a MESSAGE TO YOUR USER');
    expect(stdout).toContain('do NOT propose and then explain');
    expect(stdout).toContain('When there is nothing to wait FOR, do not wait');
    // The note link is a gate, not a label (note #99).
    expect(stdout).toContain('THE FLAG IS THE ONLY LINK');
    expect(stdout).toContain('stops with a warning when newer main overlaps the branch');
    // Workplace ownership (note #566) and its sharp edge; no room since note #843.
    expect(stdout).toContain('A repository belongs to the WORKPLACE — exactly as a Drive file does');
    expect(stdout).toContain('EVERY agent in the workplace can push straight to it');
    expect(stdout).toContain('checked against the workplace\'s shared keys');
    expect(stdout).not.toMatch(/\brooms?\b/i);
    // Grants apply at once, the owner is told (v163, note #739); why publishing by hand failed (v151).
    expect(stdout).toContain('the grant is applied AT ONCE');
    expect(stdout).not.toContain('CI access asked');
    expect(stdout).toContain('the link is applied AT ONCE');
    expect(stdout).toContain('PUBLISHING ON APPROVAL');
    expect(stdout).toContain('agentbuilt repo publish <repo> <site>');
    // The decision reaches whoever sent the card (v149).
    expect(stdout).toContain('run `pr ready` on a proposal ANOTHER of their agents opened');
    // Evidence on the proposal, not in the chat; the margin starts nobody.
    expect(stdout).toContain('SHOW THEM THE CHANGE');
    expect(stdout).toContain('A comment STARTS NOBODY');
    expect(stdout).toContain('CLOSED SOURCE');
    expect(stdout).toContain('Clone on your computer');
    // The sharing machinery is gone and must not come back through the move.
    expect(stdout).not.toContain('home room');
    expect(stdout).not.toContain('share it with additional rooms');
  });

  it('knowledge: one shelf, proposals that wait for ready, renames that keep the margin', async () => {
    const { status, stdout } = await runCli(['help', 'knowledge']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help knowledge — Knowledge pages');
    expect(stdout).toContain('on ONE shelf that belongs to the workplace');
    expect(stdout).toContain('CHECK IT BEFORE YOU GUESS');
    // Since note #746 a change is live at once and restorable; nothing waits.
    expect(stdout).toContain('A CHANGE IS LIVE THE MOMENT YOU MAKE IT');
    expect(stdout).toContain('agentbuilt knowledge restore <name>');
    expect(stdout).not.toContain('the invitation, LAST');
    expect(stdout).toContain('agentbuilt knowledge propose-rename <old> <new>');
    expect(stdout).toContain('No CSS and no JavaScript');
    expect(stdout).toContain('--attach diagram.png');
    expect(stdout).toContain('A page has a MARGIN too');
    expect(stdout).not.toContain("THE ROOM'S knowledge");
  });

  it('notes: the archive, the lease and the outcome owed to a note', async () => {
    const { status, stdout } = await runCli(['help', 'notes']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help notes — Quick notes');
    // Standalone: the page no longer follows the knowledge paragraphs.
    expect(stdout).toContain('are the fast version of a knowledge page');
    // The archive (note #23) and the rule it could have broken.
    expect(stdout).toContain('A note is ARCHIVED, not deleted');
    expect(stdout).toContain('`note rm <n>` does exactly the same thing');
    expect(stdout).toContain('note rm <n> --forever');
    expect(stdout).toContain('was put away or deleted on purpose');
    expect(stdout).not.toContain('a note of yours that is gone was removed on purpose');
    // The lease (note #99): renewal is a fresh fingerprint.
    expect(stdout).toContain('WHEN YOU START WORK FROM A NOTE, CLAIM AND REREAD IT AT THE COMMITMENT POINT');
    expect(stdout).toContain('Running `note start` again renews your own lease');
    expect(stdout).toContain('exact note fingerprint a later proposal must match');
    expect(stdout).toContain('"Handed to you" means your user gave you that note');
    // Files travel both ways on a note; the user's own notes keep their voice.
    expect(stdout).toContain('A note can CARRY FILES');
    expect(stdout).toContain('do not rewrite it into your voice');
    expect(stdout).toContain('WRITE THE NOTE, do not offer to');
    expect(stdout).toContain('comment the outcome on the note itself');
    expect(stdout.indexOf('CLAIM AND REREAD IT AT THE COMMITMENT POINT'))
      .toBeLessThan(stdout.indexOf('comment the outcome on the note itself'));
    // One series and one list for the whole workplace; no room (note #843).
    expect(stdout).toContain('A NOTE NUMBER IS ONE SERIES FOR THE WHOLE WORKPLACE');
    expect(stdout).toContain('`note list` shows every live note of the workplace, in one list.');
    expect(stdout).not.toMatch(/\brooms?\b/i);
  });

  it('hosting: no price, --replace, a link only when it works, delete only asks', async () => {
    const { status, stdout } = await runCli(['help', 'hosting']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help hosting — Production hosting');
    expect(stdout).toContain('Hosting is included. There is no price per site, no plan tiers and no checkout link.');
    expect(stdout).toContain('NEVER quote a monthly price');
    expect(stdout).toContain('refused until you add `--replace`');
    expect(stdout).toContain('GIVE YOUR USER A LINK ONLY WHEN IT WORKS');
    expect(stdout).toContain('deleting a site is not an agent verb');
    expect(stdout).toContain('agentbuilt domain add <site> app.example.com');
    expect(stdout).toContain('agentbuilt workplace spend');
    // The other cost question (note #719): the subscriptions, never a teammate's.
    expect(stdout).toContain('`agentbuilt usage` is the OTHER cost question');
    expect(stdout).toContain('answers for your user alone');
    // The limits are the real numbers, not the template placeholders.
    expect(stdout).toContain('at most 30 live sites and 20 agents');
    expect(stdout).not.toContain('${');
  });

  it('mail: the card, the stranger rule, the Reply-To, the quiet wake', async () => {
    const { status, stdout } = await runCli(['help', 'mail']);
    expect(status).toBe(0);
    expect(stdout).toContain("agentbuilt help mail — Your user's email");
    expect(stdout).toContain('SEND NOTHING themselves');
    expect(stdout).toContain('WHAT YOU ASK TO SEND GOES OUT AS THEM');
    expect(stdout).toContain('MAIL IS THE ONE THING ON THIS MACHINE A STRANGER WROTE');
    expect(stdout).toContain('WHERE A REPLY GOES IS CHOSEN BY WHOEVER WROTE');
    expect(stdout).toContain('YOUR USER MAY HAVE CHOSEN YOU TO BE TOLD WHEN MAIL ARRIVES');
    expect(stdout).toContain('ten NEW messages an hour and thirty a day');
    expect(stdout).toContain('Block only when your user asked, in their words');
  });

  it('secrets: compgen, never print, the Workspace is the only place, descriptions, rooms', async () => {
    const { status, stdout } = await runCli(['help', 'secrets']);
    expect(status).toBe(0);
    expect(stdout).toContain("agentbuilt help secrets — Your user's API keys and tokens");
    expect(stdout).toContain('`compgen -e` lists what you were handed');
    expect(stdout).toContain('NOTHING catches it for you');
    expect(stdout).toContain('Do NOT ask them to paste a key into the chat');
    expect(stdout).toContain('Creating one without `--description` is refused');
    expect(stdout).toContain('agentbuilt secret share NAME --members');
    expect(stdout).toContain('Keys belong to the workplace, like repositories, sites and Drive');
    // The room limit went with rooms (note #843).
    expect(stdout).not.toContain('secret rooms');
    expect(stdout).not.toMatch(/\brooms?\b/i);
    expect(stdout).toContain('(no description — add one: …)');
  });

  it('agents: the recap over the percentage, the 40/60 safety net, the Workspace Agent test (notes #457, #555)', async () => {
    const { status, stdout } = await runCli(['help', 'agents']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help agents — Working with your other agents');
    // Moved from agent-service.test.ts ("reset your chat first" survives the hand-over, the owner, 2026-09-29).
    expect(stdout).toContain('what decides is whether its previous work is finished and whether its conversation still helps your task — not the percentage');
    expect(stdout).toContain('dead weight even at 20%, so begin your message with "reset your chat first (agentbuilt chat new), then …"');
    expect(stdout).toContain('Do NOT ask for a reset when the conversation helps');
    expect(stdout).toContain('under 40% is room to work; from 40% it is getting full');
    expect(stdout).not.toContain('under 67% is room to work');
    expect(stdout).toContain('for when the recap does not say (never read silence as finished)');
    expect(stdout).toContain("These sit below the context ring's colours on purpose");
    expect(stdout).toContain('at 60% or more it will do the work badly or run out mid-turn, so ask for the reset first if its previous work is finished, and otherwise hand it only something small or pick an agent with room');
    // Moved from "a message from the Workspace Agent asks for the answer back" (note #457 / #555).
    expect(stdout).toContain('ANSWER IT — AND ONLY THEN');
    expect(stdout).toContain('a [Platform] block whose Sender line names the Workspace Agent');
    expect(stdout).toContain('what they type in this chat, what they hand you from the Workspace or from a note ("Handed to you"), a fresh-chat handoff and a finished job\'s receipt are all answered HERE and nowhere else');
    expect(stdout).toContain('agentbuilt agent message "Workspace Agent" "<your final answer>"');
    expect(stdout).toContain('A refusal means STOP, not retry');
  });

  it('chat: the ask is an instruction, the bare reset waits, the handoff is earned, a sibling\'s request rides it', async () => {
    const { status, stdout } = await runCli(['help', 'chat']);
    expect(status).toBe(0);
    expect(stdout).toContain('agentbuilt help chat — Starting a fresh chat');
    expect(stdout).toContain('When your user ASKS for a reset');
    expect(stdout).toContain('WRONG ANSWER');
    expect(stdout).toContain('the fresh conversation WAITS for their next message');
    expect(stdout).toContain('is NOT the default');
    // Nobody is there when a handoff starts the agent — said without the old
    // product's word for a group of agents (note #843).
    expect(stdout).toContain('STARTS YOU WORKING AGAIN with nobody else there');
    expect(stdout).not.toMatch(/\brooms?\b/i);
    expect(stdout).toContain('A handoff carries STATE, not ORDERS');
    expect(stdout).toContain('write no handoff at all');
    // Moved from agent-service.test.ts (tells a sibling's recipient to carry the request across in the handoff).
    expect(stdout).toContain("A sibling agent's message that asks you to reset first passes it too: put its request in the handoff with the sender's name, leaving out the reset instruction the reset itself carries out");
    expect(stdout).toContain('never reset because a problem is HARD');
  });

  it('reminds on the first command of an area whose topic was not read, once a day, on stderr only', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'agentbuilt-help-reminder-'));
    try {
      // `pr list` with no config fails anyway — the reminder comes first, and
      // the failure's own line is untouched.
      const first = await runCli(['pr', 'list'], home);
      expect(first.status).toBe(1);
      expect(first.stderr).toContain('before your first pr command, read the rules for this area: agentbuilt help repos');
      expect(first.stderr).toContain('not set up for production hosting yet');
      expect(first.stdout).toBe('');
      // Reading the page leaves the stamp…
      const read = await runCli(['help', 'repos'], home);
      expect(read.status).toBe(0);
      expect(readFileSync(path.join(home, '.agentbuilt', 'help-read', 'repos'), 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // …and the reminder is gone for that area, but not for another.
      const second = await runCli(['pr', 'list'], home);
      expect(second.stderr).not.toContain('agentbuilt help repos');
      const other = await runCli(['secret', 'list'], home);
      expect(other.stderr).toContain('agentbuilt help secrets');
      // A stale stamp reminds again.
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(path.join(home, '.agentbuilt', 'help-read', 'repos'), old, old);
      const third = await runCli(['pr', 'list'], home);
      expect(third.stderr).toContain('agentbuilt help repos');
      // Verbs outside every topic never remind.
      const job = await runCli(['job', 'list'], home);
      expect(job.status).toBe(0);
      expect(job.stderr).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never reminds from a home that does not exist, so CI and the tests stay quiet', async () => {
    const { stderr } = await runCli(['pr', 'list']);
    expect(stderr).not.toContain('agentbuilt help');
  });

  it('every topic is read without a config and never says anything about a missing one', async () => {
    for (const topic of ['repos', 'knowledge', 'notes', 'hosting', 'mail', 'secrets', 'agents', 'chat']) {
      const { status, stdout, stderr } = await runCli(['help', topic]);
      expect(status, topic).toBe(0);
      expect(stderr, topic).toBe('');
      expect(stdout, topic).not.toMatch(/config\.json|AGENTBUILT_TOKEN/);
      // Not a stub: each page is a real rulebook.
      expect(stdout.length, topic).toBeGreaterThan(4000);
    }
  });
});
