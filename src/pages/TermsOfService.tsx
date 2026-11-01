import LegalLayout, { ContactLines, LegalSection } from './LegalLayout';

const LINK = 'text-accent-bright underline decoration-accent-bright/40 underline-offset-2 hover:decoration-accent-bright';

/**
 * The Terms, rewritten 2026-09-14 against the running product rather than
 * against the previous draft (note 138).
 *
 * Three things were no longer true. Sign-in was described as "a username and a
 * rotating authenticator code", which was the 2026-08-31 flow; sign-up is an
 * email address and a password, confirmed by email, with an authenticator as
 * an OPTIONAL second factor (backend/src/services/workspace-web-auth.ts). The
 * cloud account was left unnamed while the front page names Fly.io outright.
 * And section 11 pointed at /refunds, a separate page for a product that takes
 * no payments — its two load-bearing sentences now live in section 3, and the
 * page is gone (note 139).
 *
 * The vocabulary follows the canonical landing page: agents, not coworkers.
 * The wording also drops the "no separate bot accounts or third-party chat
 * identities" denial — a Telegram-shaped sentence on a surface where Telegram
 * has not existed since 2026-09-07, and a denial only raises the question.
 *
 * 2026-09-25 (note #664): a new workplace no longer brings a Fly account.
 * Agent machines and deployed sites run on the platform's own Fly.io
 * account, at our expense, within per-workplace limits, and deleting a
 * workplace destroys them. Sections 2, 3, 6, 7 and 10 said the machines ran
 * in the customer's own account on the customer's bill; they now say this.
 *
 * 2026-11-01 (note #933, the owner, 07:44 UTC: "sign up is closed on our
 * cloud. Customer should ask it's own agent to setup the cloud. Fix terms and
 * privacy"): the pages said "free to use" and "we do not accept payments"
 * while the offer since 28 Oct is your own Agentic Cloud, in the customer's
 * own Fly organization, the first month free and then a licence (knowledge
 * private-copy, claims-we-never-make). Section 2 is that offer as the product
 * enforces it (services/copy-licence.ts: an offline file the copy checks by
 * itself; a notice 30 days before the end, 30 days of grace, then no new
 * people and no new agents, and nothing stops; the people limit; the update
 * key opening every release dated before it ends). Section 3 is our hosted
 * Workspace, where sign-up is closed (SIGNUP_CLOSED, note #823) and an
 * account comes only through a live invite link. Price, refunds of a
 * licence, governing law, a liability cap and notice periods are the
 * owner's choices, listed at the top of note #933's proposal: the price is on no
 * public page (claims-we-never-make), so the licence's price and term are
 * "agreed with you in writing", and no payment method is described, because
 * none is built.
 *
 * Same day, 08:56 UTC (note #935, the owner: "Let's disable licensing for
 * now, disable the mechanism for now. Let's make the product free for now"):
 * before these words went live, the licence, its price, its grace and the
 * update key's promise came out again. Both offers are free for now, and the
 * words do not describe a mechanism that is being switched off (Iris, note
 * #935). Hosted accounts stay invite-only.
 */
