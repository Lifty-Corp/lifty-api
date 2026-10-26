# Sending accounts

A sending account is a sender’s LinkedIn profile or mailbox (`senders` guide).
Select the workspace as `references.common` describes. Do not name the provider
behind Lifty’s connection pages.

## Read

`sending_accounts_get` (`lifty get sending-accounts`, optional query
`sender_id`, `channel`) lists accounts including disconnected history. Each has:

- `status`: `connected`, `needs_reconnect` (Lifty lost access; the person must
  sign in again) or `disconnected` (explicitly removed).
- `state`: `active` or `paused`, the account's own usage switch, independent of
  `status`.
- `sending`: whether the account may send now (`allowed`) and, if not, the
  `reason`. `paused_by_member` is its own pause; `paused_by_lift` (with
  `scope`) is a LIFT hold that only LIFT releases. Campaign schedule, review
  and daily budget still apply.
- `limits`: daily limits Lifty enforces (null when none). Only LIFT changes them.
- `checked_at` and `observation.state`: the last verified provider check and
  whether it is recent enough. `unverified` means the facts are older than the
  freshness window; it is not a disconnection or a reason to reconnect. Sending
  waits for a fresh check.
- `declaration`: what the person confirmed on Lifty's connect page.
- `sends`: sends today and over the last seven days.

Reads never check or change a provider. A failed read is unknown: retry it;
never report an account as disconnected or missing from a failed read.

## Connect

1. Resolve the person with `senders_get` and use their `id` (create the sender
   first only if absent). Ask whose account it is when unclear.
2. `sending_accounts_connect` with `{"sender_id":"<id>","channel":"linkedin"|"email"}`.
   Ask nothing else: Lifty's connect page asks the person's declaration (for
   LinkedIn, that it is their habitual personal account with no other
   automation tool; for email, a mailbox they already use or a dedicated
   sending mailbox), then opens the sign-in. Google and Microsoft 365/Outlook
   are offered for new mailboxes. Use the owner’s primary mailbox; aliases and shared/delegated
   mailboxes are not supported. A sender has at most one LinkedIn account
   (`LINKEDIN_ALREADY_CONNECTED`: reconnect that one instead).
3. Show `connection_url` once as a clickable link naming the account owner; do
   not open it yourself. `created:false` with the same `id` is the same attempt.
4. Read `sending_accounts_attempt` with `path.id` and `query.wait_seconds` 25:
   it returns when the attempt changes. Follow its `action_owner`, `actions` and
   `next_step`; do not reread next_step, context or schemas meanwhile.
   `verifying` means Lifty received the sign-in and finishes it on its own, even
   with every page closed: never ask for another sign-in. A failed or timed-out
   read is unknown, not a failure.
5. For a stuck, expired or failed link, `sending_accounts_replace_attempt` with
   `path.id`, then show only `successor.connection_url`; repeating it returns the
   same successor. `sending_accounts_close_attempt` ends an attempt the person no
   longer wants. Neither disconnects an account. A failed attempt's `next_step`
   says what to do; `account_in_use` means another workspace owns the account
   and no new link fixes it. If the page says it removed an old Lifty
   connection, sign in again with the same account.
6. A connected mailbox's attempt carries `next_step`, its warmup setup: follow
   it in the same reply.

Connecting never activates a campaign or sends anything.

## Reconnect

`sending_accounts_reconnect` with `path.id` = the account `id` returns a
`connection_url` like connect. The same mailbox or LinkedIn profile must sign
in; another one fails with `identity_mismatch`. After `needs_reconnect` the
account keeps its usage state. After an explicit disconnect it comes back
`paused` until resumed. Reconnecting never resumes or activates a campaign.
`CONNECT_UNAVAILABLE` means Lifty cannot reconnect this account through its
current sign-in; ask LIFT support rather than connecting a different account.

## Pause and resume

`sending_accounts_pause` / `sending_accounts_resume` with `path.id`, only when
the user asks. Pause stops new work on that account (in-flight sends settle);
resume makes it usable again only when it is connected and every campaign gate
allows. Resume refuses a disconnected account (`ACCOUNT_DISCONNECTED`):
reconnect first. Resume never lifts `paused_by_lift`. Neither changes other
accounts or activates a campaign.

## Disconnect

Only with the user's explicit yes in this conversation:
`sending_accounts_disconnect` with `path.id` and `{"confirm":true}`. The account
is paused and disconnected at once (new sends stop; already submitted sends
keep their history and limits), then Lifty removes its access at the provider.
200 means access removal is confirmed (`access_revoked_at`) or not applicable
(`access_removal: not_applicable`: a previous tool's account; connect it again
to use it). 202 means the account is blocked and Lifty keeps removing its access
on its own: do not repeat the request; say removal is pending. Never claim
access was removed without `access_revoked_at`.
Other accounts are unaffected. To change mailboxes, connect the new one and
disconnect the old one.

