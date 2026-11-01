import { describe, expect, it } from 'vitest';
import { joinerDoingLine, joinerWelcome } from '../../shared/first-run.js';

describe('the hello for a person who joins an existing workplace (note #820)', () => {
  it('names them, the workplace, every agent with what it last did, and the latest notes as links', () => {
    expect(joinerWelcome({
      firstName: 'Cara', workplace: 'Acme',
      agents: [{ name: 'Ruby', owner: 'Adam', doing: 'Put the pricing page live.' }, { name: 'Ben', owner: 'Adam' }],
      notes: [{ title: 'Launch checklist', href: '/notes/12?org=o' }],
    })).toBe([
      'Hi Cara, welcome to Acme. I\'m your Chief of Staff here. Here\'s what\'s already going on.',
      '',
      '**Agents**\n- **Ruby**, Adam\'s agent: Put the pricing page live.\n- **Ben**, Adam\'s agent: nothing yet.',
      '',
      '**Latest notes**\n- [Launch checklist](/notes/12?org=o)',
      '',
      'Ask me about any of it, or tell me what you\'d like to work on.',
    ].join('\n'));
  });
  it('names every agent in one list once the workplace has no rooms (note #843)', () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, owner: 'Adam' }));
    const text = joinerWelcome({ firstName: 'Cara', workplace: 'Acme', agents, notes: [{ title: 'Launch checklist', href: '/notes/12?org=o' }] });
    expect(text).toContain('**Agents**\n- **A0**, Adam\'s agent: nothing yet.');
    expect(text.match(/- \*\*A\d\*\*/g)).toHaveLength(6);
    expect(text).toContain('- and 2 more agents');
    expect(text).not.toMatch(/room/i);
    expect(text).toContain('- [Launch checklist](/notes/12?org=o)\n');
  });
  it('says so when nothing has been built yet, and greets without a name when there is none', () => {
    expect(joinerWelcome({ workplace: 'Acme', agents: [], notes: [] }))
      .toBe('Hi, welcome to Acme. I\'m your Chief of Staff here. Nothing has been built here yet. Tell me what you\'re working on, and I\'ll put a team of agents on it.');
  });
  it('keeps a big workplace short: six agents, then how many more, and three notes', () => {
    const agents = Array.from({ length: 7 }, (_, i) => ({ name: `A${i}` }));
    const notes = Array.from({ length: 5 }, (_, i) => ({ title: `N${i}`, href: `/notes/${i}` }));
    const text = joinerWelcome({ firstName: 'Cara', workplace: 'Acme', agents, notes });
    expect(text.match(/- \*\*A\d\*\*/g)).toHaveLength(6);
    expect(text).not.toContain('**A6**');
    // One more is "agent", not "agents".
    expect(text).toContain('- and 1 more agent\n');
    expect(text.match(/\]\(\/notes\//g)).toHaveLength(3);
    expect(text).toContain('[N0](/notes/0)');
    expect(text).not.toContain('[N3]');
  });
  it('keeps names from turning into markup', () => {
    const text = joinerWelcome({ workplace: '*Acme*', agents: [{ name: '_Kit_', owner: '[Adam]' }], notes: [{ title: 'a](evil)', href: '/notes/1' }] });
    expect(text).toContain('welcome to Acme.');
    expect(text).toContain('**Agents**\n- **Kit**, Adam\'s agent: nothing yet.');
    expect(text).toContain('- [a(evil)](/notes/1)');
  });
  it('reads one short line of what an agent did from its recap', () => {
    expect(joinerDoingLine('Shipped the headline on the site. Note #806 is Live.')).toBe('Shipped the headline on the site.');
    expect(joinerDoingLine('- Merged the fix\n- Checked it')).toBe('Merged the fix');
    const long = joinerDoingLine(`${'word '.repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith('…')).toBe(true);
  });
});
