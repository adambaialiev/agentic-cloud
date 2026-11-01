import { randomBytes } from 'node:crypto';
import type { WorkspaceMailApproval } from '../shared/workspace-mail.js';
import { MailOutboxError, type MailExtras, type MailFileUpload, type MailOutboxService, type MailSendPreview, type SentByAgent } from './mail-outbox.js';
import { MailSendError } from './mail-sender.js';
import type { MailApprovalDocument, MailApprovalStorage } from './mail-approval-storage.js';

export type MailApprovalDecision = 'approve' | 'reject';
export const MAIL_APPROVAL_SEND_STALE_MS = 5 * 60_000;

/** What the chat may see — never the owner id or the provider retry key. */
export function visibleMailApproval(doc: MailApprovalDocument): WorkspaceMailApproval {
  return {
    id: doc.id,
    kind: doc.kind,
    from: doc.from,
    to: doc.to,
    ...(doc.cc?.length ? { cc: doc.cc } : {}),
    subject: doc.subject,
    text: doc.text,
    // By name and size — never where they are kept.
    ...(doc.files?.length
      ? { attachments: doc.files.map((file) => ({ fileName: file.fileName, size: file.size, contentType: file.contentType })) }
      : {}),
    requestedBy: doc.requestedBy,
    status: doc.status,
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
    ...(doc.sentMessageId ? { sentMessageId: doc.sentMessageId } : {}),
    ...(doc.error ? { error: doc.error } : {}),
  };
}

function failureWords(error: unknown, kind: MailApprovalDocument['kind']): string {
  const noun = kind === 'reply' ? 'reply' : kind === 'forward' ? 'forward' : 'message';
  if (error instanceof MailOutboxError) return error.message;
  if (error instanceof MailSendError) return `The ${noun} could not be sent. Try again in a moment.`;
  return `The ${noun} could not be sent.`;
}

/** Who asked, and from where — the part of a request that is not the mail. */
interface MailRequester {
  userId: string;
  agentId: string;
  requestedBy: string;
  orgId?: string;
  senderName?: string;
}

/**
 * The one release gate for agent-authored mail. Creating a request validates
 * the immutable preview but sends nothing; approving claims it atomically and
 * is the only call here that reaches MailOutboxService.
 */
export class MailApprovalService {
  private readonly now: () => Date;
  constructor(
    private readonly storage: MailApprovalStorage,
    private readonly outbox: MailOutboxService,
    now: () => Date = () => new Date(),
  ) { this.now = now; }

  /** A deploy can cut the process between provider and outcome writes. The
   * stable outbound id makes retry safe, so a stale in-flight state reopens. */
  private async recovered(doc: MailApprovalDocument): Promise<MailApprovalDocument> {
    if (doc.status !== 'sending' || !doc.sendingAt) return doc;
    const started = new Date(doc.sendingAt).getTime();
    if (!Number.isFinite(started) || this.now().getTime() - started < MAIL_APPROVAL_SEND_STALE_MS) return doc;
    return await this.storage.retry(
      doc.userId,
      doc.id,
      'The last send attempt was interrupted. Review it and try again.',
    ) ?? doc;
  }

  /**
   * Record a request, with its files KEPT (slice 12). Everything is checked
   * first — the preview is the send's own validation, ceilings included — so
   * nothing is stored for a request that could never go; then the agent's
   * files are staged under the id the message will have; then the request is
   * written. A request that cannot be written takes its files with it.
   */
  private async record(
    args: MailRequester & { files?: MailFileUpload[] },
    kind: MailApprovalDocument['kind'],
    preview: MailSendPreview,
    carried: MailApprovalDocument['files'],
    extra: Partial<MailApprovalDocument>,
  ): Promise<MailApprovalDocument> {
    const outboundId = `mm_${randomBytes(9).toString('hex')}`;
    const staged = await this.outbox.stageFiles(args.userId, outboundId, args.files ?? []);
    const files = [...(carried ?? []), ...staged];
    try {
      return await this.storage.create({
        id: `ma_${randomBytes(9).toString('hex')}`,
        outboundId,
        userId: args.userId,
        agentId: args.agentId,
        ...(args.orgId ? { orgId: args.orgId } : {}),
        ...(args.senderName ? { senderName: args.senderName } : {}),
        kind,
        from: { address: preview.from, ...(args.senderName ? { name: args.senderName } : {}) },
        to: preview.to,
        ...(preview.cc.length ? { cc: preview.cc } : {}),
        subject: preview.subject,
        text: preview.text,
        ...(files.length ? { files } : {}),
        requestedBy: args.requestedBy,
        status: 'pending',
        createdAt: this.now().toISOString(),
        ...extra,
      });
    } catch (error) {
      if (staged.length) await this.outbox.dropStaged(args.userId, outboundId);
      throw error;
    }
  }

