import type { Page } from 'puppeteer-core';
import { MailboxService } from '../backend/src/services/mailbox-service.js';
import type { OrgStorage } from '../backend/src/services/org-storage.js';
import type { IssuedWorkspaceSession, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { workspaceCookieNames } from '../backend/src/services/workspace-web-session.js';
import type { OrgDocument } from '../backend/src/types/org.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteMailboxStorage } from '../backend/src/services/sqlite/sqlite-mailbox-storage.js';

export const WORKSPACE_HARNESS_PASSWORD = 'harness-password-47';

/**
 * Complete the signup form already open in a real-browser harness.
 *
 * ONE FIELD chooses the account now (note #509, commit f91b4e40): the name
 * before the @ on our own mail domain, not an outside address to confirm.
 * Creating it signs the new account straight in, so there is no link to
 * follow and no `authcontinue` door to press.
 *
 * Callers still name their account as a whole address, because that is what
 * their fixtures and their assertions read; only the LOCAL part is typed, and
 * the account ends up at that name on the mail domain.
 *
 * Authentication itself still runs through the ordinary router.
 */
export async function signUpWorkspaceByEmail(
  page: Page,
  email: string,
  password: string = WORKSPACE_HARNESS_PASSWORD,
): Promise<void> {
  await page.waitForSelector('#authMailbox');
  // The person's name comes first on the card (note #144); the local part
  // of the address is the first name, so the account still answers to it.
  await page.type('#authFirstName', email.split('@')[0] ?? email);
  await page.type('#authLastName', 'Harness');
  await page.type('#authMailbox', email.split('@')[0] ?? email);
  await page.type('#authPassword', password);
  await page.type('#authPasswordConfirm', password);
  // Create account stays disabled until the field has finished asking whether
  // the name is free — one question per pause in the typing, and a check that
  // cannot be made settles as free. Waiting for the BUTTON rather than for a
  // delay is what keeps this honest on a loaded box.
  await page.waitForFunction(
    () => !(document.getElementById('authEmailButton') as HTMLButtonElement | null)?.disabled,
    { timeout: 15_000 },
  );
  await page.click('#authEmailButton');
  // Signed in when the gate is gone. A positive signal, rather than a wait
  // long enough to look right: a refused form leaves the panel standing with
  // its error, and this then fails where the harness can say so.
  await page.waitForFunction(() => !document.getElementById('authEmailPanel'), { timeout: 20_000 });
}

/**
 * Sign an existing harness account back in.
 *
 * The sign-in field takes EITHER an address or a bare name — the server reads
 * a name as an address on our own domain — and the bare name is what a
 * harness has: {@link signUpWorkspaceByEmail} only ever typed the local part,
 * so the account created for `saddam@example.com` answers to `saddam`, and
 * signing in with the whole string it was named by is refused. Take the same
 * argument the signup took and do the same thing to it, so the two cannot
 * drift apart.
 *
 * Where it LANDS is the caller's to wait for: a password can be answered by
 * Home, by a second factor, or by an error under the form, and only the
 * harness knows which of those it came to see.
 */
export async function signInWorkspace(
  page: Page,
  email: string,
  password: string = WORKSPACE_HARNESS_PASSWORD,
): Promise<void> {
  await page.waitForSelector('#authEmail');
  await page.type('#authEmail', email.split('@')[0] ?? email);
  await page.type('#authPassword', password);
  await page.click('#authEmailButton');
}

/**
 * The mail half of a harness's backend.
 *
 * It was `harnessEmailVerification` while signing up meant proving an OUTSIDE
 * address: a sender that kept the link the router minted rather than posting
 * it, so the harness could follow it in the same browser. Since note #509
 * (commit f91b4e40) an account is an address ON our own domain, and creating
 * one is what claims it — so what a harness now needs first is a MAILBOX
 * SERVICE. Without it the router refuses every signup with "Creating an
 * account is temporarily unavailable", which is what stopped all twenty of
 * these harnesses at their first screen.
 *
 * Both halves come from here because both are the same fixture, and a harness
 * that wires one and forgets the other fails at a screen it was not written
 * to check. Pass `config` as the service's `emailVerification` and
 * `mailboxes` as its mailbox service; `link()` is still the way to follow a
 * confirmation the ROUTER sends for something else — changing an address, or
 * a recovery — and is no longer part of signing up.
 */
export function harnessMailService(workspaceUrl: string): {
  config: { workspaceUrl: string; sender: { sendVerification(message: { verificationUrl: string }): Promise<void> } };
  mailboxes: MailboxService;
  link(timeoutMs?: number): Promise<string>;
} {
  let sent: string | null = null;
  const waiting: Array<(url: string) => void> = [];
  return {
    config: {
      workspaceUrl,
      sender: {
        async sendVerification(message: { verificationUrl: string }): Promise<void> {
          sent = message.verificationUrl;
          while (waiting.length) waiting.shift()!(sent);
        },
      },
    },
    // The real storage on a database that never touches the disk: a fixture
    // for claiming a name is exactly the place not to reimplement claiming.
    mailboxes: new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:'))),
    link(timeoutMs = 10_000): Promise<string> {
      if (sent) return Promise.resolve(sent);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no confirmation email was sent')), timeoutMs);
        waiting.push((url) => { clearTimeout(timer); resolve(url); });
      });
    },
  };
}

