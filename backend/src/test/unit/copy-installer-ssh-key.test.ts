/**
 * The one installer test that needs the backend: the SSH key the installer
 * makes for a copy's backend is one the backend's own SSH library reads and
 * signs with. The installer's other tests live beside it
 * (infra/copy-installer/test, plain node:test) and are published with it
 * (note #816).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { utils as sshUtils } from 'ssh2';

const INSTALLER = path.resolve(__dirname, '../../../../infra/copy-installer/install.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let installer: any;

beforeAll(async () => {
  installer = await import(/* @vite-ignore */ pathToFileURL(INSTALLER).href);
});

describe('the installer\'s SSH key and the backend', () => {
  it('makes an SSH key the backend\'s SSH library reads and signs with', () => {
    const pair = installer.sshKeyPair('theirco-backend@agents.theirco.test');
    const key = sshUtils.parseKey(pair.privateKey);
    if (key instanceof Error) throw key;
    const parsed = Array.isArray(key) ? key[0]! : key;
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.getPublicSSH().toString('base64')).toBe(pair.publicKey.split(' ')[1]);
    const pub = sshUtils.parseKey(pair.publicKey);
    if (pub instanceof Error) throw pub;
    const publicKey = Array.isArray(pub) ? pub[0]! : pub;
    expect(publicKey.verify(Buffer.from('hello'), parsed.sign(Buffer.from('hello')))).toBe(true);
  });
});