export default function TermsOfService() {
  return (
    <LegalLayout title="Terms of Service" effectiveDate="November 1, 2026">
      <LegalSection title="1. What this is">
        <p>
          Agentic Cloud Computer (&ldquo;we&rdquo;, &ldquo;us&rdquo;) makes one shared Workspace for a
          company&rsquo;s AI agents. Each agent has a name, a job and its own cloud computer; the
          Workspace provides conversation, shared notes and knowledge, repositories, approval
          requests and the operational controls around them. Agents are created, messaged, reviewed
          and managed inside the Workspace; completion and approval updates appear there, with
          optional browser alerts.
        </p>
        <p>
          We offer it as <span className="text-white">your own Agentic Cloud</span>: the whole system,
          installed in your company&rsquo;s own Fly.io organization, on a domain of yours (section 2).
          These terms also cover the Workspace we host ourselves, where new accounts are closed and an
          account comes only with an invite (section 3). Together they are &ldquo;the
          service&rdquo;. <span className="text-white">Both are free for now</span> (section 4).
        </p>
        <p>
          Agentic Cloud Computer controls the records it holds, described in the{' '}
          <a href="/privacy" className={LINK}>
            Privacy Policy
          </a>
          . By using the service you agree to these terms; if you do not agree, do not use it.
        </p>
      </LegalSection>

      <LegalSection title="2. Your own Agentic Cloud">
        <p>
          <span className="text-white">Where it runs.</span> In a Fly.io organization of yours, on a
          domain of yours: the Workspace and its database, the code host with its CI, previews and
          sites, files, backups, email, the registry its images come from, and every agent&rsquo;s
          computer. Your agent or engineer installs it with our installer, whose source code is
          public, and the installer shows everything it will create and what Fly will bill for it
          before it creates anything. Fly bills your organization directly; nothing of ours is on
          that bill.
        </p>
        <p>
          <span className="text-white">What we provide.</span> The releases and support by email. A
          release is installed when you choose to upgrade; nothing upgrades itself.
        </p>
        <p>
          <span className="text-white">Who gets in.</span> The first admin is made with a one-time
          link the installer hands you. Everyone after that joins with an invite link, and an admin
          approves each person. Who you invite, and what they do there, is yours to decide.
        </p>
      </LegalSection>

      <LegalSection title="3. Our hosted Workspace">
        <p>
          <span className="text-white">Accounts by invite only.</span> New accounts on the Workspace
          we host at agenticcloudcomputer.com are closed. An account there comes only with an invite
          link from a workplace that has one, chooses its own address on our mail domain and a
          password, and may add an authenticator app as a second factor. A new person&rsquo;s request
          to join waits for an admin of that workplace. Accounts made before sign-up closed sign in
          and work as before.
        </p>
        <p>
          <span className="text-white">Machines and sites on our cloud.</span> Agent machines and the
          sites your agents deploy run on our own Fly.io account, at no charge to you, within the
          per-workplace limits the Workspace shows. Repository and media integrations may also point
          to services you control.
        </p>
        <p>
          It is free for now, as your own Agentic Cloud is (section 4).
        </p>
      </LegalSection>

      <LegalSection title="4. Free for now, and what others bill">
        <p>
          <span className="text-white">Free for now.</span> Your own Agentic Cloud and our hosted
          Workspace are free for now. We charge nothing, take no payments and collect no payment
                   details.
        </p>
        <p>
          <span className="text-white">AI access.</span> Members sign in with their own Claude or
          ChatGPT plan, or you connect a company API account. We do not buy, hold or resell model
          access. Your provider&rsquo;s terms govern whether your plan permits this use and how it
          processes prompts, code and outputs. A seat belongs to the member who signed it in; one
          person may not share a personal plan with several people through the service.
        </p>
        <p>
          Fly.io, your AI provider and any git, mail or media provider you choose bill your
          organization directly under the agreements you accept with them. Those charges are theirs,
          not ours.
        </p>
        <p>
          <span className="text-white">Refunds.</span> Because we collect no payment, there is no
          payment of ours to refund. A refund for a provider charge belongs with the provider that
          billed you and follows that provider&rsquo;s policy. A charge claiming to be from Agentic
          Cloud Computer was not collected by us &mdash; tell us so we can investigate it. Nothing
          here limits a stronger right the law gives you.
        </p>
        <p>
          We may ask for feedback, a short call or permission to describe a successful use case.
          Those are requests, not payment and not conditions of access.
        </p>
      </LegalSection>

      <LegalSection title="5. Your responsibilities">
        <p>
          Agents execute instructions on real computers with network access. You agree not to use
          the service to break the law; attack, spam or scrape third parties; mine cryptocurrency;
          create or distribute malware; resell machine access; or interfere with the service or
          another organisation.
        </p>
        <p>
          You are responsible for the instructions you give, the systems you connect, the people
          you admit to the Workspace, and provider charges incurred in your accounts. Keep
          appropriate human review in place for financial, legal, medical, security-sensitive or
          otherwise consequential work.
        </p>
      </LegalSection>

      <LegalSection title="6. What only a person can decide">
        <p>
          An agent can build, test and prepare a change. On a protected repository that change
          arrives as a proposal carrying the exact diff and its checks, and an agent cannot merge
          it, approve it, complete the deletion of a site or repository, or widen access to a
          saved secret. Those decisions stay with a member of your organisation.
        </p>
        <p>
          That gate is a control, not a guarantee of correctness: you are responsible for what you
          approve, and for reviewing consequential work before it lands.
        </p>
      </LegalSection>

      <LegalSection title="7. Your content and our records">
        <p>
          What your agents make is yours. We claim no ownership of your code, files, prompts or
          outputs.
        </p>
        <p>
          In your own Agentic Cloud, your messages, code, files, mail, keys and logs stay in your Fly
          organization and never reach us. We hold only what you send us, such as your email and a
          diagnostics bundle if your admin chooses to send one.
        </p>
        <p>
          In our hosted Workspace you give us only the permissions needed to operate it: authenticate
          your browser session, run your agents&rsquo; machines and sites, use the accounts you
          connect, send notifications, pass work to the AI provider you chose, and store the Workspace
          records &mdash; including recent conversation rows, notes, proposals and encrypted
          credentials &mdash; described in the Privacy Policy. Repositories and media kept in services
          you control sit outside our platform.
        </p>
      </LegalSection>

      <LegalSection title="8. Data and machine loss">
        <p>
          AI agents make mistakes: they can delete files, push bad code or misunderstand you. Human
          approval reduces risk but does not remove it. Keep anything important in a repository or
          backup you control and verify consequential output before relying on it.
        </p>
        <p>
          Your own Agentic Cloud backs its database up daily to a bucket of yours; we hold no copy,
          so we cannot restore it for you. In our hosted Workspace we cannot recover an agent&rsquo;s
          machine or a site once it is deleted, or a resource in an account you control deleted by
          you, your provider or an agent acting on your instruction; platform-hosted records and
          media follow the retention and backup rules in the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection title="9. No warranty">
        <p>
          The service is provided as is, without warranties of any kind. It is young software:
          features can change, break or disappear, uptime is not guaranteed, and AI output can be
          false or incomplete.
        </p>
      </LegalSection>

      <LegalSection title="10. Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for indirect, incidental or
          consequential damages, lost data, lost profits, provider charges or the actions of your
          agents. Where a limit is allowed by law, our total liability for any claim is limited to
          the maximum extent permitted by law.
        </p>
      </LegalSection>

      <LegalSection title="11. Suspension, leaving and shutdown">
        <p>
          Your own Agentic Cloud is yours to stop or remove, in your Fly organization; what it holds
          is yours, and we hold no copy of it. In our hosted Workspace you can stop
          at any time and request deletion as described in the Privacy Policy; deleting a workplace
          destroys its agent machines and sites on the cloud, and platform-hosted Workspace records do
          not automatically move anywhere, so export or push anything you need before closing the
          account.
        </p>
        <p>
          We can suspend or remove hosted accounts that violate section 5 or create a security risk.
          If we shut down the service, we will give reasonable notice inside the Workspace and by
          email when practicable.
        </p>
      </LegalSection>

      <LegalSection title="12. Changes to these terms">
        <p>
          We may update these terms as the service changes. The effective date shows the current
          version; material changes will be announced inside the Workspace or by email. Continuing
          to use the service after a change means you accept it.
        </p>
      </LegalSection>

      <LegalSection title="13. Contact">
        <ContactLines />
      </LegalSection>
    </LegalLayout>
  );
}
