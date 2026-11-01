import { describe, expect, it } from 'vitest';
import { selectTurnModel } from '../../services/session-model-selection.js';

const USER_TURN = 'anthropic/claude-sonnet-5';
const AUTONOMOUS = 'deepseek/deepseek-v4-pro';

describe('selectTurnModel', () => {
  it('uses the autonomous model for an autonomous run that has not engaged a user turn', () => {
    expect(selectTurnModel({
      userTurnEngaged: false,
      sessionModel: USER_TURN,
      autonomousModel: AUTONOMOUS,
    })).toBe(AUTONOMOUS);
  });

  it('upgrades to the user-turn model once a real user message engages the run', () => {
    expect(selectTurnModel({
      userTurnEngaged: true,
      sessionModel: USER_TURN,
      autonomousModel: AUTONOMOUS,
    })).toBe(USER_TURN);
  });

  it('uses the user-turn model for runs with no autonomous override', () => {
    expect(selectTurnModel({
      userTurnEngaged: true,
      sessionModel: USER_TURN,
      autonomousModel: undefined,
    })).toBe(USER_TURN);
    // Not engaged but no override → still the session (user-turn) model.
    expect(selectTurnModel({
      userTurnEngaged: false,
      sessionModel: USER_TURN,
      autonomousModel: undefined,
    })).toBe(USER_TURN);
  });
});
