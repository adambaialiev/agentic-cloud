import {
  resolveSupportedModel,
} from '../config/models.js';

export function resolveSessionModel(
  _profile: unknown,
  requestedModel: string | null | undefined,
  fallbackModel: string,
): string {
  return resolveSupportedModel(requestedModel, fallbackModel);
}

/**
 * Pick the raw model id for a single agent turn.
 *
 * `autonomousModel` (set for runs started by an autonomous trigger — intuition,
 * relay, schedule) is used only while the run has not engaged a real user turn.
 * Once a real user message is picked up (`userTurnEngaged`), or for runs with no
 * autonomous model at all, the user-turn model (`sessionModel`) is used. The
 * result is still normalized by the caller via `resolveSupportedModel`.
 */
export function selectTurnModel(args: {
  userTurnEngaged: boolean;
  sessionModel: string | undefined;
  autonomousModel: string | undefined;
}): string | undefined {
  return args.userTurnEngaged
    ? args.sessionModel
    : (args.autonomousModel ?? args.sessionModel);
}
