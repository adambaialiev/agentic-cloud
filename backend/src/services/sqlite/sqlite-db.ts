import { adoptedIdentity, type WorkspaceEmailIdentityDocument } from '../workspace-web-auth.js';
import { ensureMailSearchIndex } from './sqlite-mail-search.js';
import { ensureMailRepliesFiled, ensureMailThreads } from './sqlite-mail-threads.js';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { Timestamp } from '../../types/timestamp.js';

export type SqliteDb = Database;

/**
 * One SQLite file holds the whole product. Documents stay documents: every
 * table is (key columns, doc JSON). `Timestamp`s and `Date`s inside documents
 * are encoded as tagged markers so reads return the exact types callers
 * already expect.
 *
 * The backend is a single Node process, so better-sqlite3's synchronous API
 * gives us real synchronous transactions.
 */
const SCHEMA = `
-- Direct messages between people are NOT stored here (note #608): their text
-- lives on each workplace's own messaging machine. The platform keeps one bare
-- number per person — how many are unread — so Home's badge never wakes it.
CREATE TABLE IF NOT EXISTS direct_message_unread (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id)
);

-- A private copy's licence (note #814): the one an admin pasted, the
-- highest head count, and each change of state. Only a copy writes here.
CREATE TABLE IF NOT EXISTS copy_licence (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

-- Email set up after the install (note #946): the provider (keys encrypted),
-- the receiver the Workspace made, the last check. Only a copy writes here.
CREATE TABLE IF NOT EXISTS copy_mail_setup (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- A copy's own settings for the daily pulse (note #1057): its copyId and
-- signing key (the private half never leaves the copy), the contact person,
-- the off switch, and the last pulse exactly as sent. Only a copy writes here.
CREATE TABLE IF NOT EXISTS copy_settings (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- The public half of each copy's pulse key, kept the first time its copyId
-- reached us (note #1057). Only our own platform writes here.
CREATE TABLE IF NOT EXISTS copy_pulse_keys (
  copy_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

-- The private copies' daily pulses, on our side (notes #1057, #1058): each
-- copy's newest pulse, the last pulse of each UTC day for its history, and
-- the alert sweep's ledger of what it has already said about which copy.
-- Counts and a contact person only; the copy's signing key is kept elsewhere.
CREATE TABLE IF NOT EXISTS copy_pulses (
  copy_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS copy_pulse_days (
  copy_id TEXT NOT NULL,
  day TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (copy_id, day)
);
CREATE TABLE IF NOT EXISTS copy_pulse_alerts (
  copy_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  PRIMARY KEY (copy_id, condition)
);

-- Outreach (note #1089): the owner's target companies, one row each, every
-- touch with each (letters sent from the screen, replies that arrived, notes,
-- state changes, an install), and the words the last import brought (the
-- template and the follow-ups from note #799). Per person; only the platform
-- operator's account ever writes here.
CREATE TABLE IF NOT EXISTS outreach_targets (
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS outreach_touches (
  user_id TEXT NOT NULL,
  touch_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  at TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, touch_id)
);
CREATE INDEX IF NOT EXISTS outreach_touches_by_target ON outreach_touches (user_id, target_id, at);
CREATE TABLE IF NOT EXISTS outreach_words (
  user_id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drive_items (
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (org_id, item_id)
);
-- Work radio (note #712): one station for the whole platform, so no org key.
-- The tracks are rows; radio_station holds two small documents, the recent
-- airings and the make attempts the daily spending cap counts.
CREATE TABLE IF NOT EXISTS radio_tracks (
  track_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS radio_station (
  doc_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- Browser login is another door into the SAME user document. The rotating
-- secret and recovery-code hashes live on the identity; opaque session and
-- enrollment values are stored only as SHA-256 hashes, never as bearer
-- credentials. Dedicated columns carry uniqueness and lookup constraints,
-- while the JSON document keeps the service/storage boundary explicit.
CREATE TABLE IF NOT EXISTS workspace_totp_enrollments (
  token_hash TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_totp_identities (
  user_id TEXT PRIMARY KEY,
  username_canonical TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL
);
-- Email and a salted scrypt password hash are the current browser door. The
-- older TOTP tables stay during migration so an owner who has not linked
-- email yet is never locked out; after linking, that TOTP becomes an optional
-- second factor on the email identity.
CREATE TABLE IF NOT EXISTS workspace_email_identities (
  user_id TEXT PRIMARY KEY,
  email_canonical TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  email_canonical TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_email_verifications_by_expiry
  ON workspace_email_verifications (expires_at);
-- One-use links the sign-in door sends out: a password reset, or the
-- confirmation of a recovery address. One live link per person and purpose;
-- only the bearer's hash is ever stored.
CREATE TABLE IF NOT EXISTS workspace_auth_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_auth_links_by_purpose
  ON workspace_auth_links (user_id, purpose);
-- Each person's own address on the mail domain (note #509) — the name they
-- choose when they sign up, which IS their account here. Both columns carry a
-- uniqueness rule the service depends on: one name is one person's, and one
-- person holds one name. A row is never deleted once its account exists: an
-- address handed to a second person would collect the first person's mail.
CREATE TABLE IF NOT EXISTS workspace_mailboxes (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL
);
-- Mail that arrived at those addresses (note #509, slice 2). The seq column
-- is the list's order and its paging cursor: two messages can share a
-- millisecond, so the clock alone cannot page. The partial unique index is
-- what makes a redelivered message land as the same row rather than twice --
-- a sending server that never saw our answer will send it again.
CREATE TABLE IF NOT EXISTS workspace_mail_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  message_id TEXT,
  received_at TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'in',
  answers TEXT,
  thread TEXT,
  refs TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_mail_messages_by_user
  ON workspace_mail_messages (user_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_mail_messages_by_address_message
  ON workspace_mail_messages (address, message_id) WHERE message_id IS NOT NULL;
-- An agent may draft mail, but only its owner can release it. The request is
-- separate from either chat store so the same decision path serves room
-- agents and the Workspace Agent, and status is a compare-and-set gate
-- around the provider call rather than presentation state in a chat row.
CREATE TABLE IF NOT EXISTS workspace_mail_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_mail_approvals_by_user
  ON workspace_mail_approvals (user_id, created_at DESC);
-- Note #1090: the Chief of Staff's draft of a direct message to a teammate,
-- waiting on the person's tap. The words sit in doc ONLY while it waits:
-- every decision (sent, not sent, expired) rewrites doc without them, so a
-- decided row holds a status, the teammate's id and name, and two times.
-- The message itself lives on the workplace's messaging machine (note #608).
CREATE TABLE IF NOT EXISTS workspace_message_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
-- Senders whose pictures a person has asked to have loaded (note #509, slice
-- 10). A row is one person's decision about one address and holds nothing
-- else: no letter, no words, nothing a stranger wrote. Per sender and never
-- general, so there is no row here that could mean "load every picture".
CREATE TABLE IF NOT EXISTS workspace_mail_image_senders (
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, address)
);
-- Senders a person has BLOCKED (note #509, slice 13): the same shape, the
-- opposite decision. A letter from one of them lands in Spam on the way in
-- and wakes nobody; the letter itself is still stored whole. added_by names
-- the agent that asked, when one did, for the reason a move names it.
CREATE TABLE IF NOT EXISTS workspace_mail_blocked_senders (
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (user_id, address)
);
CREATE TABLE IF NOT EXISTS workspace_second_factor_challenges (
  token_hash TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_web_sessions (
  session_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_web_sessions_by_user
  ON workspace_web_sessions (user_id);
CREATE TABLE IF NOT EXISTS workspace_notifications (
  notification_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc TEXT NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS workspace_notifications_by_user_created
  ON workspace_notifications (user_id, created_at DESC);
-- Browser push subscriptions (encrypted endpoints) were retired by note #477.
-- The rows were capabilities to alert a browser; nothing sends to them any
-- more, so an installation that still holds the table loses it on boot.
DROP TABLE IF EXISTS workspace_push_subscriptions;
CREATE TABLE IF NOT EXISTS usernames (
  username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE TABLE IF NOT EXISTS session_messages (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_chat_messages (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id, seq)
);
CREATE TABLE IF NOT EXISTS secrets (
  user_id TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, secret_id)
);
CREATE TABLE IF NOT EXISTS platform_credentials (
  credential_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_turns (
  doc_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- Owner chat messages caught in the steering queue by Manual Stop. Unlike a
-- pending turn they must NOT resume at boot: the owner's next send consumes
-- and prepends them, so Stop remains stopped without making accepted words
-- disappear from the agent's conversation.
CREATE TABLE IF NOT EXISTS stopped_user_messages (
  run_key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_docs (
  doc_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- One row per backup job (git, db). Small and slow-moving, but it has to be
-- DURABLE: the whole point is noticing a job that stopped days ago, and a
-- monitor that forgot everything on the last restart would start every boot
-- believing all is well. (No backticks in here — this block is a JS template
-- literal, and one would end it.)
CREATE TABLE IF NOT EXISTS backup_heartbeats (
  job TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- access_requests (note #791, 25 Oct 2026) is no longer created: sign-up
-- reopened the same evening (note #794). A database that ran in between
-- keeps the table and its rows; nothing reads it, and it is left, not dropped.
-- The idle reaper's Telegram warning must survive backend deploys. Without a
-- durable stamp, every restart forgets the daily throttle and one leaked Fly
-- app trains the operator to mute the alert intended to expose it.
CREATE TABLE IF NOT EXISTS fly_idle_reaper_alerts (
  app_key TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- Per-agent last-interaction stamp for the idle reaper's recently-active
-- gate. Durable so a fresh backend can answer it on its first sweep instead of
-- stopping nothing for a grace window after every deploy (see
-- AgentActivityStore). Written on every interaction, so no JSON doc: one
-- integer per agent.
CREATE TABLE IF NOT EXISTS telegram_agent_activity (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  last_active_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);
-- How long each agent has WORKED, per UTC month (note #644; see
-- AgentWorkLedger). Beside the agent record rather than inside it because the
-- record is hard deleted with the agent and this total must outlive it: the
-- owner's screen and the workplace's total keep counting a deleted agent, by
-- the name kept here. Nothing deletes these rows.
CREATE TABLE IF NOT EXISTS agent_work_ledger (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  month TEXT NOT NULL,
  org_id TEXT,
  agent_name TEXT NOT NULL,
  working_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id, month)
);
CREATE INDEX IF NOT EXISTS agent_work_ledger_by_org ON agent_work_ledger (org_id);
-- The same working time per UTC day (since 2026-10-10), written in the same
-- transaction as the month: the Leaderboard's week and its 90-day grid read
-- days, which a month cannot be split back into. Nothing deletes these rows.
CREATE TABLE IF NOT EXISTS agent_work_days (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  working_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id, day)
);
CREATE INDEX IF NOT EXISTS agent_work_days_by_day ON agent_work_days (day);
-- The tokens each agent's turns spent (AgentTokenLedger): one row per owner,
-- agent, UTC day, provider and model, added to at every turn's end. Beside
-- the record for the working-time ledger's reason — a deleted agent's spend
-- still happened. The counts are normalized there (input is cache-excluded
-- for both providers). Nothing deletes these rows.
CREATE TABLE IF NOT EXISTS agent_token_ledger (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  org_id TEXT,
  agent_name TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id, day, provider, model)
);
CREATE INDEX IF NOT EXISTS agent_token_ledger_by_user_day ON agent_token_ledger (user_id, day);
CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_by_name ON deployments (name);
CREATE INDEX IF NOT EXISTS deployments_by_user ON deployments (user_id);
CREATE TABLE IF NOT EXISTS git_repos (
  repo_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL
);
-- Object-storage buckets agents ask for (note #768). name is not unique: a
-- destroyed bucket keeps its row as a tombstone; the live-name fence is in
-- create(), as deployments keep it.
CREATE TABLE IF NOT EXISTS storage_buckets (
  bucket_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  name TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS storage_buckets_by_org ON storage_buckets (org_id);
CREATE INDEX IF NOT EXISTS storage_buckets_by_name ON storage_buckets (name);
-- Repo names are unique per user among LIVE repos only: since slice 5 a
-- deleted repo keeps its row and its name while it waits in the trash
-- (docs/agent-git-project-repos.md), so the database can no longer hold that
-- fence and create() enforces it — the same trade deployments already make
-- for destroyed tombstones. Dropping the old unique index is the migration;
-- it is a no-op on every boot after the first, and creating a repo whose name
-- a tombstone still holds is exactly the case it has to stop refusing.
DROP INDEX IF EXISTS git_repos_by_user_name;
CREATE INDEX IF NOT EXISTS git_repos_by_user_name_v2 ON git_repos (user_id, name);
-- A public repository is reached by one opaque link id. The partial unique
-- expression index makes accidental reuse impossible while costing private
-- repositories (the overwhelming majority) no index row.
CREATE UNIQUE INDEX IF NOT EXISTS git_repos_by_public_id
  ON git_repos (json_extract(doc, '$.publicAccess.id'))
  WHERE json_extract(doc, '$.publicAccess.id') IS NOT NULL;
CREATE TABLE IF NOT EXISTS git_pull_requests (
  pr_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  doc TEXT NOT NULL
);
-- (repo, number) is how both Telegram callbacks and the CLI address a PR, so
-- the database refuses two concurrent creates minting the same "PR #3".
CREATE UNIQUE INDEX IF NOT EXISTS git_prs_by_repo_number ON git_pull_requests (repo_id, number);
CREATE INDEX IF NOT EXISTS git_prs_by_user ON git_pull_requests (user_id);
CREATE TABLE IF NOT EXISTS knowledge_proposals (
  proposal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  doc TEXT NOT NULL
);
-- One knowledge base per account, so a proposal is addressed by (user, number)
-- rather than (repo, number): "#3" is unambiguous without naming anything else,
-- and the database refuses two concurrent proposals minting the same one.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposals_by_user_number ON knowledge_proposals (user_id, number);
-- A knowledge PAGE's margin (note #66). The page itself is a blob in the
-- knowledge base's git history; its comments deliberately are not — a remark
-- is not part of the reviewed document — so the thread rows live here, one
-- per commented page, and are deleted when a page-delete lands.
CREATE TABLE IF NOT EXISTS knowledge_page_comments (
  user_id TEXT NOT NULL,
  page TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (user_id, page)
);
CREATE TABLE IF NOT EXISTS quick_notes (
  note_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  doc TEXT NOT NULL
);
-- One set of notes per owning namespace, addressed by (namespace, number)
-- like a knowledge proposal. The historical column name remains user_id.
CREATE UNIQUE INDEX IF NOT EXISTS quick_notes_by_user_number ON quick_notes (user_id, number);
-- Notes are the one numbered thing here that can be DELETED, so the counter
-- cannot be MAX(number) + 1: removing the newest note would hand its number
-- straight to the next one written, and a number the user read yesterday
-- would mean something else today. This row only ever goes up.
CREATE TABLE IF NOT EXISTS quick_note_numbers (
  user_id TEXT PRIMARY KEY,
  issued INTEGER NOT NULL
);
-- Since note #741 the key is normally a SERIES, org:<orgId>: one counter
-- for the whole workplace, so a note number names exactly one note in any
-- room. The per-room rows stay (older numbers were issued from them, and a
-- room that loses its row must still never reissue one), and the series is
-- seeded above every number and every counter its rooms hold.
--
-- Knowledge proposals got the same series the same day. Their rows are
-- never deleted except with their room, which is the one way a number could
-- otherwise come back — hence a counter rather than MAX(number) + 1.
CREATE TABLE IF NOT EXISTS knowledge_proposal_numbers (
  series TEXT PRIMARY KEY,
  issued INTEGER NOT NULL
);
-- What makes a note FINDABLE (note #242). One row per note, holding the words
-- it says rather than the markup it says them in, so a search matches text a
-- reader could have seen.
--
-- Its rowid is the note's rowid in the table above: that is what makes a write
-- a rowid update and a read a primary-key join, with no second key to keep. It
-- is also the one thing that could silently come untrue — a VACUUM renumbers
-- the rowids of a table whose primary key is not an INTEGER — so the note_id
-- rides along unindexed, every read joins on it as well, and the store checks
-- the pairing at boot and rebuilds what disagrees.
--
-- The tokenizer folds case and diacritics exactly as the query parser in
-- types/quick-note-search.ts does; the two are one rule in two places and
-- must move together.
CREATE VIRTUAL TABLE IF NOT EXISTS quick_note_search USING fts5(
  title,
  body,
  note_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- The org layer (types/org.ts; knowledge: org-layer-design): memberships are
-- many-to-many and invites are single-use doors into a specific org.
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- Every public handle a workplace ever held (knowledge: public-addresses),
-- current or previous, and whose it is. The primary key is the uniqueness.
CREATE TABLE IF NOT EXISTS org_handles (
  handle TEXT PRIMARY KEY,
  org_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS org_handles_org ON org_handles (org_id);
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_members_by_user ON org_members (user_id);
-- A seat is one human's private CLI sign-in. org_id remains as its creation
-- org for backwards-compatible migration; use org_seat_assignments for every
-- routing decision. Nothing may ever select a credential across owners.
CREATE TABLE IF NOT EXISTS org_seats (
  seat_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS org_seats_by_member ON org_seats (org_id, user_id);
CREATE INDEX IF NOT EXISTS org_seats_by_user ON org_seats (user_id);
CREATE TABLE IF NOT EXISTS org_seat_assignments (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, seat_id)
);
CREATE INDEX IF NOT EXISTS org_seat_assignments_by_seat ON org_seat_assignments (seat_id);
-- A seat sign-in ceremony still outstanding. Durable for the same reason the
-- reaper's own alert stamp is: a restart must not forget it. This one holds a
-- MACHINE awake, so forgetting it does not merely lose a throttle -- the next
-- sweep stops the machine the member is mid-sign-in on (observed 2026-09-06,
-- 65 seconds after a deploy). Bounded by the ceremony: rows are deleted when
-- it finishes and ignored once past the provider's code lifetime.
CREATE TABLE IF NOT EXISTS seat_signins (
  user_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_invites (
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  doc TEXT NOT NULL
);
-- A JOIN REQUEST (note #1): a reusable link files one of these; an admin's
-- decision is what creates the membership. status is a real column so the
-- one-pending-per-(org, user) rule and the admin's pending list are lookups.
CREATE TABLE IF NOT EXISTS org_join_requests (
  request_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS org_join_requests_by_org_user ON org_join_requests (org_id, user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS org_join_requests_one_pending ON org_join_requests (org_id, user_id) WHERE status = 'pending';
-- Rooms (note #85) were an org's inner rooms, each with its own namespace,
-- in an org_rooms table. They left the product (note #843); stage 3 (note
-- #923) stopped creating the table, and room-drop.ts drops an old one at
-- boot once its workplaces are merged. Before them, for one morning, they
-- were "tracks" — production held zero rows (2026-08-28), a plain drop.
DROP TABLE IF EXISTS org_tracks;
-- The reverse lookup (namespace → workplace) reads the workplace's own
-- namespace through this index first (OrgStorage.getOrgByNamespace).
CREATE INDEX IF NOT EXISTS orgs_by_git_namespace ON orgs (json_extract(doc, '$.git.namespaceId'));
CREATE TABLE IF NOT EXISTS git_commit_statuses (
  status_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  doc TEXT NOT NULL
);
-- One row per (repo, sha, context), latest wins: no screen has ever wanted a
-- status's history, only its current answer (docs/ci-status-miniapp.md).
CREATE UNIQUE INDEX IF NOT EXISTS git_statuses_by_commit ON git_commit_statuses (repo_id, sha, context);
-- Schedules (note #779): one doc per schedule; live marks the rows the
-- sweep reads every half minute (active, or paused for a cap that lifts).
CREATE TABLE IF NOT EXISTS agent_schedules (
  schedule_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_schedules_by_agent ON agent_schedules (agent_id);
CREATE INDEX IF NOT EXISTS agent_schedules_by_org ON agent_schedules (org_id);
CREATE INDEX IF NOT EXISTS agent_schedules_live ON agent_schedules (live);
`;

