import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Two projects under one `vitest run`, so CI and the deploy build need no
// second command: the backend suite (Node), and the React Workspace shell
// under workspace-ui/ (jsdom). Timeouts and coverage below apply to both.
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'backend',
          environment: 'node',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'workspace-ui',
          environment: 'jsdom',
          setupFiles: ['./workspace-ui/src/test/setup.ts'],
          include: ['workspace-ui/src/**/*.test.{ts,tsx}'],
        },
      },
    ],
    // Vitest's defaults (5s per test, 10s per hook) are a WORKSTATION
    // assumption, and this suite does not run on one. Two dozen of these files
    // shell out to real git, real shell scripts and real child processes, and
    // the CI machine is a shared-CPU Fly VM whose throughput depends on who
    // else is on the host: measured 2026-08-16, the same suite took 34s here
    // and 382s there — 11x slower on the same number of cores, uniformly
    // across import and execution.
    //
    // Nothing green pays for this: a timeout only costs time once it is
    // exceeded. What it buys is that a slow HOST reads as a slow run rather
    // than as seven red tests and a broken main, which is what happened the
    // day this was raised. A test that has genuinely hung is still caught,
    // 25 seconds later, and the job has its own 15-minute wall besides.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/agent/**/*.ts', 'src/services/session-storage.ts'],
      exclude: ['src/test/**'],
      thresholds: {
        'src/agent/agent-loop.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/agent/background-runner.ts': {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
