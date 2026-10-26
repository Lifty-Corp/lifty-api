# LIFTY API agent operations

DigitalOcean App Platform is the primary hosted runtime. Agents should use the
checked-in npm commands instead of copying app IDs, ingress URLs, or app specs
into prompts:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:smoke
npm run do:deploy -- <full-40-character-sha>
```

These are alternatives for the relevant operation, not a checklist to run on
every release. Merging runtime changes to `main` already starts the `Deploy`
workflow: follow that run instead of invoking `do:deploy` again. The workflow
runs `npm run verify` (or reuses a passing pull request Verify run on the
identical tree), checks the exact active commit and runs the public smoke
suite. Reuse that evidence; add a focused authenticated/compatibility probe only
when the changed behavior requires it. Preserve any database-first dependency.
Human documentation-only pushes do not deploy; packaged Markdown under `src/`
still does. For local human documentation changes, prose/link/diff checks are
enough. Code and deploy-tooling changes require `npm run verify`; reuse a passing
result for unchanged inputs instead of rerunning before each commit.

`do:deploy` is pinned to `lifty-api-staging`, its single `api` component, the
LIFTY API GitHub repository, and `main`. It verifies that the supplied SHA is
the current remote branch head, starts one deployment, waits, verifies the
exact active commit, and runs the public smoke suite. If retired-provider API
keys remain in the app or API component environment, it removes only those
entries and deploys the filtered live spec with current source in that same
deployment; otherwise it creates the deployment without reapplying the spec.
Other environment entries, including encrypted values, are preserved. It does
not upload unpushed local changes. An optional
`LIFTY_DO_APP_ID` is treated as an assertion and must match the app resolved by
name.

Build reuse is enabled by default. Use `do:deploy -- <full-sha> --force-rebuild`
only when diagnosing a stale build/cache or when a clean rebuild is explicitly
required. While retired environment cleanup is pending, `--force-rebuild` is
rejected before mutation because the source/spec update is the single deployment.
Unknown deploy flags are rejected. A successful `do:deploy` already
includes status and smoke checks; do not repeat them immediately afterward.

`do:logs` intentionally accepts only bounded `--tail N` and `--type TYPE`
options. Agents must not forward global `doctl` credential, config, or trace
flags through the repository script.

Never print the live app spec or environment values into logs. A machine or
agent needs `doctl`, `jq`, `curl`, and an authenticated DigitalOcean context;
deploys additionally need `git`. `npm run do:doctor` verifies the runtime
prerequisites without exposing the token.

The app name includes `staging`, but it uses shared GTM production Auth/database.
Juan's LIF-1097 decision on September 28, 2026 keeps connector rehearsal in this
environment; do not create another environment. Authenticated canaries require
an explicitly authorized internal workspace and seed data, and must stop before
live sending. Confirm the actual target and issue scope first. Public health
and fail-closed authentication smoke checks are safe.

## Installed clients and context

Every task context the agent reads comes from this API (`src/agent-context`),
so an API change ships its context change in the same PR and reaches every
founder on deploy. Do not change `STAGE_CLIENT_CONTRACT` for an API or
context release: it names the transport installed clients implement, and
changing it forces every founder to update the skill (LIF-1293). Keep
`tests/installed-client.test.ts` passing; a failure means the change breaks
installed clients. Change the contract only with a deliberate client release.

## Admin onboarding read

`GET /v1/admin/onboarding` (LIF-1297) lists every workspace through the
admin-only `admin_list_workspaces()` and computes each one's next_step with
the caller's own session, naming that workspace (`AuthSession.workspaceRef` →
`p_workspace_id`). Founder sessions never set it, so their reads are
unchanged. Its HubSpot, Attio and CRM sync reads need the Functions migration
`20261006200000_lif1297_admin_workspace_crm_reads.sql` first; deploy the
database through its production-database job before this API revision.
Identity reads forward the named workspace too; `get_lifty_senders` already
accepts it, so the Part 2 roster read (LIF-1302) needs no migration. Parts 3
and 4 (LIF-1260) read each mailbox's warmup and placement status and the
research schedule's plan; admins may read that status only after the Functions
migration `20261006220000_lif1260_admin_email_status.sql`, so deploy it first.
`NEXT_STEP_CATALOG` in `src/next-step.ts` is the step list the ops view shows,
and next_step builds each response's state, step, section, `context_task` and
`related_contexts` from it. Every stage context is linked by some step or
declared in `ON_REQUEST_CONTEXTS`; `tests/next-step-size.test.ts` enforces that
and that a step recommends only tools of the stages it links (LIF-1301).

## Context drafts

A LIFT admin can mark a workspace as a context test workspace in the ops
dashboard and save a draft of one `src/agent-context/<file>.md` for it
(LIF-1298). Drafts live in Supabase, written only by the admin RPCs of the
Functions migration `20261006210000_lif1298_context_drafts.sql`. lifty-api
reads them with the caller's own session (`get_lifty_context_drafts`) and
substitutes the published file only in authenticated responses: next_step
guides (CLI and MCP) and `/v1/context/<task>` when the request carries a
session, which the MCP adapter forwards. The installed CLI reads context
anonymously and always gets the git version. A served document lists its
`drafts` and gets its own revision. A failed read serves published context.
`GET /v1/admin/context` gives the ops editor every published file with its
SHA-256 and uses, plus the drafts and test workspaces. Promotion opens a
pull request here; `.github/workflows/verify.yml` runs `npm run verify` on it.
Each document's files are declared in `src/agent-context.ts`; key order is
part of the revision, so keep published documents byte-identical when
restructuring them.

## Campaign authoring fields

LIF-1378 adds optional template/variant `display_name` and step
`writing_instructions` to the existing Campaign policy and immutable revisions.
Deploy Functions migration `20261010130000_lif1378_campaign_authoring_fields.sql`
before clients save these fields, and deploy the compatible Jobs generation
consumer before enabling per-message instructions. Names do not change source
IDs or make simple templates an authored catalog. Absent fields add no defaults
or historical digest changes; `fit` and raw `slots_spec` retain their existing
selection and personalization roles.

LIF-1454: a template's subject and text define its slots; `slots_spec` is
guidance the writer reads. Campaign responses add `slots_spec_warnings` when a
spec names a placeholder its own template does not use (publish reports the
revision it approved). The API computes it from the parsed revision, so either
deploy order is safe; it never blocks a write or changes saved bytes.

## Shared writing rules

The banned-phrase list Lifty serves is the database rulebook Jobs composes
against (`outreach_rulebooks` key `anti_slop`), not a checked-in copy.
`src/writing-rules.ts` reads it through the anon RPC `get_lifty_writing_rules`
(Functions migration `20261009120000_lifty_writing_rules_read.sql`) at startup
and every five minutes, keeping the last list on a failed read. The
`anti-slop` context file holds only the instructions; the live list is appended
when a document is served. Campaign responses add `writing_recommendations` for
banned phrases in the draft's saved templates. They are recommendations and
never block a save, preview, approval or activation; the field is absent while
the list is unknown. This API works before the migration ships (it serves a
short fallback note), so the order is free. Edit phrases in the ops dashboard
rulebook, never in this repository. `src/generated/anti-slop.ts` is the Jobs
matcher; regenerate it with `node scripts/sync-writing-rules.mjs
<lift-gtm-jobs-checkout>` when Jobs changes it.

## Connection confirmation

Browser integration callbacks use `src/connection-confirmation.ts` and its typed
flow inventory. Keep the document response independent of provider I/O; use the
bounded processing/status requests and durable attempt receipts. Unknown
outcomes stay pending and never replay OAuth codes or create another resource.
Every new browser callback must pass the shared conformance suite in `npm run
verify`. See LIF-1139 and the parent workspace's Connection confirmation contract.

LIF-1139 requires the Functions migration
`20260929203000_lif1139_connection_browser_receipts.sql` before this API revision.
HubSpot/Slack fail closed before exchanging a code if its claim RPC is unavailable.
Mailivery retains ephemeral tokens and its existing single-dispatch fence.

A pending result may carry `attention`: why the provider refused a sending
account sign-in (with "Try again" on the same attempt) or that a warmup
handoff is starting. When Unipile names the existing account
(`api/already_exists`), `lifty_sending_account_conflict` says what it is to
Lifty; a retained account Lifty no longer uses is removed through the
revocation path before the retry. The Functions migration
`20261008210000_connect_provider_account_release.sql` adds that read and the
warmup `starting` receipt. This API works before it ships (the explanation
stays generic), so the order is free.

LIF-1415 requires Functions migration
`20261012130000_lif1415_disposable_sign_in_links.sql` before this API revision.
A hosted sign-in link is disposable: creating one connects nothing, and every
link of an attempt carries its deterministic auth state. The shared shell loads
first; its process and status requests ask the provider for a link whenever
none is stored, and the first stored link wins. A failed, stalled or lost link
request leaves nothing to recover: the attempt stays `preparing` and the next
status check asks again. Only a received authorization is reconciled before
another attempt; an expired attempt without one never blocks its sender.
Browser and agent progress come from the same database projection. There is no
compatibility layer: deploy this API immediately after that migration.

LIF-1629 requires Functions migration
`20261026220000_lif1629_connection_recovery.sql` before this API revision; deploy
this API right after it (no compatibility layer: attempt reads return 502 in the
gap). A received authorization finishes without any open page: the server runs
a recovery pass every 15 seconds (`startConnectionRecovery`), claiming due
attempts through the provider RPC's `recovery_claim` and verifying them exactly
as the page and the attempt read do. The database schedules each retry before
the check, so several servers or a restart never lose or repeat one. Members
close or replace an attempt (`sending_accounts_close_attempt`,
`sending_accounts_replace_attempt`); attempt reads add `action_owner`, `actions`,
`next_step` and `wait_seconds`. Jobs' release cron alerts on recoveries past
their 30-minute budget.

Microsoft warmup setup (LIF-1385) requires the Functions migration
`20261011090000_lif1385_microsoft_warmup.sql` and the matching Jobs Microsoft
Graph pending-campaign handling before this API revision. Deploy database,
Jobs, then API. The setup pins the authenticated mailbox provider; Microsoft
consent goes directly to Mailivery. Only its short-lived sign-in URL is retained
privately for same-attempt recovery. Never retry an uncertain provider link
request, replay Google tokens, or infer warmup success from consent alone.
The Microsoft confirmation page stays open while consent runs in another tab.
Status reads wake the existing verifier with a durable idempotency key; the
scheduled reconciliation remains the backstop.
Legacy V1 warmup identity reads additionally require the stable credential
scope `UNIPILE_PROVIDER_NAMESPACE`, matching the stored connection namespace;
do not derive it from the DSN. V2 uses the existing application configuration.

## CRM capabilities and reconnect

LIF-1584: `GET /v1/workspace/crm/capabilities` and the mapping catalog's
`capabilities` report what the stored CRM credential can do (map fields, create
fields per object) from the scopes the provider reports: Attio `/v2/self`, a
HubSpot OAuth grant's stored token scopes, or HubSpot's private-app token info
endpoint (cached five minutes per credential version). `property_create` no
longer reads `allow_provisioning`; a missing scope, or a provider 403, returns
`HUBSPOT_PERMISSION_REQUIRED` / `ATTIO_PERMISSION_REQUIRED`. HubSpot and Attio
callbacks record named refusal codes (`account_in_use`, `account_mismatch`,
`permission_missing`, `crm_provider_conflict`); the attempt read and the browser
page return the same codes. Ship this API revision before the
Functions migration `20261026131000_lif1584_crm_reconnect_same_account.sql`:
that migration refuses a reconnect to a different account
(`lifty_crm_account_mismatch`), which an older API cannot name and leaves pending.
An older database stores the new codes as `callback_failed`, so API-first is safe.

## Customer exclusion imports

LIF-1082's authenticated customer-exclusions status/import stage requires the
Functions migration `20261006180000_lif1082_founder_customer_exclusions.sql`
before this API revision. Deploy the database through its production-database
job first. The API reads and replaces founder-upload membership through member
RPCs; unavailable reads stay unknown. CRM and manual protections are preserved,
and a file containing only rejected customer rows cannot clear the saved list.

LIF-1128's explicit customer-source choice additionally requires
`20261008080000_lif1128_optional_customer_sources.sql`; activation/admission
holds require `20261008090000_lif1128_activation_hold.sql`. Pause the old Jobs
suppression nightly, catch-up and manual tasks and drain running syncs before
applying these migrations: the previous Jobs revision treats connection as
permission to read customers. Deploy the database through its required gates,
then the consent-aware Jobs revision and this API revision, before resuming
suppression tasks. Source choice is separate from connection and provider
grants; existing connections do not imply consent. Optional choice/status
reads that are unavailable stay unknown, and no release here bumps the
installed client contract.

## Notification configuration

LIF-1464 step 3: notification configuration is read and written through the
`notifications` schema's customer-edge functions (`get_configuration`,
`save_slack_destination`, `set_subscription`) with the caller's session and the
workspace UUID resolved from `get_lifty_workspace_status`; Slack state still
comes from `get_lifty_slack_connection`. The legacy `*_lifty_notification_*`
RPCs and the Jobs `notification-delivery` task are no longer called. Test sends
trigger `notifications-test` in the notifications service's own Trigger.dev
project, so set `NOTIFICATIONS_TRIGGER_SECRET_KEY` (distinct from
`TRIGGER_SECRET_KEY`) on the app before deploying this revision: startup
refuses without it. The response shapes changed without a client-contract
change; the CLI prints responses verbatim and agents read the schemas from
`/v1/context/notifications`. Type codes are checked by shape, so a new catalog
type needs no API release.

## CRM automatic sync and test sync

LIF-1622: `GET|PATCH /v1/workspace/crm/automatic-sync` reads and switches
whether Lifty writes to the CRM on its own; `POST|GET
/v1/workspace/crm/test-sync` starts and reads a test of up to five leads
(`src/crm-sync-controls.ts`). The database owns both and creates the CRM runs;
the route enqueues `lifty-crm-sync` for the run it returns (the turn-on
catch-up or the test). The bulk `POST /v1/workspace/crm/sync` answers
`CRM_AUTOMATIC_SYNC_PAUSED` while paused, and next_step offers the test sync
instead. Release order: the Functions migration
`20261026132000_lif1622_crm_automatic_sync.sql`, then the Jobs revision that
gates its writers and runs test syncs, then this API revision.
