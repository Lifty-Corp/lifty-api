# Senders

A sender is a named person who sends outreach: the founder or someone on their
team. Every LinkedIn account and mailbox belongs to exactly one sender. A sender
has at most one LinkedIn account and any number of mailboxes. The sender exists
before any account is connected; connecting never creates a person.

Every workspace uses the same senders and operations.
Send the chosen workspace as `references.common` describes.

Senders follow the workspace's Journeys: no campaign chooses them. Every person
with a counted account on a Journey's channel takes part in its new Journeys
(`lifty context campaigns`).

## Find the person first, then use their id

1. Read `senders_get` (`lifty get senders`) in the selected workspace.
2. Find the person the user named in that roster and keep the returned `id`.
   Use it as `sender_id` for account operations and as `path.id` for sender
   edits. Names help you find the row; they are never identifiers.
3. Treat the same full name in the same workspace as the same person and reuse
   that id, unless the user says it is someone else. Ask only when several
   people match or the user names another person.
4. Create a sender with `senders_post` only when the person is absent, then use
   the `id` that creation returns. Do not call `senders_post` to look someone
   up: it always creates a new person, and two people may share a name.

The first sender is usually the founder: use the saved name of the person who
created the account unless the founder says otherwise. Ask "whose account is
this?" before connecting; do not run a separate setup step.

After a lost `senders_post` response, read the roster before retrying; never
assume a same-name row proves your request was saved.

## Fields

- `name`: the person's name, 1–200 characters, no `@`, not "linkedin" or
  "email". Never name a sender after a mailbox or a channel.
- `signature` (email only): the founder's own words, plain text of at most 500
  characters, no HTML, links only with `https://`. Never write, suggest,
  complete or polish it, and add nothing they did not write. If they want only
  their first name, that is the whole signature. A person's mailbox takes part
  in email only while they have a signature. Each lead keeps the signature its
  person had when its Journey started, so an edit signs only Journeys that
  start afterwards and needs no campaign re-approval; emails already approved
  keep exactly the text they were approved with.
- `booking_url`: optional `https://` link writers may use.

Sending schedules and timezones belong to campaigns, not to senders.

## Edit

`senders_patch` with `path.id` and body `expected_version` plus the fields to
change. Omitted fields stay; `null` clears `signature` or `booking_url`.
`VERSION_CONFLICT` writes nothing: read the roster again and reapply the
intended edit. A changed signature redoes previews of leads whose Journey has
not started (`recomposing` counts them); show the new previews before
approving them. Started Journeys keep their signature.

## Pause, retire and turn on

Only with the founder's explicit yes. `sending` in the roster says where a
person stands: absent means they send normally, `paused` keeps their work, `off`
means retired. Never choose between pause and retire yourself.

**Pause** a person who is away, or who has nobody to take over:
`senders_pause` (`lifty post senders pause`) with `path.id` and
`{"expected_version":…,"confirm":true}`, plus their own `reason` if they give
one. They keep every lead and account, take no new leads and nothing automatic
sends on either channel, including automatic replies. Inbound is still captured
and someone can still answer by hand. A pause never turns into a retirement.
`SENDER_OFF` means the person is already retired.

`senders_resume` (`lifty post senders resume`) with
`{"expected_version":…,"confirm":true}` ends that pause and nothing else. Read
`participation.next_step` afterwards: an account can still be stopped for
another reason, and a member never resumes a Lifty stop. Only LIFT releases it.

**Retire** a person who left, once someone can take over:

1. Read `senders_get`. The founder chooses the target: another person who is on
   and not paused (no `sending` object). Never choose it yourself.
2. `senders_transfer_scope` says what to expect: `not_contacted` would move and
   `conversations` would wait for a sample; `replies` are inside `conversations`.
   Never add the groups or call them all the person's leads, and never promise
   exact numbers: it is an estimate made before the target is chosen.
3. `senders_turn_off` (`lifty post senders turn-off`) with `path.id` and
   `{"expected_version":…,"confirm":true,"reason":"…","drain_to_sender_id":"…"}`.
   The reason is the founder's own words, 1–500 characters.

`DRAIN_TARGET_INVALID` changes nothing: the target is this person, deleted,
off, paused or not in the workspace. With nobody to choose, offer a pause.

A retired person shows `sending.state: "off"`, stops at once, takes part in no
new Journey and sends no outreach. Their accounts stay connected, report cause
`sender_off`, and replies keep arriving. Untouched leads move to the target
under ordinary rules. Contacted conversations and current replies stay with the
source until a sample is approved (see Handoffs), and `drain.handoff_ref` names
that handoff. `sending.pending_transfer.handoff_ref` keeps naming it on later
reads: while it is set, open that handoff and never offer to retire them again.
Retiring never deletes, disconnects or sends by itself.

