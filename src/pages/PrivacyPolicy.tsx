import LegalLayout, { ContactLines, LegalSection } from './LegalLayout';

/**
 * The Privacy Policy, rewritten 2026-09-14 against the running product (note
 * 138). This page is load-bearing: the precise data split was deliberately
 * removed from the landing page in PR #742 and lives here and in one FAQ
 * answer, so if this is vague nothing else covers it.
 *
 * What was checked, and where:
 *  - sign-in records: email, scrypt password hash, OPTIONAL encrypted TOTP
 *    secret and hashed recovery codes — backend/src/services/workspace-web-auth.ts
 *    and backend/src/utils/workspace-password.ts. The previous text described
 *    the retired username + authenticator flow as the only way in.
 *  - the 500-row chat window — AGENT_CHAT_MESSAGE_CAP in
 *    backend/src/services/agent-chat-storage.ts.
 *  - backups, 14 daily then 8 weekly — infra/db-backup/backup-db.sh.
 *  - two processors the old text never disclosed: a transactional email
 *    provider delivers address confirmation (backend/src/services/
 *    workspace-verification-email.ts), and a voice message is transcribed by a
 *    speech-to-text provider (backend/src/services/voice-transcription-service.ts).
 *  - Drive files are platform records — backend/src/services/drive-service.ts.
 *
 * 2026-09-25 (note #664): a new workplace no longer connects a Fly account.
 * Its agent machines, their disks and its deployed sites run on the
 * platform's own Fly.io account (backend services/org-fly.ts
 * resolveHostingContext; region FLY_REGION, default ams), its files ride the
 * platform media store (org-media.ts), and deleting the workplace destroys
 * those machines and sites (workplace-deletion.ts). Sections 2, 3, 5 and 6
 * said the machines ran in the customer's own account; they now say this.
 *
 * 2026-10-09: "Where you came from" in section 2 — the first-visit record
 * (backend/src/shared/first-visit.ts): the referring site's host and the
 * first page, kept in the browser's own storage and stored with an account
 * only if one is created. Asked for by Growth, agreed by the owner.
 *
 * 2026-10-10: "The public Leaderboard" in section 2 — everyone is on it
 * unless they turn it off in Settings (the owner; backend
 * services/leaderboard.ts), and sign-up says so. What it shows is exactly
 * WorkspaceLeaderboardBuilder plus the profile's X handle.
 *
 * 2026-10-12: the same paragraph — each day of the 90-day grid now opens
 * that day's hours, merges and tokens written on a builder's own page
 * (WorkspacePublicPersonBoard.days, note #208); every past week stays on the
 * board, and a builder's page shows all-time hours and tokens written
 * (`?week=`, WorkspacePublicPersonBoard.allTime, note #209).
 *
 * 2026-10-28: the public Leaderboard is gone (Adam, note #824), and with it
 * the Settings switch and the sign-up line. The paragraph became "Your
 * builder page": a person's numbers are shown to them alone, signed in
 * (backend routes/workspace.ts publicPerson); the page itself stays public.
 *
 * 2026-11-01 (note #933, the owner: "Fix terms and privacy"): what we sell
 * is your own Agentic Cloud, and the page said the service was free and took
 * no payments. Section 2 is now that offer's data, as knowledge private-copy
 * and the code say it: nothing of the customer's crosses to us (no messages,
 * code, files, mail, keys or logs); the licence is checked inside the copy,
 * offline (services/copy-licence.ts); the update service checks an update
 * key and reads nothing from the copy (infra/copy-updates); a diagnostics
 * bundle leaves only when an admin sends it, and holds no messages, code,
 * files, mail, keys or names of people (services/copy-health.ts), with the
 * usage a renewal is settled from. What we keep is the customer list, the
 * licences and update keys we issue, and what people write to us. Sections
 * 3 to 8 are the hosted Workspace as before, with sign-up closed (an account
 * only through a live invite link, note #823).
 *
 * Same day, 08:56 UTC (note #935): licensing is off and the product is free
 * for now, so section 2 holds no licence or update-key record and no
 * agreement, and says no payment record is kept for either offer.
 */
