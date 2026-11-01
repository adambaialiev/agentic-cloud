# Test Timing Report

**Generated:** 2026-04-20 15:49 +0600  
**Branch:** main  
**Commit:** e1e80b0

---

## Frontend Tests (`npm run test:frontend`)

| Metric | Value |
|--------|-------|
| Duration | **1m 37.783s** (~98 seconds) |
| Test Files | 28 |
| Tests Passed | 351 |
| Tests Failed | 0 |
| Status | ✅ **ALL PASSED** |

---

## Backend Tests (`npm test`)

| Metric | Value |
|--------|-------|
| Duration | **48.346s** |
| Test Files | 70 total (2 failed, 47 passed, 21 skipped) |
| Tests Passed | 488 |
| Tests Failed | 6 |
| Skipped | 21 |
| Status | ⚠️ **6 FAILURES** |

### Failed Tests

| Test File | Test Name | Root Cause |
|-----------|-----------|------------|
| `live-eval-world.test.ts` | supports local terminal sessions with rendered screen state and symbolic input | Terminal session status check: expected 'running' but got 'exited' |
| `live-eval-world.test.ts` | supports reading delayed terminal output and closing a still-running session | Terminal session status check: expected 'running' but got 'exited' |
| `live-eval-world.test.ts` | supports closing a running terminal session without sending input | Terminal session status check: expected 'running' but got 'exited' |
| `system-prompt.test.ts` | describes the flattened execution protocol and action guidance | System prompt snapshot outdated |

### Notes on Failures

- The `live-eval-world.test.ts` failures are related to terminal session lifecycle changes — the sandbox terminal session exits immediately instead of staying in 'running' state.
- The `system-prompt.test.ts` failure is due to an updated system prompt that now includes `attach-sandbox-images-to-model` in the shared action tools list.
- All failures appear to be stale snapshots that need updating after recent changes to the terminal session, artifact bridge, and system prompt tooling.

---

## Combined Summary

| Suite | Duration | Passed | Failed | Skipped |
|-------|----------|--------|--------|---------|
| Frontend (`test:frontend`) | 1m 37.8s | 351 | 0 | 0 |
| Backend (`npm test`) | 48.3s | 488 | 6 | 21 |
| **Total** | **~2m 26s** | **839** | **6** | **21** |
