# Notifications

Purpose: authorize Slack, choose Slack channels and decide which notification
types reach each destination. Read `references.common` and
`references.connections` in full.

## Read current state

GET without `attempt_ref` reads Slack status, the notification `types` and the
`destinations`. Each type has a `code`, a `name`, the `channels` that can show
it (`slack`, `email`), `default_on`, `email_fallback` and `paused` (LIFT paused
that type for every workspace; while paused its notifications are skipped and
never sent later).
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
emailed.

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
`operation: route` and the corresponding fields inside `values`.

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
