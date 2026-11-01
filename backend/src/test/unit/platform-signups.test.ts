import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { signupFunnel, weekOf } from '../../services/signup-funnel.js';
import { rosterCode, type RosterPerson } from '../../services/sqlite/sqlite-user-roster.js';

/**
 * `agentbuilt signups`: Growth's sign-up numbers, read without the host key.
 * Three things must hold. Nothing that names a person leaves the backend; only
 * the platform admin's agents get an answer; and every answer carries all the
 * weeks, so a week nobody read is still counted.
 */

function person(userId: string, fields: Partial<RosterPerson>): RosterPerson {
  return {
    userId, code: rosterCode(userId), name: `Name of ${userId}`, via: 'email', email: `${userId}@example.com`, telegram: '',
    kind: '', joined: '-', from: '', firstPage: '', lastSeen: '-', stage: 'signed_up', seatAt: '-', workplaces: ['Their workplace'], webLogins: 1,
    agents: 0, agentsDeleted: 0, messagesToAgents: 0, agentMinutes: 0, liveSites: [], repos: 0, notes: 0,
    detail: { places: [], devices: ['Mozilla/5.0'], agentTime: [], agents: [], seats: [] },
    ...fields,
  };
}

const NOW = new Date('2026-10-08T17:00:00.000Z');
const people: RosterPerson[] = [
  person('u_admin', { kind: 'admin', joinedAt: '2026-07-27T09:00:00.000Z', stage: 'talked' }),
  person('u_test', { kind: 'internal', joinedAt: '2026-09-20T10:00:00.000Z', stage: 'talked' }),
  person('u_early', { via: 'anonymous_totp', joinedAt: '2026-09-05T16:46:00.000Z', stage: 'talked', stageAt: '2026-09-06T05:30:00.000Z', lastSeenAt: '2026-09-06T08:07:00.000Z' }),
  person('u_sun', { joinedAt: '2026-09-13T23:59:00.000Z', stage: 'workplace', stageAt: '2026-09-13T23:59:30.000Z', from: 't.co', firstPage: '/claude-code-in-the-cloud' }),
  person('u_mon', { joinedAt: '2026-09-07T00:00:00.000Z', stage: 'signed_up', stageAt: '2026-09-07T00:00:00.000Z', from: 'direct', firstPage: '/' }),
];

describe('signupFunnel', () => {
  const funnel = signupFunnel(people, NOW);

  it('counts outside people only, both as reached-at-least and as where they stand', () => {
    expect(funnel.outside).toBe(3);
    expect(funnel.stages).toEqual([
      { stage: 'signed_up', reached: 3, standing: 1 },
      { stage: 'confirmed', reached: 2, standing: 0 },
      { stage: 'workplace', reached: 2, standing: 1 },
      // Told the Chief of Staff what they are working on (note #726): a step
      // of its own between the workplace and the plan.
      { stage: 'told', reached: 1, standing: 0 },
      { stage: 'seat', reached: 1, standing: 0 },
      { stage: 'agent', reached: 1, standing: 0 },
      { stage: 'talked', reached: 1, standing: 1 },
    ]);
  });

  it('ranks "told" after the workplace and before the plan (note #726)', () => {
    const told = signupFunnel([person('u_told', { joinedAt: '2026-09-13T10:00:00.000Z', stage: 'told', stageAt: '2026-09-13T10:05:00.000Z' })], NOW);
    expect(told.stages.map((row) => [row.stage, row.reached, row.standing])).toEqual([
      ['signed_up', 1, 0], ['confirmed', 1, 0], ['workplace', 1, 0], ['told', 1, 1], ['seat', 0, 0], ['agent', 0, 0], ['talked', 0, 0],
    ]);
    expect(told.weeks.find((week) => week.weekOf === '2026-09-07')).toMatchObject({ signups: 1, reached: { workplace: 1, told: 1, seat: 0 } });
  });

  it('carries no name, email, handle, workplace or device — only the code', () => {
    const wire = JSON.stringify(funnel);
    for (const word of ['Name of', '@example.com', 'Their workplace', 'Mozilla', 'u_early', 'u_admin']) {
      expect(wire).not.toContain(word);
    }
    expect(funnel.accounts.map((account) => account.code)).toEqual(['u_sun', 'u_mon', 'u_early'].map(rosterCode));
    expect(funnel.accounts[2]).toEqual({
      code: rosterCode('u_early'), via: 'anonymous_totp', joinedAt: '2026-09-05T16:46:00.000Z',
      stage: 'talked', stageAt: '2026-09-06T05:30:00.000Z', lastSeenAt: '2026-09-06T08:07:00.000Z',
    });
  });

  it('counts every week from the first outside sign-up to this one, quiet weeks included', () => {
    expect(funnel.weeks.map((week) => week.weekOf)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
    // Monday 00:00 and Sunday 23:59 are the same week.
    expect(funnel.weeks[1]).toMatchObject({ signups: 2, reached: { signed_up: 2, workplace: 1, seat: 0 } });
    expect(funnel.weeks[0]).toMatchObject({ signups: 1, reached: { talked: 1 } });
    expect(funnel.weeks.slice(2).every((week) => week.signups === 0)).toBe(true);
  });

  it('counts sign-ups by where they came from, and the accounts that brought no record apart', () => {
    expect(funnel.sources).toEqual([
      { from: 'direct', signups: 1, reached: expect.objectContaining({ signed_up: 1, workplace: 0 }) },
      { from: 't.co', signups: 1, reached: expect.objectContaining({ signed_up: 1, workplace: 1, seat: 0 }) },
    ]);
    expect(funnel.unrecorded).toBe(1);
    expect(funnel.accounts[0]).toMatchObject({ from: 't.co', firstPage: '/claude-code-in-the-cloud' });
    expect(funnel.accounts[2]).not.toHaveProperty('from');
  });

  it('starts weeks on Monday, UTC', () => {
    expect(weekOf('2026-09-13T23:59:00.000Z')).toBe('2026-09-07');
    expect(weekOf('2026-09-14T00:00:00.000Z')).toBe('2026-09-14');
  });

  it('answers with no weeks to speak of when nobody from outside has come', () => {
    const empty = signupFunnel([people[0]!], NOW);
    expect(empty).toMatchObject({ outside: 0, accounts: [], weeks: [{ weekOf: '2026-10-05', signups: 0 }] });
  });
});

interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }
function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}