/** What {@link harnessEstablishedWorkplace} invents, both overridable. */
export interface HarnessWorkplace {
  /** The Fly org slug stamped on a workplace as it is created. */
  flyOrgSlug?: string;
  /** The live seat each member joins with. */
  seat?: { provider?: string; label?: string; token?: string };
}

/**
 * The workplace this harness founds is one that is already past its setup
 * gate — the fixture for every harness where founding a workplace is scenery
 * rather than the thing being checked.
 *
 * The gate is DERIVED on every state read (e9639476, "Lock incomplete
 * workplaces behind setup"): `setupRequired = no live seat of the READER's
 * || a founding still owed || …`. (No Fly org slug on the workplace was the
 * first term until note #664 hosted every workplace without one on ours.)
 * Nothing is read off the stored `setupRequired` marker any more, so
 * clearing it — which is all `harnessCompletedSetup` ever did, and why that
 * helper is gone — leaves a UI-founded workplace stopped on its gate and the
 * harness timing out on its first selector after #orgCreateBtn.
 *
 * So this invents the facts the gate asked for, and nothing else: a live
 * seat, and no founding owed by a workplace from the founder door. Since
 * note #726 there is no gate at all (`setupRequired` is always false) and a
 * founding furnishes NOTHING — no rooms, no planned agents, no arriving
 * screen; a new workplace opens on Home, the Chief of Staff's chat, and the
 * team is its to bring in — so what the seat buys now is the chat NOT
 * asking for a plan inside it, and `foundingPending: false` only spares the
 * first read its naming write. The workplace an account comes with keeps
 * its founding, which signing up settles at once with the seat this stamps.
 * The Fly slug it still stamps is no longer one of those facts; it keeps
 * these harnesses on a cloud of their own, the shape their cloud checks were
 * written against. A harness CHECKING the first run itself must not call it.
 *
 * Both facts are overridable, because the default of either is a lie in the
 * harness that cares:
 *
 *  - `flyOrgSlug` is stamped on the workplace at creation. Pass the
 *    harness's own where its checks read the slug, or where its cloud
 *    fixture answers with one — two different slugs for one workplace is a
 *    screen arguing with itself.
 *  - `seat` is the live subscription, added as each member joins rather than
 *    inside `createOrg`, because a seat for somebody who is not a member yet
 *    is refused. Pass the harness's OWN seat where its checks COUNT
 *    subscriptions: the lock needs one to exist, and the cheapest way to
 *    keep a count honest is for the seat the lock needs to be a seat the
 *    harness already expects to see.
 *
 * Every member gets one, not only the admin. The gate is per READER, so a
 * harness driving two people (a private conversation, an invite) would
 * otherwise open for the founder and hold the other one on setup forever.
 */
export function harnessEstablishedWorkplace(orgStorage: OrgStorage, workplace: HarnessWorkplace = {}): void {
  const slug = workplace.flyOrgSlug ?? 'harness-cloud';
  const provider = workplace.seat?.provider ?? 'claude';
  const createOrg = orgStorage.createOrg.bind(orgStorage);
  const addMember = orgStorage.addMember.bind(orgStorage);
  // A workplace that arrives with a slug of its own keeps it: a harness that
  // seeds its cloud record directly has already said which account this is.
  orgStorage.createOrg = async (doc) => createOrg({
    ...doc,
    setupRequired: false,
    // The workplace an account comes with keeps its founding: signing up is
    // where the harnesses that walk it expect the team to arrive.
    ...(doc.unnamed ? {} : { foundingPending: false }),
    ...((doc as { fly?: unknown }).fly ? {} : { fly: { orgSlug: slug } as never }),
  });
  orgStorage.addMember = async (doc) => {
    const membership = await addMember(doc);
    await orgStorage.addSeat({
      orgId: membership.orgId, userId: membership.userId, provider,
      token: workplace.seat?.token ?? 'harness-seat-token',
      label: workplace.seat?.label ?? `${provider} · harness`,
      status: 'active',
    } as never).catch(() => null);
    return membership;
  };
}

