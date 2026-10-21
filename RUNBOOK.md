# LIFTY REST control-plane playbook

## Architecture and trust boundary

```text
lifty CLI ── bearer JWT ──> lifty-api ── same JWT / RLS ──> Supabase RPCs
    │                             │
    └──── Supabase Auth only ─────┴── hosted OAuth ──> HubSpot
```

The CLI still uses Supabase Auth to sign in and refresh its session. Workspace
reads and writes go only through this API. The API verifies the JWT against the
project JWKS, creates a user-scoped Supabase client, and delegates to:

- `public.get_lifty_workspace_status()` and `list_lifty_member_workspaces()`
- `public.get_lifty_business_profile(p_workspace_id)` / `create_lifty_business_profile(p_payload,p_workspace_id)` / `patch_lifty_business_profile(p_workspace_id,p_payload)`
- `public.get_lifty_targeting()` / `patch_lifty_targeting()`
- `public.get_lifty_research_criteria()` / `patch_lifty_research_criteria()`
- `public.get_lifty_commercial_voice()` / `patch_lifty_commercial_voice()`
- `public.get_lifty_setup_draft()` / `save_lifty_setup_draft()` / `discard_lifty_setup_draft()`
- `public.get_lifty_setup_context()` / `submit_lifty_setup(p_workspace_id,p_expected_draft_version)` / `get_lifty_setup_status()`
- `public.retire_lifty_workspace(p_payload)` — LIFT-admin-only delete of a workspace without history, identity-confirmed, with consumed budgets preserved
- `public.start_lifty_run()` / `get_lifty_run_status()`
- `public.create_lifty_hubspot_connect_intent()` / `get_lifty_hubspot_connection()`

Business operations validate typed input at the API and independently at SQL,
then use the authenticated client directly. Resource PATCHes are synchronous
CAS. Setup saves a server draft and submits targeting plus criteria atomically.
The RPC catalog owns membership, lifecycle, locking, version conflicts and
receipt replay; no Business import or config-update task is enqueued.

The browser callback exchanges and immediately refreshes the HubSpot grant,
verifies the exact reviewed scopes and portal, and persists it through the
one-use capability RPC. The API holds the HubSpot app secret but no Supabase
service-role credential; founders and CLI responses never receive provider
tokens.

`GET /cli/auth` is hosted by this same DigitalOcean service. Its browser code
uses only the Supabase URL and publishable key, keeps session tokens in memory,
and can POST them only to the exact `127.0.0.1` port supplied by `lifty login`.
The production CLI embeds the canonical origin `https://api.liftygtm.com` for
both app and API URLs. The DigitalOcean default ingress keeps serving the same
app as a non-canonical fallback host.

The database remains responsible for actor identity (`auth.uid()`), RLS,
validation, idempotency, advisory locking, and atomic provisioning. The API validates the public contract and safely projects database errors; SQL
independently enforces persistence invariants.

The request-scoped Supabase client aborts each database request after 10 seconds.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL; HTTPS except for loopback development |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable Data API key used by the scoped client |
| `SUPABASE_JWKS_URL` | HTTPS JWKS endpoint; alternatively set inline `SUPABASE_JWKS` |
| `PUBLIC_BASE_URL` | Canonical HTTPS origin for OAuth redirects and the MCP resource: `https://api.liftygtm.com` (LIF-1103) |
| `HUBSPOT_CLIENT_ID` | Client ID for the reviewed HubSpot LIFTY app |
| `HUBSPOT_CLIENT_SECRET` | Encrypted app-level secret for the HubSpot LIFTY app |
| `SLACK_CLIENT_ID` | Client ID for the Slack OAuth app |
| `SLACK_CLIENT_SECRET` | App-level secret for Slack OAuth |
| `ATTIO_CLIENT_ID` | Client ID of LIFT's Attio OAuth app (optional; Attio connection is unavailable without it) |
| `ATTIO_CLIENT_SECRET` | Client secret of LIFT's Attio OAuth app. Register `<PUBLIC_BASE_URL>/attio/callback` and the scopes `record_permission:read-write`, `object_configuration:read-write`, `note:read-write`, `meeting:read` |
| `TRIGGER_SECRET_KEY` | Trigger.dev key of the Jobs project, for research, CRM, integration revocation and warmup tasks |
| `TRIGGER_API_URL` | Optional; defaults to `https://api.trigger.dev` |
| `NOTIFICATIONS_TRIGGER_SECRET_KEY` | Secret key of the notifications service's own Trigger.dev project, used only for `notifications-test` (notification test sends). Startup refuses a missing key or one equal to `TRIGGER_SECRET_KEY` |
| `NOTIFICATIONS_TRIGGER_API_URL` | Optional; defaults to `https://api.trigger.dev` |
| `HOST` | Bind host, default `0.0.0.0` |
| `PORT` | Bind port, default `3000` |

