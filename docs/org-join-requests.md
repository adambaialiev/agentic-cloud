# Reusable workplace invite links

A web invite link accepts requests from multiple signed-in people. It does not expire: it stays live until an admin revokes it. The link does not name a recipient and grants no membership by itself — the admin's approval is the gate, which is what makes a standing link safe to hand out.

The visitor sees the workplace and their current account, then explicitly requests to join. There is at most one pending request per workplace and person, including simultaneous submissions or submissions through different links. The pending screen includes a durable request ID in its address and can check the decision after the original link is revoked.

Admins review requests in **Workplace → Join requests** and individually choose **Approve as member** or **Decline**. Refresh requests loads new arrivals. Approval rechecks the admin's current role and atomically grants member access. Declining grants nothing. A decided request cannot be approved or declined again; an explicit resubmission creates a new request ID. Existing members keep their roles.

Revocation stops new requests. Requests already filed remain for an admin to decide. Pending requests block deleting an otherwise empty workplace until they are resolved; revoked links do not create hidden blockers.

Approval does not switch a person's existing active workplace. The applicant's status screen offers **Open workplace**, which activates it explicitly. A wrong-account visitor can sign out through **Use another account** before submitting.

Existing unconsumed links use this flow, including ones minted under the old seven-day expiry: nothing reads `expiresAt` any more, so a link that had lapsed is live again, behind the same approval. An admin who does not want one back revokes it in **Workplace → Invite links**. Historical consumed single-use tokens remain invalid. The old web redemption URL now creates requests too, so an older client cannot bypass approval.

SQLite stores requests in `org_join_requests`, with a unique pending-request index and transactional decisions. The in-memory implementation follows the same contract for tests and development. Sequential and concurrent tests exercise both implementations; route tests cover authorization, private status reads, per-person decisions, and stale workplace context.
