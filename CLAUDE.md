# lifty-api

The Lifty control plane: REST, MCP and OAuth endpoints, hosted provider
connection flows and the agent task context the Lifty CLI and dashboards read.
It is a Hono service that calls GTM database RPCs with the caller's own
Supabase session; it holds no service-role key and has no migration root.

## Workspace context

This repository is part of the LIFT workspace (`lead-gen-system`). The workspace root `CLAUDE.md` (its `AGENTS.md` is the same file) holds the rules for branches, verification, Linear, Tracecrew and GTM database changes; read it before working if your tool did not load it. Current module behavior lives in the Linear [Lead Gen System](https://linear.app/lifty-corp/document/lead-gen-system-a7b1159965fb) pages, not here. This file adds only what is specific to this repository.

Headless workers (`claudex -p`, `codex exec`) implement their brief directly: no orchestration or planning skills, no subagents, no re-delegation.

`AGENTS.md` is a symlink to this file; edit `CLAUDE.md` only.

## Where things are documented

- [README.md](README.md): routes, local development and Lifty self-service
  behavior. The hub lists it as the interim doc for that module.
- [RUNBOOK.md](RUNBOOK.md): configuration, environments, deploy, rollback and
  the connection pilot.
- [docs/](docs/): MCP authorization and tool contracts, email providers and
  the session fence.
- Module pages this API serves:
  [CRM integration](https://linear.app/lifty-corp/document/lead-gen-system-crm-integration-8c87617b7e3f),
  [Journeys & Campaigns](https://linear.app/lifty-corp/document/lead-gen-system-outreach-journeys-and-campaigns-d17db89d8616),
  [Senders & sending accounts](https://linear.app/lifty-corp/document/lead-gen-system-outreach-senders-and-sending-accounts-52db0a32df5a),
  [Email deliverability](https://linear.app/lifty-corp/document/lead-gen-system-outreach-senders-and-sending-accounts-email-7ae14873e026)
  and [Lifty CLI](https://linear.app/lifty-corp/document/lead-gen-system-lifty-cli-3137bddbf80c).

## Build and verify

Node `>=22.11.0`. Run `npm ci`, then `npm run dev` with the variables from
`.env.example` exported in the shell; the service does not load `.env` itself.
`npm run verify` checks the API-owned HubSpot policy source and generation,
then runs the typecheck, the vitest suite and the build. See
[shared contract maintenance](contracts/hubspot-grant-policy.md) before changing
the policy or distributing it to other repositories. The Verify
workflow also runs `python3 -m unittest discover -s scripts -p test_deploy_pilot.py`.

- Code, deploy tooling and Markdown under `src/` (packaged agent context) need
  `npm run verify`. Reuse a passing result for unchanged inputs instead of
  rerunning it before each commit.
- Human documentation (this file, README, RUNBOOK, `docs/`) needs prose, link
  and diff checks only. The Deploy workflow ignores those paths.

## Release

Feature PRs target `develop`, which only verifies. A batched release promotes
`develop` to `main` (Compass `CLAUDE.md`). `staging` holds `main` plus the
isolated pilot; each push deploys the pilot without running the test suite, and
its workflow can migrate the existing pilot app source from `develop` to
`staging` in its single deployment, preserving the app identity and encrypted
settings.

Merging to `main` starts the `Deploy` workflow. It runs `npm run verify` (or
reuses a passing pull request Verify run on the identical tree), deploys that
exact commit to `lifty-api-staging`, checks the active commit and runs the
public smoke suite. Follow that run; do not also call `do:deploy` or repeat its
smoke checks. Add a focused authenticated or compatibility probe only when the
changed behavior needs one.

`lifty-api-staging` uses the shared GTM production Auth and database despite
its name. Juan's LIF-1097 decision keeps connector rehearsal there; do not
create another environment. Authenticated canaries need an explicitly
authorized internal workspace and seed data, and must stop before live sending.
Confirm the target and issue scope first. Public health and fail-closed
authentication checks are safe.

`staging` deploys to the separate `lifty-api-pilot` (isolated connection
profile, staging database) through the Verify workflow and
`scripts/deploy-pilot.py`, only when `CONNECTION_PROFILE_ENABLED=true`. Never
use `do:*` for the pilot; see RUNBOOK "Connection pilot preparation".

### DigitalOcean commands

Use the checked-in commands instead of copying app IDs, ingress URLs or specs
into prompts:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:smoke
npm run do:deploy -- <full-40-character-sha>
```

They are alternatives for one operation, not a release checklist. They need
`doctl`, `jq`, `curl` and an authenticated DigitalOcean context; `do:deploy`
also needs `git`. `do:doctor` checks these without printing the token.

- `do:deploy` is pinned to `lifty-api-staging`, its single `api` component,
  this repository and `main`. It refuses a SHA that is not the remote branch
  head, starts one deployment, waits, verifies the active commit and runs the
  smoke suite, so do not repeat those checks afterward. It never uploads local
  changes. If retired-provider API keys remain in the app or component
  environment, it removes only those entries and deploys the filtered spec with
  current source in the same deployment; other entries, including encrypted
  values, are preserved. An optional `LIFTY_DO_APP_ID` is only an assertion.
- Build reuse is the default. Use `--force-rebuild` only to diagnose a stale
  build or when a clean rebuild is required; it is refused while retired-key
  cleanup is pending. Unknown flags are rejected.
- `do:logs` accepts only `--tail N` and `--type TYPE`. Never forward `doctl`
  credential, config or trace flags, and never print the live app spec or
  environment values.

## Database dependencies

GTM DDL lives in Functions migrations and ships through its
`production-database` job (workspace rules). When an API change depends on a
new Functions migration or RPC shape, the migration ships first, and this API
must tolerate both shapes during the rollout. Lifty RPC results and
Jobs-written receipts are parsed with strict schemas, so a database or Jobs
change that adds a key or code to a result this API reads needs the tolerant
API active first (Tracecrew `lead-gen-system.lifty-api.rpc-output-compatibility`).
State the order in the pull request and the issue; do not add per-release
notes here.

## Coding constraints

### Installed clients and agent context

Every task context the agent reads comes from this API (`src/agent-context`),
so a behavior change ships its context change in the same pull request and
reaches every founder on deploy. Do not change `STAGE_CLIENT_CONTRACT`
(`src/agent-context.ts`) for an API or context release: it names the transport
installed clients implement, and changing it forces every founder to update
the skill (LIF-1293). A failing `tests/installed-client.test.ts` means the
change breaks installed clients. Change the contract only with a deliberate
client release.

Each document's files are declared in `src/agent-context.ts`. Key order is part
of the revision, so keep published documents byte-identical when restructuring
them.

### next_step and the admin read

`NEXT_STEP_CATALOG` in `src/next-step.ts` is the step list; next_step builds
each response's state, step, section, `context_task` and `related_contexts`
from it. Every stage context has exactly one role: linked by some step, the
base of every step (`BASE_CONTEXTS`: summary) or read on request
(`ON_REQUEST_CONTEXTS`). `tests/next-step-size.test.ts` enforces that, the size
limits, and that a step recommends only tools of the stages it links. next_step
returns the sample review until the latest sample is confirmed
(`confirm_lifty_run_review`).

`GET /v1/admin/onboarding` lists every workspace through
`admin_list_workspaces()` and computes each next_step with the admin's own
session, naming the workspace (`AuthSession.workspaceRef` → `p_workspace_id`).
It also returns both context maps for the ops page. Founder sessions never set
`workspaceRef`.

### Context drafts

A LIFT admin can save a draft of one `src/agent-context/<file>.md` for a marked
test workspace (LIF-1298). The API reads drafts with the caller's session
(`get_lifty_context_drafts`) and substitutes them only in authenticated
responses: next_step guides and `/v1/context/<task>` with a session, which the
MCP adapter forwards. The installed CLI reads context anonymously and always
gets the git version; a failed draft read serves published context.
`GET /v1/admin/context` feeds the ops editor. Promotion opens a pull request
here, checked by the Verify workflow.

### Writing rules

The banned-phrase list is the database rulebook Jobs composes against
(`outreach_rulebooks` key `anti_slop`). `src/writing-rules.ts` reads it through
`get_lifty_writing_rules` at startup and every five minutes and keeps the last
list on a failed read. Edit phrases in the ops dashboard rulebook, never here.
Campaign `writing_recommendations` never block a save, preview, approval or
activation. `src/generated/anti-slop.ts` is the Jobs matcher; regenerate it
with `node scripts/sync-writing-rules.mjs <lift-gtm-jobs-checkout>` when Jobs
changes it.

### Campaigns

Behavior lives on Journeys & Campaigns. The database validator is the final
gate for campaign shape. Optional template/variant `display_name` and step
`writing_instructions` never change source IDs, and absent fields add no
defaults or digest changes. `slots_spec_warnings` is computed from the parsed
revision and never blocks a write or changes saved bytes.
`src/campaign-test-failure.ts` turns a test sample's `failure` into the founder
message, which never shows a raw HTTP status. A new failure code needs this API
first: an unknown code fails the response with 502.

### Connection flows

Every browser integration callback uses `src/connection-confirmation.ts` and
its typed flow inventory, and must pass the shared conformance suite in
`npm run verify` (root Connection confirmation contract, LIF-1139). Keep the
document response independent of provider I/O and use the bounded
processing/status requests and durable attempt receipts. Unknown outcomes stay
pending and never replay OAuth codes or create another resource. HubSpot and
Slack fail closed before exchanging a code if the claim RPC is unavailable.
Mailivery tokens stay ephemeral.

Sending account connection behavior, including disposable sign-in links and
the recovery pass, is on Senders & sending accounts. `startConnectionRecovery`
runs a pass every 15 seconds, but the database claims due attempts
(`recovery_claim`) and schedules each retry; keep that ownership in the
database so several servers or a restart never lose or repeat one.

Warmup setup behavior is on Email deliverability. Never repeat an uncertain
Microsoft link request, replay Google tokens or infer warmup success from
consent alone. A failed `lifty-email-warmup-verify` trigger never fails the
handoff; the scheduled reconcile covers it. Legacy V1 warmup identity reads
need `UNIPILE_PROVIDER_NAMESPACE`, matching the stored connection namespace; do
not derive it from the DSN.

### Sending accounts

Account limits change only through the database RPC the dashboard calls for
LIFT admins; this API exposes no write for them. `access_removal:
not_applicable` needs no provider revocation, so disconnect and sender delete
return 200 for it.

### CRM

Behavior lives on CRM integration. Capabilities come from the scopes the
provider reports; do not gate field creation on `allow_provisioning`. A missing
scope or a provider 403 returns `HUBSPOT_PERMISSION_REQUIRED` /
`ATTIO_PERMISSION_REQUIRED`, and refusal codes are the same on the attempt read
and the browser page. The database owns automatic sync and test sync and
creates their runs; the routes (`src/crm-sync-controls.ts`) only enqueue
`lifty-crm-sync` for the run it returns. Unavailable customer-exclusion reads
stay unknown, a file containing only rejected rows cannot clear the saved list,
and a CRM connection never implies customer-source consent.

### Notifications

No module page yet; the interim doc is the services notifications README.
Configuration goes through the `notifications` schema's customer-edge
functions with the caller's session; the legacy `*_lifty_notification_*` RPCs
are not called. Type codes are checked by shape, so a new catalog type needs no
API release. Test sends trigger `notifications-test` in the notifications
service's own Trigger.dev project: the full runtime profile refuses to start
without `NOTIFICATIONS_TRIGGER_SECRET_KEY`, which must differ from
`TRIGGER_SECRET_KEY`.
