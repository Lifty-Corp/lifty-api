# LinkedIn

LinkedIn outreach sends a connection invitation without a note from the
sender's own LinkedIn account. After the person accepts, Lifty sends the
Campaign's saved messages in order, with the Campaign's delays and schedule.
Send the chosen workspace as `references.common` describes.

## Who owns what

- **Campaigns** (`lifty context campaigns`) own the sequence, the message
  content, the schedule, the permitted senders, approval, activation and pause.
  Change LinkedIn outreach there; this stage has no settings.
- **Sending accounts** (`lifty context sending-accounts`) own each person's
  LinkedIn account and connecting it. Connect with
  `lifty post sending-accounts connect --input -` and
  `{"body":{"sender_id":"<sender id>","channel":"linkedin"}}`
  (`sending_accounts_connect`), show the returned link, then read that attempt
  with `lifty get sending-accounts attempt --input -` and
  `{"path":{"id":"<attempt id>"},"query":{"wait_seconds":25}}`.
- **LinkedIn** (this stage) reports what was done and why work waits.

Connecting an account never starts outreach. LinkedIn work runs only for an
approved, active Campaign that permits that sender.

## People already connected to the sender

Lifty sends them no invitation. Their first message waits for review. Read
`lifty context campaigns` for `reviews_get`, the exact saved message and its
history, immutable corrections and `message_review_post`. The Lifty dashboard
uses the same review workflow. Show the saved message and exact account to the
founder, then record only the decision they request. Nothing is sent before
approval. Skipping stops LinkedIn for that person only; an Email Campaign of
the same Journey that is already active can still start for them.

## Read activity

`linkedin_get` (`lifty get linkedin`, optional query `sender_id` from
`lifty get senders`) reports the workspace and each of its LinkedIn accounts,
including paused and disconnected ones so past work stays counted:

- `today` (since 00:00 UTC) and `last_7_days` (the past seven days, today
  included): the same periods as the Senders page.
- Four counts in each: `invitations_sent`, `invitations_accepted`,
  `messages_sent` and `replies_received`. They count confirmed events, not
  people: two replies from one person count twice. Queued or uncertain sends
  do not count until confirmed. An existing connection is not an accepted
  invitation, and earlier conversation shown for review is not a reply.
  The top-level totals count each event once.
- Each account's `id` and `sender_id`, its connection `status` and usage
  `state` (as in `sending-accounts`), and its `waiting_reason`.

With `sender_id`, the top-level totals and `accounts` cover only that
sender's LinkedIn account. A sender without a LinkedIn account returns no
accounts and zero counts; those zeros are real. `SENDER_NOT_FOUND` means the
sender is not in this workspace or was deleted. `LINKEDIN_STATUS_UNAVAILABLE`
means the read failed: retry it, and never report zero activity or a stopped
account from a failed read.
Reading never changes anything: it does not contact LinkedIn or start, retry
or release work.

## Why work waits

`waiting_reason` is null when nothing is due or the account is sending
normally. Otherwise it says why the account's due LinkedIn work waits:

- `prior_campaign_running`: an earlier LinkedIn Campaign on this account is
  still running; its LinkedIn work finishes first, then this one starts.
  Expected. A paused earlier Campaign still counts as running.
- `awaiting_review`: a first message to an already-connected person waits for
  review. Read the saved queue with Campaigns `reviews_get`, show the exact
  message and account, and ask the founder for their decision. They can also
  review it in the Lifty dashboard.
- `outside_schedule`: the Campaign's sending hours are closed. Expected; work
  continues in the next window.
- `daily_limit_reached`: the account reached its daily LinkedIn limit.
  Expected; work continues on a later day. Lifty sets these limits.
- `campaign_paused`: the Campaign is paused. Activating it again continues the
  work, only when the founder asks.
- `account_paused`: the account is paused. Resume it with
  `sending_accounts_resume`, only when the founder asks.
- `account_needs_attention`: Lifty cannot use the account now. Read
  `lifty get sending-accounts`: a `needs_reconnect` account (or a
  `disconnected` one the founder wants to use again) needs
  `sending_accounts_reconnect`; a connected account shown as `unverified`
  waits for Lifty's next check and needs no reconnect.
- `on_hold`: Lifty is holding this account's work while it checks something
  internally, such as whether an earlier send went through. Nothing to change;
  if it lasts, contact LIFT support. Never reconnect or retry because of it.

There is no exact time to report for waiting work; do not promise one.
