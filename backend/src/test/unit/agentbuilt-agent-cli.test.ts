import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The room roster, RUN through the exact standalone CLI shipped to machines.
 * Route tests protect the wire shape; this protects the part an agent reads:
 * room headings, the current-room mark, indentation, and an empty room that
 * would disappear if the renderer merely grouped the agents it happened to see.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

let server: Server;
let apiUrl: string;
let requested: string[];

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      env: {
        ...process.env,
        HOME: '/nonexistent-agentbuilt-agent-cli-test',
        AGENTBUILT_API_URL: apiUrl,
        AGENTBUILT_TOKEN: 'test-token',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** The payload this CLI is run against, so a test can vary one row's facts. */
let roster: { rooms: unknown[]; agents: Record<string, unknown>[] };
/** What the backend answers a sent message with, and what it lists as waiting. */
let messageAnswer: Record<string, unknown>;
let pending: Record<string, unknown>[];
let historyAnswer: Record<string, unknown>;

/** Minutes back from now, as the ISO stamp the roster carries. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(async () => {
  requested = [];
  messageAnswer = { ok: true, recipient: { id: 'agent-b', name: 'Ivy', cli: 'codex' }, message: 'Started Ivy. Their response will appear in their Workspace conversation.' };
  pending = [];
  historyAnswer = {
    ok: true,
    agent: { id: 'agent-b', name: 'Ivy' },
    steps: [
      { role: 'owner', author: 'Owner', at: '2026-09-10T09:00:00.000Z', text: 'Check the migration.\nKeep the old rows.' },
      { role: 'platform', author: 'Platform', at: '2026-09-10T09:01:00.000Z', text: 'Turn stopped by the user.' },
      { role: 'agent', author: 'Ivy', at: '2026-09-10T09:02:00.000Z', text: 'The migration is running.' },
    ],
  };
  roster = {
    rooms: [
      { roomId: 'room-platform', name: 'Platform' },
      { roomId: 'room-reviews', name: 'Reviews' },
      { roomId: 'room-empty', name: 'Empty room' },
    ],
    agents: [
      {
        id: 'agent-a', name: 'Noah', cli: 'claude', roomId: 'room-platform',
        self: true, state: 'working', about: 'Keeps the platform healthy.',
        model: 'opus', effort: 'xhigh',
      },
      {
        id: 'agent-b', name: 'Ivy', cli: 'codex', roomId: 'room-reviews',
        self: false, state: 'idle', about: 'Reviews backend changes.',
        model: 'gpt-5.6-sol', effort: 'max',
      },
    ],
  };
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    expect(req.headers.authorization).toBe('Bearer test-token');
    res.setHeader('content-type', 'application/json');

    if (req.url === '/api/agent-cli/agents' && req.method === 'GET') {
      res.end(JSON.stringify(roster));
      return;
    }
    if (req.url?.startsWith('/api/agent-cli/briefings?')) {
      res.end(JSON.stringify({ briefings: [
        { at: '2026-09-13T10:00:00.000Z', text: 'The checkout proposal is ready.' },
        { at: '2026-09-13T09:00:00.000Z', text: 'The booking page went live.' },
      ] }));
      return;
    }
    if (req.url?.startsWith('/api/agent-cli/agents/history?')) {
      res.end(JSON.stringify(historyAnswer));
      return;
    }
    if (req.url === '/api/agent-cli/agents/messages' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        res.statusCode = 202;
        res.end(JSON.stringify(messageAnswer));
      });
      return;
    }
    if (req.url === '/api/agent-cli/agents/stop' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        res.end(JSON.stringify({ ok: true, name: 'Ivy', idle: true, message: 'Stopped Ivy: its turn ended. It is idle now.' }));
      });
      return;
    }
    // The person's other workplaces (note #753).
    if (req.url === '/api/agent-cli/workplaces' && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, current: { orgId: 'org-studio', name: 'Studio' }, workplaces: [{ orgId: 'org-bakery', name: 'Bakery' }] }));
      return;
    }
    if (req.url === '/api/agent-cli/workplaces/messages' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`${req.url}:${body}`);
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: true, workplace: { orgId: 'org-bakery', name: 'Bakery' }, message: 'Started your user\'s Chief of Staff in Bakery. Its reply comes back into this conversation by itself and starts you again; nothing more to send.' }));
      });
      return;
    }
    if (req.url?.startsWith('/api/agent-cli/rooms/') && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`${req.url}:${body}`);
        const verb = req.url!.slice('/api/agent-cli/rooms/'.length);
        res.statusCode = verb === 'remove' ? 202 : 200;
        res.end(JSON.stringify(verb === 'rename'
          ? { ok: true, room: { roomId: 'room-growth', name: 'Growth' }, message: 'Renamed the room "Growth lab" to "Growth" [room-growth].' }
          : verb === 'order'
            ? { ok: true, rooms: [{ roomId: 'b', name: 'Sales' }, { roomId: 'a', name: 'Growth' }], message: 'The rooms now stand in this order: Sales, Growth.' }
            : { pending: true, room: { roomId: 'room-growth', name: 'Growth' }, message: 'Asked. "Growth" is now flagged for deletion.' }));
      });
      return;
    }
    if (req.url === '/api/agent-cli/rooms' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        res.end(JSON.stringify({ ok: true, room: { roomId: 'room-growth', name: 'Growth lab' }, message: 'Opened the room "Growth lab" [room-growth].' }));
      });
      return;
    }
    if (req.url === '/api/agent-cli/agents' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        requested.push(`room:${String(req.headers['x-agentbuilt-room'] ?? '')}`);
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: true, agent: { id: 'agent-c', name: 'Mia' }, room: { roomId: 'room-reviews', name: 'Reviews' }, message: 'Mia is arriving in Reviews [agent-c].' }));
      });
      return;
    }
    if (req.url === '/api/agent-cli/agents/model' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        res.end(JSON.stringify({ ok: true, name: 'Ivy', runtime: { cli: 'claude', model: 'sonnet', effort: 'max' }, changed: true, working: false, message: 'Ivy now runs on sonnet at max effort (Claude Code), from its next turn.' }));
      });
      return;
    }
    if ((req.url === '/api/agent-cli/agents/reset' || req.url === '/api/agent-cli/agents/remove') && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requested.push(`body:${body}`);
        res.end(JSON.stringify(req.url?.endsWith('/reset')
          ? { ok: true, name: 'Ivy', message: 'Asked Ivy for a fresh chat.' }
          : { pending: true, name: 'Ivy', message: 'Asked. Ivy is now flagged for removal.' }));
      });
      return;
    }
    if (req.url === '/api/agent-cli/agents/messages/pending') {
      res.end(JSON.stringify({ ok: true, pending }));
      return;
    }
    if (req.url?.startsWith('/api/agent-cli/agents/messages/') && req.method === 'DELETE') {
      res.end(JSON.stringify({ ok: true, recipient: { id: 'agent-b', name: 'Ivy' }, message: 'Withdrew the message waiting for Ivy. Nothing reaches them from it.' }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('agentbuilt agent list, rendered', () => {
  it('prints the live roster as one list, the caller first, with no room in it (note #843)', async () => {
    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(requested).toEqual(['/api/agent-cli/agents']);
    // The backend still sends rooms, and an empty one; nothing of them is printed.
    expect(result.stdout).toBe([
      'Noah (you)  ·  Claude Code  ·  opus  ·  xhigh  ·  working  [agent-a]',
      '    Keeps the platform healthy.',
      'Ivy  ·  Codex  ·  gpt-5.6-sol  ·  max  ·  idle  [agent-b]',
      '    Reviews backend changes.',
      '',
    ].join('\n'));
  });

  it('drops the runtime columns an older backend or a retired harness cannot fill (note #338)', async () => {
    // Rolling edges, both directions. A backend older than note #338 sends no
    // model or effort, and a retired harness has none to send — neither may
    // leave an empty column or the word "undefined" in a row an agent reads
    // to pick a recipient.
    delete roster.agents[0].model;
    delete roster.agents[0].effort;
    roster.agents[1] = {
      id: 'agent-k', name: 'Kai', cli: 'kimi', roomId: 'room-reviews',
      self: false, state: 'unavailable',
    };

    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Noah (you)  ·  Claude Code  ·  working  [agent-a]');
    expect(result.stdout).toContain('Kai  ·  kimi  ·  unavailable  [agent-k]');
    expect(result.stdout).not.toContain('undefined');
    expect(result.stdout).not.toMatch(/·\s{3,}·/);
  });

  it('prints how full each agent\'s context window is, and nothing for an unmeasured one (note #449)', async () => {
    roster.agents[1].context = { usedPercent: 95, tokens: 190_000, window: 200_000, at: minutesAgo(3) };

    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Ivy  ·  Codex  ·  gpt-5.6-sol  ·  max  ·  idle  ·  context 95% full (190k of 200k tokens)  [agent-b]');
    // Unmeasured stays silent: a "0%" would claim a measurement that never happened.
    expect(result.stdout).toContain('Noah (you)  ·  Claude Code  ·  opus  ·  xhigh  ·  working  [agent-a]');
    expect(result.stdout).not.toContain('undefined');
  });

  it('prints how long a working turn has been running, at the unit that reads (note #171)', async () => {
    roster.agents[0].activitySince = minutesAgo(12);

    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Noah (you)  ·  Claude Code  ·  opus  ·  xhigh  ·  working 12m  [agent-a]');
    // The recap still rides beneath the row: the clock says how long, the
    // recap says what — the two answer different halves of the question.
    expect(result.stdout).toContain('    Keeps the platform healthy.');
  });

  it('counts a long turn in hours and a fresh one in seconds', async () => {
    roster.agents[0].activitySince = minutesAgo(64);
    await expect(runCli(['agent', 'list']).then((r) => r.stdout))
      .resolves.toContain('·  working 1h 4m  [agent-a]');

    roster.agents[0].activitySince = new Date(Date.now() - 40_000).toISOString();
    await expect(runCli(['agent', 'list']).then((r) => r.stdout))
      .resolves.toContain('·  working 40s  [agent-a]');
  });

  it('leaves the row bare when the backend sends no start stamp', async () => {
    // An older backend, or a turn the registry has no start time for. The
    // roster must still render — the clock is an addition, never a dependency.
    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Noah (you)  ·  Claude Code  ·  opus  ·  xhigh  ·  working  [agent-a]');
  });

  it('never hangs a clock on an idle agent or on an unparseable stamp', async () => {
    // `idle` with a leftover stamp would read as "idle for 12m" — a claim
    // about idleness that this field does not make.
    roster.agents[1].activitySince = minutesAgo(12);
    roster.agents[0].activitySince = 'not-a-date';

    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Ivy  ·  Codex  ·  gpt-5.6-sol  ·  max  ·  idle  [agent-b]');
    expect(result.stdout).toContain('Noah (you)  ·  Claude Code  ·  opus  ·  xhigh  ·  working  [agent-a]');
  });

  it('floors a future stamp at zero rather than printing a negative clock', async () => {
    // Clock skew between this machine and the backend, not a negative turn.
    roster.agents[0].activitySince = minutesAgo(-5);

    const result = await runCli(['agent', 'list']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('·  working 0s  [agent-a]');
    expect(result.stdout).not.toMatch(/working -/);
  });
});

describe('agentbuilt briefing list, rendered', () => {
  it('asks for three by default and prints exact timestamps newest first', async () => {
    const result = await runCli(['briefing', 'list']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(requested).toEqual(['/api/agent-cli/briefings?limit=3']);
    expect(result.stdout).toContain('Recent Home briefings (2, newest first):');
    expect(result.stdout).toContain('[2026-09-13T10:00:00.000Z]\nThe checkout proposal is ready.');
    expect(result.stdout.indexOf('checkout')).toBeLessThan(result.stdout.indexOf('booking'));
  });

  it('passes an explicit limit and refuses one outside 1–10 before the network', async () => {
    const limited = await runCli(['briefing', 'list', '--limit', '1']);
    expect(limited.status).toBe(0);
    expect(requested).toEqual(['/api/agent-cli/briefings?limit=1']);
    requested = [];
    const invalid = await runCli(['briefing', 'list', '--limit', '11']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--limit must be a whole number from 1 to 10');
    expect(requested).toEqual([]);
  });
});

describe('agentbuilt agent message, pending and cancel (note #267)', () => {
  it('renders a bounded recent history in chronological order and validates the limit locally (note #466)', async () => {
    const result = await runCli(['agent', 'history', 'Ivy', '--limit', '4']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(requested).toEqual(['/api/agent-cli/agents/history?agent=Ivy&limit=4']);
    expect(result.stdout).toBe([
      'Agent: Ivy  [agent-b]',
      '2026-09-10T09:00:00.000Z  ·  owner  ·  Owner',
      '  Check the migration.',
      '  Keep the old rows.',
      '2026-09-10T09:01:00.000Z  ·  platform  ·  Platform',
      '  Turn stopped by the user.',
      '2026-09-10T09:02:00.000Z  ·  agent  ·  Ivy',
      '  The migration is running.',
      '',
    ].join('\n'));

    requested = [];
    const one = await runCli(['agent', 'history', 'agent-b', '--limit=1']);
    expect(one.status).toBe(0);
    expect(requested).toEqual(['/api/agent-cli/agents/history?agent=agent-b&limit=1']);
    for (const bad of ['0', '5', '1.5']) {
      requested = [];
      const refused = await runCli(['agent', 'history', 'Ivy', '--limit', bad]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('--limit must be a whole number from 1 to 4');
      expect(requested).toEqual([]);
    }
  });

  it('sends everything after the recipient as message data and prints whichever outcome the backend names', async () => {
    const started = await runCli(['agent', 'message', 'Ivy', 'review', '--sha', 'abc', 'please']);
    expect(started.status).toBe(0);
    expect(requested).toContain('body:{"recipient":"Ivy","message":"review --sha abc please"}');
    expect(started.stdout.trim()).toBe('Started Ivy. Their response will appear in their Workspace conversation.');

    messageAnswer = {
      ok: true,
      recipient: { id: 'agent-b', name: 'Ivy', cli: 'codex' },
      queued: { id: 'ab12cd34', position: 1 },
      message: 'Queued for Ivy, who is working now (nothing else waiting). Withdraw it with `agentbuilt agent cancel ab12cd34`.',
    };
    const queued = await runCli(['agent', 'message', 'agent-b', 'Verified: the fix holds.']);
    expect(queued.status).toBe(0);
    expect(queued.stdout.trim()).toBe(messageAnswer.message);

    // A backend that sends the shape without a sentence still gets one that says QUEUED, never Started.
    messageAnswer = { ok: true, recipient: { id: 'agent-b', name: 'Ivy', cli: 'codex' }, queued: { id: 'ab12cd34', position: 1 } };
    const bare = await runCli(['agent', 'message', 'Ivy', 'again']);
    expect(bare.stdout.trim()).toBe('Queued for Ivy (ab12cd34); delivered when it is idle.');
  });

  it('stops an agent by name with everything after it as the reason (note #462), and prints the backend\'s sentence', async () => {
    const stopped = await runCli(['agent', 'stop', 'Ivy', 'the note', 'text changed']);
    expect(stopped.status).toBe(0);
    expect(requested).toContain('body:{"agent":"Ivy","reason":"the note text changed"}');
    expect(stopped.stdout.trim()).toBe('Stopped Ivy: its turn ended. It is idle now.');

    const bare = await runCli(['agent', 'stop', 'agent-b']);
    expect(bare.status).toBe(0);
    expect(requested).toContain('body:{"agent":"agent-b"}');

    const noTarget = await runCli(['agent', 'stop']);
    expect(noTarget.status).not.toBe(0);
    expect(noTarget.stderr).toContain('usage: agentbuilt agent stop "<name-or-id>" ["<why>"]');
  });

  it('lists the person\'s other workplaces and passes a message to their Chief of Staff there (note #753)', async () => {
    const listed = await runCli(['workplace', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim()).toBe('Bakery  [org-bakery]');
    const sent = await runCli(['workplace', 'message', 'Bakery', 'How many orders', 'today?']);
    expect(sent.status, sent.stderr).toBe(0);
    expect(requested).toContain('/api/agent-cli/workplaces/messages:{"workplace":"Bakery","message":"How many orders today?"}');
    expect(sent.stdout.trim()).toBe('Started your user\'s Chief of Staff in Bakery. Its reply comes back into this conversation by itself and starts you again; nothing more to send.');
    const bare = await runCli(['workplace', 'message', 'Bakery']);
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain('usage: agentbuilt workplace message "<workplace>" "<message>"');
    // `spend` is still the workplace verb it was, and the usage names all three.
    const unknown = await runCli(['workplace', 'tidy']);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain('usage: agentbuilt workplace spend | list | message "<workplace>" "<message>"');
  });

  it('says rooms are gone, brings an agent in with no room, asks for a fresh chat and asks for a removal (notes #710, #843), printing the backend\'s sentence', async () => {
    // `room …` (notes #710, #740) is gone with rooms (note #843): every form
    // says so, and nothing reaches the backend.
    for (const args of [['room', 'create', 'Growth', 'lab'], ['room', 'rename', 'Growth lab', 'Growth'], ['room', 'order', 'Sales'], ['room', 'remove', 'Growth'], ['rooms']]) {
      const gone = await runCli(args);
      expect(gone.status).not.toBe(0);
      expect(gone.stderr).toContain('Rooms are gone (note #843)');
    }
    expect(requested.some((line) => line.includes('/api/agent-cli/rooms'))).toBe(false);

    // No room to name; --room is accepted, said to be ignored, and sent nowhere.
    const created = await runCli(['agent', 'create', '--cli', 'codex']);
    expect(created.status, created.stderr).toBe(0);
    expect(requested).toContain('body:{"cli":"codex"}');
    const defaulted = await runCli(['agent', 'create', '--room=room-reviews']);
    expect(defaulted.status, defaulted.stderr).toBe(0);
    expect(defaulted.stderr).toContain('--room is ignored');
    expect(requested).toContain('body:{}');
    expect(requested.filter((line) => line.startsWith('room:')).every((line) => line === 'room:')).toBe(true);
    const badCli = await runCli(['agent', 'create', '--cli', 'gemini']);
    expect(badCli.status).not.toBe(0);
    expect(badCli.stderr).toContain('--cli must be claude, codex or opencode');
    // What it thinks with (note #757): both forms of each flag ride the body;
    // which names a harness offers is the backend's to judge.
    const chosen = await runCli(['agent', 'create', '--cli', 'claude', '--model', 'sonnet', '--effort=xhigh']);
    expect(chosen.status, chosen.stderr).toBe(0);
    expect(requested).toContain('body:{"cli":"claude","model":"sonnet","effort":"xhigh"}');
    const effortAlone = await runCli(['agent', 'create', '--effort', 'max']);
    expect(effortAlone.status, effortAlone.stderr).toBe(0);
    expect(requested).toContain('body:{"effort":"max"}');
    const noModel = await runCli(['agent', 'create', '--model']);
    expect(noModel.status).not.toBe(0);
    expect(noModel.stderr).toContain('[--model <model>] [--effort <effort>]');
    const emptyEffort = await runCli(['agent', 'create', '--effort=']);
    expect(emptyEffort.status).not.toBe(0);
    const stray = await runCli(['agent', 'create', '--name', 'Ivy']);
    expect(stray.status).not.toBe(0);
    expect(stray.stderr).toContain('usage: agentbuilt agent create');

    const reset = await runCli(['agent', 'reset', 'Ivy']);
    expect(reset.status, reset.stderr).toBe(0);
    expect(requested).toContain('body:{"agent":"Ivy"}');
    expect(reset.stdout.trim()).toBe('Asked Ivy for a fresh chat.');
    const resetExtra = await runCli(['agent', 'reset', 'Ivy', 'now']);
    expect(resetExtra.status).not.toBe(0);
    expect(resetExtra.stderr).toContain('usage: agentbuilt agent reset "<name-or-id>"');

    // Note #776: the picker on an agent's screen, for the Workspace Agent.
    const model = await runCli(['agent', 'model', 'Ivy', '--model', 'sonnet', '--effort=max']);
    expect(model.status, model.stderr).toBe(0);
    expect(requested).toContain('body:{"agent":"Ivy","model":"sonnet","effort":"max"}');
    expect(model.stdout.trim()).toBe('Ivy now runs on sonnet at max effort (Claude Code), from its next turn.');
    const effortOnly = await runCli(['agent', 'model', 'Ivy', '--effort', 'high']);
    expect(effortOnly.status, effortOnly.stderr).toBe(0);
    expect(requested).toContain('body:{"agent":"Ivy","effort":"high"}');
    for (const args of [['agent', 'model', 'Ivy'], ['agent', 'model', '--model', 'opus'], ['agent', 'model', 'Ivy', '--model'], ['agent', 'model', 'Ivy', '--cli', 'codex']]) {
      const refused = await runCli(args);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('usage: agentbuilt agent model "<name-or-id>" [--model <model>] [--effort <effort>]');
    }

    const removed = await runCli(['agent', 'remove', 'Ivy', 'its work', 'is finished']);
    expect(removed.status, removed.stderr).toBe(0);
    expect(requested).toContain('body:{"agent":"Ivy","reason":"its work is finished"}');
    expect(removed.stdout.trim()).toBe('Asked. Ivy is now flagged for removal.');
    const noTarget = await runCli(['agent', 'remove']);
    expect(noTarget.status).not.toBe(0);
    expect(noTarget.stderr).toContain('usage: agentbuilt agent remove "<name-or-id>" ["<why>"]');
  });

  it('lists what is waiting and withdraws one by id', async () => {
    const empty = await runCli(['agent', 'pending']);
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe('Nothing of yours is waiting for a working agent.');

    pending = [{
      id: 'ab12cd34', recipient: { id: 'agent-b', name: 'Ivy' }, position: 2,
      queuedAt: '2026-09-05T10:00:00.000Z', expiresAt: '2026-09-05T11:00:00.000Z', message: 'Verified: the fix holds.',
    }];
    const listed = await runCli(['agent', 'pending']);
    expect(listed.stdout).toBe([
      'ab12cd34  ·  for Ivy  ·  #2 in line  ·  queued 2026-09-05T10:00:00.000Z  ·  expires 2026-09-05T11:00:00.000Z',
      '      Verified: the fix holds.',
      '',
    ].join('\n'));

    const cancelled = await runCli(['agent', 'cancel', 'ab12cd34']);
    expect(cancelled.status).toBe(0);
    expect(requested).toContain('/api/agent-cli/agents/messages/ab12cd34');
    expect(cancelled.stdout.trim()).toBe('Withdrew the message waiting for Ivy. Nothing reaches them from it.');

    const noId = await runCli(['agent', 'cancel']);
    expect(noId.status).not.toBe(0);
    expect(noId.stderr).toContain('usage: agentbuilt agent cancel <id>');
  });
});
