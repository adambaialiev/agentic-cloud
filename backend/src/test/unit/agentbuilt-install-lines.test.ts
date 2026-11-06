import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgentbuiltInstallLines } from '../../services/agent-service.js';

/**
 * The config the backend writes on every agent machine carries the names the
 * CLI's own words use (note #807): a private copy's apps domain and catalogue.
 */
function writtenConfig(lines: string[]): Record<string, unknown> {
  const line = lines.find((l) => l.includes('base64 -d > "$HOME/.agentbuilt/config.json"'));
  const encoded = /printf '%s' '([^']+)'/.exec(line ?? '')?.[1];
  return JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8'));
}

describe('buildAgentbuiltInstallLines', () => {
  it('writes the api, the token, the apps domain and the catalogue', () => {
    const config = writtenConfig(buildAgentbuiltInstallLines('https://agents.theirco.test', 'ab_tok', { appsDomain: 'agents.theirco.test' }));
    expect(config).toMatchObject({ apiUrl: 'https://agents.theirco.test', token: 'ab_tok', appsDomain: 'agents.theirco.test' });
    expect(typeof config.catalogueUrl).toBe('string');
  });

  it('leaves the apps domain out when none is given', () => {
    const config = writtenConfig(buildAgentbuiltInstallLines('https://api.example.test', 'ab_tok'));
    expect(config.appsDomain).toBeUndefined();
  });

  it("tells a copy's CLI that the apps directory is members only, and ours nothing (note #1014)", async () => {
    expect(writtenConfig(buildAgentbuiltInstallLines('https://api.example.test', 'ab_tok')).catalogueMembersOnly).toBeUndefined();
    vi.stubEnv('PRIVATE_COPY', '1');
    vi.resetModules();
    const copy = await import('../../services/agent-service.js');
    expect(writtenConfig(copy.buildAgentbuiltInstallLines('https://agents.theirco.test', 'ab_tok')).catalogueMembersOnly).toBe(true);
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
