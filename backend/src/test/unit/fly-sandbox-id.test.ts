import { describe, expect, it } from 'vitest';
import {
  buildFlySandboxId,
  buildFlyServerRecordId,
  isFlySandboxId,
  parseFlySandboxId,
  parseFlyServerRecordId,
} from '../../services/fly-sandbox-id.js';
import { isServerBackedSandboxRecord } from '../../services/user-sandbox-manager.js';
import type { UserSandboxRecord } from '../../services/sandbox-storage.js';

const APP = 'ia-9f0a1b2c3d4e5f60';
const MACHINE = '9080e6d3a6e389';

describe('fly sandbox id codec', () => {
  it('round-trips app + machine through the sandbox id', () => {
    const sandboxId = buildFlySandboxId(APP, MACHINE);
    expect(sandboxId).toBe(`fly-sandbox-${APP}.${MACHINE}`);
    expect(isFlySandboxId(sandboxId)).toBe(true);
    expect(parseFlySandboxId(sandboxId)).toEqual({ appName: APP, machineId: MACHINE });
  });

  it('rejects non-fly sandbox ids', () => {
    expect(isFlySandboxId('hcloud-sandbox-123')).toBe(false);
    expect(parseFlySandboxId('hcloud-sandbox-123')).toBeNull();
    expect(parseFlySandboxId('fly-sandbox-noseparator')).toBeNull();
    expect(parseFlySandboxId('')).toBeNull();
    expect(parseFlySandboxId(undefined)).toBeNull();
  });

  it('resolves the record form and the sandbox form to a sandbox id', () => {
    const recordId = buildFlyServerRecordId(APP, MACHINE);
    expect(recordId).toBe(`fly_${APP}.${MACHINE}`);
    expect(parseFlyServerRecordId(recordId)).toBe(`fly-sandbox-${APP}.${MACHINE}`);
    // Already-built sandbox ids pass through.
    expect(parseFlyServerRecordId(`fly-sandbox-${APP}.${MACHINE}`)).toBe(`fly-sandbox-${APP}.${MACHINE}`);
  });

  it('returns null for non-fly record ids', () => {
    expect(parseFlyServerRecordId('hcloud_123')).toBeNull();
    expect(parseFlyServerRecordId('123')).toBeNull();
    expect(parseFlyServerRecordId(undefined)).toBeNull();
  });
});

function makeRecord(overrides: Partial<UserSandboxRecord>): UserSandboxRecord {
  return {
    sandboxId: 'sandbox-x',
    name: 'x',
    status: 'running',
    createdAt: new Date(),
    lastUsedAt: new Date(),
    ...overrides,
  };
}

describe('isServerBackedSandboxRecord', () => {
  it('treats a Fly record (string id in the sandbox id, no numeric serverId) as server-backed', () => {
    expect(isServerBackedSandboxRecord(makeRecord({
      provider: 'fly',
      sandboxId: buildFlySandboxId(APP, MACHINE),
    }))).toBe(true);
    // Even without the provider field, the fly sandbox-id encoding is enough.
    expect(isServerBackedSandboxRecord(makeRecord({
      sandboxId: buildFlySandboxId(APP, MACHINE),
    }))).toBe(true);
  });

  it('keeps Hetzner numeric-id records working', () => {
    expect(isServerBackedSandboxRecord(makeRecord({
      provider: 'hetzner',
      sandboxId: 'hcloud-sandbox-123',
      serverId: 123,
    }))).toBe(true);
    expect(isServerBackedSandboxRecord(makeRecord({
      provider: 'hetzner',
      sandboxId: 'hcloud-sandbox-123',
      serverId: undefined,
    }))).toBe(false);
  });

  it('rejects legacy / non-server-backed records', () => {
    expect(isServerBackedSandboxRecord(makeRecord({
      provider: 'sumai',
      sandboxId: 'sandbox-legacy',
    }))).toBe(false);
  });
});
