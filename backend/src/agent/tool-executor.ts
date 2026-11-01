import {
  DeleteAgentThreadParams,
  DeleteAgentMessageParams,
  GetAgentMessagePolicyParams,
  ListAgentContactsParams,
  AddAgentContactParams,
  RemoveAgentContactParams,
  UpdateAgentContactNameParams,
  UpdateAgentMessagePolicyParams,
  ListAgentInboxParams,
  ReadAgentThreadParams,
  SendAgentMessageDelivery,
  ReplyAgentThreadDelivery,
  DeleteAgentThreadResult,
  DeleteAgentMessageResult,
  AgentMessagePolicySummary,
  AgentContactSummary,
  AgentInboxThreadSummary,
  AgentThreadMessageSummary,
  SaveMemoryHtmlParams,
  ReadMemoryHtmlParams,
  SaveSkillsHtmlParams,
  ReadSkillsHtmlParams,
  AgentMessageFileAttachment,
  UploadedFileMetadata,
  UploadedFileMediaKind,
} from '../types/tools.js';
import { normalizeAgentUsername } from '../utils/agent-username.js';
export const PATCH_TOOL_PAYLOAD_ENV = 'PATCH_TOOL_PAYLOAD_B64';
const DEFAULT_LIST_SESSIONS_LIMIT = 10;
const MAX_LIST_SESSIONS_LIMIT = 50;
const DEFAULT_OBSERVE_SESSION_HISTORY_LIMIT = 3;
const MAX_OBSERVE_SESSION_HISTORY_LIMIT = 10;
/**
 * Puts files on an agent's machine from signed URLs. Each one STREAMS to a
 * temporary file beside its destination — hashed and counted on the way —
 * and is renamed into place only once it is whole and checked (note #943: a
 * chat file has no size cap any more, and the machine has a fraction of the
 * memory a big one would need to sit in). A file the disk has no room for is
 * refused before a byte is fetched, with the numbers, so the turn can say
 * why rather than only that it failed.
 */
export const MATERIALIZE_SANDBOX_REMOTE_FILES_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const payload = JSON.parse(Buffer.from(process.env.${PATCH_TOOL_PAYLOAD_ENV} ?? '', 'base64').toString('utf8'));
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';

for (const file of payload.files) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  const tempPath = \`\${file.path}.tmp-\${process.pid}-\${Math.random().toString(36).slice(2, 10)}\`;

  try {
    if (typeof file.expectedSizeBytes === 'number' && typeof fs.statfsSync === 'function') {
      const disk = fs.statfsSync(path.dirname(file.path));
      const free = Number(disk.bavail) * Number(disk.bsize);
      if (file.expectedSizeBytes > free) {
        throw new Error(\`no room on this machine: the file is \${gb(file.expectedSizeBytes)} and the disk has \${gb(free)} free\`);
      }
    }
    const source = String(file.url).startsWith('file:')
      ? fs.createReadStream(fileURLToPath(file.url))
      : await (async () => {
          const response = await fetch(file.url);
          if (!response.ok || !response.body) {
            throw new Error(\`download returned HTTP \${response.status}\`);
          }
          return Readable.fromWeb(response.body);
        })();
    const hash = crypto.createHash('sha256');
    let received = 0;
    const tally = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(source, tally, fs.createWriteStream(tempPath));
    if (typeof file.expectedSizeBytes === 'number' && received !== file.expectedSizeBytes) {
      throw new Error(\`expected \${file.expectedSizeBytes} bytes but received \${received}\`);
    }

    if (typeof file.sha256 === 'string' && file.sha256) {
      if (hash.digest('hex') !== String(file.sha256).toLowerCase()) {
        throw new Error('sha256 mismatch');
      }
    }

    if (typeof file.mode === 'number') {
      fs.chmodSync(tempPath, file.mode);
    }
    fs.renameSync(tempPath, file.path);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

process.stdout.write(payload.successMessage ?? 'Files materialized successfully.\\n');
`;

/**
 * What happened to the deleted agent's machine.
 * - `destroyed`: the Fly machine, its volume and its app are gone.
 * - `none`: the agent never had one (a failed or half-finished provision).
 * - `unmanaged`: a legacy non-Fly machine we do not own the teardown path for.
 *   Reported rather than silently treated as `none`, so nobody is told a server
 *   they are still being billed for was destroyed.
 * - `left`: deliberately left standing in the workplace's own cloud account —
 *   a deleted workplace's agents (owner, 2026-09-22): their machines are the
 *   customer's, and removing them there is the customer's call.
 */
export type AgentMachineDisposal = 'destroyed' | 'none' | 'unmanaged' | 'left';

/** Result of the setup agent's `delete_agent` tool. */
export interface AgentDeletionResult {
  agentId: string;
  name: string;
  cli: 'codex' | 'claude' | 'opencode';
  machine: AgentMachineDisposal;
  /** How many agents the user has left. */
  remaining: number;
}