The response's `drain` is the first batch: `outcomes` counts leads `moved`,
`closed` (nothing left to send), `skipped`, `waiting_send` (a send in flight
settles first), `waiting_sample_approval` or `error`, and `remaining` counts
leads still to move. Lifty drains the rest and retries errors on its own;
`sending.leads_remaining` shows progress. `drain.state` `target_unavailable`
means the target was deleted, turned off or paused meanwhile: retire the person
again with another target. `waiting_customer_list` means the customer list holds
outreach until it is current (`lifty context customer-exclusions`).

After an uncertain response read the roster before retrying:
`sending.state: "off"` means it was saved.

With the founder's yes, `senders_turn_on` (`lifty post senders turn-on`) with
`{"expected_version":…,"confirm":true}` lets the person take part in new
Journeys again. Leads already moved stay with their target.

## Handoffs

A handoff moves contacted conversations to another person after the founder
approves a real sample. Retiring a person opens one, and inbox recovery can open
one when that person has no other healthy inbox.

1. `senders_handoff_get` (`lifty get senders handoff-get`) with `path.handoff_ref`.
   Drafts prepare on their own; `senders_handoff_prepare` asks again and never
   approves. `sample_complete: false` means drafts are still arriving: read
   again later.
2. Show the source, the replacement, the `samples` with their real text and the
   `cohort_count`. `held_for_human` counts conversations a person must answer:
   say so. Each member's `dispatch_reason` says why its first message would wait.
3. To change the writing, `senders_handoff_settings_revise` redrafts everything;
   `senders_handoff_reply_revise` edits one current reply. Either needs approval
   again, and so does any new inbound message.
4. Only with the founder's explicit yes to this sample, `senders_handoff_approve`
   with `action`, `confirm:true`, both sender ids and the `revision` and hashes
   you just read. One approval covers the sample and each remaining first
   message, never a future reply. A `HANDOFF_*_STALE` refusal means read again and
   show what changed; `HANDOFF_SAMPLE_INCOMPLETE` means wait.

Approved and queued are not sent. Never say a message went out from a handoff
read: messages go on their schedule under the usual checks. `senders_handoff_cancel`
ends a waiting handoff; leads that already moved stay moved. An approved handoff
cannot be canceled (`HANDOFF_ALREADY_APPROVED`).

## Technical recovery

`sending_accounts_incidents_get` lists inbox failures Lifty is watching. Show each
`next_step.label`. `due_at` is the earliest Lifty may act: 24 hours after a severe
failure, two business days after a recoverable one. Never promise that work will
move: that depends on things you cannot see. `counts` is a plan and can be null;
only `moved` says work moved. With no other healthy inbox of the same person,
contacted work waits for a sample, and `handoff_ref` is the handoff above.
`handoff_pending` says that sample still waits, even after the inbox recovered.
Reconnecting never brings moved work back, and a voluntary pause is never a failure.

A notification's link reads `sending_accounts_action` with `path.id` and
`query.action` (`reconnect`, `warmup`): whether it still applies and which
operation does it. Opening it changes nothing; another workspace's account is 404.

## Who gets new leads

`senders_settings_get` reads the workspace's choices; `senders_settings_patch`
changes them with `expected_version` (0 until the first save). `assignment.mode`
is `equal` (default), `founder_weight` (the founder gets twice the share) or
`tier_a_founder` (Tier A leads go to the founder). Both of the last two need
`founder_sender_id`. `handoff.sample_size` is how many conversations a handoff
shows, 1 to 100, default 5. `review` is the review policy (`lifty context
campaigns`). Leads already assigned stay with their person.

## LIFT stops

Operators use `senders_stops_get`, `senders_stop_set`, `senders_stop_release` and
`senders_stop_review`. Members get `ADMIN_REQUIRED`: never offer these to a
founder. Tell them what `participation.next_step` says instead.

## Delete

Delete only when the person leaves the roster for good, and only with the
founder's explicit yes: `senders_delete` (`lifty post senders delete`) with
`path.id` and `{"expected_version":…,"confirm":true}`. The person
leaves the roster and every account they own is disconnected exactly like
`sending_accounts_disconnect`; history stays and it is not reversible.
200 means Lifty's access was removed from every account. 202 means the accounts
are already blocked and Lifty keeps removing access at the provider on its own
(`access_revoked_at: null`): do not repeat the request; tell the founder removal
is pending. Never claim access was removed without `access_revoked_at`.

A deleted sender cannot receive connections or take part in new Journeys.
Removing or replacing a person's account does not hand over their leads.
Technical recovery may act on a lost inbox, and only `moved` says it did.
When leads wait on a person's lost account and their outreach has not started,
move them with `lead_reassign_post` (`lifty context campaigns`); it never moves
contacted leads. To hand over every admitted lead of a person, contacted or
not, retire them with a target.
