import { describe, expect, it } from 'vitest';
import {
  extractTouchedFiles,
  extractTouchedFilesFromPatch,
  getPlanFilePath,
  normalizePlanState,
  renderPlanMarkdown,
  validatePlanState,
} from '../../agent/working-state.js';

describe('working-state', () => {
  it('normalizes plan text before persisting it', () => {
    expect(normalizePlanState({
      summary: '  Fix   the login bug  ',
      activeStepId: ' inspect ',
      steps: [
        {
          stepId: ' inspect ',
          text: ' Inspect   login   flow ',
          status: 'in_progress',
        },
      ],
    })).toEqual({
      summary: 'Fix the login bug',
      activeStepId: 'inspect',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'in_progress',
        },
      ],
    });
  });

  it('promotes a pending active step to in_progress when no other active step exists', () => {
    expect(normalizePlanState({
      summary: 'Fix the login bug',
      activeStepId: 'patch',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'pending',
        },
      ],
    })).toEqual({
      summary: 'Fix the login bug',
      activeStepId: 'patch',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'in_progress',
        },
      ],
    });
  });

  it('infers activeStepId from a lone in_progress step', () => {
    expect(normalizePlanState({
      summary: 'Fix the login bug',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'in_progress',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'pending',
        },
      ],
    })).toEqual({
      summary: 'Fix the login bug',
      activeStepId: 'inspect',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'in_progress',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'pending',
        },
      ],
    });
  });

  it('clears a stale activeStepId once all steps are completed', () => {
    expect(normalizePlanState({
      summary: 'Fix the login bug',
      activeStepId: 'verify',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'verify',
          text: 'Verify the fix',
          status: 'completed',
        },
      ],
    })).toEqual({
      summary: 'Fix the login bug',
      activeStepId: undefined,
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'verify',
          text: 'Verify the fix',
          status: 'completed',
        },
      ],
    });
  });

  it('validates active-step consistency', () => {
    expect(validatePlanState({
      summary: 'Fix the login bug',
      activeStepId: 'patch',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'pending',
        },
      ],
    })).toBe('Active step "patch" must be in_progress or blocked.');
  });

  it('renders a markdown checklist for the workspace mirror', () => {
    const markdown = renderPlanMarkdown({
      summary: 'Fix the login bug',
      activeStepId: 'patch',
      steps: [
        {
          stepId: 'inspect',
          text: 'Inspect login flow',
          status: 'completed',
        },
        {
          stepId: 'patch',
          text: 'Patch the bug',
          status: 'in_progress',
        },
      ],
    });

    expect(markdown).toContain('# Execution Plan');
    expect(markdown).toContain('Summary: Fix the login bug');
    expect(markdown).toContain('- [x] Inspect login flow `inspect`');
    expect(markdown).toContain('- [ ] Patch the bug `patch` (in progress) <- active');
  });

  it('stores plan files under /root/.plans/<sessionId>/plan.md', () => {
    expect(getPlanFilePath('session:1/alpha')).toBe('/root/.plans/session_1_alpha/plan.md');
  });

  it('stores plan files under the provided development root when one is supplied', () => {
    expect(getPlanFilePath('session:1/alpha', '/root')).toBe('/root/.plans/session_1_alpha/plan.md');
  });

  it('extracts touched files from mutating shell commands', () => {
    expect(extractTouchedFiles(
      "printf 'updated' > src/app.ts",
      '/root/customer-portal',
    )).toEqual(['/root/customer-portal/src/app.ts']);

    expect(extractTouchedFiles(
      "sed -i '' src/app.ts",
      '/root/customer-portal',
    )).toEqual(['/root/customer-portal/src/app.ts']);
  });

  it('extracts touched files from unified diff patches', () => {
    expect(extractTouchedFilesFromPatch([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const version = 1;',
      '+const version = 2;',
    ].join('\n'), '/root/customer-portal')).toEqual([
      '/root/customer-portal/src/app.ts',
    ]);

    expect(extractTouchedFilesFromPatch([
      '*** Update File: src/server.ts',
      '@@',
      '-old',
      '+new',
    ].join('\n'), '/root/customer-portal')).toEqual([
      '/root/customer-portal/src/server.ts',
    ]);
  });
});