  async requestSend(args: MailRequester & MailExtras & {
    to: unknown;
    subject: unknown;
    text: string;
    files?: MailFileUpload[];
  }): Promise<MailApprovalDocument> {
    const preview = await this.outbox.previewSend(args);
    return this.record(args, 'send', preview, [], {});
  }

  async requestReply(args: MailRequester & MailExtras & {
    messageId: string;
    text: string;
    files?: MailFileUpload[];
  }): Promise<MailApprovalDocument> {
    const preview = await this.outbox.previewReply(args);
    return this.record(args, 'reply', preview, [], { replyToMessageId: args.messageId });
  }

  /** Forward a letter (slice 12). `carry` names which of its files go —
   *  absent, all of them — and they are recorded here, by the letter's own
   *  records, so the card lists exactly what will leave. */
  async requestForward(args: MailRequester & MailExtras & {
    messageId: string;
    to: unknown;
    text: string;
    carry?: unknown;
    files?: MailFileUpload[];
  }): Promise<MailApprovalDocument> {
    const preview = await this.outbox.previewForward(args);
    return this.record(args, 'forward', preview, preview.carried, {
      forwardOfMessageId: args.messageId,
      wrote: String(args.text ?? '').trim(),
    });
  }

  async get(userId: string, id: string): Promise<WorkspaceMailApproval | null> {
    const doc = await this.storage.get(userId, id);
    return doc ? visibleMailApproval(await this.recovered(doc)) : null;
  }

  async getMany(userId: string, ids: string[]): Promise<Map<string, WorkspaceMailApproval>> {
    const docs = await this.storage.getMany(userId, ids);
    const recovered = await Promise.all(docs.map((doc) => this.recovered(doc)));
    return new Map(recovered.map((doc) => [doc.id, visibleMailApproval(doc)]));
  }

  /** A request whose card could not be placed is not a hidden approval —
   *  and the files it kept for itself go with it. */
  async withdraw(userId: string, id: string): Promise<void> {
    const doc = await this.storage.get(userId, id);
    await this.storage.removePending(userId, id);
    if (doc?.status === 'pending' && doc.files?.length) await this.outbox.dropStaged(userId, doc.outboundId);
  }

  async decide(args: {
    userId: string;
    id: string;
    decision: MailApprovalDecision;
  }): Promise<WorkspaceMailApproval | null> {
    const current = await this.storage.get(args.userId, args.id);
    if (!current) return null;
    if (current.status !== 'pending') return visibleMailApproval(current);
    const at = this.now().toISOString();
    if (args.decision === 'reject') {
      const rejected = await this.storage.reject(args.userId, args.id, at);
      // Nothing is leaving, so the files kept for it go. Only this request's
      // own — a forwarded letter's files are that letter's, under its prefix.
      if (rejected?.files?.length) await this.outbox.dropStaged(args.userId, rejected.outboundId);
      const latest = rejected ?? await this.storage.get(args.userId, args.id);
      return latest ? visibleMailApproval(latest) : null;
    }

    const claimed = await this.storage.claim(args.userId, args.id, at);
    if (!claimed) {
      const latest = await this.storage.get(args.userId, args.id);
      return latest ? visibleMailApproval(latest) : null;
    }
    try {
      const sentBy: SentByAgent = {
        agentId: claimed.agentId,
        ...(claimed.requestedBy ? { name: claimed.requestedBy } : {}),
      };
      // Exactly what the card showed: the same Cc and the same kept files,
      // under the same outbound id — see `idempotencyKey` in mail-sender.ts.
      const common = {
        userId: claimed.userId,
        ...(claimed.senderName ? { senderName: claimed.senderName } : {}),
        sentBy,
        outboundId: claimed.outboundId,
        cc: (claimed.cc ?? []).map((party) => party.address),
        staged: claimed.files ?? [],
      };
      const sent = claimed.kind === 'reply'
        ? await this.outbox.reply({ ...common, messageId: claimed.replyToMessageId!, text: claimed.text })
        : claimed.kind === 'forward'
          ? await this.outbox.forward({
            ...common, messageId: claimed.forwardOfMessageId!, to: claimed.to.address, text: claimed.wrote ?? '',
          })
          : await this.outbox.send({ ...common, to: claimed.to.address, subject: claimed.subject, text: claimed.text });
      const completed = await this.storage.complete(args.userId, args.id, this.now().toISOString(), sent.id)
        ?? await this.storage.get(args.userId, args.id);
      return completed ? visibleMailApproval(completed) : null;
    } catch (error) {
      await this.storage.retry(args.userId, args.id, failureWords(error, claimed.kind));
      throw error;
    }
  }
}
