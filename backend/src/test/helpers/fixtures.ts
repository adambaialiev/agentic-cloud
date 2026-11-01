/**
 * Fixture builders for creating structured LLM responses in tests.
 * These are used with the mock streamText to simulate tool-call responses.
 */

export interface ToolCallFixture {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ResponseFixture {
  text?: string;
  toolCalls: ToolCallFixture[];
}

export const LLMResponseFixture = {
  /**
   * Create a text-only terminal response.
   */
  simpleMessage(message: string, thought?: string): ResponseFixture {
    return {
      text: thought ? `${thought}\n\n${message}` : message,
      toolCalls: [],
    };
  },

  /**
   * Create a response that starts a terminal command.
   */
  executeCodeSync(
    command: string,
    cwd?: string,
    thought?: string
  ): ResponseFixture {
    const args: Record<string, unknown> = { action: 'start', command };
    if (cwd) args.cwd = cwd;
    return {
      text: thought,
      toolCalls: [{
        toolName: 'execute_terminal_session',
        args,
      }],
    };
  },

  /**
   * Create a response that starts a terminal session (non-terminal).
   */
  executeTerminalSessionStart(
    command: string,
    cwd?: string,
    thought?: string
  ): ResponseFixture {
    const args: Record<string, unknown> = { action: 'start', command };
    if (cwd) args.cwd = cwd;
    return {
      text: thought,
      toolCalls: [{
        toolName: 'execute_terminal_session',
        args,
      }],
    };
  },

  /**
   * Create a response with multiple tool calls.
   */
  multipleTools(
    invocations: Array<{ toolName: string; args: Record<string, unknown> }>,
    thought?: string
  ): ResponseFixture {
    return {
      text: thought,
      toolCalls: invocations,
    };
  },

  /**
   * Create an empty response (for testing empty-response error handling).
   */
  empty(): ResponseFixture {
    return { toolCalls: [] };
  },

  /**
   * Create a text-only response (no tool calls).
   */
  textOnly(text: string): ResponseFixture {
    return { text, toolCalls: [] };
  },
};
