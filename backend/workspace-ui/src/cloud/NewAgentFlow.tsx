import { AskToChoose } from '../ui/Ask.js';
import { NEW_AGENT_CLIS, NEW_AGENT_QUESTION } from '../screens/home/agent-words.js';

/**
 * Both Home and the document handoff row enter the same flow: which CLI the
 * new agent thinks with. It used to open on "Connect Fly to create your first
 * agent" whenever the workplace had no cloud of its own; since note #664
 * every such workplace runs on ours, so there is nothing to connect first.
 * A workplace at its limit is told so by the creation itself.
 */
export function NewAgentFlow({ onAnswer }: { onAnswer: (cli: string | null) => void }) {
  return <AskToChoose title="New agent" message={NEW_AGENT_QUESTION} options={NEW_AGENT_CLIS} onAnswer={onAnswer} />;
}