async function readAs(admin: boolean, withRoster = true): Promise<MockResponse> {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const minted = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    ...(admin ? { roles: { admin: true } } : {}),
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: { 'agent-a': { id: 'agent-a', name: 'Rosa', cli: 'claude', agentbuiltTokenHash: minted.tokenHash } as never },
    },
  } as never);
  const deps: Partial<RouteDeps> = { userStorage, ...(withRoster ? { userRoster: async () => people } : {}) };
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const route = router.stack.find((layer) => layer.route?.path === '/platform/signups')!.route!;
  const res = createMockResponse();
  const headers: Record<string, string> = { authorization: `Bearer ${minted.token}` };
  await route.stack.at(-1)!.handle({
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    method: 'GET', path: '/platform/signups', params: {}, query: {},
  }, res);
  return res;
}

describe('GET /api/agent-cli/platform/signups', () => {
  it('answers the platform admin\'s agents with the funnel', async () => {
    const res = await readAs(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outside: 3, accounts: [{ code: rosterCode('u_sun') }, {}, {}] });
  });

  it('refuses everyone else\'s agents, before saying anything about the backend', async () => {
    const res = await readAs(false, false);
    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error: string }).error)).toContain("platform operator's");
  });
});

describe('agentbuilt signups', () => {
  const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function run(args: string[]): Promise<{ status: number | null; stdout: string; requested: string[] }> {
    const requested: string[] = [];
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(signupFunnel(people, NOW)));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SOURCE_CLI, 'signups', ...args], {
        env: { ...process.env, HOME: '/nonexistent-agentbuilt-signups-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, requested }));
    });
  }

  it('prints the stages, every week and the accounts newest first, by code', async () => {
    const result = await run([]);
    expect(result.status).toBe(0);
    expect(result.requested).toEqual(['/api/agent-cli/platform/signups']);
    expect(result.stdout).toContain('Sign-ups from outside: 3, the newest on 2026-09-13 (24 days ago).');
    expect(result.stdout).toMatch(/workplace\s+2\s+1\n/);
    // WORKPLACE, TOLD, SEAT, AGENT, TALKED after the sign-ups (note #726 added the TOLD column).
    expect(result.stdout).toMatch(/2026-09-07\s+2\s+1\s+0\s+0\s+0\s+0\n/);
    expect(result.stdout).toMatch(/2026-10-05\s+0/);
    const accounts = result.stdout.slice(result.stdout.indexOf('Newest first:'));
    expect(accounts.indexOf(rosterCode('u_sun'))).toBeLessThan(accounts.indexOf(rosterCode('u_early')));
    expect(accounts).toMatch(new RegExp(`${rosterCode('u_early')}\\s+old browser\\s+2026-09-05 16:46\\s+talked\\s+2026-09-06 05:30\\s+2026-09-06 08:07`));
    expect(accounts).toMatch(new RegExp(`${rosterCode('u_mon')}.*never\\s+direct\\s+/\n`));
    expect(accounts).toMatch(new RegExp(`${rosterCode('u_sun')}.*t\\.co\\s+/claude-code-in-the-cloud`));
    expect(result.stdout).toMatch(/Where they came from[^\n]*\nFROM\s+SIGN-UPS[^\n]*\ndirect\s+1\s+0[^\n]*\nt\.co\s+1\s+1/);
    expect(result.stdout).toContain('1 joined before sources were recorded (2026-10-09), or their browser kept nothing.');
  });

  it('gives the whole answer as JSON', async () => {
    const result = await run(['--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ outside: 3, weeks: expect.any(Array) });
  });
});
