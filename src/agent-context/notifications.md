# Notifications

Purpose: choose notification activity sources and delivery destinations, pause a
workspace, and authorize Slack when Slack delivery is wanted. Read `references.common` and
`references.connections` in full.

## Read current state

GET without `attempt_ref` reads Slack status, the notification `types` and the
`destinations`, plus `controls` when the shared controls migration is installed.
`controls.global` and `controls.workspace` contain `enabled`, activity `sources`
(`email`, `linkedin`), allowed delivery `channels` (`slack`, `email`) and `version`.
Global restrictions win; a workspace cannot override them. Each type has a `code`, a `name`, the `channels` that can show
it (`slack`, `email`), `default_on`, `email_fallback` and `paused` (LIFT paused
that type for every workspace; skipped notices are never sent later), plus
`email_explicit` when the workspace has made an explicit destination choice.
Each destination is a saved Slack channel (`address` is its channel ID) or the
workspace owner's email (`channel: email`, with `address` and `name` null).
Its `types` lists the codes it receives; `active: false` means Lifty stopped
posting there, for example because the channel was archived. A Slack `name`
can be null: name the channel by its ID then. The supporting `channels` GET
lists Slack channels currently available to Lifty. Workspace/channel IDs and
names are private authenticated data.

New types can appear at any time. Use the codes and names this read returns;
never assume a fixed list.

## Where notifications go

Every workspace has one email destination: the owner's Lifty login address.
Email needs no setup. A type with `email_fallback` reaches that email only
while no active Slack destination receives it; once a Slack channel receives
it, the email stops. A type whose `channels` lists only `slack` is never
emailed. Replies retain legacy fallback only without connected active Slack;
turning their Slack route off does not itself enable an email. Explicit Email or
Both overrides fallback, while explicit Off never falls back to email.

Activity source and receipt are independent: LinkedIn activity may arrive by email.
Neutral workspace/leads/CRM notices are not guessed from a contact profile.
Pausing preserves preferences and never resumes outreach or replays skipped notices.

`notifications_controls_set` takes `body` with `enabled`, `sources`, `channels`
and `expected_version` from the latest workspace controls read. Lists must be
nonempty and unique; use `enabled: false` to pause. The workspace is the current
selection; do not send a workspace ID. A stale edit returns
`NOTIFICATION_SETTINGS_CHANGED`: read again before trying another change.

`notifications_preferences_set` takes `body` with `notification_type`, `channels`
and `slack_destination_ref`. Choose `channels: []` and a null Slack ref for Off;
`["email"]` and null for Email; `["slack"]` or `["slack","email"]` with the saved
Slack destination ref for Slack or Both. Only supported type channels are accepted.
This atomically replaces that type's workspace destinations and returns the saved
configuration. Email/Off do not require a Slack connection.

## First setup and required inputs

POST with an empty object starts Slack workspace consent. Immediately show
the actual returned link, then verify its exact `attempt_ref` with GET after
authorization. The founder selects the Slack workspace in the consent screen;
do not request tokens or infer authorization from channel data.

After verified authorization, read `channels` and obtain only the missing
channel choice. Explain when Lifty needs to be invited to a private channel.
In MCP, `notifications_destination_upsert` takes `body` with the actual
`channel_id` and `channel_name` and returns the saved destination. A new
channel already receives every default-on type Slack can show (its `types`);
change that only when the founder asks. Saving an existing channel again
updates its name and reactivates it.

`notifications_route_set` takes `body` with `notification_type` (a type
`code`), `destination_ref` and `enabled`: `true` subscribes that destination
to the type, `false` unsubscribes it. It works for the owner email destination
too and returns the updated destination. Each tool performs only its named
operation; do not include an `operation` selector or `values` wrapper. Read
`notifications_get` to confirm the saved setup.

The CLI and HTTP API retain PATCH with `operation: destination` or
`operation: route` and the corresponding fields inside `values`. They also accept
`operation: controls` or `operation: preferences` with the fields above in `values`.
HTTP clients can PUT the same fields to `/v1/notifications/controls` or
`/v1/notifications/preferences`. No global controls are exposed to founders.

## Later edits

Use the matching MCP tool, or the existing CLI/HTTP PATCH, for later changes. Reconnect
Slack via a fresh POST and verify its exact attempt; old healthy Slack state
does not prove completion. PATCH cannot authorize Slack or set connection state.
`test` posts one visible test message to a saved Slack destination, active or
not; send it only when the founder asks to check a channel. Its `request_ref`
means Lifty accepted the request, not that the message arrived: ask the
founder to look in the channel. The email destination cannot be tested.
`disconnect` removes the Slack grant from the current workspace after the
founder confirms; Slack notifications stop until Slack is reconnected.

## User-facing behavior and errors

Describe which notification types reach which Slack channel or the founder's
email, by the names the read returns. Saving a channel and sending a test need
connected Slack: `SLACK_NOT_CONNECTED` or `SLACK_RECONNECT_REQUIRED` means
connect or reconnect it first. `DESTINATION_NOT_FOUND` and
`NOTIFICATION_TYPE_UNKNOWN` mean re-read notifications and use its current
refs and codes. `NOTIFICATION_CHANNEL_UNSUPPORTED` means that type cannot go to
that destination's channel; `DESTINATION_NOT_TESTABLE` means only Slack
destinations take a test. Refresh channel/state reads before retrying. Follow
the common pending/expiry/denial/reconnection rules; a failed status request
means authorization could not be verified, not disconnected. Connecting Slack
does not authorize sending outreach or a test message.
