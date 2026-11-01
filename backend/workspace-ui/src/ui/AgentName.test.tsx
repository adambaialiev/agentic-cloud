import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_CLAUDE_MODEL_CATALOG,
  TELEGRAM_CODEX_MODEL_CATALOG,
} from '../../../src/agent/harness-models.js';
import { AgentName } from './AgentName.js';
import { agentWearsCrown } from './agent-crown.js';

/** Notes #296 and #324: the agents running their CLI's flagship — Fable on
 *  Claude Code, GPT-6 Astra on Codex — are marked where the app writes their
 *  name, so every screen that names one shows it. */
describe('AgentName', () => {
  it('gives a flagship agent its name and a crown beside it', () => {
    const { container } = render(<span className="name"><AgentName agent={{ name: 'Ruby', model: 'fable' }} /></span>);

    const name = container.querySelector('.name')!;
    // The text is its own node so the stylesheet can let it truncate alone.
    expect(name.querySelector('.nametext')!.textContent).toBe('Ruby');
    expect(name.querySelector('svg.crown')).toBeTruthy();
    expect(name.textContent).toBe('Ruby');
  });

  it('leaves every other model the bare text node it has always been', () => {
    const { container } = render(<span className="name"><AgentName agent={{ name: 'Felix', model: 'opus' }} /></span>);

    const name = container.querySelector('.name')!;
    expect(name.textContent).toBe('Felix');
    expect(name.querySelector('.nametext')).toBeNull();
    expect(name.querySelector('.crown')).toBeNull();
  });

  it('crowns a Codex agent running GPT-6 Astra, the same way', () => {
    // Note #324. One component, so this is the same crown in the same place;
    // what changed is that the mark means "its CLI's flagship" and not "Fable".
    const { container } = render(<span className="name"><AgentName agent={{ name: 'Mira', model: 'gpt-6-astra' }} /></span>);

    const name = container.querySelector('.name')!;
    expect(name.querySelector('.nametext')!.textContent).toBe('Mira');
    expect(name.querySelector('svg.crown')).toBeTruthy();
    expect(name.textContent).toBe('Mira');
  });

  it('reads the model the way the server writes it, and nothing near it', () => {
    // The state carries the catalog's own label; case and stray space are
    // tolerated because the answer is a mark, not a parse.
    expect(agentWearsCrown('fable')).toBe(true);
    expect(agentWearsCrown(' Fable ')).toBe(true);
    expect(agentWearsCrown('gpt-6-astra')).toBe(true);
    expect(agentWearsCrown(' GPT-6-Astra ')).toBe(true);
    expect(agentWearsCrown('opus')).toBe(false);
    // A near-miss on the crowned one, and the model a Codex agent gets by
    // default: neither is the flagship, so neither is marked.
    expect(agentWearsCrown('gpt-6')).toBe(false);
    expect(agentWearsCrown('gpt-5.6-sol')).toBe(false);
    expect(agentWearsCrown(undefined)).toBe(false);
  });

  /**
   * The crown is written out in `agent-crown.ts` on purpose — it is a claim
   * about which model is best, not a reading of list order. This is what
   * stops that copy from quietly going stale: the catalogs order themselves
   * flagship-first, so if a new model ever takes the top of one, this fails
   * and whoever moved it decides, in the open, whether it wears the crown.
   *
   * Fix by editing `CROWNED_MODELS` in `agent-crown.ts` (or by not putting the
   * new model first) — never by loosening this test.
   */
  it('crowns exactly the first model of each CLI catalog, and nothing else', () => {
    const flagships = [TELEGRAM_CLAUDE_MODEL_CATALOG[0]!, TELEGRAM_CODEX_MODEL_CATALOG[0]!];
    expect(flagships.map((entry) => entry.value)).toEqual(['fable', 'gpt-6-astra']);

    for (const catalog of [TELEGRAM_CLAUDE_MODEL_CATALOG, TELEGRAM_CODEX_MODEL_CATALOG]) {
      for (const [index, entry] of catalog.entries()) {
        // The row carries the LABEL, so that is what has to answer here.
        expect([entry.label, agentWearsCrown(entry.label)]).toEqual([entry.label, index === 0]);
      }
    }
  });
});