Never inject `SUPABASE_SECRET_KEY`, `SUPABASE_SECRET_KEYS`, or
`SUPABASE_SERVICE_ROLE_KEY`; startup fails when one is populated. TLS
termination and per-IP/per-token rate limiting belong at the deployment ingress.

## Deploy and verify

Merging runtime changes to `main` starts the `Deploy` GitHub Actions workflow.
Follow that run: it runs `npm run verify` (skipped when a pull request Verify run
passed on the identical tree), deploys the exact main SHA, waits for
it to become active, and probes health, readiness (including CRM), OpenAPI, v6 Business/setup public context and
fail-closed authentication. Do not run a second deploy or repeat those public
probes after the workflow passes. Human documentation-only pushes are excluded;
Markdown shipped under `src/agent-context/` still triggers deployment.

Configure the publishable Supabase and encrypted HubSpot values above when
setting up the host; founders do not set them locally. Keep the service private
from browser integrations (no CORS allowlist). Release prerequisite migrations
through their owning CI before merging the dependent API. For LIF-1173, deploy the Business resource migration and compatible Jobs
consumers before this API. Publish the v6 CLI before or alongside the API;
v5 calls intentionally return 409. Retire queued legacy Business jobs only
after they drain. For LIF-897, deploy
its database capability and replay ledger first, then the Jobs task
`lifty-crm-mapping-sync`, then this API. The public smoke checks both
`/readyz/crm` (`lifty-crm-company.v1`) and `/readyz/crm-mapping`
(`lifty-crm-mapping.v1`); these verify static database capabilities without
reading a tenant or contacting HubSpot. Worker deployment is a separate
prerequisite, verified by its owning release workflow.

If a change affects CLI ingress, provisioning or HubSpot onboarding, verify that
specific behavior with the matching CLI and a disposable nonproduction founder,
following the canary constraints below. Do not run the entire provisioning flow
for documentation or deploy-tooling changes.

Logs contain request ID, method, path, status, and public error code. They must
not contain bearer tokens, request bodies, Business drafts, or database error
details.

## Environments and database (decision 2026-08-31, LIF-617)

LIFTY runs on the GTM engine Supabase project (`ycwarkyijoeunmgjbikm`,
`https://ycwarkyijoeunmgjbikm.supabase.co`). The dedicated LIFTY Supabase
boundary built under LIF-625 was rejected and deleted the same day; do not
recreate it. Tenant isolation for founder JWTs is enforced inside the shared
catalog (RLS by workspace, locked-down grants, backend-only secrets) under the
LIF-617 track.

This repository carries no migration root. The LIFTY schema (workspaces,
memberships, typed Business resources and versioned RPCs) lives in
the GTM engine migration ledger and changes through the same flow as every
other GTM engine migration. The only Supabase configuration this repo owns is
the runtime environment of the App Platform app (`SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL`). HubSpot app credentials and
`PUBLIC_BASE_URL` are also owned by that DigitalOcean runtime.

The LIF-1174 API revision (client contract v7) requires the Functions migration
that adds the research schedule, weekly ledger and the `p_workspace_id` forms of
`start_lifty_run`, `get_lifty_run_status` and `get_lifty_run_progress`. Deploy
that migration first; an older database makes these operations return 502
"unavailable", never a guessed state. Weekly research links use
`LIFTY_DASHBOARD_ORIGIN`, the same owner as sample research links.

## DigitalOcean staging

