export default {
  // Same reason as vite.config.ts: the Workspace components under backend/
  // must run on the site's React, not backend/node_modules' copy.
  resolve: { dedupe: ['react', 'react-dom', 'react-router-dom'] },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.frontend.ts'],
    // Same reason, same number as backend/vitest.config.ts, which was raised
    // on 2026-08-16 after a slow CI host turned into seven red tests and a
    // broken main. This project was left on Vitest's 5s default, which is a
    // WORKSTATION assumption: these tests render whole pages through jsdom on
    // a shared-CPU VM whose throughput depends on who else is on the host.
    //
    // It came due on 2026-09-11. `renders the English landing page at the
    // index route` — the first test in its file, so it pays the cold render
    // cost — took 5161ms against the 5000ms default and failed a merge to
    // main. It takes ~1200ms on an idle machine: a 4x margin that a busy host
    // ate anyway. First failure in 1748 runs, which is precisely the shape of
    // the problem: rare enough to read as mysterious, frequent enough to
    // eventually break a green main for no reason.
    //
    // Nothing green pays for this — a timeout only costs time once exceeded.
    // A genuinely hung test is still caught, and the job has its own wall.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'custom',
      customProviderModule: './backend/node_modules/@vitest/coverage-v8/dist/index.js',
      reporter: ['text', 'lcov'],
      all: true,
      include: [
        'src/agent-loop-consumption-v2/reducer.ts',
        'src/agent-loop-consumption-v2/snapshot.ts',
        'src/agent-loop-consumption-v2/projection.ts',
        'src/agent-loop-consumption-v2/effects.ts',
      ],
    },
  },
};
