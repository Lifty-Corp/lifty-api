# MCP tool effects and review annotations

Tool descriptions and hints must describe the complete operation, including
defaults and downstream work. A successful save can confirm configuration or
accepted work without proving that research, compilation, CRM delivery or
outreach completed. Authentication, workspace membership, version checks and
saved Campaign approvals remain enforced by their owning handlers.

The [OpenAI annotation rules](https://developers.openai.com/plugins/plugin-guidelines#correct-annotation)
require explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` values.
Private revision history does not make replacing an effective resource additive.
A bounded connected CRM account is private scope; public prospect acquisition
and contact with external recipients are open-world effects.

## Audited operation contracts

Tuple order is read-only / destructive / open-world. Hints describe the complete
operation, including persisted provider maintenance and enabled scheduled work.

| Tool | Hints | Complete requested effect |
| --- | --- | --- |
| `targeting_patch` | false / true / false | Changes effective private search lanes; can remove lanes and replace criteria transactionally. |
| `setup_patch_draft` | false / true / false | Replaces the complete effective setup draft and generated criteria, retaining prior revisions. |
| `sample_review_progress` | true / false / false | Bounded, authenticated polling of one saved run and its existing cohort. |
| `sample_review_get` | true / false / false | Reads the saved current sample, grades, state and review marker. |
| `sample_review_post` | false / true / true | Queues prospect discovery/research, reattaches active work or retries an incomplete failed sample. |
| `research_schedule_patch` | false / true / false | Replaces the effective weekly target; does not activate research. |
| `research_schedule_activate` | false / true / true | Saves active research intent; later scheduled cycles acquire and research public prospects. |
| `leads_list` | true / false / false | Lists existing tenant research results; does not acquire or enrich leads. |
| `crm_sync_start` | false / true / false | Queues creation/update of eligible saved leads in the connected CRM and configured research mirrors. |
| `crm_mapping_sources` | true / false / false | Reads saved evidence for the explicit tenant-owned cohort. |
| `crm_mapping_preview` | false / true / false | Computes proposed mapping values against existing records; can replace stored CRM credentials or connection health. |
| `crm_mapping_catalog` | false / true / false | Reads the full saved mapping and live provider schema with the same credential maintenance. |
| `crm_records` | false / true / false | Verifies existing synced record identities and links with the same credential maintenance. |
| `crm_mapping_context`, `crm_client_mapping_context` | false / true / false | Reads bounded live HubSpot company schema/mapping with the same credential maintenance. |
| `crm_mapping_sync` | false / true / false | Queues bounded existing-record updates; approved write policies can overwrite populated fields. |
| `journeys_activate` | false / true / true | Selects an approved revision for new starts; active Campaigns can subsequently contact recipients. |
| `campaigns_activate` | false / true / true | Selects an approved revision and active intent, or resumes retained work that can contact recipients. |
| `campaigns_post` | false / false / false | Adds an inactive, unapproved private Campaign draft. |
| `campaigns_draft_patch` | false / true / false | Replaces the effective unapproved draft and refreshes default Business/current sender revision pins. |
| `sending_accounts_resume` | false / true / true | Resumes an existing account; already active approved Campaigns may automatically send pending work to external recipients. |
| `campaigns_review_settings_patch` | false / true / true | Saves channel review choices; send-and-sample enables future unflagged drafts to send automatically under existing Campaign and safety gates. Existing pending drafts remain held. |
| `notifications_connect` | false / true / false | Starts a Slack consent attempt and supersedes earlier unused pending links; does not replace the existing grant or post messages. |
| `notifications_destination_upsert` | false / true / false | Saves a Slack channel destination, or renames and reactivates the saved one, while Slack is connected. A new destination receives every default-on type Slack can show; a type that falls back to email stops reaching the owner's email while an active Slack channel receives it. Posts nothing. |
| `notifications_route_set` | false / true / false | Subscribes or unsubscribes one destination, a Slack channel or the owner email, to one notification type; affects future notifications only. |
| `notifications_test` | false / true / true | Asks the notifications service to post one visible test message in a saved Slack channel. The returned `request_ref` is acceptance, not delivery. |

## Description and schema boundaries

- Setup draft saves require the complete `draft`. `generated_criteria: null`
  clears the effective criteria; this is not a partial-field patch.
- Sample starts return accepted/queued work. Use progress or sample reads to
  verify completion; reattachment and incomplete failed-run retry are distinct.
- New CRM sync cohorts contain at most 2,000 eligible saved leads. Active runs
  reattach and failed runs retry their saved cohort. Mapping replay accepts at
  most 25 explicit leads and reuses the exact receipt for an identical
  `request_ref`; it does not create records.
- Campaign draft edits use current confirmed `profile_version` and
  `voice_version` when those fields are omitted, and pin current permitted
  sender revisions. Existing approved execution remains pinned.
- Journey and Campaign activation receipts confirm saved selection/intent.
  Scheduled execution can contact external recipients after the existing
  readiness, account, customer-list and incident gates permit it.
- Resuming an account removes its paused state, allowing already approved
  active Campaigns to send when all existing gates permit it. It does not
  approve or activate a Campaign or release separate sending holds.
- Channel review choices affect new drafts. `send_and_sample` permits future
  automatic external-recipient sends; risk holds and existing pending drafts
  remain protected. A 0% rate disables post-send sampling, as implemented by
  LIF-1360; it does not remove pre-send review or risk holds.
- Slack connection requests replace earlier unused pending consent links.
  Recover an uncertain request through its exact attempt when known. MCP
  discovery names this operation `notifications_connect`; cached
  `notifications_post` calls remain compatible through the same route and
  strict input/authentication checks. HTTP/CLI POST is unchanged.
- Notification type codes are validated by shape, not by a fixed list: the
  `notifications` schema owns the catalog, refuses unknown codes and refuses a
  type on a channel that cannot show it. Route and test writes check the
  destination against `notifications.get_configuration` first.
- The research target RPC accepts one-to-nine-digit positive integers before
  checking the workspace's plan limit. The API maximum is therefore
  `999999999`, not the wider PostgreSQL integer bound; `null` still follows the
  plan's full limit.

## Provider-session maintenance boundary

Mapping previews do not save mappings, enqueue delivery or write CRM records.
Their shared provider transport can replace stored OAuth credentials and mark
an invalid connection as needing reconnect. The same effects occur in live
catalog, record verification and company-context reads. These operations are
therefore annotated as writes under OpenAI's no-environment-mutation rule;
overwritten credential/health state justifies the destructive hint. The bounded
connected private CRM remains closed-world. This synchronous maintenance uses
existing authorization; it is not a new CRM business write or an asynchronous
job. Saved source, sync-status and mapping-status reads remain read-only.
See [transport.ts](../src/crm-mapping/transport.ts) and the bounded company
[runtime.ts](../src/company-mapping/runtime.ts). An earlier session-maintenance
interpretation is superseded by the complete persistence effects above.

## Source and verification

Operation owners are [business-operations.ts](../src/business-operations.ts),
[research-operations.ts](../src/research-operations.ts),
[outreach-operations.ts](../src/outreach-operations.ts),
[identity-operations.ts](../src/identity-operations.ts),
[member-review-operations.ts](../src/member-review-operations.ts),
[stage-contracts.ts](../src/stage-contracts.ts) and
[mcp-stage-tools.ts](../src/mcp-stage-tools.ts).

The backing Functions migrations are
`20261002120000_lif1173_business_resources.sql`,
`20261002131000_lif1174_research_schedule.sql`,
`20261002132000_lif1174_runs_and_outreach_gate.sql`,
`20261004110000_lif1188_outreach_operations.sql`,
`20261005234000_lif1247_full_plan_target.sql`,
`20261006150000_lif1238_attio_self_service.sql` and
`20261008090000_lif1128_activation_hold.sql`. Scheduled work is owned by Jobs'
`lifty-first-run`, `lifty-crm-sync`, `lifty-crm-mapping-sync` and
`lifty-workspace-outreach` tasks. Source inspection does not prove a sibling
revision is deployed.

Account resumption is implemented by
`20261003100000_lif1182_identity_resources.sql`; its paused-account blocker is
consumed by `20261004130000_lif1188_native_runtime.sql` and Jobs' scheduled
`lifty-email` dispatch. All existing readiness, suppression, incident and final
send fences still apply.

Notification configuration (LIF-1464) uses the `notifications` schema's
customer-edge functions `get_configuration`, `save_slack_destination` and
`set_subscription`, owned by lift-gtm-services migrations; test sends are its
`notifications-test` Trigger task.

Channel review choices and future automatic approvals are implemented in
`20261007190200_lif1287_channel_review_policy.sql`; LIF-1360's subsequent
sampling migration preserves 0% support. Slack attempt supersession is owned
by `20260916203147_lif890_exact_connection_attempts.sql`.

Existing MCP catalog/HTTP tests protect schemas, annotations, authentication
and dispatch. The research invalid-input table rejects a ten-digit target
before an RPC. Run `npm run verify` before releasing changes. A generic scan
finding requiring further review does not identify a particular failed rule;
only a fresh scan of the deployed definitions can show its next result.
