import { describe, expect, it } from 'vitest';
import type { SessionObservation, SessionToolSummary } from '../../types/tools.js';
import { formatSessionObservation, formatSessionSummaryLine } from '../../agent/session-progress-format.js';

describe('formatSessionSummaryLine', () => {
  it('reports raw recent tools with absolute timestamps and a stale last_reply with its send time', () => {
    const session: SessionToolSummary = {
      sessionId: 'session_child',
      title: 'Wire up deploy',
      status: 'running',
      updatedAt: '2026-06-17T10:00:00.000Z',
      // Stale reply from before authentication completed.
      lastAssistantMessage: 'Open https://github.com/login/device and enter ABCD-1234',
      lastAssistantMessageAt: '2026-06-17T09:55:00.000Z',
      recentToolCalls: [
        { toolName: 'execute_terminal_session', timestamp: '2026-06-17T09:59:55.000Z', status: 'success' },
        { toolName: 'write_file', timestamp: '2026-06-17T09:59:40.000Z', status: 'success' },
        { toolName: 'execute_terminal_session', timestamp: '2026-06-17T09:55:00.000Z', status: 'success' },
      ],
    };

    const line = formatSessionSummaryLine(session, { timeZone: 'UTC' });

    expect(line).toContain('recent_tools="execute_terminal_session:success @ Jun 17, 2026, 09:59 UTC, write_file:success @ Jun 17, 2026, 09:59 UTC, execute_terminal_session:success @ Jun 17, 2026, 09:55 UTC"');
    expect(line).toContain('last_reply="Open https://github.com/login/device and enter ABCD-1234"');
    expect(line).toContain('last_reply_at="Jun 17, 2026, 09:55 UTC"');
    // No heuristic interpretation is emitted.
    expect(line).not.toContain('current_phase');
    expect(line).not.toContain('note=');
  });

  it('omits the timestamp for a recent tool with an unparseable time', () => {
    const session: SessionToolSummary = {
      sessionId: 'session_child',
      status: 'running',
      recentToolCalls: [
        { toolName: 'write_file', timestamp: 'not-a-date', status: 'success' },
      ],
    };

    const line = formatSessionSummaryLine(session);

    expect(line).toContain('recent_tools="write_file:success"');
    expect(line).not.toContain('@');
  });

  it('reports where the session last touched a terminal', () => {
    const session: SessionToolSummary = {
      sessionId: 'session_child',
      title: 'Fixing warnings',
      status: 'completed',
      progress: {
        lastTerminalContext: {
          serverId: '144324665',
          cwd: '/home/agent/myrepo-fix-warnings',
          timestamp: '2026-06-17T09:59:55.000Z',
        },
      },
    };

    const line = formatSessionSummaryLine(session);

    expect(line).toContain('last_terminal="server 144324665, cwd /home/agent/myrepo-fix-warnings"');
  });

  it('omits last_terminal when the session never named a server or working directory', () => {
    const session: SessionToolSummary = {
      sessionId: 'session_child',
      status: 'completed',
      progress: {
        lastTerminalContext: { timestamp: '2026-06-17T09:59:55.000Z' },
      },
    };

    expect(formatSessionSummaryLine(session)).not.toContain('last_terminal=');
  });

  it('omits last_reply_at when the send time is unknown', () => {
    const session: SessionToolSummary = {
      sessionId: 'session_done',
      status: 'completed',
      updatedAt: '2026-06-17T09:00:00.000Z',
      lastAssistantMessage: 'PR opened.',
    };

    const line = formatSessionSummaryLine(session);

    expect(line).toContain('last_reply="PR opened."');
    expect(line).not.toContain('last_reply_at=');
    expect(line).not.toContain('current_phase');
  });
});

describe('formatSessionObservation', () => {
  const baseSession: SessionToolSummary = {
    sessionId: 'session_child',
    title: 'Wire up deploy',
    status: 'running',
    updatedAt: '2026-06-17T10:00:00.000Z',
  };

  it('renders the list-sessions summary line plus history items with text, thinking, and tool outputs', () => {
    const observation: SessionObservation = {
      session: baseSession,
      totalHistoryItems: 42,
      history: [
        {
          role: 'assistant',
          createdAt: '2026-06-17T09:59:00.000Z',
          content: 'Applying the patch now.',
          thinking: 'The failing test points at the retry path.',
          toolCalls: [
            {
              toolName: 'apply_patch',
              parameters: { path: 'src/retry.ts' },
              result: 'Patch applied cleanly.',
            },
          ],
        },
        {
          role: 'tool',
          createdAt: '2026-06-17T09:59:30.000Z',
          toolName: 'apply_patch',
          content: 'File src/retry.ts updated.',
        },
        {
          role: 'user',
          createdAt: '2026-06-17T10:00:00.000Z',
          content: 'Also run the tests.',
        },
      ],
    };

    const text = formatSessionObservation(observation, { timeZone: 'UTC' });

    expect(text).toContain('Session summary:');
    expect(text).toContain('- session_child | Wire up deploy | status=running | updated=Jun 17, 2026, 10:00 UTC');
    expect(text).toContain('Recent history (last 3 of 42 items, oldest first):');
    expect(text).toContain('--- [40/42] assistant @ Jun 17, 2026, 09:59 UTC ---');
    expect(text).toContain('thinking:\nThe failing test points at the retry path.');
    expect(text).toContain('text:\nApplying the patch now.');
    expect(text).toContain('tool_call: apply_patch');
    expect(text).toContain('parameters: {"path":"src/retry.ts"}');
    expect(text).toContain('result:\nPatch applied cleanly.');
    expect(text).toContain('--- [41/42] tool (apply_patch) @ Jun 17, 2026, 09:59 UTC ---');
    expect(text).toContain('output:\nFile src/retry.ts updated.');
    expect(text).toContain('--- [42/42] user @ Jun 17, 2026, 10:00 UTC ---');
    expect(text).toContain('Also run the tests.');
  });

  it('truncates oversized content blocks but preserves newlines', () => {
    const longOutput = `line one\n${'x'.repeat(3_000)}`;
    const observation: SessionObservation = {
      session: baseSession,
      totalHistoryItems: 1,
      history: [
        {
          role: 'tool',
          toolName: 'execute_terminal_session',
          content: longOutput,
        },
      ],
    };

    const text = formatSessionObservation(observation);

    expect(text).toContain('output:\nline one\n');
    expect(text).toContain(`… [truncated ${longOutput.length - 2_000} chars]`);
    expect(text).not.toContain(longOutput);
  });

  it('marks an in-progress tool call and reports an empty history', () => {
    const inProgress: SessionObservation = {
      session: baseSession,
      totalHistoryItems: 5,
      history: [
        {
          role: 'assistant',
          toolCalls: [
            { toolName: 'execute_terminal_session', parameters: {}, isComplete: false },
          ],
        },
      ],
    };
    expect(formatSessionObservation(inProgress)).toContain('tool_call: execute_terminal_session (in progress)');
    // Empty parameters objects are not rendered.
    expect(formatSessionObservation(inProgress)).not.toContain('parameters:');

    const empty: SessionObservation = {
      session: baseSession,
      totalHistoryItems: 0,
      history: [],
    };
    expect(formatSessionObservation(empty)).toContain('Recent history: (empty — the session has no history items yet)');
  });
});
