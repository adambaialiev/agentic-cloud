/**
 * The words of the room's "Reset finished agents" (note #707): the door, the
 * question over it, and the line that reports what the press did. Kept here
 * rather than in the component, so a test can read every sentence.
 */

import type { WorkspaceFreshChatsAnswer } from '../../../../src/shared/workspace-api.js';

/** "Oscar", "Oscar and Ada", "Oscar, Ada and Noah". */
export function namesInWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function freshChatsLabel(count: number): string {
  return `Reset ${count} finished ${count === 1 ? 'agent' : 'agents'}`;
}

export function freshChatsQuestion(names: readonly string[]): { title: string; message: string; verb: string } {
  const one = names.length === 1;
  return {
    title: one ? `Reset ${names[0]}?` : `Reset ${names.length} finished agents?`,
    message: `${namesInWords(names)} ${one ? 'has' : 'have'} finished ${one ? 'its' : 'their'} work, and nothing is waiting on ${one ? 'it' : 'them'}. `
      + `${one ? 'It saves' : 'Each saves'} what matters, then starts a fresh chat and answers you there.`,
    verb: one ? 'Reset' : `Reset ${names.length}`,
  };
}

/**
 * What the press did, in one banner: who was asked, and anyone the server
 * left as they were, with the reason it gave — a turn that started, a
 * proposal that opened — since the question was drawn.
 */
export function freshChatsResult(answer: WorkspaceFreshChatsAnswer): { text: string; ok: boolean } {
  const asked = answer.asked.map((agent) => agent.name);
  const kept = answer.skipped.map((agent) => `${agent.name ?? 'One agent'} ${agent.reason}`);
  const keptLine = kept.length ? `Left as ${kept.length === 1 ? 'it is' : 'they are'}: ${kept.join('; ')}.` : '';
  if (!asked.length) return { text: `Nobody was reset. ${keptLine}`.trim(), ok: false };
  const askedLine = `Asked ${namesInWords(asked)} to start a fresh chat — ${asked.length === 1 ? 'it answers in its chat' : 'each answers in its own chat'}.`;
  return { text: keptLine ? `${askedLine} ${keptLine}` : askedLine, ok: true };
}
