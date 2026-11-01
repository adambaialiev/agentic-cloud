import type { AgentType } from '../types/persistence.js';

export function resolveAgentType(
  agentType?: AgentType,
  isAutonomous?: boolean,
): AgentType {
  if (agentType) {
    return agentType;
  }

  return isAutonomous ? 'autonomous' : 'reactive';
}
