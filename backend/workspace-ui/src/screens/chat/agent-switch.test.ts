import { describe, expect, it } from 'vitest';
import { agentSwitchHeld, agentSwitchShown, agentSwitchStack, agentSwitchWorkingFirst } from './agent-switch.js';

/**
 * The rules behind the composer's agent stack (note #581): who is on the
 * button, and what order the sheet behind it comes in. The sheet grouped the
 * fleet by room under room tabs (notes #581, #713) until rooms left the
 * product (note #843); what stayed is All — one list of every agent.
 */

const fleet = [
  { id: 'felix' },
  { id: 'ben' },
  { id: 'gus' },
];

describe('the stack on the button', () => {
  it('leaves out the conversation already open', () => {
    expect(agentSwitchStack(fleet, 'felix').map((one) => one.id)).toEqual(['ben', 'gus']);
  });

  it('is the whole fleet where no one agent is being read', () => {
    expect(agentSwitchStack(fleet).map((one) => one.id)).toEqual(['felix', 'ben', 'gus']);
    expect(agentSwitchStack(null)).toEqual([]);
  });
});

describe('the sheet’s search (note #713)', () => {
  const named = [
    { id: 'ben', name: 'Ben' },
    { id: 'zoe', name: 'Zoë' },
    { id: 'felix', name: 'Felix' },
    { id: 'gus', name: 'Gus' },
  ];

  it('shows every agent, in the fleet’s own order, with nothing typed', () => {
    expect(agentSwitchShown(named, '').map((one) => one.id)).toEqual(['ben', 'zoe', 'felix', 'gus']);
  });

  it('matches names whatever their case and accents', () => {
    expect(agentSwitchShown(named, '  ZOE ').map((one) => one.id)).toEqual(['zoe']);
    expect(agentSwitchShown(named, 'e').map((one) => one.id)).toEqual(['ben', 'zoe', 'felix']);
    expect(agentSwitchShown(named, 'nobody')).toEqual([]);
  });
});

describe('the sheet’s order: working first (note #775)', () => {
  const named = [
    { id: 'ben', name: 'Ben' },
    { id: 'zoe', name: 'Zoë', working: true },
    { id: 'felix', name: 'Felix' },
    { id: 'gus', name: 'Gus', working: true },
  ];

  it('puts every working agent before every idle one, each half in the fleet’s own order', () => {
    expect(agentSwitchShown(named, '').map((one) => one.id)).toEqual(['zoe', 'gus', 'ben', 'felix']);
    expect(agentSwitchWorkingFirst(named).map((one) => one.id)).toEqual(['zoe', 'gus', 'ben', 'felix']);
  });

  it('keeps the rule through a search', () => {
    expect(agentSwitchShown(named, 'e').map((one) => one.id)).toEqual(['zoe', 'ben', 'felix']);
  });
});

describe('a held order (note #775)', () => {
  const row = (id: string) => ({ id });

  it('keeps every card where it was drawn, whatever the fresh order says', () => {
    expect(agentSwitchHeld(['a', 'b', 'c'], [row('c'), row('a'), row('b')]).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('adds a newcomer at the end and lets a removed card go', () => {
    expect(agentSwitchHeld(['a', 'b', 'c'], [row('d'), row('c'), row('a')]).map((one) => one.id)).toEqual(['a', 'c', 'd']);
  });
});