function formatAgentInboxLine(thread: AgentInboxThreadSummary): string {
  const parts = [`- @${thread.username}`];
  if (thread.contactName) {
    parts.push(`name=${JSON.stringify(thread.contactName)}`);
  }
  parts.push(`last_direction=${thread.lastMessageDirection}`);
  const incomingCount = thread.incomingThreadCount ?? 0;
  const outgoingCount = thread.outgoingThreadCount ?? 0;
  if (incomingCount + outgoingCount > 1) {
    parts.push(`threads=${incomingCount} incoming/${outgoingCount} outgoing`);
  }
  if (typeof thread.messageCount === 'number' && thread.messageCount > 0) {
    parts.push(`message_count=${thread.messageCount}`);
  }
  if (thread.updatedAt) {
    parts.push(`updated=${thread.updatedAt}`);
  }
  const lastMessage = thread.lastMessageBody ?? thread.lastMessagePreview;
  if (lastMessage) {
    parts.push(`last_message=${JSON.stringify(lastMessage)}`);
  }
  if (thread.lastMessageFiles?.length) {
    parts.push(`files=${JSON.stringify(formatAgentMessageFileSummary(thread.lastMessageFiles))}`);
  }
  return parts.join(' | ');
}

function formatAgentThreadMessageLine(message: AgentThreadMessageSummary): string {
  const parts = [
    `- message_id=${message.messageId}`,
    `direction=${message.direction}`,
    `from=@${message.senderUsername}`,
    `to=@${message.recipientUsername}`,
  ];
  if (message.createdAt) {
    parts.push(`at=${message.createdAt}`);
  }
  parts.push(`message=${JSON.stringify(message.body)}`);
  if (message.files?.length) {
    parts.push(`files=${JSON.stringify(formatAgentMessageFileSummary(message.files))}`);
  }
  return parts.join(' | ');
}

function formatAgentThreadMessagePreviewLine(message: AgentThreadMessageSummary): string {
  const parts = [
    `- message_id=${message.messageId}`,
    `direction=${message.direction}`,
    `from=@${message.senderUsername}`,
    `to=@${message.recipientUsername}`,
  ];
  if (message.createdAt) {
    parts.push(`at=${message.createdAt}`);
  }
  parts.push(`message=${JSON.stringify(message.body)}`);
  if (message.files?.length) {
    parts.push(`files=${JSON.stringify(formatAgentMessageFileSummary(message.files))}`);
  }
  return parts.join(' | ');
}

function formatAgentMessageFileSummary(files: AgentMessageFileAttachment[]): string[] {
  return files.map((file) => {
    const label = file.displayName || file.fileName;
    return `${label} (${file.contentType}, ${file.sizeBytes} bytes)`;
  });
}

function formatAgentContactLine(contact: AgentContactSummary): string {
  const parts = [`- @${contact.username}`];
  if (contact.name) {
    parts.push(`name=${JSON.stringify(contact.name)}`);
  }
  return parts.join(' | ');
}

function formatAgentContactResult(contact: AgentContactSummary): string[] {
  return [
    `Username: @${contact.username}.`,
    contact.name ? `Name: ${contact.name}.` : 'Name: not set.',
  ];
}

function formatAgentMessagePolicySummary(policy: AgentMessagePolicySummary): string[] {
  const contactNames = policy.contactNames ?? {};
  return [
    `Inbound messages: ${policy.inboundEnabled ? 'enabled' : 'disabled'}.`,
    `Unknown senders: ${policy.allowUnknownSenders ? 'allowed' : 'approved contacts only'}.`,
    `Contacts: ${policy.contacts.length > 0 ? policy.contacts.map((username) => (
      contactNames[username] ? `${contactNames[username]} (@${username})` : `@${username}`
    )).join(', ') : 'none'}.`,
    `Explicit allowlist: ${policy.allowedUsernames.length > 0 ? policy.allowedUsernames.map((username) => `@${username}`).join(', ') : 'none'}.`,
    `Blocked: ${policy.blockedUsernames.length > 0 ? policy.blockedUsernames.map((username) => `@${username}`).join(', ') : 'none'}.`,
  ];
}

function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*[a-z0-9_-]+=[^;]+)*$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function inferGeneratedMediaExtension(contentType: string, mediaKind: UploadedFileMediaKind): string {
  const normalizedContentType = contentType.split(';', 1)[0].trim().toLowerCase();
  switch (normalizedContentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
      return 'png';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    case 'video/ogg':
      return 'ogv';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/ogg':
      return 'oga';
    case 'audio/opus':
      return 'opus';
    case 'audio/aiff':
      return 'aiff';
    case 'audio/basic':
      return 'mulaw';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      return mediaKind === 'video' ? 'mp4' : mediaKind === 'audio' ? 'wav' : 'png';
  }
}

function parseBase64DataUrl(value: string): { contentType: string; data: Buffer } | null {
  if (!value.startsWith('data:')) {
    return null;
  }

  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

  const metadata = value.slice(5, commaIndex);
  const metadataParts = metadata.split(';').map(part => part.trim()).filter(Boolean);
  const contentType = normalizeContentType(metadataParts[0]) ?? 'application/octet-stream';
  const isBase64 = metadataParts.slice(1).some(part => part.toLowerCase() === 'base64');
  if (!isBase64) {
    return null;
  }

  const encoded = value.slice(commaIndex + 1).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return null;
  }

  return {
    contentType,
    data: Buffer.from(encoded, 'base64'),
  };
}
