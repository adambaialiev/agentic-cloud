import { randomBytes, randomUUID } from 'node:crypto';
import type { SecretCipher } from './secret-cipher.js';
import type { UserStorage } from './user-storage.js';
import { PERSON_NAME_MAX_LENGTH, type UserProfileDocument } from '../types/user.js';
import type { FirstVisit } from '../shared/first-visit.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotpCode,
} from '../utils/totp.js';
import {
  hashWorkspacePassword,
  normalizeWorkspacePassword,
  verifyWorkspacePassword,
} from '../utils/workspace-password.js';
import { MailboxError, type MailboxService } from './mailbox-service.js';
import { MAIL_DOMAIN, isMailDomainAddress, mailSignInAddress } from '../shared/workspace-mail.js';
import type { WorkspaceVerificationEmailSender } from './workspace-verification-email.js';

export const WORKSPACE_USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
export const WORKSPACE_TOTP_ISSUER = 'Agentic Cloud Computer';
export const WORKSPACE_ENROLLMENT_TTL_MS = 10 * 60_000;
export const WORKSPACE_SECOND_FACTOR_TTL_MS = 5 * 60_000;
export const WORKSPACE_EMAIL_VERIFICATION_TTL_MS = 30 * 60_000;
export const WORKSPACE_EMAIL_RESEND_COOLDOWN_MS = 60_000;
export const WORKSPACE_EMAIL_RESEND_WINDOW_MS = 60 * 60_000;
export const WORKSPACE_EMAIL_RESEND_MAX_PER_WINDOW = 5;
export const WORKSPACE_AUTH_LINK_TTL_MS = 30 * 60_000;
export const WORKSPACE_AUTH_LINK_COOLDOWN_MS = 60_000;
export const WORKSPACE_SESSION_IDLE_MS = 30 * 24 * 60 * 60_000;
export const WORKSPACE_SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60_000;