function adoptHeldAddresses(db: SqliteDb): void {
  const rows = db.prepare(`
    SELECT i.user_id AS userId, i.doc AS doc, m.address AS address
      FROM workspace_email_identities i
      JOIN workspace_mailboxes m ON m.user_id = i.user_id
     WHERE i.email_canonical <> m.address
  `).all() as Array<{ userId: string; doc: string; address: string }>;
  if (rows.length === 0) return;
  const nowIso = new Date().toISOString();
  const update = db.prepare('UPDATE workspace_email_identities SET email_canonical = ?, doc = ? WHERE user_id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const taken = db.prepare('SELECT user_id FROM workspace_email_identities WHERE email_canonical = ?').get(row.address) as { user_id: string } | undefined;
      if (taken && taken.user_id !== row.userId) continue;
      const identity = adoptedIdentity(deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc), row.address, nowIso);
      update.run(row.address, serializeDoc(identity), row.userId);
    }
  })();
}

/**
 * Until note #608 direct messages were two tables in this file. They were
 * empty in production when the text moved to the messaging machines, so an
 * installation that still holds them EMPTY loses them on boot. Tables that
 * hold anything are left exactly as they are and said out loud: private
 * conversations are never dropped by a schema change.
 */
function retireDirectMessageTables(db: SqliteDb): void {
  const exists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!exists('direct_messages') && !exists('direct_message_threads')) return;
  const held = exists('direct_messages') ? (db.prepare('SELECT COUNT(*) AS n FROM direct_messages').get() as { n: number }).n : 0;
  if (held > 0) {
    console.warn(`[Storage] direct_messages still holds ${held} message(s) from before the messaging machines — left in place, not served`);
    return;
  }
  db.exec('DROP TABLE IF EXISTS direct_message_threads; DROP TABLE IF EXISTS direct_messages;');
}