/** The account {@link harnessSignedIn} created and signed the page in as. */
export interface HarnessAccount {
  userId: string;
  /** The whole address the account answers to on the harness's mail domain. */
  address: string;
  session: IssuedWorkspaceSession;
}

/**
 * THE FIXTURE DOOR (note #550): an account that exists and a browser that is
 * signed in as it, with no screen driven to get there.
 *
 * Twenty harnesses used to open the signup form for a fixture they never
 * checked, and paid for it together: when the form grew two required name
 * fields (note #144), every one of them timed out at the create button, and
 * one product change read as twenty unrelated failures. A harness whose
 * SUBJECT is signing up — react-auth, react-org, react-seat, react-join —
 * still types into the real form with {@link signUpWorkspaceByEmail}; every
 * other one comes through here, and the onboarding road can change shape
 * without their noticing.
 *
 * Two halves, both the product's own code rather than a shortcut around it:
 * the account is registered through the SAME service method the router's
 * signup route calls, so a harness cannot hold an account the product could
 * not have made; and the session it issues is handed to the browser as the
 * two cookies the router would have set — the HttpOnly session and the
 * readable CSRF token the shell copies into `X-CSRF-Token`. Names are what
 * the harness's cookies get, so pass the origin the harness serves on and
 * the router was given as `workspaceWebOrigin`: an http: origin gets the
 * plain names, https: the `__Host-` ones, exactly as the router decides it.
 *
 * Like {@link signUpWorkspaceByEmail}, this takes the whole address a harness
 * names its person by and claims only the local part. A first and last name
 * are always passed, because signup asks for them since note #144 and a
 * backend from before it ignores them.
 */
export async function harnessSignedIn(
  page: Page,
  auth: WorkspaceWebAuthService,
  origin: string,
  email: string,
  person: { password?: string; firstName?: string; lastName?: string } = {},
): Promise<HarnessAccount> {
  const created = await auth.registerMailbox({
    mailbox: email.split('@')[0] ?? email,
    password: person.password ?? WORKSPACE_HARNESS_PASSWORD,
    firstName: person.firstName ?? 'Harness',
    lastName: person.lastName ?? 'Person',
    userAgent: 'workspace-harness',
  } as Parameters<WorkspaceWebAuthService['registerMailbox']>[0]);
  const names = workspaceCookieNames(origin);
  await page.browserContext().setCookie(
    { name: names.session, value: created.session.token, url: origin, path: '/', httpOnly: true, secure: names.secure, sameSite: 'Lax' },
    { name: names.csrf, value: created.session.csrfToken, url: origin, path: '/', httpOnly: false, secure: names.secure, sameSite: 'Strict' },
  );
  return { userId: created.userId, address: created.address, session: created.session };
}

/**
 * The other half of the fixture door: the workplace the signed-in person
 * founded, written the way the founder route writes it and without the
 * founder screens. The org is stamped with its own namespace, the person is
 * its admin and it is their ACTIVE workplace — the three facts the shell
 * reads before it will draw Home rather than the create form. A workplace
 * is one place (note #843), with no rooms.
 *
 * It deliberately founds NOTHING the harness did not name: no planned agents, however many the product's own founder route seats
 * (note #144). The road may furnish a new workplace however it likes; a
 * harness that wants that furniture is checking onboarding, and drives the
 * screens. Everything else runs {@link harnessEstablishedWorkplace} first if
 * it needs the setup gate open — that hook patches `createOrg`/`addMember`
 * on the storage, so it takes effect here exactly as it did under the form.
 */
export async function harnessWorkplace(
  orgStorage: OrgStorage,
  args: { userId: string; name: string },
): Promise<{ org: OrgDocument }> {
  const org = await orgStorage.createOrg({ name: args.name, createdByUserId: args.userId, setupRequired: true });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  await orgStorage.addMember({ orgId: org.orgId, userId: args.userId, role: 'admin' });
  await orgStorage.setActiveOrg(args.userId, org.orgId);
  return { org: (await orgStorage.getOrg(org.orgId))! };
}
