import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import LiveChief from './LiveChief';
import LiveDecisions from './LiveDecisions';

void React;

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// Note #1016 (Adam, 6 Nov 2026, 08:03 UTC, answering the docs audit of note
// #1011): "agents can share one seat" and "knowledge changes do not wait for
// a decision".
describe('the docs-audit fixes of note #1016', () => {
  it('says several agents can share one seat, in llms.txt, the docs and /product, never "another subscription"', () => {
    expect(read('scripts/prerender.mjs')).toMatch(/Several agents can share one seat, and more seats run more agents at once\./);
    for (const file of [
      'scripts/prerender.mjs',
      'src/components/ProductPitch.tsx',
      'src/docs/chapters/agents.tsx',
      'src/docs/chapters/your-cloud-and-subscriptions.tsx',
      'src/lib/product-copy.ts',
    ]) {
      expect(read(file), file).not.toMatch(/means another subscription|Add another subscription|text: 'Another subscription\.'/);
    }
  });

  it('the decisions panel waits on code proposals only', () => {
    render(<MemoryRouter><LiveDecisions /></MemoryRouter>);
    const says = document.querySelector('.sr-only')?.textContent ?? '';
    expect(says).toMatch(/four code proposals/);
    expect(says).not.toMatch(/knowledge/i);
    expect(document.body.textContent).not.toMatch(/Runbook: deploying the routing service|On-call for the pings pipeline|What six dispatchers told us/);
  });

  it('the Chief of Staff forwards the code proposal alone and says the knowledge page is live', () => {
    render(<MemoryRouter><LiveChief /></MemoryRouter>);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/knowledge proposal #4/);
    expect(read('src/components/LiveChief.tsx')).toMatch(/Otis’s on-call page is live in knowledge/);
    expect(read('src/components/LiveChief.tsx')).not.toMatch(/kind: 'knowledge'/);
  });

  it('the moving row shows Otis’s page as a live knowledge page, not a proposal waiting', () => {
    const source = read('src/components/LiveMarquee.tsx');
    expect(source).toMatch(/<KnowledgeRow page=\{KNOWLEDGE_PAGE\}/);
    expect(source).not.toMatch(/KnowledgeProposalRow/);
    expect(source).toMatch(/Otis’s knowledge page, on-call for the pings pipeline, already live\./);
  });
});
