/**
 * Telegram → machine attachment delivery for CLI-harness turns.
 *
 * When the user sends files (photos, documents, archives) to a connected
 * agent, the bytes are already persisted to media storage on intake; this
 * module stages them onto the agent's OWN machine — `~/inbox/<date>/<name>` —
 * before the CLI turn starts, and returns a short prompt note with the
 * absolute paths. The CLI's own tools take it from there (Claude Code and
 * Codex both open images natively), so the backend stays free of media AI.
 *
 * Transport is the same machine-pull used for platform-loop attachments: a
 * tiny node script runs on the machine and fetches short-lived signed URLs
 * (never Telegram file URLs, which would put the bot token in a command
 * line on the user's machine).
 *
 * Staging never throws: a failed download degrades to a prompt note telling
 * the agent which files did not arrive, so the turn itself always runs.
 */

import { posix as pathPosix } from 'node:path';
import type { WorkspaceRuntimeClient } from '../services/sandbox-client.js';
import type { MediaStorage } from '../services/media-storage.js';
import type { AttachmentRecord } from '../types/tools.js';
import {
  MATERIALIZE_SANDBOX_REMOTE_FILES_SCRIPT,
  PATCH_TOOL_PAYLOAD_ENV,
} from './tool-executor.js';
import { quoteShellArg } from '../utils/shell-quote.js';

const INBOX_DIR_NAME = 'inbox';
const STAGE_TIMEOUT_MS = 120_000;
const MAX_INBOX_FILE_NAME_LENGTH = 80;
const HEREDOC_DELIMITER = 'HARNESS_ATTACHMENTS_EOF';
/**
 * Files fetched per command on the machine. The payload rides the command
 * line as one environment value, and Linux refuses any single argument over
 * 128 KiB — a signed URL is most of a kilobyte, so a message of a hundred
 * files (note #672 lets a chat message carry any number) would fail to stage
 * as one. Each batch also gets the whole timeout to itself.
 */
const STAGE_BATCH_FILES = 20;

/**
 * The attachments a harness turn should deliver to the machine. `model_input`
 * is a legacy stored value from the removed vision path; voice notes
 * (`user_visible`) are excluded — they reach the model as transcribed text.
 */
export function getStageableHarnessAttachments(
  attachments: AttachmentRecord[] | undefined,
): AttachmentRecord[] {
  return (attachments ?? []).filter(
    (attachment) => attachment.use === 'sandbox_input' || attachment.use === 'model_input',
  );
}

/** `report v2.csv` → `report-v2.csv`; anything hostile or empty → fallback. */
function sanitizeInboxFileName(attachment: AttachmentRecord): string {
  const candidate = pathPosix.basename(
    (attachment.displayName || attachment.fileName || '').trim(),
  );
  const cleaned = candidate
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(0, MAX_INBOX_FILE_NAME_LENGTH);
  return cleaned || `${attachment.fileId}.bin`;
}