export function openSqliteDb(path: string): SqliteDb {
  const db = new DatabaseConstructor(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Lets operator scripts on the same host read/write alongside the backend.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // Email ownership verification arrived after password identities were live.
  // Stamp every identity already on disk as a grandfathered legacy account:
  // it keeps all existing sessions and logins while the UI gently asks its
  // owner to confirm. New identities are written as `pending` by the service.
  db.exec(`
    UPDATE workspace_email_identities
       SET doc = json_set(
         doc,
         '$.verificationStatus', 'legacy',
         '$.verificationGrandfatheredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )
     WHERE json_extract(doc, '$.verificationStatus') IS NULL;
  `);
  // People sign in by the name of their address here. An account that
  // attached an outside email first and took its address here later still
  // carried the outside email as its sign-in name, which is exactly the
  // name the door no longer reads; make the address it holds its sign-in
  // name and keep the outside email as the recovery address.
  adoptHeldAddresses(db);
  retireDirectMessageTables(db);
  // Replies (note #509 slice 4) arrived hours after the table itself, so an
  // installation that already holds mail needs the two columns added. Both
  // are read by the inbox list, which shows only what came IN.
  const mailColumns = db.prepare('PRAGMA table_info(workspace_mail_messages)').all() as { name: string }[];
  if (!mailColumns.some((column) => column.name === 'direction')) {
    db.exec("ALTER TABLE workspace_mail_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'");
  }
  if (!mailColumns.some((column) => column.name === 'answers')) {
    db.exec('ALTER TABLE workspace_mail_messages ADD COLUMN answers TEXT');
  }
  // Search (slice 7): built, and filled from the mail already here, the first
  // time an installation opens without it.
  ensureMailSearchIndex(db);
  // Conversations (slice 8): every stored message in one, the mail already
  // here threaded the first time an installation opens with this code.
  ensureMailThreads(db);
  // Where each reply is kept (slice 9): every reply given the stamps of the
  // letter it answers, so Sent says where each letter in it is and a reply
  // under something in Trash is in Trash too. Run at every boot, and on a
  // mailbox already filed it matches no row.
  ensureMailRepliesFiled(db);
  // Spam (slice 13): the letters the checks had already marked suspicious
  // are filed into Spam the first time an installation opens with this code.
  // Once, per letter: a letter its owner has since marked Not spam carries
  // `notSpam` and is left where they put it.
  ensureMailSuspiciousFiled(db);
  return db;
}

/**
 * Before slice 13 a letter nothing vouched for stayed in the inbox with a
 * warning on it. Now it is filed into Spam on the way in, and this files the
 * ones already here the same way — stamped at the moment they arrived, so
 * Spam lists them in the order they came, and with the reason the screen
 * says out loud. Trash is left alone: that is a place its owner chose.
 */
export function ensureMailSuspiciousFiled(db: SqliteDb): void {
  db.prepare(
    `UPDATE workspace_mail_messages
        SET doc = json_set(doc, '$.spamAt', json_extract(doc, '$.receivedAt'), '$.spamWhy', 'suspicious')
      WHERE direction = 'in'
        AND json_extract(doc, '$.suspicious') = 1
        AND json_extract(doc, '$.spamAt') IS NULL
        AND json_extract(doc, '$.trashedAt') IS NULL
        AND json_extract(doc, '$.notSpam') IS NULL`,
  ).run();
  // A reply under one of them is filed with it, as every reply is.
  ensureMailRepliesFiled(db);
}

const TS_TAG = '__sqlite_ts__';
const DATE_TAG = '__sqlite_date__';

function isTimestampLike(value: unknown): value is { toMillis(): number } {
  return typeof value === 'object'
    && value !== null
    && value instanceof Timestamp;
}

function encodeValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (isTimestampLike(value)) {
    // Via toMillis, not toDate: the millisecond precision must survive the
    // round trip for updatedAt ordering to stay stable.
    return { [TS_TAG]: new Date(value.toMillis()).toISOString() };
  }
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => encodeValue(entry));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = encodeValue(entry);
    }
    return out;
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeValue(entry));
  }
  const record = value as Record<string, unknown>;
  if (typeof record[TS_TAG] === 'string') {
    return Timestamp.fromDate(new Date(record[TS_TAG] as string));
  }
  if (typeof record[DATE_TAG] === 'string') {
    return new Date(record[DATE_TAG] as string);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = decodeValue(entry);
  }
  return out;
}

/** Serialize a document for storage: undefined keys drop, Timestamps/Dates survive round trips. */
export function serializeDoc(doc: unknown): string {
  return JSON.stringify(encodeValue(doc));
}

export function deserializeDoc<T>(json: string): T {
  return decodeValue(JSON.parse(json)) as T;
}