The sole hosted runtime is the `lifty-api-staging` App Platform app. The
repository exposes the normal operational workflow through npm so agents do
not need a memorized app ID or dashboard-only steps:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:smoke
```

`do:logs` defaults to the last 100 runtime lines. For a bounded, agent-safe
query it accepts only `--tail N` and `--type TYPE`; unsupported or global
`doctl` flags fail closed.

For an intentional manual redeploy when no CI deployment is already running,
use the reviewed current main SHA and wait for verification with:

```sh
npm run do:deploy -- <full-40-character-sha>
```

The deploy command resolves the app by name and validates its ID, single API
component, GitHub repository, and `main` branch before mutation. It requires
the supplied SHA to match the remote branch head, starts one App Platform
deployment, waits, verifies the exact active commit, and runs health, readiness,
OpenAPI, and unauthenticated fail-closed checks. When retired integration keys
(`INSTANTLY_API_KEY`, `HEYREACH_API_KEY`, `SMARTLEAD_API_KEY`,
`SMARTDELIVERY_API_KEY`) remain at app or API component scope, it filters only
those entries from the live spec and deploys that spec with the current source
using `apps update --update-sources`. It preserves all other fields and verifies
the keys are absent from both configured and active specs. Otherwise it uses
`apps create-deployment` without reapplying the live spec. Eligible builds can be
reused; append `--force-rebuild` only when a clean rebuild is required or to
diagnose stale build/cache state. That flag fails before mutation while retired
environment cleanup is pending; use the normal release command first.
Unknown flags are rejected. It never prints environment values or uploads local files.

Agents need `doctl`, `jq`, and `curl`, plus an authenticated DigitalOcean
context; deploys additionally need `git`. Run `npm run do:doctor` first on a
new machine. The optional `LIFTY_DO_APP_ID` variable is an additional
assertion; it cannot redirect the script to another app.

Authenticated canaries use disposable founder accounts and workspaces and must
follow the LIF-628 cleanup receipt. Public smoke checks remain safe because
they perform no persistent writes.

## Rollback

The database migrations live in the GTM engine repository, not here. Roll back
the DigitalOcean deployment to the previous exact commit and mark affected
HubSpot connections `reconnect_required` if a provider-grant regression is
suspected. Setup receipt replay makes retrying the exact submitted draft version safe.
Rollback must retain the Business schema and consumer compatibility; do not
restore a v5-only API against new resource writes without an explicit plan.

## Request limits

`POST /v1/workspace/business`, `POST /v1/workspace/setup`, and `POST /v1/workspace/sample-review` share a budget of ten requests per authenticated user per minute per API process. Exhaustion returns 429 `RATE_LIMITED` with `Retry-After`. The in-memory budget resets on restart and is not shared across replicas. Per-IP and fleet-wide limiting belong at ingress. Reads and OAuth callbacks do not consume this budget.

## Connection pilot preparation

The existing app named `lifty-api-staging` serves production Auth/data. Its
`do:*` commands must never be used to provision or deploy LIF-1594's pilot.

The pilot target is `lifty-api-pilot`, API `https://api.pilot.liftygtm.com`,
dashboard `https://pilot.liftygtm.com`, staging Supabase
`csyhcwpcojbjlwwxdmhc`, and Unipile application
`app_01m5fr5mgdfzx8ftceq7y7z0h4` on `https://auth.pilot.liftygtm.com`.

Build the API, then prepare a private spec with staging's publishable key in
`SUPABASE_PUBLISHABLE_KEY` and private credential files:

```sh
npm run build
node scripts/prepare-pilot.mjs --output /private/tmp/lifty-pilot-app.json \
  --unipile-key-file /private/path/to/pilot-account-key \
  --email-key-file /private/path/to/pilot-email-capability
```

The files must be readable only by their owner. Use a distinct random email
capability of at least 32 characters and provision only its SHA-256 digest in
the staging database. The Unipile Account key belongs exclusively to the pilot
application. Do not copy the production app spec, credentials or encrypted
values. Never print the generated spec: it contains secrets even though App
Platform encrypts SECRET entries after accepting them.

Before creating this separately authorized USD5/month resource, verify the
Functions-owned staging contract receipt and its real Auth/workspace/sender/
connection checks, plus a deployed signed durable intake and replay path. Auth
health alone is insufficient. Hold deployment when a contract is missing.
Ordinary push, PR and merge gates still apply. Deploy the reviewed source only
after its database dependencies; do not deploy local uncommitted source.

Staging Google administrator Trusted approval and Google brand verification are
separate acceptance checks. External/Testing and invited test users establish
only testing behavior. Keep campaigns and warmup disabled in this profile.

### Develop delivery and readiness

The Verify workflow deploys `develop` only when repository variable
`CONNECTION_PROFILE_ENABLED=true`. It verifies the source first, then
`scripts/deploy-pilot.py` requires the Functions-owned staging contract and a
replay heartbeat newer than two minutes before creating/updating the separate
pilot app. The first create is the deployment; later pushes create one
provider deployment and verify its active SHA. `main` retains its existing
production workflow and app. Set `LIFTY_PILOT_APP_ID` to the created ID for an
additional target assertion.

The API repository's staging secrets are `STAGING_PUBLISHABLE_KEY`,
`STAGING_EMAIL_SERVER_KEY` and `STAGING_UNIPILE_ACCESS_TOKEN`. The existing
DigitalOcean deployment credential is reused. No administrative database key
enters the API. The connection profile routes use shared workspace/sender/
attempt contracts, expose unavailable metrics as null, and keep unsupported
operations closed. `/readyz` requires both Auth health and the exact installed
connection catalog, including its permissions and the replay heartbeat.

The custom domain must resolve to the created app before testing browser
callbacks. A healthy default ingress proves the deployment; it does not prove
custom-domain DNS or a real mailbox consent. Record those live checks in
LIF-1594 before enabling the dashboard's develop deployment.


### Temporary own runner for staging

If hosted Actions minutes are unavailable, register an ephemeral repository
runner with a unique label (no default labels) in `STAGING_RUNNER_LABEL` and
dispatch Verify on develop with `self_hosted_staging=true`. This single job
runs the complete API verification and existing release-contract tests before
using the same guarded pilot deployment script. The machine needs Python,
doctl and Node installation support; no local database is started. The runner
is removed after the one requested job. Normal push and production routing
remain unchanged. The database/replay readiness gate must pass before an app
is created; do not use the old app named staging, which uses production data.