/** Batch-level dedupe: `photo.jpg`, `photo-2.jpg`, … (same-name resends across batches intentionally overwrite). */
function dedupeInboxFileNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) {
      return name;
    }
    const extension = pathPosix.extname(name);
    return `${name.slice(0, name.length - extension.length)}-${count}${extension}`;
  });
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} kB`;
  }
  return `${bytes} B`;
}

function buildMaterializeCommand(files: Array<{
  path: string;
  url: string;
  expectedSizeBytes?: number;
  sha256?: string;
}>): string {
  const payloadBase64 = Buffer.from(
    JSON.stringify({ files, successMessage: 'ok\n' }),
    'utf8',
  ).toString('base64');
  return [
    `${PATCH_TOOL_PAYLOAD_ENV}='${payloadBase64}' node --input-type=module <<'${HEREDOC_DELIMITER}'`,
    MATERIALIZE_SANDBOX_REMOTE_FILES_SCRIPT,
    HEREDOC_DELIMITER,
  ].join('\n');
}

export interface StageHarnessAttachmentsArgs {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  sshUser: string;
  /** The harness user's home directory; the inbox lives directly under it. */
  homeDir: string;
  /** For log lines only. */
  sessionId: string;
  /** Pre-filtered via {@link getStageableHarnessAttachments}. */
  attachments: AttachmentRecord[];
  mediaStorage?: MediaStorage;
  now?: Date;
}

/**
 * Deliver the attachments to the machine and describe the result for the CLI
 * prompt. Returns null only for an empty attachment list.
 */
export async function stageHarnessAttachments(
  args: StageHarnessAttachmentsArgs,
): Promise<string | null> {
  const { attachments, sessionId } = args;
  if (attachments.length === 0) {
    return null;
  }

  const dateDir = (args.now ?? new Date()).toISOString().slice(0, 10);
  const inboxDir = pathPosix.join(args.homeDir, INBOX_DIR_NAME, dateDir);
  const names = dedupeInboxFileNames(attachments.map(sanitizeInboxFileName));

  const staged: Array<{ attachment: AttachmentRecord; path: string; url: string }> = [];
  const failed: Array<{ attachment: AttachmentRecord; name: string }> = [];

  await Promise.all(attachments.map(async (attachment, index) => {
    const name = names[index];
    // A fresh signed URL first — the one on the record may have expired while
    // the message sat in a queue. Fall back to the recorded URL.
    let url: string | undefined;
    if (args.mediaStorage) {
      try {
        url = (await args.mediaStorage.createReadAccess({
          storagePath: attachment.storagePath,
        })).url;
      } catch (error) {
        console.warn(
          `[harness-attachments] [${sessionId}] Failed to refresh read URL for ${attachment.fileId}:`,
          error,
        );
      }
    }
    url ??= attachment.url?.trim() || undefined;
    if (!url) {
      failed.push({ attachment, name });
      return;
    }
    staged.push({ attachment, path: pathPosix.join(inboxDir, name), url });
  }));

  // Batches run one after another, in order: a batch that fails marks only
  // its own files undelivered, and the rest still arrive.
  const delivered: typeof staged = [];
  for (let at = 0; at < staged.length; at += STAGE_BATCH_FILES) {
    const batch = staged.slice(at, at + STAGE_BATCH_FILES);
    const command = buildMaterializeCommand(batch.map((file) => ({
      path: file.path,
      url: file.url,
      ...(file.attachment.sizeBytes > 0 ? { expectedSizeBytes: file.attachment.sizeBytes } : {}),
      ...(file.attachment.sha256 ? { sha256: file.attachment.sha256 } : {}),
    })));
    try {
      const result = await args.sandboxClient.execSync(
        args.sandboxId,
        command,
        args.homeDir,
        { timeoutMs: STAGE_TIMEOUT_MS, sshUser: args.sshUser },
      );
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          (result.stderr || result.stdout || `exit_code: ${result.exitCode}`).trim().slice(-400),
        );
      }
      delivered.push(...batch);
    } catch (error) {
      console.warn(
        `[harness-attachments] [${sessionId}] Failed to stage ${batch.length} attachment(s) on ${args.sandboxId}:`,
        error,
      );
      for (const file of batch) {
        failed.push({ attachment: file.attachment, name: pathPosix.basename(file.path) });
      }
    }
  }

  const lines: string[] = [];
  if (delivered.length > 0) {
    lines.push('The user attached files with this message; they are saved on this machine:');
    for (const file of delivered) {
      const size = file.attachment.sizeBytes > 0
        ? ` (${formatFileSize(file.attachment.sizeBytes)})`
        : '';
      lines.push(`- ${file.path}${size}`);
    }
  }
  if (failed.length > 0) {
    lines.push(
      `The user also attached ${failed.map((file) => file.name).join(', ')}, but the ${failed.length === 1 ? 'file' : 'files'} could not be delivered to this machine — tell the user and ask them to re-send.`,
    );
  }
  return `[${lines.join('\n')}]`;
}

// ── Outbound: agent → user (the ATTACH: convention) ─────────────────────────

/**
 * Telegram bots may upload files up to 50 MB; leave margin for the multipart
 * envelope.
 */
export const OUTBOUND_ATTACHMENT_MAX_BYTES = 45 * 1024 * 1024;
const OUTBOUND_FETCH_TIMEOUT_MS = 120_000;

/** Line-anchored `ATTACH: /absolute/path` (or `~/path`) in a CLI reply. */
const OUTBOUND_ATTACH_LINE = /^[ \t]*ATTACH:[ \t]*(\S[^\n]*?)[ \t]*$/gm;

/**
 * Split a CLI reply into the text to deliver and the machine paths the agent
 * asked to send (the `ATTACH:` convention taught in the identity block).
 * Only line-anchored markers count — prose that mentions "ATTACH:" mid-line
 * is left alone.
 */
export function extractOutboundAttachments(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const stripped = text.replace(OUTBOUND_ATTACH_LINE, (_line, rawPath: string) => {
    paths.push(rawPath);
    return '';
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, paths };
}

export type OutboundAttachmentFetch =
  | { ok: true; fileName: string; sizeBytes: number; content: Uint8Array }
  | { ok: false; fileName: string; reason: string };

/**
 * Pull one requested file off the agent's machine (size-gated, base64 over
 * the SSH exec channel). Never throws — a failure comes back as a reason the
 * caller folds into the reply text, so drops are always visible to the user.
 */
export async function fetchOutboundAttachment(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  rawPath: string,
  options: { sshUser?: string; homeDir?: string; maxBytes?: number } = {},
): Promise<OutboundAttachmentFetch> {
  const maxBytes = options.maxBytes ?? OUTBOUND_ATTACHMENT_MAX_BYTES;
  const path = options.homeDir && rawPath.startsWith('~/')
    ? `${options.homeDir}/${rawPath.slice(2)}`
    : rawPath;
  const fileName = pathPosix.basename(path) || 'file.bin';
  if (!path.startsWith('/')) {
    return { ok: false, fileName, reason: 'the path must be absolute (or start with ~/)' };
  }
  try {
    const stat = await sandboxClient.execSync(
      sandboxId,
      `wc -c < ${quoteShellArg(path)}`,
      undefined,
      { timeoutMs: OUTBOUND_FETCH_TIMEOUT_MS, sshUser: options.sshUser },
    );
    const sizeBytes = Number.parseInt(stat.stdout.trim(), 10);
    if (stat.exitCode !== 0 || !Number.isFinite(sizeBytes)) {
      return { ok: false, fileName, reason: 'the file was not found on the machine' };
    }
    if (sizeBytes > maxBytes) {
      return { ok: false, fileName, reason: `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB Telegram limit` };
    }
    const fetched = await sandboxClient.execSync(
      sandboxId,
      `base64 < ${quoteShellArg(path)} | tr -d '\n'`,
      undefined,
      { timeoutMs: OUTBOUND_FETCH_TIMEOUT_MS, sshUser: options.sshUser },
    );
    if (fetched.exitCode !== 0) {
      return { ok: false, fileName, reason: 'the file could not be read' };
    }
    const content = new Uint8Array(Buffer.from(fetched.stdout.trim(), 'base64'));
    if (content.byteLength === 0 && sizeBytes > 0) {
      return { ok: false, fileName, reason: 'the file could not be read' };
    }
    return { ok: true, fileName, sizeBytes: content.byteLength, content };
  } catch (error) {
    console.warn(`[harness-attachments] Outbound fetch failed for ${path} on ${sandboxId}:`, error);
    return { ok: false, fileName, reason: 'the machine could not be reached' };
  }
}