## Email warmup after connection

Warmup, placement and inbox health keep their own operations. They take the
explicit `workspace` and, as `connection_ref`, the email account's `id` from
`sending_accounts_get`. With one email account, `connection_ref` can be
omitted; with several it is required and the operation returns
`EMAIL_MAILBOX_SELECTION_REQUIRED` without it. GET inputs belong in query;
POST inputs belong in body. Every workspace uses the same operations, and each
mailbox has its own warmup: starting one never stops another.

Warmup needs the owner's second sign-in. As soon as a mailbox connects,
whatever its use, call `warmup_start` once and show the returned setup link in
the same reply: until the owner finishes it, Lifty can neither warm up nor
test the mailbox. A null `connect_url` means warmup is already set up. Lifty
selects Google or Microsoft automatically, and the owner must authorize that
same mailbox. Microsoft consent opens in another tab;
keep the Lifty confirmation page open until it verifies warmup is running.
An organization may require Microsoft administrator approval. A canceled or
blocked consent does not mean warmup is running; read the same attempt's status.
Preserve existing warmup evidence during a migration until the replacement is
verified; connecting does not transfer warmup age.
Never request an App Password or route the founder to a password form.

Use the response's `mailbox_use` and `recommended_go_live` to explain what
happens next. Do not compute dates yourself.

- `personal` (a mailbox the person already uses, declared habitual): a
  lookalike-domain or outreach-only address is really dedicated, so offer
  `sending_accounts_declare`. Otherwise no initial warmup period is required.
  Warmup still protects inbox placement and reply rates alongside outreach,
  and Lifty runs the placement test once setup is done.
  Tradeoff: a warmup service gets access to the mailbox, and warmup emails and
  replies pass through the inbox. If the founder declines, do not push it;
  say Lifty cannot warm up or test the mailbox without it.
- `outreach` (a dedicated sending mailbox): warmup is required. The mailbox
  needs a healthy check after 21 active warmup days, followed by placement,
  before it can send. Lifty starts that
  placement test by itself when warmup finishes. Paused days and days with a
  problem don't count, so the date moves later if either happens. Give the
  returned date and suggest what to prepare meanwhile: targeting, copy and
  schedule.

Once the initial period is complete (`initial_period_complete: true`), warmup
keeps running while campaigns send. Warmup holds the mailbox again only if
warmup emails start landing in spam: `spam.holds_sending: true` and
`recommended_go_live.kind: "held"`. Say how many landed in spam and that
only the spam hold clears after a later sufficient measurement is below the
limit. User pauses, disconnection and placement holds remain independent.
`warmup_ready` is warmup's contribution only. Campaign activation,
placement checks and campaign or sender pauses are separate; never claim
sending is enabled from warmup status alone.
Warmup never pauses or resumes campaigns.

