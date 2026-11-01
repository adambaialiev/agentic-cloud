# Deploy canary

A no-op file touched when we need a harmless PR whose merge+deploy restarts the
backend on purpose — e.g. to live-test that in-flight harness turns survive a
restart (detached CLI + re-attach, PR #774).

Last poke: 2026-07-18
