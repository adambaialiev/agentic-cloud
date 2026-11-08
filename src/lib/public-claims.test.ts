import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Note #1081: the false claims the acceptance pass found (Ada's verdicts on
// note #1080, from Nina's install on note #1079), kept out once fixed. The
// legal pages are pinned in src/pages/LegalPages.test.tsx and the docs'
// sign-up picture in src/components/LiveDocsPanels.test.tsx.
const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const flat = (file: string) => read(file).replace(/\s+/g, ' ');

describe('the installer README a buyer is pinned to (claims 10, 30 and 35)', () => {
  const readme = read('infra/copy-installer/README.md');
  const commands = readme.match(/^node install\.mjs install .*$/gm) ?? [];

  it('gives every install command the contact the installer insists on', () => {
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) expect(command).toContain('--contact-email');
  });

  it('lists every reason the installer stops for a person, contact among them', () => {
    const install = read('infra/copy-installer/install.mjs');
    const reasons = new Set([...install.matchAll(/PersonNeeded\('([a-z-]+)'/g)].map((match) => match[1]));
    // The licence's two reasons sit behind COPY_LICENCE=on, off while the
    // product is free for now (claims-we-never-make).
    for (const reason of reasons) {
      if (reason === 'licence' || reason === 'update-key') continue;
      expect(readme).toMatch(new RegExp(`\`${reason}\``));
    }
    expect(reasons.has('contact')).toBe(true);
  });

  it('never promises a separate token the installer cannot make, and says what revoking it does', () => {
    expect(readme).not.toMatch(/It also asks Fly for a separate organization token for the backend\./);
    expect(flat('infra/copy-installer/README.md')).toMatch(/it cannot make a second one, so the backend keeps the very token the install ran with/);
    expect(flat('infra/copy-installer/README.md')).toMatch(/revoking the backend's token stops every agent machine/);
  });
});

describe('the guide (claim 35 and the partly verdicts 3, 4 and 34)', () => {
  const guide = flat('public/own-cloud.md');

  it('pins an installer whose README is the fixed one', () => {
    const pin = guide.match(/raw\/([0-9a-f]{40})\?path=infra\/copy-installer\/install\.mjs/);
    expect(pin).toBeTruthy();
    // 1345d2b2 carried "There is no telemetry" and the commands without
    // --contact-email.
    expect(pin![1]).not.toBe('1345d2b2b95a21a0d896988794e19dda5b5d3ae6');
  });

  it('warns that the backend keeps an organization token it was given', () => {
    expect(guide).toMatch(/the Workspace keeps this very one to start agent machines, and revoking it later stops every agent/);
    expect(guide).toMatch(/fly tokens create org -o <org>/);
  });

  it('says when the report goes, what it holds, and which address to offer', () => {
    expect(guide).toMatch(/once a day, about two minutes after every start, and when an admin changes the contact/i);
    expect(guide).toMatch(/backup age, free disk and health/);
    expect(guide).not.toMatch(/Offer the first admin's address/);
  });
});

describe('the public pages of your own Agentic Cloud (claims 44 and 48)', () => {
  it('llms.txt says auto-merge wherever a change waits for a person', () => {
    const llms = flat('scripts/prerender.mjs');
    expect(llms).toMatch(/waits for a person to approve it, unless that person has turned on auto-merge/);
    expect(llms).not.toMatch(/only a person can approve one\.\s/);
  });

  it('/product says the apps directory is private, and promises no public catalogue', () => {
    const pitch = flat('src/components/ProductPitch.tsx');
    expect(pitch).not.toMatch(/ship joins a public catalogue/);
    expect(pitch).toMatch(/the directory is private to your workplace/);
  });
});
