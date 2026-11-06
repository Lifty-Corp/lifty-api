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
- [Slack app configuration](config/slack/README.md): the shared app manifest and
  hosted customer authorization boundaries.
- [docs/](docs/): MCP authorization and tool contracts, email providers and
  the session fence.
- Module pages this API serves:
  [CRM integration](https://linear.app/lifty-corp/document/lead-gen-system-crm-integration-8c87617b7e3f),
  [Journeys & Campaigns](https://linear.app/lifty-corp/document/lead-gen-system-outreach-journeys-and-campaigns-d17db89d8616),
  [Senders & sending accounts](https://linear.app/lifty-corp/document/lead-gen-system-outreach-senders-and-sending-accounts-52db0a32df5a),
  [Email deliverability](https://linear.app/lifty-corp/document/lead-gen-system-outreach-senders-and-sending-accounts-email-7ae14873e026)
  and [Lifty CLI](https://linear.app/lifty-corp/document/lead-gen-system-lifty-cli-3137bddbf80c).

## Build and verify

Node `>=22.11.0` on CI's major (22). Run `npm ci`, then `npm run dev` with the
variables from `.env.example` exported in the shell; the service does not load
`.env` itself.

`npm run verify` (`scripts/verify.mjs`) is the one check command. It selects
steps from the files that differ from the merge-base with `origin/develop`
(`-- --base <ref>` or `VERIFY_BASE` for another base), plus staged, unstaged
and untracked files:

- Code, deploy tooling and Markdown under `src/` (packaged agent context) run
  the pillars check, the HubSpot policy check and tests, the typecheck and the
  whole vitest suite.
  The build runs when its inputs change (`scripts/copy-context-assets.mjs`,
  context assets, `Dockerfile`), the deploy-pilot Python tests when the pilot
  files change.
- Dependencies, a `tsconfig`, the vitest config, CI, the verify script, an
  unmapped path or a missing merge-base run the full tier. `npm run verify:full`
  (`--full`) runs it on request: every step above, the build and the
  deploy-pilot tests.
- Human documentation alone (this file, README, RUNBOOK, `docs/`, other `*.md`
  outside `src/`) needs prose, link and diff checks. The Deploy workflow
  ignores the first four.
- The connection inventory and conformance suite
  (`tests/connection-confirmation.test.ts`) runs on every invocation.

It refuses a Node major other than CI's (`fnm exec --using 22 npm run verify`),
never starts Docker, Supabase, a browser or a server, and ends with the CI-only
proofs the diff still needs. Reuse a passing result for unchanged inputs
instead of rerunning it before each commit. See
[shared contract maintenance](contracts/hubspot-grant-policy.md) before changing
the policy or distributing it to other repositories.

## Engineering pillars

Rules: [Engineering pillars](https://linear.app/lifty-corp/document/lead-gen-system-engineering-pillars-d387e90e3f29). `npm run verify` runs the check; `pillars.exceptions.json` lists what is frozen and only shrinks. Copy the model file, and do not add an exception to get past a failure.

| Pillar | Model | Check |
|---|---|---|
| validation | `src/attio-oauth.ts` | No cast or `any` on response JSON; request bodies are size-limited and reach a zod parse |
| providers | `src/crm-mapping/transport.ts` | Every raw call has a signal and uses the injected transport; one client per provider host; `enqueueRevocationWithRetry` is the only retry |

The loose-schema rule covers new schemas for provider JSON. Lifty RPC results and Jobs receipts stay strict (see Database dependencies).

## Release

Feature PRs target `develop`, which deploys nothing. The Verify workflow runs
the fast tier (`npm run verify -- --base origin/<base>`) on hotfix pull requests
to `main` and the full tier
(`npm run verify:full`) on the release pull request `develop` → `main` and on
manual runs; a pull request or push to `develop` runs nothing (LIF-1818). A batched release promotes
`develop` to `main` (Compass `CLAUDE.md`). `staging` holds `main`
plus the isolated pilot: every push to `main` merges into it automatically
([Sync staging](.github/workflows/sync-staging.yml)), and each `staging` push
deploys the pilot without running the test suite; its workflow can migrate the
existing pilot app source from `develop` to `staging` in its single deployment,
preserving the app identity and encrypted settings.

Merging to `main` starts the `Deploy` workflow. It runs `npm run verify:full`
(or reuses the release pull request's passing full-tier Verify run on the
identical tree; a fast-tier run never counts, so a hotfix is verified there),
deploys that exact commit to `lifty-api-staging`, checks the active commit and
runs the public smoke suite. Follow that run; do not also call `do:deploy` or repeat its
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
API active first.
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

### Targeting vocabulary

`src/generated/industry-labels.ts` and `src/generated/naics-2022.ts` are
generated: regenerate them with `scripts/industry-labels.mjs` and
`scripts/sync-naics-2022.mjs`, never by hand. Writes enforce them in
`src/targeting-vocabulary.ts`; read schemas stay tolerant so values saved
earlier still load and appear in `filter_warnings` (README).

### Writing rules

Each workspace owns one copy of its writing rules (anti-slop Markdown) in its
commercial voice, `writing_rules`; every workspace starts from LIFT's default
and the founder edits it freely (LIF-1724). The copy is drafting context,
never enforcement: nothing in this API checks copy against it, and campaign
saves report no phrases. Drafting documents (`references.anti_slop` in
campaigns and journeys, and next_step's drafting guides) end with the caller
workspace's copy, read through `commercial-voice.get` with the caller's
session (`src/writing-rules.ts`). A public read carries no copy and points the
agent to commercial voice; a failed read says so and is never shown as empty.
The PATCH schema mirrors the database limits for `writing_rules`.

### Campaigns

Behavior lives on Journeys & Campaigns. The database validator is the final
gate for campaign shape. Optional template/variant `display_name` and step
`writing_instructions` never change source IDs, and absent fields add no
defaults or digest changes. `slots_spec_warnings` is computed from the parsed
revision and never blocks a write or changes saved bytes.
`src/campaign-test-failure.ts` turns a test sample's `failure` into the founder
message, never a raw HTTP status. A new failure code needs this API first: an
unknown code fails the response with 502.

### Reports

`src/report-operations.ts` passes stored reports and shared measurement through
a strict envelope and computes nothing: a closed week reads the stored report
the digest reads, any other range reads the live RPC. `get_lifty_research_status`
keeps its admission-week meaning. A new metric or result key needs this API
first (`METRIC_IDS`): an unknown key fails the response with 502. A nonmember's
Slack approval of a Campaign revision has a null `actor_ref` and is still
approved; Journey authoring stays member-only.

### Connection flows

The contract is on [Connections](https://linear.app/lifty-corp/document/lead-gen-system-connections-2f15a8ae4cc6).
Every browser integration callback uses `src/connection-confirmation.ts` and
its typed flow inventory, and must pass the shared conformance suite
(`tests/connection-confirmation.test.ts`), which every `npm run verify` runs
whatever changed. HubSpot and Slack fail closed before exchanging a code if the
claim RPC is unavailable. Mailivery tokens stay ephemeral.

`startConnectionRecovery` runs a pass every 15 seconds, but the database claims
due attempts (`recovery_claim`) and schedules each retry; keep that ownership in
the database so several servers or a restart never lose or repeat one.

Warmup (Email deliverability): never repeat an uncertain Microsoft link
request, replay Google tokens or infer warmup success from consent alone. A
failed `lifty-email-warmup-verify` trigger never fails the handoff; the
scheduled reconcile covers it. Warmup identity reads only the bound Unipile V2
account; a transport still on the retired V1 API asks for the connection again.

### Sending accounts

This API exposes no write for account limits; LIFT admins change them through
the database RPC the dashboard calls. `access_removal: not_applicable` needs no
provider revocation, so disconnect and sender delete return 200 for it.

### CRM

Behavior lives on CRM integration. Capabilities come from the scopes the
provider reports; do not gate field creation on `allow_provisioning`. The
database owns automatic sync and test sync and creates their runs; the routes
(`src/crm-sync-controls.ts`) only enqueue `lifty-crm-sync` for the run it
returns.

### Analytics

`src/analytics.ts` records every catalog mutation and the next_step read at
the `/v1/*` middleware (events and milestones in README "Analytics events").
Event and group properties pass an allow-list by name and shape: codes,
identifiers and enum values only, never free text, addresses, links or
anything read from a request body. A new milestone is one `MILESTONES` entry
plus the README table. Keep `observe` outside the request path: no await on
the sink, no new per-request reads before the response.

### Notifications

Behavior is on [Notifications & Slack](https://linear.app/lifty-corp/document/lead-gen-system-notifications-and-slack-a6e52a3fd81f);
configuration and test sends are in README. Call the `notifications` schema's
customer-edge functions with the caller's session, never the legacy
`*_lifty_notification_*` RPCs.