export interface WorkspaceTotpEnrollmentDocument {
  tokenHash: string;
  username: string;
  usernameCanonical: string;
  /** Existing Telegram/web user when this enrollment adds browser login. */
  userId?: string;
  encryptedTotpSecret: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceTotpIdentityDocument {
  userId: string;
  username: string;
  usernameCanonical: string;
  encryptedTotpSecret: string;
  lastAcceptedStep: number;
  recoveryCodeHashes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEmailIdentityDocument {
  userId: string;
  email: string;
  emailCanonical: string;
  passwordHash: string;
  /** Present only when the owner opted into an authenticator second factor. */
  encryptedTotpSecret?: string;
  lastAcceptedStep?: number;
  recoveryCodeHashes?: string[];
  /** Missing only on a pre-verification record while its one-time migration
   * has not run. Those accounts are treated as legacy, never locked out. */
  verificationStatus?: 'pending' | 'verified' | 'legacy';
  emailVerifiedAt?: string;
  verificationGrandfatheredAt?: string;
  verificationLastSentAt?: string;
  verificationWindowStartedAt?: string;
  verificationSendsInWindow?: number;
  /** A legacy TOTP door stays usable only while a newly linked email is
   * pending, so attaching an address cannot lock its owner out. */
  preserveLegacyLoginUntilVerified?: boolean;
  /** An OUTSIDE address a forgotten password can be reset through. It is
   * never a sign-in name. Unverified until its owner opens the link we sent
   * there; an account that attached an outside email before it took its
   * address here inherits that email as its recovery address. */
  recoveryEmail?: string;
  recoveryEmailVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One-use links the door sends out: a password reset, or the confirmation
 * of a recovery address. Only the bearer's hash is stored. */
export type WorkspaceAuthLinkPurpose = 'password_reset' | 'recovery_email';

export interface WorkspaceAuthLinkDocument {
  tokenHash: string;
  userId: string;
  purpose: WorkspaceAuthLinkPurpose;
  /** The address the link went to; a recovery confirmation must still match it when consumed. */
  email: string;
  createdAt: string;
  expiresAt: string;
}

export type WorkspaceAuthLinkConsumption =
  | { outcome: 'consumed'; link: WorkspaceAuthLinkDocument }
  | { outcome: 'expired' | 'invalid' };

export interface WorkspaceEmailVerificationDocument {
  tokenHash: string;
  userId: string;
  emailCanonical: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceSecondFactorChallengeDocument {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** The public identity shape consumed outside this service. `username` stays
 * during the TOTP migration because invitations and old clients name that
 * field; for an email identity it contains the canonical email address. */
export type WorkspaceBrowserIdentity =
  | (WorkspaceEmailIdentityDocument & { kind: 'email'; username: string })
  | (WorkspaceTotpIdentityDocument & { kind: 'totp' });

export type WorkspaceWebSessionAuthMethod = 'password' | 'email_verification' | 'totp' | 'recovery';

export type WorkspaceEmailVerificationConsumption =
  | { outcome: 'verified'; userId: string }
  | { outcome: 'expired' | 'invalid' };

export interface WorkspaceWebSessionDocument {
  sessionId: string;
  userId: string;
  authMethod: WorkspaceWebSessionAuthMethod;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  userAgent?: string;
  revokedAt?: string;
}

export interface WorkspaceWebAuthStorage {
  getEmailIdentityByUserId(userId: string): Promise<WorkspaceEmailIdentityDocument | null>;
  getEmailIdentityByEmail(emailCanonical: string): Promise<WorkspaceEmailIdentityDocument | null>;
  createEmailIdentity(doc: WorkspaceEmailIdentityDocument): Promise<'created' | 'email_taken' | 'user_has_identity'>;
  updateEmailPassword(userId: string, passwordHash: string): Promise<boolean>;
  /**
   * Make the address this account holds on our mail domain its sign-in name.
   * An outside email it signed in with until now becomes its recovery
   * address, keeping the verification it already earned.
   */
  adoptSignInAddress(userId: string, address: string, nowIso: string): Promise<'adopted' | 'unchanged' | 'address_taken' | 'missing'>;
  updateRecoveryEmail(
    userId: string,
    recovery: Pick<WorkspaceEmailIdentityDocument, 'recoveryEmail' | 'recoveryEmailVerifiedAt'>,
    nowIso: string,
  ): Promise<boolean>;
  /** One link per person per purpose; a new one replaces the last. Refuses one sent within the cooldown. */
  saveAuthLink(doc: WorkspaceAuthLinkDocument, cooldownMs: number): Promise<'created' | 'rate_limited'>;
  consumeAuthLink(tokenHash: string, purpose: WorkspaceAuthLinkPurpose, nowIso: string): Promise<WorkspaceAuthLinkConsumption>;
  updateEmailSecondFactor(
    userId: string,
    factor: Pick<WorkspaceEmailIdentityDocument, 'encryptedTotpSecret' | 'lastAcceptedStep' | 'recoveryCodeHashes'>,
  ): Promise<boolean>;
  acceptEmailTotpStep(userId: string, step: number): Promise<boolean>;
  consumeEmailRecoveryCode(userId: string, encodedHash: string): Promise<boolean>;
  beginEmailVerification(
    doc: WorkspaceEmailVerificationDocument,
    limits: { cooldownMs: number; windowMs: number; maxPerWindow: number },
  ): Promise<'created' | 'rate_limited' | 'already_verified' | 'identity_changed'>;
  consumeEmailVerification(
    tokenHash: string,
    nowIso: string,
  ): Promise<WorkspaceEmailVerificationConsumption>;
  saveSecondFactorChallenge(doc: WorkspaceSecondFactorChallengeDocument): Promise<void>;
  getSecondFactorChallenge(tokenHash: string, nowIso: string): Promise<WorkspaceSecondFactorChallengeDocument | null>;
  deleteSecondFactorChallenge(tokenHash: string): Promise<void>;
  saveEnrollment(doc: WorkspaceTotpEnrollmentDocument): Promise<void>;
  getEnrollment(tokenHash: string): Promise<WorkspaceTotpEnrollmentDocument | null>;
  deleteEnrollment(tokenHash: string): Promise<void>;
  getIdentityByUserId(userId: string): Promise<WorkspaceTotpIdentityDocument | null>;
  getIdentityByUsername(usernameCanonical: string): Promise<WorkspaceTotpIdentityDocument | null>;
  createIdentity(doc: WorkspaceTotpIdentityDocument): Promise<'created' | 'username_taken' | 'user_has_identity'>;
  deleteIdentity(userId: string): Promise<void>;
  acceptTotpStep(userId: string, step: number): Promise<boolean>;
  consumeRecoveryCode(userId: string, encodedHash: string): Promise<boolean>;
  createSession(tokenHash: string, doc: WorkspaceWebSessionDocument): Promise<void>;
  getSession(tokenHash: string): Promise<WorkspaceWebSessionDocument | null>;
  getSessionById(userId: string, sessionId: string): Promise<WorkspaceWebSessionDocument | null>;
  touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void>;
  revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean>;
  revokeAllSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number>;
  listSessions(userId: string): Promise<WorkspaceWebSessionDocument[]>;
}

export class WorkspaceWebAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_username'
      | 'invalid_email'
      | 'invalid_password'
      | 'email_taken'
      | 'username_taken'
      | 'already_enabled'
      | 'enrollment_missing'
      | 'enrollment_expired'
      | 'authentication_required'
      | 'invalid_code'
      | 'invalid_credentials'
      | 'verification_invalid'
      | 'verification_expired'
      | 'verification_unavailable'
      | 'invalid_mailbox'
      | 'invalid_name'
      | 'mailbox_taken'
      | 'outside_email_closed'
      | 'invalid_recovery_email'
      | 'link_invalid'
      | 'link_expired'
      | 'profile_missing',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceWebAuthError';
  }
}

export interface IssuedWorkspaceSession {
  token: string;
  csrfToken: string;
  session: WorkspaceWebSessionDocument;
}

export interface FinishedWorkspaceEnrollment extends IssuedWorkspaceSession {
  username: string;
  recoveryCodes: string[];
  userId: string;
  linkedExistingUser: boolean;
}

export interface FinishedWorkspaceEmailRegistration {
  email: string;
  userId: string;
  newAccount: boolean;
  linkedExistingUser: boolean;
  verificationRequired: true;
}

export interface PendingWorkspaceSecondFactor {
  secondFactorRequired: true;
  secondFactorToken: string;
  expiresAt: string;
}

export interface PendingWorkspaceEmailVerification {
  authenticated: false;
  verificationRequired: true;
}

export interface WorkspaceEmailVerificationConfig {
  workspaceUrl: string;
  sender: WorkspaceVerificationEmailSender;
}

export function normalizeWorkspaceUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const username = input.trim().toLowerCase();
  return WORKSPACE_USERNAME_PATTERN.test(username) ? username : null;
}

export function normalizeWorkspaceEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  // Deliberately practical rather than pretending to validate every RFC 5322
  // address. It rejects whitespace, missing halves and pathological values;
  // the address remains the stable account identifier.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function workspaceEmailVerificationStatus(
  identity: WorkspaceEmailIdentityDocument,
): 'pending' | 'verified' | 'legacy' {
  if (identity.verificationStatus) return identity.verificationStatus;
  return identity.emailVerifiedAt ? 'verified' : 'legacy';
}

function buildWebUserId(): string {
  return `web_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

/** Keeps unknown-email and known-email password checks on the same expensive
 * scrypt path without storing or resolving a real account. */
const DUMMY_PASSWORD_HASH = hashWorkspacePassword('not-a-real-workspace-password');

/** A person's name as typed, with its whitespace tidied; '' when there is none. */
function normalizePersonName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export class WorkspaceWebAuthService {
  constructor(
    readonly storage: WorkspaceWebAuthStorage,
    private readonly users: UserStorage,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
    private readonly emailVerification?: WorkspaceEmailVerificationConfig,
    /** Absent on a backend with no mail service: signup then creates the
     *  account without an address, and Settings offers one later. */
    private readonly mailboxes?: MailboxService,
  ) {}

  async hasIdentity(userId: string): Promise<boolean> {
    return Boolean(await this.storage.getEmailIdentityByUserId(userId)
      || await this.storage.getIdentityByUserId(userId));
  }

  async identityForUser(userId: string): Promise<WorkspaceBrowserIdentity | null> {
    const email = await this.storage.getEmailIdentityByUserId(userId);
    if (email) return { ...email, kind: 'email', username: email.email };
    const totp = await this.storage.getIdentityByUserId(userId);
    return totp ? { ...totp, kind: 'totp' } : null;
  }

  /**
   * Attach an OUTSIDE email address to an account that already exists — the
   * Settings door a legacy authenticator account uses to move over, and the
   * only place an address we do not host is still accepted.
   *
   * Since note #509 this is no longer how anybody signs up: creating an
   * account is `registerMailbox`, which allocates the person's own address
   * here. Public registration with an outside email is closed at the route.
   */
  async registerEmail(args: {
    email: unknown;
    password: unknown;
    inviteToken?: unknown;
    authenticatedUserId?: string;
    userAgent?: string;
  }): Promise<FinishedWorkspaceEmailRegistration> {
    if (!this.emailVerification) {
      throw new WorkspaceWebAuthError(
        'verification_unavailable',
        'Email confirmation is temporarily unavailable. Try again later.',
      );
    }
    const userId = args.authenticatedUserId;
    if (!userId) {
      throw new WorkspaceWebAuthError(
        'outside_email_closed',
        'Accounts are created with an address here. Sign in, then add an email in Settings.',
      );
    }
    const email = normalizeWorkspaceEmail(args.email);
    if (!email) throw new WorkspaceWebAuthError('invalid_email', 'Enter a valid email address.');
    const password = normalizeWorkspacePassword(args.password);
    if (!password) {
      throw new WorkspaceWebAuthError('invalid_password', 'Use at least 10 characters for your password.');
    }
    if (!await this.users.getProfile(userId)) {
      throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
    }
    if (await this.storage.getEmailIdentityByUserId(userId)) {
      throw new WorkspaceWebAuthError('already_enabled', 'Email sign-in is already set up for this account.');
    }
    const answer = (): FinishedWorkspaceEmailRegistration => ({
      email, userId, newAccount: false, linkedExistingUser: true, verificationRequired: true,
    });
    // Existence-oblivious: Settings can truthfully say to check the address,
    // and no answer confirms whether it already belongs to somebody else.
    // Only its actual owner ever receives the link.
    if (await this.storage.getEmailIdentityByEmail(email)) return answer();

    const passwordHash = hashWorkspacePassword(password);
    const now = this.now().toISOString();
    const legacyFactor = await this.storage.getIdentityByUserId(userId);
    const outcome = await this.storage.createEmailIdentity({
      userId,
      email,
      emailCanonical: email,
      passwordHash,
      // A migrated authenticator becomes the optional second factor. The old
      // standalone TOTP door stays only through pending confirmation, then
      // closes in login() below so it cannot bypass the verified primary.
      ...(legacyFactor ? {
        encryptedTotpSecret: legacyFactor.encryptedTotpSecret,
        lastAcceptedStep: legacyFactor.lastAcceptedStep,
        recoveryCodeHashes: [...legacyFactor.recoveryCodeHashes],
      } : {}),
      verificationStatus: 'pending',
      ...(legacyFactor ? { preserveLegacyLoginUntilVerified: true } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (outcome !== 'created') {
      if (outcome === 'email_taken') return answer();
      throw new WorkspaceWebAuthError('already_enabled', 'Email sign-in is already set up for this account.');
    }
    await this.users.updateProfile(userId, { email, authType: 'email' });
    const identity = await this.storage.getEmailIdentityByUserId(userId);
    if (!identity) throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
    await this.issueEmailVerification(identity, args.inviteToken);
    return answer();
  }

  /**
   * Create an account from the one thing it needs: the name this person wants
   * on our mail domain, and a password (note #509). The address IS the
   * account — nobody else can have chosen it, so there is no outside owner to
   * prove anything to and no confirmation link to wait for. The session opens
   * here, with the address held in the same breath as the identity.
   */
  async registerMailbox(args: {
    mailbox: unknown;
    password: unknown;
    /** The person's own name (note #144): asked with the address, so every
     *  screen after this one — and the Workspace Agent's first words — can
     *  address them by it, and teammates see a name rather than a mailbox. */
    firstName: unknown;
    lastName: unknown;
    userAgent?: string;
    /** Already cleaned (`cleanFirstVisit`): kept on the profile as it is. */
    firstVisit?: FirstVisit;
  }): Promise<{ address: string; userId: string; session: IssuedWorkspaceSession }> {
    if (!this.mailboxes) {
      throw new WorkspaceWebAuthError(
        'verification_unavailable',
        'Creating an account is temporarily unavailable. Try again later.',
      );
    }
    const password = normalizeWorkspacePassword(args.password);
    if (!password) {
      throw new WorkspaceWebAuthError('invalid_password', 'Use at least 10 characters for your password.');
    }
    const firstName = normalizePersonName(args.firstName);
    const lastName = normalizePersonName(args.lastName);
    if (!firstName || !lastName) {
      throw new WorkspaceWebAuthError('invalid_name', 'Tell us your first and last name.');
    }
    if (firstName.length > PERSON_NAME_MAX_LENGTH || lastName.length > PERSON_NAME_MAX_LENGTH) {
      throw new WorkspaceWebAuthError('invalid_name', `A name here fits in ${PERSON_NAME_MAX_LENGTH} characters.`);
    }
    const userId = buildWebUserId();
    // The name is taken BEFORE the account exists: one somebody else just took
    // is a reason not to create this account at all, and everything after this
    // point releases it again if it cannot finish.
    let address: string;
    try {
      address = (await this.mailboxes.claim(userId, args.mailbox)).address;
    } catch (error) {
      if (error instanceof MailboxError) {
        throw new WorkspaceWebAuthError(
          error.code === 'invalid_mailbox' ? 'invalid_mailbox' : 'mailbox_taken',
          error.message,
        );
      }
      throw error;
    }
    const passwordHash = hashWorkspacePassword(password);
    const now = this.now().toISOString();
    try {
      await this.users.createProfile(userId, {
        email: address,
        displayName: `${firstName} ${lastName}`,
        photoURL: '',
        authType: 'email',
      });
      await this.users.updatePersonFields(userId, { firstName, lastName });
      if (args.firstVisit) await this.users.updateProfile(userId, { firstVisit: args.firstVisit });
      const outcome = await this.storage.createEmailIdentity({
        userId,
        email: address,
        emailCanonical: address,
        passwordHash,
        // Verified on creation, and that is not a shortcut: the address was
        // minted for this account one line ago. There is no third party whose
        // ownership could be in question.
        verificationStatus: 'verified',
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (outcome !== 'created') {
        throw new WorkspaceWebAuthError('mailbox_taken', 'That address is already taken. Choose another name.');
      }
    } catch (error) {
      await this.mailboxes.release(userId, address).catch(() => undefined);
      await this.users.deleteUserData(userId).catch(() => undefined);
      throw error;
    }
    return { address, userId, session: await this.issueSession(userId, 'password', args.userAgent) };
  }

  async loginEmail(args: {
    email: unknown;
    password: unknown;
    userAgent?: string;
  }): Promise<IssuedWorkspaceSession | PendingWorkspaceSecondFactor | PendingWorkspaceEmailVerification> {
    const identity = await this.identityForSignIn(args.email);
    const candidate = typeof args.password === 'string' && args.password.length <= 256 ? args.password : '';
    // Always do one scrypt verification. A missing name must not be a cheap
    // timing oracle that confirms which addresses have accounts.
    const passwordValid = verifyWorkspacePassword(candidate, identity?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!identity || !passwordValid) throw this.invalidCredentials('Invalid name or password.');

    if (workspaceEmailVerificationStatus(identity) === 'pending') {
      return { authenticated: false, verificationRequired: true };
    }

    if (identity.encryptedTotpSecret) {
      const secondFactorToken = randomBytes(32).toString('base64url');
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + WORKSPACE_SECOND_FACTOR_TTL_MS);
      await this.storage.saveSecondFactorChallenge({
        tokenHash: hashOpaqueToken(secondFactorToken),
        userId: identity.userId,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return { secondFactorRequired: true, secondFactorToken, expiresAt: expiresAt.toISOString() };
    }
    return this.issueSession(identity.userId, 'password', args.userAgent);
  }

  /**
   * Who is signing in. People sign in by the name of their address here:
   * `adam` is `adam@agenticcloudcomputer.com`, and the person who HOLDS that
   * address is the account — whatever email their identity record was
   * created with. That is what keeps an account that attached an outside
   * email first, and took its address here later, from being locked behind
   * a name it no longer thinks of as its own.
   *
   * An outside email typed in full still reaches the account created with
   * it, for the accounts that have not taken an address here yet: there is
   * no other door for them, and Settings is where they pick their name.
   */
  private async identityForSignIn(typedInput: unknown): Promise<WorkspaceEmailIdentityDocument | null> {
    const typed = typeof typedInput === 'string' ? typedInput.trim().toLowerCase() : '';
    if (!typed) return null;
    const address = normalizeWorkspaceEmail(mailSignInAddress(typed));
    if (!address) return null;
    if (isMailDomainAddress(address) && this.mailboxes) {
      const holder = await this.mailboxes.holderOf(address);
      if (holder) return this.storage.getEmailIdentityByUserId(holder);
    }
    return this.storage.getEmailIdentityByEmail(address);
  }

  /**
   * The address this account just took here becomes its sign-in name. Called
   * after a claim from Settings; signup writes the identity with the address
   * from the start, so this is a no-op there.
   */
  async adoptMailboxAddress(userId: string, address: string): Promise<void> {
    const outcome = await this.storage.adoptSignInAddress(userId, address, this.now().toISOString());
    if (outcome === 'address_taken') {
      // Cannot happen while mailboxes are unique per person, but a stale
      // identity carrying the same address must not be silently overwritten.
      throw new WorkspaceWebAuthError('email_taken', 'That address already signs in to another account.');
    }
  }

  /**
   * "Forgot your password" — existence-oblivious, like the public resend. A
   * link goes to the account's recovery address when it has a confirmed one;
   * an account that still signs in with an outside email gets it there. An
   * account with neither has nothing to send to, and the caller learns
   * nothing either way.
   */
  async requestPasswordReset(nameInput: unknown): Promise<void> {
    if (!this.emailVerification?.sender.sendPasswordReset) {
      throw new WorkspaceWebAuthError('verification_unavailable', 'Password reset is temporarily unavailable. Try again later.');
    }
    const identity = await this.identityForSignIn(nameInput);
    if (!identity) return;
    const target = this.passwordResetAddress(identity);
    if (!target) return;
    const issued = await this.issueAuthLink(identity.userId, 'password_reset', target, '/reset-password');
    if (!issued) return;
    await this.emailVerification.sender.sendPasswordReset({
      email: target,
      signInName: identity.email,
      resetUrl: issued.url,
      expiresAt: issued.expiresAt,
      idempotencyKey: `workspace-password-reset-${issued.tokenHash}`,
    });
  }

  /** Where a reset for this account may go, or null when it has nowhere safe. */
  passwordResetAddress(identity: WorkspaceEmailIdentityDocument): string | null {
    if (identity.recoveryEmail && identity.recoveryEmailVerifiedAt) return identity.recoveryEmail;
    if (!isMailDomainAddress(identity.emailCanonical) && workspaceEmailVerificationStatus(identity) !== 'pending') {
      return identity.emailCanonical;
    }
    return null;
  }

  /**
   * The link from that email sets a new password. It deliberately opens no
   * session: the owner signs in with the new password, and through their
   * authenticator when they have one — possession of the recovery inbox
   * must not become a way around the second factor. Every other browser is
   * signed out, exactly as a password change from Settings does.
   */
  async resetPassword(rawToken: unknown, newPassword: unknown): Promise<{ userId: string; revoked: number }> {
    const password = normalizeWorkspacePassword(newPassword);
    if (!password) {
      throw new WorkspaceWebAuthError('invalid_password', 'Use at least 10 characters for your new password.');
    }
    const link = await this.consumeAuthLink(rawToken, 'password_reset');
    if (!await this.storage.updateEmailPassword(link.userId, hashWorkspacePassword(password))) {
      throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
    }
    const revoked = await this.revokeAllSessions(link.userId);
    return { userId: link.userId, revoked };
  }

  /**
   * Settings: an outside address a forgotten password can be reset through.
   * Pending until its owner opens the link — a typo must not become the
   * address that can take over this account.
   */
  async requestRecoveryEmail(userId: string, emailInput: unknown): Promise<{ email: string }> {
    if (!this.emailVerification?.sender.sendRecoveryConfirmation) {
      throw new WorkspaceWebAuthError('verification_unavailable', 'Email delivery is temporarily unavailable. Try again later.');
    }
    const email = normalizeWorkspaceEmail(emailInput);
    if (!email) throw new WorkspaceWebAuthError('invalid_recovery_email', 'Enter a valid email address.');
    if (isMailDomainAddress(email)) {
      throw new WorkspaceWebAuthError(
        'invalid_recovery_email',
        `A recovery address has to be outside ${MAIL_DOMAIN}: it is where you read from when you cannot sign in here.`,
      );
    }
    const identity = await this.storage.getEmailIdentityByUserId(userId);
    if (!identity) throw new WorkspaceWebAuthError('profile_missing', 'This account has no password sign-in.');
    const now = this.now().toISOString();
    const unchanged = identity.recoveryEmail === email && identity.recoveryEmailVerifiedAt;
    if (!unchanged) {
      await this.storage.updateRecoveryEmail(userId, { recoveryEmail: email, recoveryEmailVerifiedAt: undefined }, now);
    }
    const issued = await this.issueAuthLink(userId, 'recovery_email', email, '/confirm-recovery');
    if (issued) {
      await this.emailVerification.sender.sendRecoveryConfirmation({
        email,
        signInName: identity.email,
        confirmUrl: issued.url,
        expiresAt: issued.expiresAt,
        idempotencyKey: `workspace-recovery-email-${issued.tokenHash}`,
      });
    }
    return { email };
  }

  async confirmRecoveryEmail(rawToken: unknown): Promise<{ email: string }> {
    const link = await this.consumeAuthLink(rawToken, 'recovery_email');
    const identity = await this.storage.getEmailIdentityByUserId(link.userId);
    // The address changed again after this link was sent: the link confirms
    // an address the account no longer wants, so it confirms nothing.
    if (!identity || identity.recoveryEmail !== link.email) {
      throw new WorkspaceWebAuthError('link_invalid', 'That link is no longer valid. Request a new one from Settings.');
    }
    const now = this.now().toISOString();
    await this.storage.updateRecoveryEmail(link.userId, { recoveryEmail: link.email, recoveryEmailVerifiedAt: now }, now);
    return { email: link.email };
  }

  async removeRecoveryEmail(userId: string): Promise<void> {
    await this.storage.updateRecoveryEmail(userId, { recoveryEmail: undefined, recoveryEmailVerifiedAt: undefined }, this.now().toISOString());
  }

  private async issueAuthLink(
    userId: string,
    purpose: WorkspaceAuthLinkPurpose,
    email: string,
    path: '/reset-password' | '/confirm-recovery',
  ): Promise<{ url: string; tokenHash: string; expiresAt: string } | null> {
    if (!this.emailVerification) return null;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashOpaqueToken(token);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + WORKSPACE_AUTH_LINK_TTL_MS).toISOString();
    const saved = await this.storage.saveAuthLink({
      tokenHash, userId, purpose, email, createdAt: createdAt.toISOString(), expiresAt,
    }, WORKSPACE_AUTH_LINK_COOLDOWN_MS);
    if (saved !== 'created') return null;
    const url = new URL(this.emailVerification.workspaceUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    url.search = '';
    // The bearer rides in the fragment, as the confirmation link's does:
    // never in an access log or a Referer.
    url.hash = new URLSearchParams({ token }).toString();
    return { url: url.toString(), tokenHash, expiresAt };
  }

  private async consumeAuthLink(rawToken: unknown, purpose: WorkspaceAuthLinkPurpose): Promise<WorkspaceAuthLinkDocument> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new WorkspaceWebAuthError('link_invalid', 'That link is no longer valid. Request a new one.');
    }
    const consumed = await this.storage.consumeAuthLink(hashOpaqueToken(token), purpose, this.now().toISOString());
    if (consumed.outcome === 'consumed') return consumed.link;
    throw new WorkspaceWebAuthError(
      consumed.outcome === 'expired' ? 'link_expired' : 'link_invalid',
      consumed.outcome === 'expired' ? 'That link expired. Request a new one.' : 'That link is no longer valid. Request a new one.',
    );
  }

  /** Public resend is intentionally an existence-oblivious operation. A
   * missing, already verified, malformed or rate-limited address all complete
   * without exposing which case applied. */
  async requestEmailVerification(emailInput: unknown, inviteToken?: unknown): Promise<void> {
    if (!this.emailVerification) {
      throw new WorkspaceWebAuthError(
        'verification_unavailable',
        'Email confirmation is temporarily unavailable. Try again later.',
      );
    }
    const email = normalizeWorkspaceEmail(emailInput);
    if (!email) return;
    const identity = await this.storage.getEmailIdentityByEmail(email);
    if (!identity || workspaceEmailVerificationStatus(identity) === 'verified') return;
    await this.issueEmailVerification(identity, inviteToken);
  }

  /** A confirmed address is enough to open an ordinary new account without
   * asking for its password a second time. A migrated account carrying an
   * authenticator deliberately receives no session here: email possession
   * must not become a way around its second factor. */
  async verifyEmail(rawToken: unknown, userAgent?: string): Promise<IssuedWorkspaceSession | null> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new WorkspaceWebAuthError(
        'verification_invalid',
        'That confirmation link is no longer valid. Request a new one.',
      );
    }
    const consumed = await this.storage.consumeEmailVerification(
      hashOpaqueToken(token),
      this.now().toISOString(),
    );
    if (consumed.outcome === 'verified') {
      const identity = await this.storage.getEmailIdentityByUserId(consumed.userId);
      if (!identity) {
        throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
      }
      if (identity.encryptedTotpSecret) return null;
      return this.issueSession(identity.userId, 'email_verification', userAgent);
    }
    throw new WorkspaceWebAuthError(
      consumed.outcome === 'expired' ? 'verification_expired' : 'verification_invalid',
      consumed.outcome === 'expired'
        ? 'That confirmation link expired. Request a new one.'
        : 'That confirmation link is no longer valid. Request a new one.',
    );
  }

  async changeEmailPassword(userId: string, currentPassword: unknown, newPassword: unknown): Promise<void> {
    const identity = await this.storage.getEmailIdentityByUserId(userId);
    if (!identity || typeof currentPassword !== 'string'
      || !verifyWorkspacePassword(currentPassword, identity.passwordHash)) {
      throw this.invalidCredentials('The current password is not correct.');
    }
    const password = normalizeWorkspacePassword(newPassword);
    if (!password) {
      throw new WorkspaceWebAuthError('invalid_password', 'Use at least 10 characters for your new password.');
    }
    if (!await this.storage.updateEmailPassword(userId, hashWorkspacePassword(password))) {
      throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
    }
  }

  async finishSecondFactor(args: {
    secondFactorToken: string;
    code?: string;
    recoveryCode?: string;
    userAgent?: string;
  }): Promise<IssuedWorkspaceSession> {
    const tokenHash = hashOpaqueToken(args.secondFactorToken.trim());
    const pending = await this.storage.getSecondFactorChallenge(tokenHash, this.now().toISOString());
    if (!pending) throw this.invalidCredentials('That security check expired. Sign in again.');
    const identity = await this.storage.getEmailIdentityByUserId(pending.userId);
    if (!identity?.encryptedTotpSecret) throw this.invalidCredentials();

    if (args.recoveryCode) {
      let matched: string | undefined;
      for (const encoded of identity.recoveryCodeHashes ?? []) {
        if (verifyRecoveryCode(args.recoveryCode, encoded)) matched = encoded;
      }
      if (!matched || !await this.storage.consumeEmailRecoveryCode(identity.userId, matched)) {
        throw this.invalidCredentials('That recovery code is not valid.');
      }
      await this.storage.deleteSecondFactorChallenge(tokenHash);
      return this.issueSession(identity.userId, 'recovery', args.userAgent);
    }

    let secret: string;
    try { secret = this.cipher.decrypt(identity.encryptedTotpSecret); }
    catch { throw this.invalidCredentials(); }
    const verification = verifyTotpCode(secret, args.code ?? '', {
      nowMs: this.now().getTime(),
      lastAcceptedStep: identity.lastAcceptedStep,
    });
    if (!verification.ok || verification.matchedStep === undefined
      || !await this.storage.acceptEmailTotpStep(identity.userId, verification.matchedStep)) {
      throw this.invalidCredentials('That authenticator code is not valid.');
    }
    await this.storage.deleteSecondFactorChallenge(tokenHash);
    return this.issueSession(identity.userId, 'totp', args.userAgent);
  }

  async startTotpSecondFactor(userId: string): Promise<{
    enrollmentToken: string;
    secret: string;
    otpauthUrl: string;
    expiresAt: string;
  }> {
    const identity = await this.storage.getEmailIdentityByUserId(userId);
    if (!identity) throw new WorkspaceWebAuthError('profile_missing', 'Add email sign-in first.');
    if (identity.encryptedTotpSecret) {
      throw new WorkspaceWebAuthError('already_enabled', 'Authenticator security is already enabled.');
    }
    const enrollmentToken = randomBytes(32).toString('base64url');
    const generated = generateTotpSecret(identity.email, WORKSPACE_TOTP_ISSUER);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + WORKSPACE_ENROLLMENT_TTL_MS);
    await this.storage.saveEnrollment({
      tokenHash: hashOpaqueToken(enrollmentToken),
      username: identity.email,
      usernameCanonical: identity.emailCanonical,
      userId,
      encryptedTotpSecret: this.cipher.encrypt(generated.secret),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return {
      enrollmentToken,
      secret: generated.secret,
      otpauthUrl: generated.otpauthUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async finishTotpSecondFactor(args: {
    userId: string;
    enrollmentToken: string;
    code: string;
  }): Promise<{ recoveryCodes: string[] }> {
    const tokenHash = hashOpaqueToken(args.enrollmentToken.trim());
    const pending = await this.storage.getEnrollment(tokenHash);
    if (!pending || pending.userId !== args.userId) {
      throw new WorkspaceWebAuthError('enrollment_missing', 'That setup request is no longer available.');
    }
    const now = this.now();
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      await this.storage.deleteEnrollment(tokenHash);
      throw new WorkspaceWebAuthError('enrollment_expired', 'That setup request expired. Start again.');
    }
    const secret = this.cipher.decrypt(pending.encryptedTotpSecret);
    const verification = verifyTotpCode(secret, args.code, { nowMs: now.getTime() });
    if (!verification.ok || verification.matchedStep === undefined) {
      throw new WorkspaceWebAuthError('invalid_code', 'That authenticator code is not valid.');
    }
    const recoveryCodes = generateRecoveryCodes();
    const updated = await this.storage.updateEmailSecondFactor(args.userId, {
      encryptedTotpSecret: pending.encryptedTotpSecret,
      lastAcceptedStep: verification.matchedStep,
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
    });
    if (!updated) throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
    await this.storage.deleteEnrollment(tokenHash);
    return { recoveryCodes };
  }

  async disableTotpSecondFactor(userId: string, code: string): Promise<void> {
    const identity = await this.storage.getEmailIdentityByUserId(userId);
    if (!identity?.encryptedTotpSecret) {
      throw new WorkspaceWebAuthError('invalid_code', 'Authenticator security is not enabled.');
    }
    let secret: string;
    try { secret = this.cipher.decrypt(identity.encryptedTotpSecret); }
    catch { throw new WorkspaceWebAuthError('invalid_code', 'That authenticator code is not valid.'); }
    // This is proof of possession inside an already authenticated, CSRF-
    // protected session, not a session-issuing login. Reusing the code that
    // opened this browser moments ago is therefore safe and avoids making the
    // owner wait for the next 30-second step just to turn the factor off.
    const verification = verifyTotpCode(secret, code, { nowMs: this.now().getTime() });
    if (!verification.ok) {
      throw new WorkspaceWebAuthError('invalid_code', 'That authenticator code is not valid.');
    }
    await this.storage.updateEmailSecondFactor(userId, {
      encryptedTotpSecret: undefined,
      lastAcceptedStep: undefined,
      recoveryCodeHashes: undefined,
    });
  }

  async startEnrollment(usernameInput: unknown, userId?: string): Promise<{
    enrollmentToken: string;
    username: string;
    secret: string;
    otpauthUrl: string;
    expiresAt: string;
  }> {
    const username = normalizeWorkspaceUsername(usernameInput);
    if (!username) {
      throw new WorkspaceWebAuthError(
        'invalid_username',
        'Username must be 3–32 characters using lowercase letters, numbers, or underscores.',
      );
    }
    if (userId) {
      if (!await this.users.getProfile(userId)) {
        throw new WorkspaceWebAuthError('profile_missing', 'This account no longer exists.');
      }
      if (await this.storage.getIdentityByUserId(userId)) {
        throw new WorkspaceWebAuthError('already_enabled', 'Browser login is already set up for this account.');
      }
    }
    if (await this.storage.getIdentityByUsername(username)) {
      throw new WorkspaceWebAuthError('username_taken', 'That username is already taken.');
    }

    const enrollmentToken = randomBytes(32).toString('base64url');
    const generated = generateTotpSecret(username, WORKSPACE_TOTP_ISSUER);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + WORKSPACE_ENROLLMENT_TTL_MS);
    await this.storage.saveEnrollment({
      tokenHash: hashOpaqueToken(enrollmentToken),
      username,
      usernameCanonical: username,
      ...(userId ? { userId } : {}),
      encryptedTotpSecret: this.cipher.encrypt(generated.secret),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return {
      enrollmentToken,
      username,
      secret: generated.secret,
      otpauthUrl: generated.otpauthUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async finishEnrollment(args: {
    enrollmentToken: string;
    code: string;
    authenticatedUserId?: string;
    userAgent?: string;
  }): Promise<FinishedWorkspaceEnrollment> {
    const tokenHash = hashOpaqueToken(args.enrollmentToken.trim());
    const pending = await this.storage.getEnrollment(tokenHash);
    if (!pending) {
      throw new WorkspaceWebAuthError('enrollment_missing', 'That setup request is no longer available.');
    }
    const now = this.now();
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      await this.storage.deleteEnrollment(tokenHash);
      throw new WorkspaceWebAuthError('enrollment_expired', 'That setup request expired. Start again.');
    }
    if (pending.userId && pending.userId !== args.authenticatedUserId) {
      throw new WorkspaceWebAuthError(
        'authentication_required',
        'Reopen your authenticated Workspace and finish browser-login setup there.',
      );
    }
    const secret = this.cipher.decrypt(pending.encryptedTotpSecret);
    const verification = verifyTotpCode(secret, args.code, { nowMs: now.getTime() });
    if (!verification.ok || verification.matchedStep === undefined) {
      throw new WorkspaceWebAuthError('invalid_code', 'That one-time code is not valid.');
    }

    const linkedExistingUser = Boolean(pending.userId);
    const userId = pending.userId ?? buildWebUserId();
    let createdProfile = false;
    if (!pending.userId) {
      await this.users.createProfile(userId, {
        email: '',
        displayName: pending.username,
        photoURL: '',
        authType: 'anonymous_totp',
      });
      createdProfile = true;
    }
    const recoveryCodes = generateRecoveryCodes();
    const identity: WorkspaceTotpIdentityDocument = {
      userId,
      username: pending.username,
      usernameCanonical: pending.usernameCanonical,
      encryptedTotpSecret: pending.encryptedTotpSecret,
      lastAcceptedStep: verification.matchedStep,
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const outcome = await this.storage.createIdentity(identity);
    if (outcome !== 'created') {
      if (createdProfile) await this.users.deleteUserData(userId).catch(() => undefined);
      throw new WorkspaceWebAuthError(
        outcome === 'username_taken' ? 'username_taken' : 'already_enabled',
        outcome === 'username_taken'
          ? 'That username was just taken. Choose another one.'
          : 'Browser login is already set up for this account.',
      );
    }
    await this.storage.deleteEnrollment(tokenHash);
    try {
      const issued = await this.issueSession(userId, 'totp', args.userAgent);
      return { ...issued, username: pending.username, recoveryCodes, userId, linkedExistingUser };
    } catch (error) {
      // The identity is valid even if issuing its first browser cookie failed.
      // A normal login can retry; never roll credentials back after showing
      // the authenticator secret and burning its first code.
      throw error;
    }
  }

  async login(args: { username: unknown; code: string; userAgent?: string }): Promise<IssuedWorkspaceSession> {
    const username = normalizeWorkspaceUsername(args.username);
    if (!username) throw this.invalidCredentials();
    const identity = await this.storage.getIdentityByUsername(username);
    if (!identity) throw this.invalidCredentials();
    // Once linked email is confirmed, the old standalone TOTP door closes.
    // Until then it is the lockout-safe transition path. Afterwards the same
    // secret follows a verified password as the optional second factor.
    const emailIdentity = await this.storage.getEmailIdentityByUserId(identity.userId);
    if (emailIdentity && !emailIdentity.preserveLegacyLoginUntilVerified) throw this.invalidCredentials();
    let secret: string;
    try {
      secret = this.cipher.decrypt(identity.encryptedTotpSecret);
    } catch {
      throw this.invalidCredentials();
    }
    const verification = verifyTotpCode(secret, args.code, {
      nowMs: this.now().getTime(),
      lastAcceptedStep: identity.lastAcceptedStep,
    });
    if (!verification.ok || verification.matchedStep === undefined) throw this.invalidCredentials();
    // Compare-and-set inside storage closes the two-request replay race.
    if (!await this.storage.acceptTotpStep(identity.userId, verification.matchedStep)) {
      throw this.invalidCredentials();
    }
    return this.issueSession(identity.userId, 'totp', args.userAgent);
  }

  async recover(args: {
    username: unknown;
    recoveryCode: string;
    userAgent?: string;
  }): Promise<IssuedWorkspaceSession> {
    const username = normalizeWorkspaceUsername(args.username);
    if (!username) throw this.invalidCredentials('Invalid username or recovery code.');
    const identity = await this.storage.getIdentityByUsername(username);
    if (!identity) throw this.invalidCredentials('Invalid username or recovery code.');
    if (await this.storage.getEmailIdentityByUserId(identity.userId)) {
      throw this.invalidCredentials('Invalid username or recovery code.');
    }
    let matched: string | undefined;
    // Evaluate every stored code so its position is not reflected in timing.
    for (const encoded of identity.recoveryCodeHashes) {
      const ok = verifyRecoveryCode(args.recoveryCode, encoded);
      if (ok) matched = encoded;
    }
    if (!matched || !await this.storage.consumeRecoveryCode(identity.userId, matched)) {
      throw this.invalidCredentials('Invalid username or recovery code.');
    }
    return this.issueSession(identity.userId, 'recovery', args.userAgent);
  }

  async authenticateSession(rawToken: string): Promise<WorkspaceWebSessionDocument | null> {
    if (!rawToken) return null;
    const tokenHash = hashOpaqueToken(rawToken);
    const session = await this.storage.getSession(tokenHash);
    if (!session || session.revokedAt) return null;
    const now = this.now();
    if (Date.parse(session.idleExpiresAt) <= now.getTime()
      || Date.parse(session.absoluteExpiresAt) <= now.getTime()) return null;
    if (!await this.users.getProfile(session.userId)) return null;
    if (now.getTime() - Date.parse(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS) {
      const absolute = Date.parse(session.absoluteExpiresAt);
      const nextIdle = new Date(Math.min(absolute, now.getTime() + WORKSPACE_SESSION_IDLE_MS)).toISOString();
      await this.storage.touchSession(tokenHash, now.toISOString(), nextIdle);
      return { ...session, lastSeenAt: now.toISOString(), idleExpiresAt: nextIdle };
    }
    return session;
  }

  /** Read-only validity check for capabilities tied to a browser session,
   * notably Web Push. It deliberately does not extend the idle lifetime. */
  async isSessionActive(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.storage.getSessionById(userId, sessionId);
    if (!session || session.revokedAt) return false;
    const now = this.now().getTime();
    if (Date.parse(session.idleExpiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) return false;
    return Boolean(await this.users.getProfile(userId));
  }

  async listSessions(userId: string, currentToken?: string): Promise<Array<WorkspaceWebSessionDocument & { current: boolean }>> {
    const current = currentToken ? hashOpaqueToken(currentToken) : '';
    const rows = await this.storage.listSessions(userId);
    const currentDoc = current ? await this.storage.getSession(current) : null;
    const now = this.now().getTime();
    return rows
      .filter((session) => Date.parse(session.idleExpiresAt) > now && Date.parse(session.absoluteExpiresAt) > now)
      .map((session) => ({ ...session, current: session.sessionId === currentDoc?.sessionId }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.storage.revokeSession(userId, sessionId, this.now().toISOString());
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    return this.storage.revokeAllSessions(userId, this.now().toISOString(), exceptSessionId);
  }

  private async issueSession(
    userId: string,
    authMethod: WorkspaceWebSessionAuthMethod,
    userAgent?: string,
  ): Promise<IssuedWorkspaceSession> {
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session: WorkspaceWebSessionDocument = {
      sessionId: randomUUID(),
      userId,
      authMethod,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + WORKSPACE_SESSION_IDLE_MS).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + WORKSPACE_SESSION_ABSOLUTE_MS).toISOString(),
      ...(userAgent?.trim() ? { userAgent: userAgent.trim().slice(0, 300) } : {}),
    };
    await this.storage.createSession(hashOpaqueToken(token), session);
    return { token, csrfToken, session };
  }

  private async issueEmailVerification(identity: WorkspaceEmailIdentityDocument, inviteToken?: unknown): Promise<void> {
    if (!this.emailVerification) return;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashOpaqueToken(token);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + WORKSPACE_EMAIL_VERIFICATION_TTL_MS);
    const reserved = await this.storage.beginEmailVerification({
      tokenHash,
      userId: identity.userId,
      emailCanonical: identity.emailCanonical,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }, {
      cooldownMs: WORKSPACE_EMAIL_RESEND_COOLDOWN_MS,
      windowMs: WORKSPACE_EMAIL_RESEND_WINDOW_MS,
      maxPerWindow: WORKSPACE_EMAIL_RESEND_MAX_PER_WINDOW,
    });
    if (reserved !== 'created') return;

    const verificationUrl = new URL(this.emailVerification.workspaceUrl);
    verificationUrl.pathname = `${verificationUrl.pathname.replace(/\/$/, '')}/verify-email`;
    verificationUrl.search = '';
    // Fragments never reach HTTP access logs or asset Referer headers. The
    // Workspace removes it from browser history before posting the token.
    const fragment = new URLSearchParams({ token });
    if (typeof inviteToken === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(inviteToken)) {
      fragment.set('continue', `/invite/${inviteToken}`);
    }
    verificationUrl.hash = fragment.toString();
    await this.emailVerification.sender.sendVerification({
      email: identity.email,
      verificationUrl: verificationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      idempotencyKey: `workspace-email-verification-${tokenHash}`,
    });
  }

  private invalidCredentials(message: string = 'Invalid username or one-time code.'): WorkspaceWebAuthError {
    return new WorkspaceWebAuthError('invalid_credentials', message);
  }
}

/**
 * The identity after its address here became its sign-in name. Shared by both
 * storages and by the one-time migration in sqlite-db, so the three can never
 * disagree about what happens to the outside email: it moves to the recovery
 * slot, keeping the confirmation it earned, unless a recovery address was
 * already set.
 */
export function adoptedIdentity(
  identity: WorkspaceEmailIdentityDocument,
  address: string,
  nowIso: string,
): WorkspaceEmailIdentityDocument {
  const outsideEmail = !isMailDomainAddress(identity.emailCanonical);
  const keepsRecovery = Boolean(identity.recoveryEmail);
  const wasVerified = workspaceEmailVerificationStatus(identity) !== 'pending';
  const adopted: WorkspaceEmailIdentityDocument = {
    ...identity,
    email: address,
    emailCanonical: address,
    verificationStatus: 'verified',
    emailVerifiedAt: identity.emailVerifiedAt ?? nowIso,
    updatedAt: nowIso,
  };
  delete adopted.preserveLegacyLoginUntilVerified;
  if (outsideEmail && !keepsRecovery) {
    adopted.recoveryEmail = identity.emailCanonical;
    if (wasVerified) {
      adopted.recoveryEmailVerifiedAt = identity.emailVerifiedAt ?? identity.verificationGrandfatheredAt ?? nowIso;
    } else {
      delete adopted.recoveryEmailVerifiedAt;
    }
  }
  return adopted;
}

/** In-memory parity implementation for route/service tests and no-SQLite dev. */
export class InMemoryWorkspaceWebAuthStorage implements WorkspaceWebAuthStorage {
  private readonly emailIdentities = new Map<string, WorkspaceEmailIdentityDocument>();
  private readonly emails = new Map<string, string>();
  private readonly emailVerifications = new Map<string, WorkspaceEmailVerificationDocument>();
  private readonly authLinks = new Map<string, WorkspaceAuthLinkDocument>();
  private readonly secondFactorChallenges = new Map<string, WorkspaceSecondFactorChallengeDocument>();
  private readonly enrollments = new Map<string, WorkspaceTotpEnrollmentDocument>();
  private readonly identities = new Map<string, WorkspaceTotpIdentityDocument>();
  private readonly usernames = new Map<string, string>();
  private readonly sessions = new Map<string, WorkspaceWebSessionDocument>();

  async getEmailIdentityByUserId(userId: string): Promise<WorkspaceEmailIdentityDocument | null> {
    const doc = this.emailIdentities.get(userId);
    return doc ? structuredClone(doc) : null;
  }
  async getEmailIdentityByEmail(emailCanonical: string): Promise<WorkspaceEmailIdentityDocument | null> {
    const userId = this.emails.get(emailCanonical);
    return userId ? this.getEmailIdentityByUserId(userId) : null;
  }
  async createEmailIdentity(
    doc: WorkspaceEmailIdentityDocument,
  ): Promise<'created' | 'email_taken' | 'user_has_identity'> {
    if (this.emailIdentities.has(doc.userId)) return 'user_has_identity';
    if (this.emails.has(doc.emailCanonical)) return 'email_taken';
    this.emailIdentities.set(doc.userId, structuredClone(doc));
    this.emails.set(doc.emailCanonical, doc.userId);
    return 'created';
  }
  async updateEmailPassword(userId: string, passwordHash: string): Promise<boolean> {
    const doc = this.emailIdentities.get(userId);
    if (!doc) return false;
    doc.passwordHash = passwordHash;
    doc.updatedAt = new Date().toISOString();
    return true;
  }
  async adoptSignInAddress(userId: string, address: string, nowIso: string): Promise<'adopted' | 'unchanged' | 'address_taken' | 'missing'> {
    const identity = this.emailIdentities.get(userId);
    if (!identity) return 'missing';
    if (identity.emailCanonical === address) return 'unchanged';
    const holder = this.emails.get(address);
    if (holder && holder !== userId) return 'address_taken';
    this.emails.delete(identity.emailCanonical);
    this.emailIdentities.set(userId, adoptedIdentity(identity, address, nowIso));
    this.emails.set(address, userId);
    return 'adopted';
  }
  async updateRecoveryEmail(
    userId: string,
    recovery: Pick<WorkspaceEmailIdentityDocument, 'recoveryEmail' | 'recoveryEmailVerifiedAt'>,
    nowIso: string,
  ): Promise<boolean> {
    const identity = this.emailIdentities.get(userId);
    if (!identity) return false;
    identity.recoveryEmail = recovery.recoveryEmail;
    identity.recoveryEmailVerifiedAt = recovery.recoveryEmailVerifiedAt;
    identity.updatedAt = nowIso;
    return true;
  }
  async saveAuthLink(doc: WorkspaceAuthLinkDocument, cooldownMs: number): Promise<'created' | 'rate_limited'> {
    const nowMs = Date.parse(doc.createdAt);
    for (const [hash, link] of this.authLinks) {
      if (Date.parse(link.expiresAt) <= nowMs) { this.authLinks.delete(hash); continue; }
      if (link.userId === doc.userId && link.purpose === doc.purpose) {
        if (nowMs - Date.parse(link.createdAt) < cooldownMs) return 'rate_limited';
        this.authLinks.delete(hash);
      }
    }
    this.authLinks.set(doc.tokenHash, structuredClone(doc));
    return 'created';
  }
  async consumeAuthLink(tokenHash: string, purpose: WorkspaceAuthLinkPurpose, nowIso: string): Promise<WorkspaceAuthLinkConsumption> {
    const link = this.authLinks.get(tokenHash);
    if (!link || link.purpose !== purpose) return { outcome: 'invalid' };
    this.authLinks.delete(tokenHash);
    if (Date.parse(link.expiresAt) <= Date.parse(nowIso)) return { outcome: 'expired' };
    return { outcome: 'consumed', link };
  }
  async updateEmailSecondFactor(
    userId: string,
    factor: Pick<WorkspaceEmailIdentityDocument, 'encryptedTotpSecret' | 'lastAcceptedStep' | 'recoveryCodeHashes'>,
  ): Promise<boolean> {
    const doc = this.emailIdentities.get(userId);
    if (!doc) return false;
    Object.assign(doc, factor, { updatedAt: new Date().toISOString() });
    return true;
  }
  async acceptEmailTotpStep(userId: string, step: number): Promise<boolean> {
    const doc = this.emailIdentities.get(userId);
    if (!doc || step <= (doc.lastAcceptedStep ?? -1)) return false;
    doc.lastAcceptedStep = step;
    doc.updatedAt = new Date().toISOString();
    return true;
  }
  async consumeEmailRecoveryCode(userId: string, encodedHash: string): Promise<boolean> {
    const doc = this.emailIdentities.get(userId);
    if (!doc?.recoveryCodeHashes?.includes(encodedHash)) return false;
    doc.recoveryCodeHashes = doc.recoveryCodeHashes.filter((hash) => hash !== encodedHash);
    doc.updatedAt = new Date().toISOString();
    return true;
  }
  async beginEmailVerification(
    verification: WorkspaceEmailVerificationDocument,
    limits: { cooldownMs: number; windowMs: number; maxPerWindow: number },
  ): Promise<'created' | 'rate_limited' | 'already_verified' | 'identity_changed'> {
    const identity = this.emailIdentities.get(verification.userId);
    if (!identity || identity.emailCanonical !== verification.emailCanonical) return 'identity_changed';
    if (workspaceEmailVerificationStatus(identity) === 'verified') return 'already_verified';
    const nowMs = Date.parse(verification.createdAt);
    const lastSentMs = Date.parse(identity.verificationLastSentAt ?? '');
    if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < limits.cooldownMs) return 'rate_limited';
    let windowStartedAt = identity.verificationWindowStartedAt;
    let sendsInWindow = identity.verificationSendsInWindow ?? 0;
    const windowMs = Date.parse(windowStartedAt ?? '');
    if (!Number.isFinite(windowMs) || nowMs - windowMs >= limits.windowMs) {
      windowStartedAt = verification.createdAt;
      sendsInWindow = 0;
    }
    if (sendsInWindow >= limits.maxPerWindow) return 'rate_limited';
    identity.verificationLastSentAt = verification.createdAt;
    identity.verificationWindowStartedAt = windowStartedAt;
    identity.verificationSendsInWindow = sendsInWindow + 1;
    identity.updatedAt = verification.createdAt;
    for (const [tokenHash, pending] of this.emailVerifications) {
      if (pending.userId === identity.userId || Date.parse(pending.expiresAt) <= nowMs) {
        this.emailVerifications.delete(tokenHash);
      }
    }
    this.emailVerifications.set(verification.tokenHash, structuredClone(verification));
    return 'created';
  }
  async consumeEmailVerification(
    tokenHash: string,
    nowIso: string,
  ): Promise<WorkspaceEmailVerificationConsumption> {
    const pending = this.emailVerifications.get(tokenHash);
    if (!pending) return { outcome: 'invalid' };
    if (Date.parse(pending.expiresAt) <= Date.parse(nowIso)) {
      this.emailVerifications.delete(tokenHash);
      return { outcome: 'expired' };
    }
    const identity = this.emailIdentities.get(pending.userId);
    if (!identity || identity.emailCanonical !== pending.emailCanonical
      || workspaceEmailVerificationStatus(identity) === 'verified') {
      this.emailVerifications.delete(tokenHash);
      return { outcome: 'invalid' };
    }
    identity.verificationStatus = 'verified';
    identity.emailVerifiedAt = nowIso;
    identity.preserveLegacyLoginUntilVerified = undefined;
    identity.updatedAt = nowIso;
    for (const [storedHash, verification] of this.emailVerifications) {
      if (verification.userId === identity.userId) this.emailVerifications.delete(storedHash);
    }
    return { outcome: 'verified', userId: identity.userId };
  }
  async saveSecondFactorChallenge(doc: WorkspaceSecondFactorChallengeDocument): Promise<void> {
    for (const [tokenHash, challenge] of this.secondFactorChallenges) {
      if (Date.parse(challenge.expiresAt) <= Date.parse(doc.createdAt)) this.secondFactorChallenges.delete(tokenHash);
    }
    this.secondFactorChallenges.set(doc.tokenHash, structuredClone(doc));
  }
  async getSecondFactorChallenge(tokenHash: string, nowIso: string): Promise<WorkspaceSecondFactorChallengeDocument | null> {
    const doc = this.secondFactorChallenges.get(tokenHash);
    if (!doc) return null;
    if (Date.parse(doc.expiresAt) <= Date.parse(nowIso)) {
      this.secondFactorChallenges.delete(tokenHash);
      return null;
    }
    return structuredClone(doc);
  }
  async deleteSecondFactorChallenge(tokenHash: string): Promise<void> {
    this.secondFactorChallenges.delete(tokenHash);
  }

  async saveEnrollment(doc: WorkspaceTotpEnrollmentDocument): Promise<void> {
    this.enrollments.set(doc.tokenHash, structuredClone(doc));
  }
  async getEnrollment(tokenHash: string): Promise<WorkspaceTotpEnrollmentDocument | null> {
    const doc = this.enrollments.get(tokenHash);
    return doc ? structuredClone(doc) : null;
  }
  async deleteEnrollment(tokenHash: string): Promise<void> { this.enrollments.delete(tokenHash); }
  async getIdentityByUserId(userId: string): Promise<WorkspaceTotpIdentityDocument | null> {
    const doc = this.identities.get(userId);
    return doc ? structuredClone(doc) : null;
  }
  async getIdentityByUsername(usernameCanonical: string): Promise<WorkspaceTotpIdentityDocument | null> {
    const userId = this.usernames.get(usernameCanonical);
    return userId ? this.getIdentityByUserId(userId) : null;
  }
  async createIdentity(doc: WorkspaceTotpIdentityDocument): Promise<'created' | 'username_taken' | 'user_has_identity'> {
    if (this.identities.has(doc.userId)) return 'user_has_identity';
    if (this.usernames.has(doc.usernameCanonical)) return 'username_taken';
    this.identities.set(doc.userId, structuredClone(doc));
    this.usernames.set(doc.usernameCanonical, doc.userId);
    return 'created';
  }
  async deleteIdentity(userId: string): Promise<void> {
    const doc = this.identities.get(userId);
    if (doc) this.usernames.delete(doc.usernameCanonical);
    this.identities.delete(userId);
  }
  async acceptTotpStep(userId: string, step: number): Promise<boolean> {
    const doc = this.identities.get(userId);
    if (!doc || step <= doc.lastAcceptedStep) return false;
    doc.lastAcceptedStep = step;
    doc.updatedAt = new Date().toISOString();
    return true;
  }
  async consumeRecoveryCode(userId: string, encodedHash: string): Promise<boolean> {
    const doc = this.identities.get(userId);
    if (!doc || !doc.recoveryCodeHashes.includes(encodedHash)) return false;
    doc.recoveryCodeHashes = doc.recoveryCodeHashes.filter((hash) => hash !== encodedHash);
    doc.updatedAt = new Date().toISOString();
    return true;
  }
  async createSession(tokenHash: string, doc: WorkspaceWebSessionDocument): Promise<void> {
    this.sessions.set(tokenHash, structuredClone(doc));
  }
  async getSession(tokenHash: string): Promise<WorkspaceWebSessionDocument | null> {
    const doc = this.sessions.get(tokenHash);
    return doc ? structuredClone(doc) : null;
  }
  async getSessionById(userId: string, sessionId: string): Promise<WorkspaceWebSessionDocument | null> {
    for (const doc of this.sessions.values()) {
      if (doc.userId === userId && doc.sessionId === sessionId) return structuredClone(doc);
    }
    return null;
  }
  async touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    const doc = this.sessions.get(tokenHash);
    if (doc) Object.assign(doc, { lastSeenAt, idleExpiresAt });
  }
  async revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    for (const doc of this.sessions.values()) {
      if (doc.userId === userId && doc.sessionId === sessionId && !doc.revokedAt) {
        doc.revokedAt = revokedAt;
        return true;
      }
    }
    return false;
  }
  async revokeAllSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number> {
    let count = 0;
    for (const doc of this.sessions.values()) {
      if (doc.userId === userId && doc.sessionId !== exceptSessionId && !doc.revokedAt) {
        doc.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }
  async listSessions(userId: string): Promise<WorkspaceWebSessionDocument[]> {
    return [...this.sessions.values()]
      .filter((doc) => doc.userId === userId && !doc.revokedAt)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((doc) => structuredClone(doc));
  }
}

export type WorkspaceWebAuthProfile = Pick<
  UserProfileDocument,
  'userId' | 'displayName' | 'telegram' | 'person'
>;
