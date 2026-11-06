import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A private copy puts every address on the customer's own domain (note #804):
 * the backend reads MAIL_DOMAIN once, and the shell it serves hands the same
 * value to the browser as a meta tag. Ours stays the default everywhere else.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshMailModule() {
  vi.resetModules();
  return import('../../shared/workspace-mail.js');
}

describe('MAIL_DOMAIN', () => {
  it('is ours when nothing is configured', async () => {
    vi.stubEnv('MAIL_DOMAIN', '');
    const mail = await freshMailModule();
    expect(mail.MAIL_DOMAIN).toBe('agenticcloudcomputer.com');
    expect(mail.mailAddress('adam')).toBe('adam@agenticcloudcomputer.com');
  });

  it("is the copy's own domain when set, and every address follows it", async () => {
    vi.stubEnv('MAIL_DOMAIN', ' Mail.TheirCo.test ');
    const mail = await freshMailModule();
    expect(mail.MAIL_DOMAIN).toBe('mail.theirco.test');
    expect(mail.mailAddress('ada')).toBe('ada@mail.theirco.test');
    expect(mail.isMailDomainAddress('ada@mail.theirco.test')).toBe(true);
    expect(mail.isMailDomainAddress('ada@agenticcloudcomputer.com')).toBe(false);
    expect(mail.normalizeMailLocal('ada@agenticcloudcomputer.com')).toBe('');
  });

  it('ignores a malformed value rather than minting addresses on it', async () => {
    vi.stubEnv('MAIL_DOMAIN', 'not a domain');
    expect((await freshMailModule()).MAIL_DOMAIN).toBe('agenticcloudcomputer.com');
  });

  it('the served shell carries the domain for the browser, and only when it differs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shell-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    vi.stubEnv('MAIL_DOMAIN', 'theirco.test');
    vi.resetModules();
    const copy = await import('../../routes/workspace-ui.js');
    expect((await copy.loadWorkspaceUiShell(dir)).html.toString()).toContain('<meta name="acc-mail-domain" content="theirco.test">');
    vi.stubEnv('MAIL_DOMAIN', '');
    vi.resetModules();
    const ours = await import('../../routes/workspace-ui.js');
    expect((await ours.loadWorkspaceUiShell(dir)).html.toString()).not.toContain('acc-mail-domain');
  });
});

/**
 * The host public addresses and the catalogue are on (note #807): the
 * Workspace's own host in a private copy, ours everywhere else.
 */
describe('PUBLIC_HOST', () => {
  async function freshHostModule() {
    vi.resetModules();
    return import('../../shared/public-host.js');
  }

  it('is ours when WORKSPACE_URL is unset or ours', async () => {
    vi.stubEnv('WORKSPACE_URL', 'https://agenticcloudcomputer.com/workspace');
    const host = await freshHostModule();
    expect(host.PUBLIC_HOST).toBe('agenticcloudcomputer.com');
    expect(host.CATALOGUE_URL).toBe('https://agenticcloudcomputer.com/apps');
  });

  it("is the copy's own Workspace host, and the catalogue follows it", async () => {
    vi.stubEnv('WORKSPACE_URL', 'https://agents.theirco.test');
    const host = await freshHostModule();
    expect(host.PUBLIC_HOST).toBe('agents.theirco.test');
    expect(host.CATALOGUE_URL).toBe('https://agents.theirco.test/apps');
    vi.resetModules();
    const handles = await import('../../shared/handles.js');
    expect(handles.normalizeHandle('https://agents.theirco.test/acme')).toBe('acme');
  });

  it("names the catalogue: ours the public one, a copy's the workplace's members-only directory (note #1014)", async () => {
    vi.stubEnv('PRIVATE_COPY', '');
    expect((await freshHostModule()).CATALOGUE_NAME).toBe('the public catalogue');
    vi.stubEnv('PRIVATE_COPY', '1');
    const copy = await freshHostModule();
    expect(copy.CATALOGUE_NAME).toBe("the workplace's apps directory (members only)");
    expect(copy.CATALOGUE_FULL_NAME).not.toContain('public');
  });

  it('a development origin without a dot stays ours', async () => {
    vi.stubEnv('WORKSPACE_URL', 'http://localhost:5175');
    expect((await freshHostModule()).PUBLIC_HOST).toBe('agenticcloudcomputer.com');
  });

  it('the served shell carries the host for the browser, only when it differs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shell-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    vi.stubEnv('WORKSPACE_URL', 'https://agents.theirco.test');
    vi.stubEnv('MAIL_DOMAIN', '');
    vi.resetModules();
    const copy = await import('../../routes/workspace-ui.js');
    const html = (await copy.loadWorkspaceUiShell(dir)).html.toString();
    expect(html).toContain('<meta name="acc-public-host" content="agents.theirco.test">');
    expect(html).not.toContain('acc-mail-domain');
  });
});

/**
 * That this IS a copy (note #808), for the sign-up door, which then says
 * accounts come through an invite instead of drawing an open form.
 */
describe('PRIVATE_COPY in the browser', () => {
  it('the served shell says so in a copy, and says nothing on ours', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shell-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    vi.stubEnv('PRIVATE_COPY', '1');
    vi.resetModules();
    const copy = await import('../../routes/workspace-ui.js');
    expect((await copy.loadWorkspaceUiShell(dir)).html.toString()).toContain('<meta name="acc-private-copy" content="1">');
    expect((await import('../../shared/private-copy.js')).PRIVATE_COPY).toBe(true);
    vi.stubEnv('PRIVATE_COPY', '');
    vi.resetModules();
    const ours = await import('../../routes/workspace-ui.js');
    expect((await ours.loadWorkspaceUiShell(dir)).html.toString()).not.toContain('acc-private-copy');
    expect((await import('../../shared/private-copy.js')).PRIVATE_COPY).toBe(false);
  });

  // Note #823: our own platform with new sign-ups closed tells the browser
  // so, and a copy never carries it whatever its environment says.
  it('carries SIGNUP_CLOSED on ours when set, and never in a copy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shell-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    vi.stubEnv('PRIVATE_COPY', '');
    vi.stubEnv('SIGNUP_CLOSED', '1');
    vi.resetModules();
    const closed = await import('../../routes/workspace-ui.js');
    expect((await closed.loadWorkspaceUiShell(dir)).html.toString()).toContain('<meta name="acc-signup-closed" content="1">');
    expect((await import('../../shared/private-copy.js')).SIGNUP_CLOSED).toBe(true);
    vi.stubEnv('PRIVATE_COPY', '1');
    vi.resetModules();
    const copy = await import('../../routes/workspace-ui.js');
    expect((await copy.loadWorkspaceUiShell(dir)).html.toString()).not.toContain('acc-signup-closed');
    expect((await import('../../shared/private-copy.js')).SIGNUP_CLOSED).toBe(false);
    vi.stubEnv('PRIVATE_COPY', '');
    vi.stubEnv('SIGNUP_CLOSED', '');
    vi.resetModules();
    const open = await import('../../routes/workspace-ui.js');
    expect((await open.loadWorkspaceUiShell(dir)).html.toString()).not.toContain('acc-signup-closed');
  });
});