`warmup_start` returns the setup link. Show it as "Set up warmup for your
mailbox". The page shows the mailbox, the sender name warmup emails will use
(from the sender's profile) and one "Continue with Google" or "Continue with Microsoft" button. Lifty sets
the warmup schedule and volume; the founder fills in nothing. The page also
says when Lifty sends the initial test email from the mailbox to about 20-40 test
inboxes (right after setup for a habitual mailbox, after warmup for a
dedicated one), repeats it weekly while the mailbox is active and warmup is
running, and that continuing accepts warmup and these tests. Say so
before sharing the link. For Google, Lifty verifies the exact address before
sharing tokens once with Mailivery, without storing or logging them. For
Microsoft, Mailivery receives authorization directly and Lifty verifies the
resulting mailbox and its workspace binding before starting warmup. The setup
flow does not create another email address. If setup is unavailable, report
the actual blocker and involve support. Do not create another
account or invent a link.

After the founder finishes, Lifty verifies the mailbox and starts warmup right
away, usually within a few minutes. The setup page says warmup is starting,
then confirms it. Read `warmup_status` again before saying warmup runs; if it
still waits for authorization, read it again a minute later. Do not say Lifty
waits for a scheduled check. For a habitual mailbox the placement test starts
in the same step: the result usually comes within 20 minutes, on Slack and by
email according to the founder's notification settings.
For `mailbox_in_other_warmup`, quote `blocking_reason.message`; start again
after external removal. For `provider_rejected`, our team fixes setup first.
Pending handoffs stay locked.

`warmup_start` fails with `EMAIL_CONNECTION_REQUIRED` until a connected,
verified email account exists, and with `EMAIL_WARMUP_MAILBOX_TAKEN` when
another Lifty workspace already warms the same mailbox. It fails with
`EMAIL_WARMUP_DNS_INVALID`, without creating a link, when the mailbox domain
has no valid SPF, DMARC or MX record. Tell the founder which record the
message names and call `warmup_start` again once it is published. After a
removal, status shows `Removed`; `warmup_start` can set up a new warmup with a
new link only when previous setup is resolved. An ambiguous handoff is never
retried automatically: check status and involve support, rather than trying
another account or bypassing the setup hold.

Disconnecting the email account pauses its warmup; reconnecting the same
account clears only that suspension, after health verification. A user pause
(`user_paused`) stays until the user explicitly resumes warmup; a connection
suspension (`connection_paused`) and any spam hold are separate.
Pausing the account itself (its active switch) stops
prospect sends only; warmup keeps running.

Use `warmup_pause`, `warmup_resume` or `warmup_remove` only when the founder
asks, with the same selectors in body. Lifty applies the request at its next
check. A pending removal wins over pause or resume, and resume on a running
warmup only cancels a pending pause. For a dedicated mailbox that has not
completed its initial period, pausing or removing warmup delays sending; say
so and get an explicit yes first. Report each mailbox separately.

## Placement tests

A placement test shows where a mailbox's email lands (inbox, spam or missing)
at Gmail, Microsoft and other providers. It needs the mailbox's warmup setup.
Read
`placement_status` with the explicit `workspace` and, when the workspace has
more than one warmed mailbox, its `connection_ref`.

Lifty automatically tests a habitual mailbox once warmup runs, or a dedicated
mailbox after warmup. Setup consent covers the initial test and weekly retests;
do not call `placement_start` for them. Retests run seven days after the latest
measured result, including member tests, while the workspace, account and
warmup are active. They use one credit and the same fixed short signed email,
never campaign copy. Initial results and measured failures follow the configured
Slack/email notices; recurring passes refresh health without repeating onboarding.
Lifty allows one test in progress. Unbilled failures retry daily.

Only call `placement_start` when the user asks for another test, after they
explicitly agree to what it does.
Mailivery sends one email from that mailbox to roughly 20-40 of its seed
inboxes, and each test uses one Mailivery test credit. Use the subject and
plain-text body of the first email of the real sequence, and send
`confirm: true`. Retrying the same start returns the test already in progress.
A second test within 24 hours of a completed one is refused.

A test takes about 10-20 minutes after Lifty creates it. Read
`placement_status` again and repeat its `label`; do not compute a verdict
yourself. `uncertain` means Lifty is checking whether Mailivery created the
test and will not create a second one. `did_not_run` is not a placement
result.

When `gates_sending` is true (LIFT client mailboxes), the mailbox can send
campaign email only with a passing test from the last 10 days, after 21 active
warmup days and an explicit operator release. A passing test never releases the
mailbox or starts campaigns by itself. For founders it is advisory.

## Inbox health

For inbox health, recent placement tests or readiness dates, use
`deliverability` with the explicit `workspace` in query. Add `sender` (an `id`
from `senders_get`, or `unassigned`) or `mailbox`; add `detail: placement` with one
`mailbox_ref` only when the stored test reports are needed. Follow
`next_cursor` until it is null before describing all inboxes.

Report each inbox's `label`, `description` and `reasons` as returned; do not
recalculate health, readiness or dates. Lead with `status` and `next_step`
(`owner` says who acts). A pending or failed test run is not a
placement result, a configured campaign is not evidence of sending, and
missing or out-of-date evidence is not healthy. Workspace health covers the
whole workspace, not one inbox. This read never starts a test or
changes sending; propose those only as separate, explicitly requested actions.

## Campaigns and accounts

Campaigns refer to senders. Which of a sender's mailboxes sends is a campaign
decision; a reconnected or replaced mailbox never changes an approved
campaign. A connected account does not authorize any email, message or
invitation: use campaign previews and explicit approval/activation.
Connection can proceed while the sample or new research waits for the weekly
reset.


## Resume campaigns after disconnect

Read `disconnect_pause.count` and `can_resume`. Once the same LinkedIn profile
is connected, active and free of holds, obtain explicit confirmation for
`sending_accounts_resume_campaigns` (`lifty post sending-accounts resume-campaigns`):
`{"path":{"id":"ACCOUNT_UUID"},"body":{"confirm":true}}`.
Report each blocked result; other pauses stay. First steps become due now;
follow-ups keep receipt-relative timing. Retries reuse actions. An absent count
means recovery is unavailable, not zero.
