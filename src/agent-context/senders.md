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

## Turn a person off or on

When a person should stop sending (they left, are away, or their leads belong
with someone else) turn them off instead of deleting them: they stay in the
roster and keep every account connected, so replies keep arriving. Only with the
founder's explicit yes and the person who takes their leads:

1. Read `senders_get`. The founder chooses the target: another person in the
   roster who is on (no `sending` object). Never choose it yourself.
2. `senders_turn_off` (`lifty post senders turn-off`) with `path.id` and
   `{"expected_version":…,"confirm":true,"reason":"…","drain_to_sender_id":"…"}`.
   The reason is the founder's own words, 1–500 characters.

A person who is off shows `sending.state: "off"`, takes part in no new Journey
and sends no outreach; their accounts report participation `paused` with cause
`sender_off`. Their admitted leads drain to the target: each lead's run ends and
the target starts one with only the channels that prospect never received
(`drain_mode` `unused_channels`); a lead with nothing left to send keeps no run.
`continue` is not available yet (`DRAIN_MODE_UNAVAILABLE`). Turning off never
deletes, disconnects or sends by itself; the target's new runs send on the
target's normal schedule.

The response's `drain` is the first batch: `outcomes` counts leads `moved`,
`closed` (nothing left to send), `skipped`, `waiting_send` (a send in flight
settles first) or `error`, and `remaining` counts leads still to move. Lifty
drains the rest and retries errors on its own; `sending.leads_remaining` in the
roster shows progress. `drain.state` `target_unavailable` means the target was
deleted or turned off meanwhile: turn the person off again with another target.
`waiting_customer_list` means the customer list holds outreach until it is
current (`lifty context customer-exclusions`). `DRAIN_TARGET_INVALID` writes
nothing: the target is this person, deleted, off or not in the workspace.

After an uncertain response read the roster before retrying:
`sending.state: "off"` means it was saved. Turning off a person who is already
off, with their current version, changes the reason or target.

With the founder's yes, `senders_turn_on` (`lifty post senders turn-on`) with
`{"expected_version":…,"confirm":true}` lets the person take part in new
Journeys again. Leads already drained stay with the person they moved to.

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
Removing or replacing a person's account never moves their leads on its own.
When leads wait on a person's lost account and their outreach has not started,
move them with `lead_reassign_post` (`lifty context campaigns`); it never moves
contacted leads. To hand over every admitted lead of a person, contacted or
not, turn them off with a target.
