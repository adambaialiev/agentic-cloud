import { describe, expect, it } from 'vitest';
import {
  buildHarnessSandboxId,
  parseHetznerServerId,
} from '../../services/agent-service.js';
import { buildCloudManagedServerRecordId } from '../../services/managed-server-service.js';
import { buildFlyServerRecordId } from '../../services/fly-sandbox-id.js';
import { FlySandboxClient } from '../../services/fly-sandbox-client.js';

describe('parseHetznerServerId', () => {
  it('reads the numeric id from every id form the agent might pass', () => {
    expect(parseHetznerServerId('hcloud_123')).toBe(123);
    expect(parseHetznerServerId('hcloud-sandbox-123')).toBe(123);
    expect(parseHetznerServerId('123')).toBe(123);
    expect(parseHetznerServerId('  hcloud_123  ')).toBe(123);
    expect(parseHetznerServerId('HCLOUD_123')).toBe(123);
  });

  it('rejects non-server strings and out-of-range ids', () => {
    expect(parseHetznerServerId('web-1')).toBeNull();
    expect(parseHetznerServerId('do_123')).toBeNull();
    expect(parseHetznerServerId('hcloud_')).toBeNull();
    expect(parseHetznerServerId('hcloud_0')).toBeNull();
    expect(parseHetznerServerId('')).toBeNull();
    expect(parseHetznerServerId('hcloud_12abc')).toBeNull();
  });
});

describe('buildHarnessSandboxId', () => {
  it('wraps a stored recordId as the sandbox-client id', () => {
    expect(buildHarnessSandboxId('hcloud_123')).toBe('hcloud-sandbox-123');
    expect(buildHarnessSandboxId('123')).toBe('hcloud-sandbox-123');
  });

  it('returns null when there is no recorded server', () => {
    expect(buildHarnessSandboxId(undefined)).toBeNull();
    expect(buildHarnessSandboxId('not-a-server')).toBeNull();
  });

  it('round-trips so the harness reaches the exact server the agent recorded', () => {
    // The setter stores buildCloudManagedServerRecordId(...) and the harness
    // reads it back through buildHarnessSandboxId(...); the sandbox client then
    // parses the numeric id out. All three must agree on the same server.
    const serverId = 456;
    const storedRecordId = buildCloudManagedServerRecordId('hetzner', serverId);
    expect(storedRecordId).toBe('hcloud_456');

    const sandboxId = buildHarnessSandboxId(storedRecordId);
    // Legacy hcloud records still map to their historical sandbox-id form; the
    // provider is retired, so any such id reaching runtime fails loudly in
    // RetiredSandboxClient rather than silently hitting a dead API.
    expect(sandboxId).toBe('hcloud-sandbox-456');
  });

  it('resolves a Fly agent record id into a fly sandbox id the client can parse', () => {
    const appName = 'ia-9f0a1b2c3d4e5f60';
    const machineId = '9080e6d3a6e389';
    const storedRecordId = buildFlyServerRecordId(appName, machineId);
    expect(storedRecordId).toBe(`fly_${appName}.${machineId}`);

    const sandboxId = buildHarnessSandboxId(storedRecordId);
    expect(sandboxId).toBe(`fly-sandbox-${appName}.${machineId}`);
    expect(FlySandboxClient.parseSandboxId(sandboxId!)).toEqual({ appName, machineId });
  });
});
