import { posix as pathPosix } from 'path';
import type { PersistedPlanState, PersistedPlanStep } from '../types/persistence.js';
import { DEFAULT_DEVELOPMENT_ROOT } from '../services/development-root.js';

const PLAN_STORAGE_DIRNAME = '.plans';

function normalizePlanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizePlanState(plan: PersistedPlanState): PersistedPlanState {
  const normalizedSteps = plan.steps.map((step) => ({
    stepId: step.stepId.trim(),
    text: normalizePlanText(step.text),
    status: step.status,
  }));
  const explicitActiveStepId = typeof plan.activeStepId === 'string' && plan.activeStepId.trim().length > 0
    ? plan.activeStepId.trim()
    : undefined;
  const explicitActiveStep = explicitActiveStepId
    ? normalizedSteps.find((step) => step.stepId === explicitActiveStepId)
    : undefined;
  const inProgressSteps = normalizedSteps.filter((step) => step.status === 'in_progress');
  const blockedSteps = normalizedSteps.filter((step) => step.status === 'blocked');
  let activeStepId = explicitActiveStepId;
  if (inProgressSteps.length === 1) {
    activeStepId = inProgressSteps[0]?.stepId;
  } else if (inProgressSteps.length === 0 && blockedSteps.length === 1) {
    activeStepId = blockedSteps[0]?.stepId;
  } else if (
    explicitActiveStep
    && explicitActiveStep.status === 'completed'
    && inProgressSteps.length === 0
    && blockedSteps.length === 0
  ) {
    activeStepId = undefined;
  }
  const hasInProgressStep = inProgressSteps.length > 0;

  return {
    summary: normalizePlanText(plan.summary),
    activeStepId,
    steps: normalizedSteps.map((step) => ({
      stepId: step.stepId,
      text: step.text,
      status: (
        activeStepId
        && !hasInProgressStep
        && step.stepId === activeStepId
        && step.status === 'pending'
      )
        ? 'in_progress'
        : step.status,
    })),
  };
}

export function validatePlanState(plan: PersistedPlanState): string | null {
  if (!plan.summary.trim()) {
    return 'Plan summary must be non-empty.';
  }

  if (plan.steps.length === 0) {
    return 'Plan must contain at least one step.';
  }

  const seenStepIds = new Set<string>();
  for (const step of plan.steps) {
    if (!step.stepId.trim()) {
      return 'Every plan step must include a non-empty stepId.';
    }
    if (!step.text.trim()) {
      return `Plan step "${step.stepId}" must include non-empty text.`;
    }
    if (seenStepIds.has(step.stepId)) {
      return `Duplicate plan stepId "${step.stepId}" is not allowed.`;
    }
    seenStepIds.add(step.stepId);
  }

  const activeStep = plan.activeStepId
    ? plan.steps.find((step) => step.stepId === plan.activeStepId)
    : undefined;
  if (plan.activeStepId && !activeStep) {
    return `Active step "${plan.activeStepId}" does not exist in the plan.`;
  }

  const inProgressSteps = plan.steps.filter((step) => step.status === 'in_progress');
  if (inProgressSteps.length > 1) {
    return 'Plan can have at most one in_progress step.';
  }

  if (activeStep && activeStep.status !== 'in_progress' && activeStep.status !== 'blocked') {
    return `Active step "${activeStep.stepId}" must be in_progress or blocked.`;
  }

  if (inProgressSteps.length === 1 && plan.activeStepId !== inProgressSteps[0]?.stepId) {
    return `Active step must match the in_progress step "${inProgressSteps[0]?.stepId}".`;
  }

  return null;
}

function formatPlanStep(step: PersistedPlanStep, isActive: boolean): string {
  const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
  const statusSuffix = step.status === 'in_progress'
    ? ' (in progress)'
    : step.status === 'blocked'
      ? ' (blocked)'
      : '';
  const activeSuffix = isActive ? ' <- active' : '';
  return `- ${checkbox} ${step.text} \`${step.stepId}\`${statusSuffix}${activeSuffix}`;
}

export function renderPlanMarkdown(plan: PersistedPlanState): string {
  const lines = [
    '# Execution Plan',
    '',
    `Summary: ${plan.summary}`,
  ];

  if (plan.activeStepId) {
    lines.push(`Active step: ${plan.activeStepId}`);
  }

  lines.push('', '## Steps', '');

  for (const step of plan.steps) {
    lines.push(formatPlanStep(step, step.stepId === plan.activeStepId));
  }

  lines.push('');
  return lines.join('\n');
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
}

export function getPlanFilePath(
  sessionId: string,
  developmentRoot = DEFAULT_DEVELOPMENT_ROOT,
): string {
  return pathPosix.join(
    developmentRoot,
    PLAN_STORAGE_DIRNAME,
    sanitizePathSegment(sessionId),
    'plan.md',
  );
}

function normalizeCandidatePath(token: string, baseDirectory?: string): string | null {
  const cleaned = token.replace(/^['"]|['"]$/g, '').trim();
  if (!cleaned || cleaned === '/dev/null' || cleaned === '.') {
    return null;
  }

  if (cleaned.startsWith('/')) {
    return pathPosix.normalize(cleaned);
  }

  if (!baseDirectory) {
    return pathPosix.normalize(cleaned);
  }

  return pathPosix.resolve(baseDirectory, cleaned);
}

function findAllMatches(command: string, pattern: RegExp): string[] {
  const matches = [...command.matchAll(pattern)];
  return matches
    .map((match) => match[1] ?? '')
    .filter(Boolean);
}

export function extractTouchedFiles(command: string, baseDirectory?: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /(?:^|\s)>\s*([^\s|&;]+)/g,
    /(?:^|\s)>>\s*([^\s|&;]+)/g,
    /\btee\s+([^\s|&;]+)/g,
    /\btouch\s+([^\s|&;]+)/g,
    /\bsed\s+-i(?:\s+['"][^'"]*['"])?\s+([^\s|&;]+)/g,
    /\bmv\s+[^\s|&;]+\s+([^\s|&;]+)/g,
    /\bcp\s+[^\s|&;]+\s+([^\s|&;]+)/g,
  ];

  for (const pattern of patterns) {
    for (const rawMatch of findAllMatches(command, pattern)) {
      const normalized = normalizeCandidatePath(rawMatch, baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
    }
  }

  return [...candidates];
}

function normalizePatchPath(token: string, baseDirectory?: string): string | null {
  const cleaned = token.replace(/^['"]|['"]$/g, '').trim();
  if (!cleaned || cleaned === '/dev/null') {
    return null;
  }

  const withoutDiffPrefix = cleaned.replace(/^[ab]\//, '');
  return normalizeCandidatePath(withoutDiffPrefix, baseDirectory);
}

export function extractTouchedFilesFromPatch(patch: string, baseDirectory?: string): string[] {
  const candidates = new Set<string>();
  const lines = patch.split('\n');

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      const normalized = normalizePatchPath(line.slice(4), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const normalized = normalizePatchPath(line.slice(4), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const normalized = normalizePatchPath(line.slice('*** Update File: '.length), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      const normalized = normalizePatchPath(line.slice('*** Add File: '.length), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const normalized = normalizePatchPath(line.slice('*** Delete File: '.length), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (line.startsWith('*** Move to: ')) {
      const normalized = normalizePatchPath(line.slice('*** Move to: '.length), baseDirectory);
      if (normalized) {
        candidates.add(normalized);
      }
    }
  }

  return [...candidates];
}