export default function PrivacyPolicy() {
  return (
    <LegalLayout title="Privacy Policy" effectiveDate="November 1, 2026">
      <LegalSection title="1. Who we are">
        <p>
          Agentic Cloud Computer makes a shared Workspace for a company&rsquo;s AI agents. We offer it
          as your own Agentic Cloud, which runs in your company&rsquo;s own cloud account, and we also
          host a Workspace ourselves, where new accounts are closed and an account comes only with an
          invite. Agentic Cloud Computer controls the records described here.
        </p>
        <p>
          Section 2 says what we hold when you run your own Agentic Cloud, which is very little.
          Sections 3 to 8 say what our hosted Workspace stores for the accounts on it. For anything
          this page does not answer:
        </p>
        <ContactLines />
      </LegalSection>

      <LegalSection title="2. Your own Agentic Cloud">
        <p>
          <b className="text-white">Your data stays in your cloud account.</b> The Workspace and its
          database, the code host, files, backups, email and every agent&rsquo;s computer run in your
          Fly.io organization, on your domain. Your messages, code, files, mail, keys and logs never
          reach us, and we have no access to your Agentic Cloud unless you give it to us. Fly.io hosts
          it under your agreement with them, and the AI and mail providers you choose receive what you
          send them under yours.
        </p>
        <p>
          <b className="text-white">What we hold.</b> Only what you send us: the addresses you write to
          us from and what you write, such as your company&rsquo;s name and domain. Your own Agentic
          Cloud is free for now, so we hold no payment record or card details for it.
        </p>
        <p>
          <b className="text-white">What crosses, and when.</b> When your agent fetches a release, it
          downloads it from our update service, which reads nothing from your Agentic Cloud. Its
          admins can make a
          diagnostics bundle for support: the health report, its settings with every key said only as
          set or not set, and how many people use it, now and at most. It holds no messages, code,
          files, mail, keys or names of people, and it reaches us only if an admin sends it.
        </p>
      </LegalSection>

      <LegalSection title="3. What our hosted Workspace stores">
        <p>
          <b className="text-white">Account and identity records.</b> Your email address, a hash of
          your password, and &mdash; if you add an authenticator app &mdash; an encrypted
          authenticator secret and hashed recovery codes. We never store the password itself. With
          these sit your membership, roles, agent records, browser-session records and the
          operational state needed to show and run your Workspace.
        </p>
        <p>
          <b className="text-white">Where you came from.</b> The first time you open our site, your
          browser keeps a small note in its own storage: the name of the site that sent you, if your
          browser says (such as google.com, never the page you were on), and the first page you opened
          here. If you create an account, that note is saved with it, so we can tell which places bring
          people to us. It is not used for anything else, and nobody else receives it.
        </p>
        <p>
          <b className="text-white">Recent Workspace conversations.</b> We store a rolling window of
          up to 500 chat rows per agent: your messages, agent replies and platform notices. New rows
          trim the oldest. Chat attachments are held in the organisation&rsquo;s configured media
          store and are removed when their row is trimmed or the agent is deleted. The coding
          harness also keeps its own working session on the agent&rsquo;s machine; that session is
          destroyed with the machine.
        </p>
        <p>
          <b className="text-white">Workspace records.</b> Notes, comments, knowledge pages,
          proposal and approval records, repository metadata, deployment records, files kept in the
          workplace Drive and the other documents your team uses in the Workspace. These are
          platform records even when the code they refer to lives in a service you control.
        </p>
        <p>
          <b className="text-white">Credentials and secrets.</b> AI sign-in tokens, saved
          organisation secrets, and access tokens needed for any git, media or cloud integration you
          connect. We store these encrypted and use them to provide the feature you connected.
          We do not receive the password you type at an AI provider.
        </p>
        <p>
          <b className="text-white">No payment record.</b> The hosted Workspace is free for now, so
          for it we store no card, platform invoice or subscription billing record. Your AI provider
          and any other provider you connect keep their own billing records under their agreements
          with you.
        </p>
        <p>
          <b className="text-white">Your builder page.</b> Your page at agenticcloudcomputer.com and
          the address you chose shows anyone your name, picture and the public repositories you
          contributed to. The numbers on it are shown only to you, signed in: how many agents you
          run and how many are working, your agent working hours, the changes your agents got
          merged and the Claude Code and Codex tokens they wrote this week, your all-time agent
          working hours and tokens written, a 90-day activity grid whose days show those same
          counts for that day, and your X profile if you add one. It never shows what your agents
          work on, your workplaces or your email.
        </p>
      </LegalSection>

      <LegalSection title="4. Where hosted machines, sites and connected services live">
        <p>
          Agent machines and their disks, and the sites your agents deploy, run on our own Fly.io
          account, in its Amsterdam region by default. Repositories and media can use
          customer-controlled services when those integrations are configured; the relevant
          provider then controls their region, backups and billing.
        </p>
        <p>
          The platform may also host repositories or media when your organisation uses the built-in
          services. The Workspace shows those resources.
        </p>
      </LegalSection>

      <LegalSection title="5. Signing in and notifications">
        <p>
          New accounts are made only through an invite link from a workplace that has one. You sign
          in to the Workspace in a browser with your own address on our mail domain and a password.
          An account created before we hosted addresses may still sign in with the outside email
          address it was made with, and we send a message to such an address to confirm it. You may
          add an authenticator app as a second factor, which issues recovery codes we store hashed.
          Browser sessions use the access records described above.
        </p>
        <p>
          Completion notices and approval requests are kept as Workspace notification records. If
          you enable system notifications, your browser push service processes the minimal title,
          message and same-origin destination needed to display that alert.
        </p>
      </LegalSection>

      <LegalSection title="6. Who else processes data">
        <p>
          <b className="text-white">Your AI provider</b> &mdash; Anthropic, OpenAI or a provider you
          connect &mdash; receives the prompts, code, files and context an agent sends it. Your
          account and provider terms govern that processing. Business products from Anthropic and
          OpenAI currently exclude business data from model training by default, subject to their
          terms and any opt-in settings; check the plan you actually use.
        </p>
        <p>
          <b className="text-white">A transactional email provider</b> delivers the messages we send
          to your address, such as the confirmation of your account, and therefore processes that
          address. <b className="text-white">A speech-to-text provider</b> receives the audio of a
          voice message you record in the Workspace, in order to transcribe it; typed messages are
          not sent to it.
        </p>
        <p>
          <b className="text-white">Infrastructure providers</b>, Fly.io among them, process the data
          needed to host the platform, agent machines and sites, git and media. Your browser or
          operating-system push service processes alerts you enable. We do not sell personal data, run ads or use
          third-party behavioural analytics on the public site.
        </p>
      </LegalSection>

      <LegalSection title="7. Retention and deletion">
        <p>
          The recent chat window keeps at most 500 rows per agent. Deleting an agent removes its
          active platform chat rows and chat files and destroys its machine and its harness
          session. Deleting a workplace also destroys its agent machines and sites on the cloud.
        </p>
        <p>
          Notes, knowledge pages, proposals, Drive files, account and organisation records remain
          while the Workspace needs them or until they are deleted under the product&rsquo;s
          controls. Archived notes and trashed Drive items are retained rather than deleted. Ask us
          to delete an account or organisation and we will remove its active platform records and
          revoke platform-held credentials.
        </p>
        <p>
          Database backups keep 14 daily snapshots and then one weekly snapshot for up to eight
          weeks, so a deletion can remain in a protected backup until that snapshot expires. Backups
          are used for disaster recovery, not to restore a deleted account on request.
        </p>
      </LegalSection>

      <LegalSection title="8. Operator access and security">
        <p>
          In our hosted Workspace, the operator can access platform records, logs and managed
          machines when needed to run, secure or troubleshoot the service. Credentials are kept in
          encrypted secret storage, databases and disks use their hosting provider&rsquo;s at-rest
          protection, and agent machines are isolated from one another. No system is perfectly
          secure.
        </p>
      </LegalSection>

      <LegalSection title="9. Children">
        <p>The service is for organisations and is not directed to children.</p>
      </LegalSection>

      <LegalSection title="10. Changes">
        <p>
          Updates appear here with a new effective date. Material changes will be announced inside
          the Workspace or by email.
        </p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <ContactLines />
      </LegalSection>
    </LegalLayout>
  );
}
