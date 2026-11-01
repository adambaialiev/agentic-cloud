import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySessionStorage } from '../../services/session-storage.js';
import { AgentMessage } from '../../types/agent.js';
import type { PersistedScheduledReminderDocument } from '../../types/persistence.js';

describe('InMemorySessionStorage', () => {
  let storage: InMemorySessionStorage;

  beforeEach(() => {
    storage = new InMemorySessionStorage();
  });

  describe('createSession', () => {
    it('should create a new session with correct initial state', async () => {
      const session = await storage.createSession('session-1', 'user-1');

      expect(session.sessionId).toBe('session-1');
      expect(session.userId).toBe('user-1');
      expect(session.status).toBe('idle');
      expect(session.history).toEqual([]);
      expect(session.messageCount).toBe(0);
      expect(session.pendingClarification).toBe(false);
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    it('should create sessions with different IDs', async () => {
      const session1 = await storage.createSession('session-1', 'user-1');
      const session2 = await storage.createSession('session-2', 'user-1');

      expect(session1.sessionId).toBe('session-1');
      expect(session2.sessionId).toBe('session-2');
    });

    it('should persist runtime context when provided', async () => {
      const session = await storage.createSession('session-1', 'user-1', {
        runtimeContext: {
          timeZone: 'America/New_York',
        },
      });

      expect(session.runtimeContext).toEqual({
        timeZone: 'America/New_York',
      });
    });

    it('should persist sandbox assignment when provided', async () => {
      const session = await storage.createSession('session-1', 'user-1', {
        sandboxId: 'sandbox-default',
      });

      expect(session.sandboxId).toBe('sandbox-default');
    });

    it('should persist machine name when provided', async () => {
      const session = await storage.createSession('session-1', 'user-1', {
        sandboxId: 'sh_macbook',
        machineName: 'Local MacBook',
      });

      expect(session.machineName).toBe('Local MacBook');
      await expect(storage.getSession('user-1', 'session-1')).resolves.toMatchObject({
        machineName: 'Local MacBook',
      });
    });

    it('does not seed legacy controller metadata for new sessions', async () => {
      const session = await storage.createSession('session-1', 'user-1');

      expect(session.observations).toEqual([]);
      expect(session.touchedFiles).toBeUndefined();
    });

  });

  describe('getSession', () => {
    it('should return null for non-existent session', async () => {
      const session = await storage.getSession('user-1', 'non-existent');

      expect(session).toBeNull();
    });

    it('should return the created session with history: []', async () => {
      await storage.createSession('session-1', 'user-1');
      await storage.addToHistory('user-1', 'session-1', { role: 'user', content: 'Hello!' });

      const session = await storage.getSession('user-1', 'session-1');

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('session-1');
      expect(session!.userId).toBe('user-1');
      // getSession() returns metadata only — history is always []
      expect(session!.history).toEqual([]);
      expect(session!.messageCount).toBe(1);
    });
  });

  describe('updateSession', () => {
    it('should update session status', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.updateSession('user-1', 'session-1', { status: 'running' });

      const session = await storage.getSession('user-1', 'session-1');
      expect(session!.status).toBe('running');
    });

    it('should update multiple fields at once', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.updateSession('user-1', 'session-1', {
        status: 'error',
        lastError: 'Something went wrong',
      });

      const session = await storage.getSession('user-1', 'session-1');
      expect(session!.status).toBe('error');
      expect(session!.lastError).toBe('Something went wrong');
    });

    it('should update clarifying question state', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.updateSession('user-1', 'session-1', {
        status: 'awaiting_input',
        pendingClarification: true,
        clarifyingQuestion: {
          question: 'What color?',
          options: ['Red', 'Blue', 'Green'],
        },
      });

      const session = await storage.getSession('user-1', 'session-1');
      expect(session!.status).toBe('awaiting_input');
      expect(session!.pendingClarification).toBe(true);
      expect(session!.clarifyingQuestion).toEqual({
        question: 'What color?',
        options: ['Red', 'Blue', 'Green'],
      });
    });

    it('should update updatedAt timestamp', async () => {
      const session1 = await storage.createSession('session-1', 'user-1');
      const originalUpdatedAt = session1.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await storage.updateSession('user-1', 'session-1', { status: 'running' });

      const session2 = await storage.getSession('user-1', 'session-1');
      expect(session2!.updatedAt.seconds).toBeGreaterThanOrEqual(
        originalUpdatedAt.seconds
      );
    });

    it('should do nothing for non-existent session', async () => {
      // Should not throw
      await storage.updateSession('user-1', 'non-existent', { status: 'running' });

      const session = await storage.getSession('user-1', 'non-existent');
      expect(session).toBeNull();
    });
  });

  describe('updateSessionRunnerState', () => {
    it('updates runner metadata without changing updatedAt', async () => {
      const created = await storage.createSession('session-1', 'user-1');
      const originalUpdatedAt = created.updatedAt;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.updateSessionRunnerState('user-1', 'session-1', {
        runner: {
          ownerId: 'runner-1',
          runId: 'run-1',
          heartbeatAt: '2026-05-16T12:00:00.000Z',
          expiresAt: '2026-05-16T12:02:00.000Z',
        },
        shutdownCheckpointAt: '2026-05-16T12:00:00.000Z',
      });

      const session = await storage.getSession('user-1', 'session-1');
      expect(session?.runner?.ownerId).toBe('runner-1');
      expect(session?.shutdownCheckpointAt).toBe('2026-05-16T12:00:00.000Z');
      expect(session?.updatedAt).toBe(originalUpdatedAt);
    });
  });

  describe('addToHistory', () => {
    it('should add message and increment messageCount', async () => {
      await storage.createSession('session-1', 'user-1');

      const message: AgentMessage = { role: 'user', content: 'Hello!' };
      await storage.addToHistory('user-1', 'session-1', message);

      const session = await storage.getSession('user-1', 'session-1');
      expect(session!.messageCount).toBe(1);

      // Verify via getHistory()
      const history = await storage.getHistory('user-1', 'session-1');
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(message);
    });

    it('should handle tool role with structured fields', async () => {
      await storage.createSession('session-1', 'user-1');

      const message: AgentMessage = {
        role: 'tool',
        content: 'success',
        toolCallId: 'call_1',
        toolName: 'execute_terminal_session',
        terminalResult: {
          sessionId: 'ssh_1',
          revision: 1,
          status: 'running',
          exitCode: null,
          screen: {
            cols: 120,
            rows: 30,
            altBuffer: false,
            cursor: { row: 1, col: 1 },
            output: ['success'],
          },
        },
      };
      await storage.addToHistory('user-1', 'session-1', message);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history[0].role).toBe('tool');
      expect(history[0].toolCallId).toBe('call_1');
      expect(history[0].toolName).toBe('execute_terminal_session');
      expect(history[0].terminalResult?.screen.output).toEqual(['success']);
    });

    it('should preserve file metadata on tool history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      const message: AgentMessage = {
        role: 'tool',
        content: 'Sent 1 server file to the user on Telegram.',
        toolCallId: 'call_send_telegram_files_1',
        toolName: 'send-server-files-to-user-telegram',
        files: [
          {
            fileId: 'file-preview',
            url: 'https://example.com/preview.png',
            expiresAt: '2026-04-16T00:00:00.000Z',
            storagePath: 'users/user-1/sessions/session-1/files/file-preview/preview.png',
            fileName: 'preview.png',
            displayName: 'Checkout preview',
            contentType: 'image/png',
            mediaKind: 'image',
            renderAs: 'image',
            sizeBytes: 12345,
            visibility: 'session',
            purpose: 'user_visible',
          },
        ],
      };

      await storage.addToHistory('user-1', 'session-1', message);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history[0].files).toEqual(message.files);
    });

    it('should preserve user attachment metadata on history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      const message: AgentMessage = {
        role: 'user',
        content: 'Please review this image.',
        attachments: [
          {
            fileId: 'attachment-1',
            url: 'https://example.com/design.png',
            expiresAt: '2026-04-16T00:00:00.000Z',
            storagePath: 'users/user-1/sessions/session-1/files/attachment-1/design.png',
            fileName: 'design.png',
            displayName: 'Design',
            contentType: 'image/png',
            mediaKind: 'image',
            renderAs: 'image',
            sizeBytes: 2048,
            visibility: 'session',
            source: 'user_input',
            use: 'model_input',
          },
        ],
      };

      await storage.addToHistory('user-1', 'session-1', message);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history[0].attachments).toEqual(message.attachments);
    });

    it('should round-trip persisted plan history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      const message: AgentMessage = {
        role: 'assistant',
        content: '',
        plan: {
          summary: 'Repair checkout and verify the totals',
          activeStepId: 'verify',
          steps: [
            {
              stepId: 'repair',
              text: 'Repair the checkout flow',
              status: 'completed',
            },
            {
              stepId: 'verify',
              text: 'Verify the totals',
              status: 'in_progress',
            },
          ],
        },
      };
      await storage.addToHistory('user-1', 'session-1', message);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history[0]).toEqual(message);
    });

    it('should round-trip replay-only summary fields on history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      const assistantMessage: AgentMessage = {
        role: 'assistant',
        content: '',
        phase: 'run',
        thinking: 'Inspect the previous tool output before acting.',
        model: 'mock-model',
        replayThinking: 'Reviewed prior output and selected the next action.',
        nextPhase: 'run',
        toolCalls: [
          {
            toolCallId: 'call_1',
            tool_name: 'execute_terminal_session',
            parameters: {
              cmd: 'npm test',
            },
            replayParameters: {
              cmd: 'npm test',
            },
          },
        ],
      };
      const toolMessage: AgentMessage = {
        role: 'tool',
        content: 'very large raw tool output',
        replayContent: 'Tests failed in checkout.spec.ts with a totals mismatch.',
        toolCallId: 'call_1',
        toolName: 'execute_terminal_session',
      };

      await storage.addToHistory('user-1', 'session-1', assistantMessage);
      await storage.addToHistory('user-1', 'session-1', toolMessage);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history).toEqual([assistantMessage, toolMessage]);
    });

    it('should set title from first non-trigger user message', async () => {
      await storage.createSession('session-1', 'user-1');

      // First message is the trigger — should not set title
      const trigger: AgentMessage = {
        role: 'user',
        content: "Hi, I just started a new session. Please introduce yourself and ask what I'd like you to help me with.",
      };
      await storage.addToHistory('user-1', 'session-1', trigger);

      let session = await storage.getSession('user-1', 'session-1');
      expect(session!.title).toBeUndefined();

      // Second user message should set the title
      const userMsg: AgentMessage = { role: 'user', content: 'Help me build a todo app' };
      await storage.addToHistory('user-1', 'session-1', userMsg);

      session = await storage.getSession('user-1', 'session-1');
      expect(session!.title).toBe('Help me build a todo app');
    });

    it('should not overwrite existing title', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.addToHistory('user-1', 'session-1', { role: 'user', content: 'First question' });
      await storage.addToHistory('user-1', 'session-1', { role: 'user', content: 'Second question' });

      const session = await storage.getSession('user-1', 'session-1');
      expect(session!.title).toBe('First question');
    });
  });

  describe('getHistory', () => {
    it('should return empty array for session with no history', async () => {
      await storage.createSession('session-1', 'user-1');

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history).toEqual([]);
    });

    it('should return messages in order', async () => {
      await storage.createSession('session-1', 'user-1');

      const messages: AgentMessage[] = [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      for (const msg of messages) {
        await storage.addToHistory('user-1', 'session-1', msg);
      }

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('Hello!');
      expect(history[1].content).toBe('Hi there!');
      expect(history[2].content).toBe('How are you?');
    });

    it('should return empty array for non-existent session', async () => {
      const history = await storage.getHistory('user-1', 'non-existent');
      expect(history).toEqual([]);
    });

    it('returns the newest tail first when paging history without a cursor', async () => {
      await storage.createSession('session-1', 'user-1');

      for (const content of ['one', 'two', 'three', 'four']) {
        await storage.addToHistory('user-1', 'session-1', { role: 'user', content });
      }

      const page = await storage.getHistoryPage?.('user-1', 'session-1', { limit: 2 });
      expect(page).toBeDefined();
      expect(page?.messages.map((message) => message.content)).toEqual(['three', 'four']);
      expect(page?.oldestLoadedSeq).toBe(2);
      expect(page?.hasMoreHistory).toBe(true);
    });

    it('returns older history before the provided seq cursor', async () => {
      await storage.createSession('session-1', 'user-1');

      for (const content of ['one', 'two', 'three', 'four']) {
        await storage.addToHistory('user-1', 'session-1', { role: 'user', content });
      }

      const page = await storage.getHistoryPage?.('user-1', 'session-1', {
        beforeSeq: 2,
        limit: 2,
      });
      expect(page).toBeDefined();
      expect(page?.messages.map((message) => message.content)).toEqual(['one', 'two']);
      expect(page?.oldestLoadedSeq).toBe(0);
      expect(page?.hasMoreHistory).toBe(false);
    });
  });

  describe('updateHistoryReplayData', () => {
    it('persists replay summary fields for existing history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.addToHistory('user-1', 'session-1', {
        role: 'assistant',
        content: '',
        nextPhase: 'run',
        thinking: 'Inspect the checkout flow before applying the fix.',
        toolCalls: [{
          toolCallId: 'call_1',
          tool_name: 'apply_patch',
          parameters: {
            patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch',
          },
        }],
      });
      await storage.addToHistory('user-1', 'session-1', {
        role: 'tool',
        content: 'Patch applied successfully',
        toolCallId: 'call_1',
        toolName: 'apply_patch',
      });
      await storage.addToHistory('user-1', 'session-1', {
        role: 'assistant',
        content: '',
        nextPhase: 'run',
        thinking: 'Run the focused test before reporting.',
      });

      await storage.updateHistoryReplayData('user-1', 'session-1', [
        {
          seq: 0,
          replayThinking: '[replay summary] Older reasoning focused on the checkout fix.',
          toolCalls: [{
            toolCallId: 'call_1',
            tool_name: 'apply_patch',
            parameters: {
              patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch',
            },
            replayParameters: {
              patch: '[replay summary] summarized apply_patch input for src/app.ts',
            },
          }],
        },
        {
          seq: 1,
          replayContent: '[apply_patch replay summary]\nresult: patch applied successfully',
        },
      ]);

      const history = await storage.getHistory('user-1', 'session-1');

      expect(history[0].replayThinking).toBe(
        '[replay summary] Older reasoning focused on the checkout fix.',
      );
      expect(history[0].toolCalls?.[0].replayParameters).toEqual({
        patch: '[replay summary] summarized apply_patch input for src/app.ts',
      });
      expect(history[1].replayContent).toBe(
        '[apply_patch replay summary]\nresult: patch applied successfully',
      );
    });

    it('persists updated attachments for existing history entries', async () => {
      await storage.createSession('session-1', 'user-1');

      const attachment = {
        fileId: 'file_photo_1',
        url: 'https://storage.example.com/logo.jpg',
        storagePath: 'users/user-1/sessions/session-1/files/file_photo_1/telegram-photo-abc123.jpg',
        fileName: 'telegram-photo-abc123.jpg',
        contentType: 'image/jpeg',
        mediaKind: 'image',
        renderAs: 'image',
        sizeBytes: 1000,
        visibility: 'session',
        source: 'user_input',
        use: 'sandbox_input',
      } as const;

      await storage.addToHistory('user-1', 'session-1', {
        role: 'user',
        content: 'Hermes',
        attachments: [{ ...attachment }],
      });

      await storage.updateHistoryReplayData('user-1', 'session-1', [
        {
          seq: 0,
          attachments: [{
            ...attachment,
            description: 'A black-and-white anime-style logo illustration.',
          }],
        },
      ]);

      const history = await storage.getHistory('user-1', 'session-1');
      expect(history[0].attachments?.[0].description).toBe(
        'A black-and-white anime-style logo illustration.',
      );
    });
  });

  describe('getSessionsForUser', () => {
    it('should return empty array for user with no sessions', async () => {
      const sessions = await storage.getSessionsForUser('user-1');

      expect(sessions).toEqual([]);
    });

    it('should return all sessions for a user with history: []', async () => {
      await storage.createSession('session-1', 'user-1');
      await storage.createSession('session-2', 'user-1');
      await storage.createSession('session-3', 'user-2');

      // Add some history to session-1
      await storage.addToHistory('user-1', 'session-1', { role: 'user', content: 'Hello!' });

      const sessions = await storage.getSessionsForUser('user-1');

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual([
        'session-1',
        'session-2',
      ]);
      // history should be empty in listing (lightweight)
      for (const s of sessions) {
        expect(s.history).toEqual([]);
      }
    });

    it('should return sessions sorted by updatedAt descending', async () => {
      // Import Timestamp to create controlled timestamps
      const { Timestamp } = await import('../../types/timestamp.js');

      // Create sessions — we need to manipulate the internal storage timestamps
      // so we use getSession + getHistory pattern
      await storage.createSession('session-1', 'user-1');
      await storage.createSession('session-2', 'user-1');
      await storage.createSession('session-3', 'user-1');

      // Access internal storage to set timestamps directly
      // (InMemorySessionStorage stores sessions in a Map)
      const s1 = (storage as any).storage.get('user-1/session-1');
      const s2 = (storage as any).storage.get('user-1/session-2');
      const s3 = (storage as any).storage.get('user-1/session-3');
      s1.updatedAt = new Timestamp(1000, 0);
      s2.updatedAt = new Timestamp(2000, 0);
      s3.updatedAt = new Timestamp(3000, 0);

      const sessions = await storage.getSessionsForUser('user-1');

      // session-3 has highest seconds, so it should be first
      expect(sessions[0].sessionId).toBe('session-3');
      expect(sessions[1].sessionId).toBe('session-2');
      expect(sessions[2].sessionId).toBe('session-1');
    });

    it('should apply an optional limit after sorting by updatedAt descending', async () => {
      const { Timestamp } = await import('../../types/timestamp.js');

      await storage.createSession('session-1', 'user-1');
      await storage.createSession('session-2', 'user-1');
      await storage.createSession('session-3', 'user-1');

      const s1 = (storage as any).storage.get('user-1/session-1');
      const s2 = (storage as any).storage.get('user-1/session-2');
      const s3 = (storage as any).storage.get('user-1/session-3');
      s1.updatedAt = new Timestamp(1000, 0);
      s2.updatedAt = new Timestamp(2000, 0);
      s3.updatedAt = new Timestamp(3000, 0);

      const sessions = await storage.getSessionsForUser('user-1', { limit: 2 });

      expect(sessions.map((session) => session.sessionId)).toEqual([
        'session-3',
        'session-2',
      ]);
    });
  });

  describe('getLatestUserMessages', () => {
    it('returns the newest visible user or assistant message per user', async () => {
      await storage.createSession('older-session', 'user-1');
      await storage.createSession('newer-session', 'user-1');
      await storage.createSession('other-user-session', 'user-2');

      await storage.addToHistory('user-1', 'older-session', {
        role: 'user',
        content: 'Older request',
        createdAt: '2026-05-01T10:00:00.000Z',
      });
      await storage.addToHistory('user-1', 'newer-session', {
        role: 'user',
        content: "Hi, I just started a new session. Please introduce yourself and ask what I'd like you to help me with.",
        createdAt: '2026-05-03T10:00:00.000Z',
      });
      await storage.addToHistory('user-1', 'newer-session', {
        role: 'user',
        content: 'Newest real request',
        createdAt: '2026-05-02T10:00:00.000Z',
      });
      await storage.addToHistory('user-1', 'newer-session', {
        role: 'assistant',
        content: 'Assistant response after the latest user message',
        createdAt: '2026-05-04T10:00:00.000Z',
      });
      await storage.addToHistory('user-2', 'other-user-session', {
        role: 'user',
        content: 'Other user request',
        createdAt: '2026-05-05T10:00:00.000Z',
      });

      const latestMessages = await storage.getLatestUserMessages(['user-1', 'user-2', 'missing-user']);

      expect(latestMessages).toEqual({
        'user-1': {
          userId: 'user-1',
          sessionId: 'newer-session',
          role: 'assistant',
          content: 'Assistant response after the latest user message',
          createdAt: '2026-05-04T10:00:00.000Z',
        },
        'user-2': {
          userId: 'user-2',
          sessionId: 'other-user-session',
          role: 'user',
          content: 'Other user request',
          createdAt: '2026-05-05T10:00:00.000Z',
        },
      });
    });
  });

  describe('replaceSandboxForUser', () => {
    it('updates all sessions assigned to the replaced sandbox', async () => {
      await storage.createSession('session-1', 'user-1', { sandboxId: 'sandbox-old' });
      await storage.createSession('session-2', 'user-1', { sandboxId: 'sandbox-old' });
      await storage.createSession('session-3', 'user-1', { sandboxId: 'sandbox-other' });

      await storage.replaceSandboxForUser('user-1', 'sandbox-old', 'sandbox-new');

      expect((await storage.getSession('user-1', 'session-1'))?.sandboxId).toBe('sandbox-new');
      expect((await storage.getSession('user-1', 'session-2'))?.sandboxId).toBe('sandbox-new');
      expect((await storage.getSession('user-1', 'session-3'))?.sandboxId).toBe('sandbox-other');
    });
  });

  describe('deleteSession', () => {
    it('should delete an existing session', async () => {
      await storage.createSession('session-1', 'user-1');

      await storage.deleteSession('user-1', 'session-1');

      const session = await storage.getSession('user-1', 'session-1');
      expect(session).toBeNull();
    });

    it('should not throw for non-existent session', async () => {
      await expect(storage.deleteSession('user-1', 'non-existent')).resolves.not.toThrow();
    });

    it('should not affect other sessions', async () => {
      await storage.createSession('session-1', 'user-1');
      await storage.createSession('session-2', 'user-1');

      await storage.deleteSession('user-1', 'session-1');

      const session2 = await storage.getSession('user-1', 'session-2');
      expect(session2).not.toBeNull();
    });

  });
});
