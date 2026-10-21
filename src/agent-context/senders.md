# Senders

A sender is a named person who sends outreach: the founder or someone on their
team. Every LinkedIn account and mailbox belongs to exactly one sender. A sender
has at most one LinkedIn account and any number of mailboxes. The sender exists
before any account is connected; connecting never creates a person.

Every workspace uses the same senders and operations.
Send the chosen workspace as `references.common` describes.

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
  their first name, that is the whole signature. Lifty signs each email when
  the campaign version is prepared; emails already approved keep exactly the
  text they were approved with.
- `booking_url`: optional `https://` link writers may use.

Sending schedules and timezones belong to campaigns, not to senders.

## Edit

`senders_patch` with `path.id` and body `expected_version` plus the fields to
change. Omitted fields stay; `null` clears `signature` or `booking_url`.
`VERSION_CONFLICT` writes nothing: read the roster again and reapply the
intended edit. A changed signature recomposes still-unapproved previews
(`recomposing` counts them); show the new previews before approval.

## Delete

Only with the founder's explicit yes: `senders_delete` (`lifty post senders
delete`) with `path.id` and `{"expected_version":…,"confirm":true}`. The person
leaves the roster and every account they own is disconnected exactly like
`sending_accounts_disconnect`; history stays and it is not reversible.
200 means Lifty's access was removed from every account. 202 means the accounts
are already blocked but removal at the provider is not confirmed yet
(`access_revoked_at: null`): repeat the same request a few times with short
waits; no new consent is needed. If it is still unconfirmed, tell the founder
the accounts are blocked and removal is pending, and repeat it later on the same
sender. Never claim access was removed without `access_revoked_at`.

A deleted sender cannot receive connections or be chosen for campaigns.
Removing or replacing a person's account never moves their leads to someone
else.
