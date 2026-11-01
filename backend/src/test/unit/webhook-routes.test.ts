import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { webhookRoutes } from '../../routes/webhooks.js';
import type { RouteDeps } from '../../routes/deps.js';

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: undefined,
  };

  response.status = ((code: number) => {
    response.statusCode = code;
    return response as Response;
  }) as Response['status'];

  response.json = ((payload: unknown) => {
    response.body = payload;
    return response as Response;
  }) as Response['json'];

  return response;
}

function getRouteHandler(
  path: string,
  method: 'post',
  deps: Partial<RouteDeps>,
  stackIndex = -1,
): (req: Partial<Request>, res: MockResponse) => Promise<Response> {
  const router = webhookRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<Response> }>;
      };
    }>;
  };

  const layer = router.stack.find((candidate) => (
    candidate.route?.path === path && candidate.route.methods[method]
  ));
  const stack = layer?.route?.stack ?? [];
  const index = stackIndex >= 0 ? stackIndex : stack.length + stackIndex;
  const handler = stack[index]?.handle;

  if (!handler) {
    throw new Error(`Failed to locate ${method.toUpperCase()} ${path} handler`);
  }

  return handler;
}
describe('webhookRoutes', () => {
  it('does not expose a customer Telegram webhook', () => {
    expect(() => getRouteHandler('/telegram', 'post', {})).toThrow(
      'Failed to locate POST /telegram handler',
    );
    expect(() => getRouteHandler('/telegram/:botId', 'post', {})).toThrow(
      'Failed to locate POST /telegram/:botId handler',
    );
  });

  it('returns 503 when the internal ops bot is not configured', async () => {
    const handler = getRouteHandler('/telegram-ops', 'post', {});
    const response = createMockResponse();

    await handler({ body: {}, get: vi.fn() } as Partial<Request>, response);

    expect(response.statusCode).toBe(503);
  });

  it('protects the internal ops webhook with its dedicated secret', async () => {
    const handleUpdate = vi.fn();
    const handler = getRouteHandler('/telegram-ops', 'post', {
      opsBotService: { handleUpdate } as never,
      opsBotWebhookSecret: 'ops-secret',
    });
    const response = createMockResponse();

    await handler({
      body: {},
      get: vi.fn(() => 'wrong-secret'),
    } as Partial<Request>, response);

    expect(response.statusCode).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('dispatches a valid internal ops update', async () => {
    const body = { message: { text: '/pool', chat: { id: 5 } } };
    const handleUpdate = vi.fn().mockResolvedValue('answered');
    const handler = getRouteHandler('/telegram-ops', 'post', {
      opsBotService: { handleUpdate } as never,
      opsBotWebhookSecret: 'ops-secret',
    });
    const response = createMockResponse();

    await handler({
      body,
      get: vi.fn((name: string) => (
        name.toLowerCase() === 'x-telegram-bot-api-secret-token' ? 'ops-secret' : undefined
      )),
    } as Partial<Request>, response);

    expect(response.body).toEqual({ ok: true, outcome: 'answered' });
    expect(handleUpdate).toHaveBeenCalledWith(body);
  });
});
