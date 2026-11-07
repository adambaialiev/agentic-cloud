import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDay, copyRow, sortCopies, type CopyPulseRecord, type WorkspaceCopiesAnswer, type WorkspaceCopyAnswer } from '../../../../src/shared/copy-pulse.js';
import { fixtureCopies, fixtureHistory } from '../../../../src/shared/copy-pulse-fixtures.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { copiesSub, healthWords, releaseWords, standingWords } from './copies-words.js';

const org = { orgId: 'org-1', name: 'ACC', role: 'admin' as const, members: 1, seats: 1, seatProviders: ['claude' as const] };
const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];

/** The fixture copies (note #1057's exact shape), as the server would answer them now. */
function fixtures() {
  const now = new Date();
  return fixtureCopies(now).map(({ pulse, receivedAt }) => {
    const history = fixtureHistory(pulse, receivedAt);
    const record: CopyPulseRecord = { copyId: pulse.copyId, firstSeenAt: receivedAt[0]!, lastSeenAt: receivedAt.at(-1)!, pulse: { ...pulse, receivedAt: receivedAt.at(-1)! } };
    const days = history.map((day) => ({ copyId: pulse.copyId, day: day.receivedAt.slice(0, 10), lastSeenAt: day.receivedAt, pulse: { ...day.pulse, receivedAt: day.receivedAt } })).reverse();
    return { row: copyRow(record, OFFERED, now), days: days.map(copyDay) };
  });
}

function open(path: string, copies: ReturnType<typeof fixtures>, operator = true, extra: Record<string, Answer> = {}) {
  const script: Record<string, Answer> = {
    ...workspaceScript(() => emptyState({ org, ...(operator ? { copies: true as const } : {}) })),
    'GET api/copies': () => ({ copies: sortCopies(copies.map((one) => one.row)), latestRelease: '2026.11.06.0' } satisfies WorkspaceCopiesAnswer),
    ...Object.fromEntries(copies.map((one) => [`GET api/copies/${one.row.copyId}`, () => ({ copy: one.row, latestRelease: '2026.11.06.0', days: one.days } satisfies WorkspaceCopyAnswer)])),
    ...extra,
  };
  const test = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={test.api} /></MemoryRouter>);
  return test;
}

afterEach(cleanup);

describe('Copies (note #1058)', () => {
  it('says plainly that no copy has sent a pulse yet', async () => {
    open('/copies', []);
    expect(await screen.findByText('No copy has sent a pulse yet. Each one appears here after its first.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Copies' })).toBeTruthy();
    expect(document.querySelector('#copiesSub')!.textContent).toBe('Private copies');
    expect(document.querySelector('#copiesAbout')!.textContent).toContain('The latest release is 2026.11.06.0.');
  });

  it('shows one copy as one row: domain, contact, release, counts, health and when it was seen', async () => {
    const [acme] = fixtures();
    open('/copies', [acme!]);
    const row = await waitFor(() => { const found = document.querySelector('[data-copy="fixture-acme-0001"]'); expect(found).toBeTruthy(); return found!; });
    const text = row.textContent!;
    expect(text).toContain('agents.acme.example');
    expect(text).toContain('Dana Field · dana@acme.example');
    expect(text).toContain('2026.11.06.0 · up to date');
    expect(text).toContain('12 people · 8 agents · 171 turns in 24h');
    expect(text).toContain('Healthy · seen 2h ago · active 2h ago');
    expect(row.querySelector('.copybadge')).toBeNull();
    expect(document.querySelector('#copiesSub')!.textContent).toBe('1 copy');
  });

  it('marks the copies that need a look, newest heard from first', async () => {
    open('/copies', fixtures());
    await waitFor(() => expect(document.querySelectorAll('.copyrow')).toHaveLength(4));
    expect([...document.querySelectorAll('.copyrow')].map((row) => [row.getAttribute('data-copy'), row.querySelector('.copybadge')?.textContent ?? ''])).toEqual([
      ['fixture-acme-0001', ''],
      ['fixture-northwind-02', ''],
      ['fixture-initech-04', 'Opted out'],
      ['fixture-globex-03', 'Silent 4 days'],
    ]);
    const northwind = document.querySelector('[data-copy="fixture-northwind-02"]')!.textContent!;
    expect(northwind).toContain('2026.11.01.1 · 3 behind');
    expect(northwind).toContain('Disk 6% free');
    expect(document.querySelector('#copiesSub')!.textContent).toBe('4 copies · 3 need a look');
  });

  it('opens an opted-out copy with its last numbers and says why they stopped', async () => {
    const all = fixtures();
    open('/copies', all);
    fireEvent.click(await waitFor(() => { const found = document.querySelector('[data-copy="fixture-initech-04"]'); expect(found).toBeTruthy(); return found!; }));
    expect(await screen.findByRole('heading', { name: 'agents.initech.example' })).toBeTruthy();
    expect(document.querySelector('#copyOptedOut')!.textContent).toMatch(/^Its admin turned the daily pulse off\. These are the last numbers it sent, on /);
    expect(document.querySelector('#copyPeople .v')!.textContent).toBe('2');
    expect(document.querySelector('#copyAgents .v')!.textContent).toBe('1 · Claude 1');
    // The history: a bar for every day it was heard from, and the same numbers as a table.
    expect(document.querySelectorAll('#copyChart [data-day]')).toHaveLength(5);
    expect(document.querySelectorAll('#copyDays tbody tr')).toHaveLength(5);
    expect(document.querySelector('#copyDays tbody tr th')!.textContent).toMatch(/ · off$/);
  });

  it('writes to the contact as a draft in the reader\'s own mailbox, never a send', async () => {
    const [acme] = fixtures();
    const { calls } = open('/copies/fixture-acme-0001', [acme!], true, {
      'GET api/mail/messages': () => ({ address: 'adam@example.com', messages: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Write to Dana Field' }));
    const to = await screen.findByRole('textbox', { name: 'To' }) as HTMLInputElement;
    expect(to.value).toBe('dana@acme.example');
    expect((document.querySelector('#mailSubjectField') as HTMLInputElement).value).toBe('Your Agentic Cloud at agents.acme.example');
    expect(calls.some((call) => call.path === 'api/mail/send')).toBe(false);
  });

  it('is offered in the account menu to the operator alone, and is not found for anyone else', async () => {
    open('/', fixtures());
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Copies/ }));
    expect(await screen.findByRole('heading', { name: 'Copies' })).toBeTruthy();
    cleanup();

    const { calls } = open('/', fixtures(), false);
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const theirs = await screen.findByRole('menu', { name: 'Your account' });
    expect(within(theirs).queryByRole('menuitem', { name: /Copies/ })).toBeNull();
    cleanup();
    open('/copies', fixtures(), false);
    await waitFor(() => expect(document.querySelector('#screenCopies')).toBeNull());
    expect(calls.some((call) => call.path === 'api/copies')).toBe(false);
  });

  it('words a row the way the screen says it', () => {
    const [acme, northwind, globex, initech] = fixtures();
    expect(releaseWords(northwind!.row)).toBe('2026.11.01.1 · 3 behind');
    expect(releaseWords({ release: '2026.11.06.0', releasesBehind: null, updatesState: 'off' })).toBe('2026.11.06.0 · updates off');
    expect(healthWords(globex!.row)).toBe('Backup 2 days old');
    expect(standingWords(initech!.row)).toBe('Opted out');
    expect(copiesSub([acme!.row])).toBe('1 copy');
  });
});
