import LegalLayout, { ContactLines, LegalSection } from './LegalLayout';

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
 */
export default function TermsOfService() {
  return (
    <LegalLayout title="Terms of Service" effectiveDate="September 25, 2026">
      <LegalSection title="1. What this is">
        <p>
          Agentic Cloud Computer (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;the service&rdquo;) is one shared
          Workspace for an organisation&rsquo;s AI agents. Each agent has a name, a job and its own
          cloud computer; the Workspace provides conversation, shared notes and knowledge,
          repositories, approval requests and the operational controls around them.
        </p>
        <p>
          You sign up in a browser by choosing your own address on our mail domain and a password,
          and may add an authenticator app as a second factor. Agents are created, messaged,
          reviewed and managed inside the Workspace; completion and approval updates appear there,
          with optional browser alerts.
        </p>
        <p>
          Agentic Cloud Computer operates the service and controls the platform data described in
          these terms. By using the service you agree to these terms; if you do not agree, do not
          use it.
        </p>
      </LegalSection>

      <LegalSection title="2. What you bring">
        <p>
          <span className="text-white">AI access.</span> Members sign in with their own Claude or
          ChatGPT plan, or you connect a company API account. We do not buy, hold or resell model
          access. Your provider&rsquo;s terms govern whether your plan permits this use and how it
          processes prompts, code and outputs. A seat belongs to the member who signed it in; one
          person may not share a personal plan with several people through the service.
        </p>
        <p>
          <span className="text-white">No cloud account.</span> Agent machines and the sites your
          agents deploy run on our own Fly.io account, at no charge to you, within the
          per-workplace limits the Workspace shows. Repository and media integrations may also
          point to services you control.
        </p>
      </LegalSection>

      <LegalSection title="3. Free service and provider costs">
        <p>
          <span className="text-white">Agentic Cloud Computer is free to use.</span> We do not
          charge you, accept payments, collect payment details, operate checkout or offer a paid
          tier.
        </p>
        <p>
          Your AI, git and media providers may charge your organisation directly for the
          services you choose from them. Those third-party provider charges are separate from this
          free service and follow the provider agreements you accept.
        </p>
        <p>
          <span className="text-white">Payments and refunds.</span> Because we collect no payment,
          there is no platform payment to refund. A refund for a provider charge belongs with the
          provider that billed you and follows that provider&rsquo;s policy. A charge claiming to be
          from Agentic Cloud Computer was not collected by this service &mdash; tell us so we can
          investigate it. Nothing here limits a stronger right the law gives you.
        </p>
        <p>
          We may ask for feedback, a short call or permission to describe a successful use case.
          Those are requests, not payment and not conditions of access.
        </p>
      </LegalSection>

      <LegalSection title="4. Your responsibilities">
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

      <LegalSection title="5. What only a person can decide">
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

      <LegalSection title="6. Your content and our records">
        <p>
          What your agents make is yours. We claim no ownership of your code, files, prompts or
          outputs. You give us only the permissions needed to operate the service: authenticate
          your browser session, run your agents&rsquo; machines and sites, use the accounts you
          connect, send notifications, pass work
          to the AI provider you chose, and store the control-plane records described in the{' '}
          <a
            href="/privacy"
            className="text-accent-bright underline decoration-accent-bright/40 underline-offset-2 hover:decoration-accent-bright"
          >
            Privacy Policy
          </a>
          .
        </p>
        <p>
          Repositories and media kept in services you control sit outside our platform. Agent
          machines and deployed sites run on the cloud, and Workspace records &mdash; including
          recent conversation rows, notes, proposals and encrypted credentials &mdash; are stored by
          the platform as described in that policy.
        </p>
      </LegalSection>

      <LegalSection title="7. Data and machine loss">
        <p>
          AI agents make mistakes: they can delete files, push bad code or misunderstand you. Human
          approval reduces risk but does not remove it. Keep anything important in a repository or
          backup you control and verify consequential output before relying on it.
        </p>
        <p>
          We cannot recover an agent&rsquo;s machine or a site once it is deleted, or a resource in
          an account you control deleted by you, your provider or an agent acting on your
          instruction. Platform-hosted records and media follow the retention and backup rules in
          the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection title="8. No warranty">
        <p>
          The service is provided as is, without warranties of any kind. It is young software:
          features can change, break or disappear, uptime is not guaranteed, and AI output can be
          false or incomplete.
        </p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for indirect, incidental or
          consequential damages, lost data, lost profits, provider charges or the actions of your
          agents. Where a limit is allowed by law, our total liability for any claim is limited to
          the maximum extent permitted by law.
        </p>
      </LegalSection>

      <LegalSection title="10. Suspension, leaving and shutdown">
        <p>
          You can stop at any time and request deletion as described in the Privacy Policy.
          Deleting a workplace destroys its agent machines and sites on the cloud, and
          platform-hosted Workspace records do not automatically move anywhere, so export or push
          anything you need before closing the account.
        </p>
        <p>
          We can suspend or remove accounts that violate section 4 or create a security risk. If we
          shut down the service, we will give reasonable notice inside the Workspace and by email
          when practicable.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes to these terms">
        <p>
          We may update these terms as the service changes. The effective date shows the current
          version; material changes will be announced inside the Workspace or by email. Continuing
          to use the service after a change means you accept it.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact">
        <ContactLines />
      </LegalSection>
    </LegalLayout>
  );
}
