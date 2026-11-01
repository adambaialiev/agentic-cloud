import { createGateway } from '@ai-sdk/gateway';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

const AI_GATEWAY_TIMEOUT_MS = 900_000;
const AI_GATEWAY_CONNECT_TIMEOUT_MS = 30_000;

export const aiGatewayDispatcher = new Agent({
  headersTimeout: AI_GATEWAY_TIMEOUT_MS,
  bodyTimeout: AI_GATEWAY_TIMEOUT_MS,
  keepAliveTimeout: AI_GATEWAY_TIMEOUT_MS,
  keepAliveMaxTimeout: AI_GATEWAY_TIMEOUT_MS,
  connectTimeout: AI_GATEWAY_CONNECT_TIMEOUT_MS,
});

export const fetchWithDispatcher: typeof globalThis.fetch = async (input, init) => (
  await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as UndiciRequestInit | undefined),
    dispatcher: aiGatewayDispatcher,
  }) as unknown as Response
);

globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({
  fetch: fetchWithDispatcher,
});
