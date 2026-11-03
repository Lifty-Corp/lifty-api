# Email connection providers

New connections use Lifty's branded Unipile V2 Google application. Google is the
only provider offered for new email connections while V2 identity verification
for other providers is unavailable. Reconnecting an account still bound through
V1 is not possible through V2 hosted sign-in while preserving its canonical
account; the database reports `CONNECT_UNAVAILABLE` for it (LIF-1182). See the
README section "Senders and sending accounts".

The existing habitual-mailbox declaration, workspace
ownership, exact account binding, and ten-email daily budget still apply.
Connecting a mailbox does not approve or activate outreach.

Identity comes from the bound V2 account and its email senders: exactly one
verified primary sender must equal the connected mailbox, and Outlook also needs
its mail grants. IMAP and other mailbox providers are rejected until equivalent
vendor identity evidence exists. Jobs repeats these checks before acquiring the
final send permission. Unknown sends remain blocked for reconciliation, never
blindly resent.

Sources checked September 17, 2026:

- [Hosted authentication](https://developer.unipile.com/reference/hostedcontroller_requestlink)
- [Account readback](https://developer.unipile.com/reference/accountscontroller_getaccountbyid)
- [Microsoft delegated mailbox behavior](https://developer.unipile.com/docs/microsoft-oauth)

This rollout uses automated contract tests. Juan deferred live account
connection/send/reply acceptance; no such acceptance is claimed.
