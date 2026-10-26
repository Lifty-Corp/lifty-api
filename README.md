# LIFTY Control Plane and OAuth API

The LIFTY CLI-facing REST boundary for workspace status, provisioning, and
hosted provider connections. It is a standalone Hono service that authenticates
Supabase user JWTs and invokes the existing LIFTY RPCs through a request-scoped,
RLS-enforced Supabase client.

The process deliberately has no Supabase secret key or service-role client. It
refuses to start if a known secret-key environment variable is populated.

`src/server.ts` is the long-running Node/container entrypoint used by the sole
hosted runtime on DigitalOcean App Platform. `src/index.ts` constructs the same
configured Hono app for programmatic use.

## API

### Agent task context

`GET /v1/context/stages` indexes the current stages. Each
`GET /v1/context/{stage}` returns public guidance, schemas and operation routes
from the same catalog used by HTTP and MCP. Public context works before login
and contains no tenant values or Scout base.

The supported client contract is `lifty-cli-context.v11` (CLI 0.1.0-next.35).
It names the transport, not the API: API and context releases keep it
(LIF-1293). The CLI requests it through the public `client_contract` query and
sends `x-lifty-client-contract: lifty-cli-context.v11` on authenticated requests.
Missing, retired or unknown contracts return 409 `CONTEXT_CLIENT_UNSUPPORTED`
after authentication. Invalid sessions return 401. Public unversioned links
show current documentation. Health, login and provider browser callbacks keep
their bootstrap behavior. The context envelope remains `lifty-context.v1`.

Business state is stored in workspace-scoped resources: commercial profile,
neutral targeting lanes, research criteria and commercial voice. PATCH uses
integer `expected_version` compare-and-swap and commits synchronously. The
server assigns lane and persona ids; a lane change without id adds a lane and
`{id, remove: true}` removes one. Persona changes must carry regenerated
criteria and commit both resources atomically. The server records the source
versions of every criteria revision. Validation failures return bounded repair
issues; conflicts return `current_version` without overwriting another writer.

Setup uses a server draft with its own version. `setup_generation_context`
returns the actual current Scout base and API-owned guidance after login.
Submission creates targeting and criteria in one transaction; an exact retry
returns the existing receipt. Login, profile edits and setup never start
research, connect an account or activate outreach. One membership is selected
implicitly. Several memberships require `x-lifty-workspace` (UUID or slug) on
every authenticated call, reads and writes alike; the session forwards it to
the database, which applies this one rule for every Lifty RPC.

Edit public guidance in `src/agent-context/`. The CLI fetches fresh context,
resolves a catalog operation and transports its request/response. It owns no
Business schema, generation template or authoritative local draft. Build
replaces `dist/agent-context/`, removing retired assets. Publish a compatible v8
CLI and dashboard alongside this API cutover; v7 is deliberately retired.

Weekly research (LIF-1174) is one schedule per workspace: `weekly_target` plus
active or paused, with CAS `expected_version`. A `null` target follows the
plan's full limit (LIF-1247). The plan's explicit weekly research allowance is read-only;
LIFT admins assign entitlements independently of payment arrangements. a Monday 00:00 UTC week counts
each person once, when their first research completes, and includes the
five-person sample. Weekly status, the calibration sample and the lead list
read the same ledger. Like every stage, these RPCs select the workspace in the
database from the forwarded `x-lifty-workspace` header. Typed RPC errors map
through one table in `src/rpc-errors.ts`; an unknown code is a 502
"unavailable", never a leaked internal reason. Failed sample reasons are
`calibration_sample_incomplete`, `calibration_review_required`,
`research_failed`, `search_exhausted` and `research_limit_reached`.

### Routes

- `GET /healthz`, `GET /readyz` — process liveness and readiness
- `GET /openapi.json` — generated OpenAPI 3.1 contract
- `GET /v1/context/{task}` — public stage guidance and operation catalog
- `GET /cli/auth` — hosted sign-in and loopback CLI authorization
- `GET /v1/workspace/business`, `POST …/business`, `PATCH …/business` — typed profile and explicit workspace creation
- `GET /v1/workspace/targeting`, `PATCH …/targeting` — versioned neutral targeting lanes
- `GET /v1/workspace/research-criteria`, `PATCH …/research-criteria` — criteria text and research fields
- `GET /v1/workspace/commercial-voice`, `PATCH …/commercial-voice` — independently versioned tone and rules
- `GET /v1/workspace/setup/draft`, `PATCH …/setup/draft`, `DELETE …/setup/draft` — server draft with CAS
- `GET /v1/workspace/setup/context` — authenticated Scout base and setup generation guidance
- `POST /v1/workspace/setup`, `GET …/setup/status` — atomic submission and durable receipt
- `GET /v1/workspace/summary`, `GET …/next-step` — independently observed resources and resumption guidance
- `GET /v1/workspace` — authenticated workspace state
- `POST /v1/workspace/sample-review`, `GET …/sample-review`, `GET /v1/workspace/runs/progress` — five-person calibration sample, its results and bounded progress
- `GET /v1/workspace/research-schedule`, `PATCH …/research-schedule`, `POST …/research-schedule/activate`, `POST …/research-schedule/pause`, `GET …/research-schedule/status` — weekly research schedule and weekly status
- `GET /v1/workspace/leads` — researched leads, newest first, with grade/week filters and an opaque cursor
- `GET /v1/workspace/senders`, `POST …/senders`, `PATCH …/senders/{id}`, `POST …/senders/{id}/delete` — senders (people) with versioned name, signature and booking link; soft delete
- `GET /v1/workspace/sending-accounts`, `POST …/sending-accounts/connect`, `GET …/sending-accounts/attempts/{id}`, `POST …/sending-accounts/{id}/reconnect|pause|resume|disconnect` — accounts each sender owns
- `GET /v1/workspace/crm/preferences`, `PATCH …/crm/preferences` — the selected CRM's research-note, conversation and channel choices with expected_version; reads `public.get_lifty_crm_preferences` and writes through `public.patch_lifty_crm_preferences`
- `GET /v1/workspace/linkedin` — read-only LinkedIn activity (confirmed invitations, acceptances, messages and replies today and over the last 7 days) and each LinkedIn account's waiting reason; reads `public.get_lifty_linkedin`
- `GET /connect/{email|linkedin}`, `POST …` — Lifty's connect page (declaration, then sign-in); `/connect/{channel}/return` is the shared confirmation shell
- `GET /v1/workspaces/{workspace_ref}/research/recovery/{first_run_ref}`, `POST …` — operator-only acquisition recovery for a failed first run; not in the customer catalog, MCP tools or CLI. The database allows only LIFT admins
- `POST /v1/integrations/{provider}/connect` — short-lived connection URL
- `POST /v1/workspaces/{workspace_ref}/integrations/slack/connect-link` — admin-only seven-day client invitation for an explicit workspace; requires membership as well as LIFT admin status
- `GET /v1/integrations/{provider}` — secret-free connection status
- `DELETE /v1/integrations/{provider}` — disconnect: detaches the stored grant (unusable by LIFT from that moment), deactivates the integration, clears the portal pointer, and enqueues the `lifty-integration-revoke` job that revokes the grant at the provider best-effort and deletes the secret (LIF-681); 409 while a CRM sync is in flight. Founder confirmation is the skill's job (LIF-669)
- `POST /v1/integrations/{provider}/sync` / `GET …/sync` — start / poll the CRM sync run (LIF-663)
- `GET /hubspot/start` — redirect an opaque connect intent to HubSpot consent
- `GET /hubspot/callback` — verify OAuth, refreshability, scopes, and portal;
  persist the encrypted grant and render a safe browser result

- `GET /slack/start` — redirect a connect intent to Slack consent
- `GET /slack/callback` — validate Slack authorization and persist the grant
- `GET /v1/notifications` — notification types, destinations (Slack channels and the owner email) with the types each receives, and Slack status; reads `notifications.get_configuration` for the resolved workspace and `public.get_lifty_slack_connection`
- `GET /v1/notifications/slack/channels` — available Slack destinations
- `PUT /v1/notifications/destinations/slack` — save, rename or reactivate a Slack channel destination while Slack is connected; `notifications.save_slack_destination`
- `PUT /v1/notifications/routes` — subscribe or unsubscribe one destination to one notification type; `notifications.set_subscription`
- `POST /v1/notifications/destinations/{destination_ref}/test` — queue one test message to a Slack destination through the notifications service's `notifications-test` task

Notification configuration lives in the private `notifications` schema (LIF-1464); its functions take the workspace UUID, which the API resolves from the session's selection first. Type codes are checked by shape only, so new catalog types need no API release. Test sends use the notifications service's own Trigger.dev project: set `NOTIFICATIONS_TRIGGER_SECRET_KEY` (distinct from `TRIGGER_SECRET_KEY`; startup refuses otherwise) and optionally `NOTIFICATIONS_TRIGGER_API_URL` (see RUNBOOK).

Slack disconnect deletes the stored Slack authorization directly; it has no HubSpot revocation job.

The `/v1` endpoints accept `Authorization: Bearer <Supabase access token>`. No
CORS middleware is enabled: consumers are the CLI and authenticated dashboard server actions. The four `/hubspot` and `/slack` OAuth routes are browser-facing but accept only a
one-use capability (ten minutes for founder connections, seven days for admin Slack invitations) or the provider's authorization response; they never
render credentials or provider response bodies.

New HubSpot connections require the exact LIFTY CRM contract: contacts,
companies, and deals read/write; contact and company property-schema
read/write; and the base `oauth` scope. Expanding the app contract does not
expand existing HubSpot refresh tokens, so older connections report
`reconnect_required` until the founder reconnects.

## Local development

Requirements: Node.js `>=22.11.0` and npm.

```sh
npm ci
cp .env.example .env
set -a
. ./.env
set +a
npm run dev
```

The service does not load `.env` itself. Export the variables through the shell,
container runtime, or local process manager. Use `SUPABASE_JWKS` instead of
`SUPABASE_JWKS_URL` when an inline JWKS is preferable.

```sh
npm run verify
docker build -t lifty-api .
```

See [RUNBOOK.md](./RUNBOOK.md) for deployment, smoke tests, and rollback.

DigitalOcean App Platform is the only hosted runtime. Agents can inspect or
operate it with `npm run do:doctor`, `do:status`, `do:logs`, `do:smoke`, and
`do:deploy -- <full-sha>`; the runbook documents the guardrails and
prerequisites.

Admin Slack invitations reuse `/slack/start` and `/slack/callback`. Reissuing replaces unused Slack invitations only for the selected workspace. The database rechecks the issuer's admin status, membership, and workspace activity when the callback consumes an admin invitation. Store neither generated links nor OAuth tokens in logs or durable evidence. Deploy migration `20260914180009_lif639_admin_slack_connect_links.sql` before this API, then the dashboard Settings card.

## Senders and sending accounts (LIF-1182)

A sender is a named person; every LinkedIn account or mailbox (a sending account)
belongs to one sender, at most one LinkedIn account per sender. Every workspace
uses the same operations; the database resolves the workspace from
`x-lifty-workspace` (`src/identity-operations.ts`, member RPCs `get_lifty_senders`,
`create_/patch_/delete_lifty_sender`, `get_lifty_sending_accounts`,
`connect_/reconnect_lifty_sending_account`, `get_lifty_sending_account_attempt`,
`pause_/resume_/disconnect_lifty_sending_account`). Reads are pure: they never
check or change a provider. Account `observation` and `sends` come from SQL.

Connect and reconnect open a durable attempt and return Lifty's connect URL
(`/connect/{channel}?intent=<sealed>`, `src/connect-state.ts`). The page asks
the person's declaration (LinkedIn: habitual personal account, no other
automation; email: habitual or dedicated mailbox), claims one sign-in link and
hands off to the provider's Lifty-branded hosted sign-in. Completion requires a
signed provider authorization, matching application/scope, an authenticated
identity read (primary mailbox or LinkedIn SELF profile, the same identity for a
reconnect) and the database's exclusivity checks. Browser return parameters are
hints only. The confirmation shell, the agent's attempt read and the webhook
converge on the same attempt through the trusted
`lifty_sending_account_provider` RPC (`src/account-connection.ts`). Connecting
never activates a campaign.

After email or LinkedIn sign-in returns, the confirmation page waits for the
provider's signed authorization and verified identity on the same attempt.
While that evidence is pending, it does not offer the already used sign-in
link again. A bounded wait ends with a status check for the same attempt;
reloads keep waiting, and late verification shows the connected result.
The preparation page still offers the initial sign-in action, and explicit
provider refusals keep their stated recovery steps.

Disconnect and sender delete commit the local block first, then request access
removal at the provider within one 20-second budget per request
(`REVOCATION_BUDGET_MS`). 200 means every affected account has
`access_revoked_at` from provider evidence; 202 means it is still unconfirmed and
the same request finishes it. Providers without a removal operation stay 202.

Configuration: `UNIPILE_V2_ACCESS_TOKEN`, `UNIPILE_V2_APPLICATION_ID`,
`UNIPILE_V2_HOSTED_AUTH_ORIGINS` (Lifty's verified hosted sign-in origins only)
and the existing `LIFTY_EMAIL_SERVER_KEY` / `LIFTY_LINKEDIN_SERVER_KEY`. The
optional `UNIPILE_DSN` + `UNIPILE_ACCESS_TOKEN` pair removes access for accounts
still bound through the earlier provider API. Warmup identification for those
accounts also requires `UNIPILE_PROVIDER_NAMESPACE` to match their stored
credential scope. It verifies the authenticated primary mailbox before choosing
Google or Microsoft; it never infers the provider from the email domain. The Functions
migration providing these RPCs must be released before this API.

`LIFTY_LINKEDIN_SERVER_KEY` is the dedicated capability for LinkedIn account
connections: a random key of at least 32 characters, different from the email
key. Store its SHA-256 digest and the stable Unipile namespace in
`private.lifty_linkedin_server_config`.

## Mailivery warmup (LIF-989)

The hosted email form now asks how the founder uses the mailbox. `personal`
stays the default. `outreach` (a new or dedicated account) is accepted and
means warmup is required: outreach unlocks only after 21 active warmup days
with a healthy check from the last 24 hours. Paused days do not count.

Routes, all bound to the caller's session and an explicit workspace:

- `GET /v1/email/warmup?workspace=<slug-or-id>` returns state, active days
  N of 21, today's warmup volume and ramp target, SPF/DMARC/MX, last check
  time, a plain-words blocking reason and `recommended_go_live`.
- `POST /v1/email/warmup/start` `{workspace}` calls
  `lifty_email_warmup('start')`. Only while the binding is `link_issued`
  (no Mailivery campaign bound yet) legacy mode mints a hosted Mailivery form URL tagged
  `lifty-ws:<workspace_ref>` and `lifty-sender:<sender_ref>`; `expires_at`
  comes from the signed URL's own `expires` claim. Without a verified email
  connection the database answers `email_connection_required`. A
  `pending_consent` binding already has its campaign, so `start` returns status
  and tells the founder to finish Microsoft consent in Mailivery; a second form
  would create another billed campaign. A mailbox warmed from another
  workspace fails with `email_warmup_mailbox_taken`.
- `POST /v1/email/warmup/pause|resume|remove` `{workspace}` record the
  requested action. The jobs worker applies it at the provider.

Configure `MAILIVERY_API_KEY` in the API deployment to enable `start`. Without
it `start` returns `EMAIL_WARMUP_NOT_CONFIGURED` before any write. The API never
logs the key, the signed URL or Mailivery response bodies. Deploy the
`lifty_email_warmup` founder RPC migration before this API.

### Warmup per mailbox (LIF-1000)

Warmup operations select one email account with `connection_ref` (the sending
account `id`), in addition to `workspace`; it is required when the workspace has
several email accounts. The same selector is supported on status, start, pause,
resume and remove; the database checks workspace membership and that the account
belongs to that workspace.

For example, an operator with a Lifty API session for a member of `lift` can
issue one request per connected mailbox. Set `CONNECTION_REF` to the verified
connection UUID for that address; it is not the sender UUID or the Unipile
provider account ID. Use the existing API authentication flow to obtain
`LIFTY_ACCESS_TOKEN`; no administrative credential is needed.

```sh
curl --fail-with-body "$LIFTY_API_BASE/v1/email/warmup/start" \
  -H "Authorization: Bearer $LIFTY_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"workspace\":\"lift\",\"connection_ref\":\"$CONNECTION_REF\"}"

curl --fail-with-body \
  "$LIFTY_API_BASE/v1/email/warmup?workspace=lift&connection_ref=$CONNECTION_REF" \
  -H "Authorization: Bearer $LIFTY_ACCESS_TOKEN"

curl --fail-with-body "$LIFTY_API_BASE/v1/email/warmup/pause" \
  -H "Authorization: Bearer $LIFTY_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"workspace\":\"lift\",\"connection_ref\":\"$CONNECTION_REF\"}"
```

Use `/resume` or `/remove` with the same body to resume or remove that
mailbox's warmup. These actions never resume outreach campaigns. `start`
returns a branded Google OAuth `connect_url` for the selected address; the
mailbox owner opens it and authorizes that exact Google account. Client
starts fail before writing when branded OAuth setup is unavailable and
never fall back to the legacy Mailivery hosted form. Distinct connections
under one actual sender have distinct binding references in the provider
tags, so each mailbox is reconciled independently.

Warmup status includes the selected `connection_ref`, `initial_period_complete`,
`warmup_ready`, `spam`, `user_paused` and `connection_paused`. It does not expose
provider identity or campaign-pause fields. `warmup_ready` describes only this
mailbox's warmup contribution; it is never permission to activate a campaign.
A new/dedicated mailbox needs a healthy check after 21 active warmup days,
then placement. A mailbox declared habitual proceeds to placement immediately
after connection, without that initial warmup period. Measured warmup spam can
hold either type (`recommended_go_live.kind: "held"`). Missing metrics or fewer
than 20 measured sends cannot clear an existing spam hold. A projected date is
the earliest initial-period completion, not an automatic campaign launch.

User pause, connection suspension and deliverability remain independent.
Reconnection can release only the connection suspension, after warmup health
checks pass. A clean spam measurement releases only the spam hold; it does not
resume a user-paused warmup or activate campaigns.

Deploy the independent-pause migration first, then Jobs (which requires
`lif1228.warmup.v3`), then this API together with a CLI release supporting
`lifty-cli-context.v10` (next.34). v10 was later retired by the v11 client
release (LIF-1296). Older clients receive an explicit upgrade response.

## Shared deliverability read (LIF-1042)

`GET /v1/email/deliverability` is the single read behind the Deliverability
page and `lifty email deliverability`. It returns `email-deliverability.v1`:
one row per inbox (an address inside one workspace) with its senders, warmup
per provider, placement history, campaigns, approval, human notes and send
controls. Every state carries `code`, `label`, `tone`, `description` and
`reasons`, computed once here, so the page tooltip and the agent read the same
text. Workspace health is returned separately and is never an inbox result.

```text
GET /v1/email/deliverability?workspace=<slug-or-id>[&sender=<sender_ref>|unassigned]
    [&mailbox=<mailbox_ref-or-address>][&history_limit=1..8][&limit=1..100][&cursor=...]
GET /v1/email/deliverability?workspace=<slug-or-id>&mailbox=<mailbox_ref>&detail=placement
GET /v1/email/deliverability?scope=fleet            # LIFT admins only
```

The API calls `public.deliverability_read` (LIF-1041) with the caller's
session. The database authorizes the workspace, fleet scope, sender, mailbox
and cursor; omitting `workspace` never grants the fleet. `detail=placement`
projects stored placement samples for at most the three newest completed tests
of the one authorized inbox. It never contacts retired providers, creates tests,
sends seeds or changes sending. Historical tests retain their provider and
result; detail reports `no_report` when no sample was stored.

The presentation keeps the canonical rules separate: warmup running is not
the same as a completed warmup period, which is not the same as being allowed
to send; a configured campaign is never reported as proof of sending; a test
that did not run is an execution error, not a placement failure; and missing or
stale evidence is never shown as healthy. Placement results count as current
for 10 days where a rule applies. Sample sources and responses live in
`tests/fixtures/email-deliverability/`; the sources are real
`deliverability_read` output for the LIF-1041 two-tenant fixture.

### Google OAuth setup (LIF-995)

OAuth-enabled servers return a one-hour, single-use Lifty `/warmup/setup`
link. The page shows the mailbox, asks only for the sender name and has one
"Continue with Google" button. Lifty owns the warmup policy:
the stored version-1 policy is `DEFAULT_WARMUP_POLICY` in `src/warmup-setup.ts`
with the timezone the browser reports (the default applies when the browser
sends none or an invalid IANA zone). The page's only script fills that
timezone and is allowed by hash in the CSP. The policy does not reserve the
shared Mailivery daily pool or change Lifty's outreach cap. Provider refusal
leaves setup blocked. Policy is immutable after handoff; editing an
already-bound warmup is not part of this setup surface.

Google consent requests `openid email https://mail.google.com/`, offline
access, PKCE and a nonce. The callback verifies Google's signature, issuer,
audience, expiry, nonce and `email_verified`, then compares the canonical
address without treating aliases, dots or plus-addressing as equivalent.
The access/refresh tokens exist only inside the callback request. They are
forwarded once to Mailivery and never persisted, enqueued or logged by Lifty.
Mailivery necessarily stores the credentials for its ongoing mailbox access.

Browser form submissions require same-origin and a browser-bound CSRF cookie;
OAuth state is also bound to that HttpOnly/SameSite cookie. Database intent
records store only hashes and non-secret setup data. Every step revalidates
the original member, active workspace, current Unipile connection and exact
mailbox. A durable dispatch fence is committed before the provider POST.
If the request fails or its response is lost, no callback, refreshed setup
link or removal/recreation automatically resends the tokens. Jobs reconciles
by authenticated campaign readback, including both tags and all email fields.
No campaign becoming visible is not proof that creation failed: operator
review is required to resolve a permanently ambiguous handoff.

Deploy in order: the LIF-995 migration in `lift-supabase-functions`, the
policy-aware Jobs worker, a CLI that trusts the pinned API setup URL, then
this API. Existing signed Mailivery links must expire or be reconciled before
the first OAuth canary; an already-open hosted form cannot be revoked here.

Before setting `LIFTY_WARMUP_SETUP_ENABLED=true`:

1. Configure one Google web OAuth client and the exact redirect URI
   `<PUBLIC_BASE_URL>/warmup/google/callback`. Use an External app published
   to production (unverified is acceptable for the pilot: 100-user cap and
   Google's unverified-app screen). Testing-mode refresh expiry is unsuitable
   for 21 days. Restricted-scope verification removes the screen and the cap.
2. Save that same client ID and secret in Mailivery (Settings → Team Settings →
   API Access → Google OAuth Credentials) before creating a mailbox, and deploy
   `LIFTY_WARMUP_GOOGLE_CLIENT_ID` / `LIFTY_WARMUP_GOOGLE_CLIENT_SECRET`.
   This is Lifty's one Google client: configure the same client in the
   runtime's Unipile application. The email connect page shows the client ID
   in the Workspace Trusted instructions whenever it is set, without the
   secret and even while warmup setup is off; the connections profile accepts
   the ID and refuses the secret. The pilot deploy pins the ID next to its
   Unipile application.
   Mailivery's partner OAuth endpoint needs no separate enablement: a
   placeholder probe on 2026-09-23 passed its enablement gate (LIF-986).
3. Keep proxy/APM body capture off for these routes and outbound OAuth calls;
   redact callback query strings and setup links from access logs. Application
   errors expose only bounded public messages, never provider response bodies.

Test first with an owned non-live-sender mailbox. Creating a Mailivery campaign
may itself initiate provider activity: a disabled Jobs schedule is not a
guarantee that Mailivery will send nothing. Within 48 hours verify token
refresh after an hour, same-address rejection, that a second create for the
same email is refused, policy readback, health polling and pause/resume
before the first founder; keep the canary running and test removal last.
These live-provider checks are not replaced by the local fake-provider suite. OAuth must be enabled
for v1 launch; the legacy mode exists only for staged compatibility.

References: [Mailivery OAuth](https://mailivery.readme.io/reference/createcampaignwithgoogleoauth),
[Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).



## Password recovery (LIF-837)

The hosted `/cli/auth` login includes **Forgot your password?**, opening a separate `/auth/password-reset` page. It requests recovery through the existing Supabase Auth public REST API. Known and unknown addresses receive the same success message; no email is retried automatically.

Configure this single exact Supabase Auth redirect URL for the deployed `PUBLIC_BASE_URL`:

```text
https://api.liftygtm.com/auth/password-update
```

Preserve the existing Site URL, other redirect entries and SMTP configuration. The recovery email template must use Supabase's normal recovery confirmation URL so Auth verifies its one-time recovery token and redirects to the supplied `redirect_to`. A template that hardcodes SiteURL, strips the fragment or converts to PKCE requires a separate configuration correction; this implementation does not accept an arbitrary return URL.

Recovery uses the documented implicit flow so the email can open in another browser without a stored PKCE verifier. `/auth/password-update` removes its URL fragment/query immediately, checks its recovery access token against `GET /auth/v1/user`, and lets the owner choose/confirm a new password via `PUT /auth/v1/user`. It keeps no recovery token in local/session storage or cookies, discards the refresh token, and makes a best-effort `POST /auth/v1/logout?scope=local` after success. Supabase access JWTs may remain valid until expiry; this does not promise absolute token revocation or terminate other sessions.

The recovery page never calls the CLI loopback endpoint or grants workspace access. After changing the password, return to the original login tab and sign in/approve normally, or run `lifty login` again if that request expired. The CLI's original nonce, origin and fixed loopback-port checks are unchanged. Closing/reloading the recovery page loses its in-memory session; request a fresh link. Password-update network/server ambiguity reports that the change may have happened and does not replay it.

Validation: browser-script tests execute the delivered inline JavaScript against mocked Auth REST responses, plus public-route/CSP and production-composition checks. They do not prove live email delivery or project Auth configuration. A live test must be performed by the account owner after deploying and allowlisting the exact URL; only the owner enters the new password.

Primary contracts: [password recovery guide](https://supabase.com/docs/guides/auth/passwords), [Auth REST schema](https://github.com/supabase/auth/blob/master/openapi.yaml), [official Auth client recovery/transport](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts), [redirect allowlist](https://supabase.com/docs/guides/auth/redirect-urls). No mandatory email-verification or leaked-password setting is introduced.

## Workspace retirement

Workspace members and LIFT admins use the same retirement endpoint,
`POST /v1/workspaces/{workspace_ref}/retire`, with the exact current name and
slug as confirmation. The caller's JWT is forwarded to `retire_lifty_workspace`;
there is no privileged API credential or role bypass. SQL permits retirement
only without business history and after all required integration disconnections
and revocations finish. Shared references and historical sender/reply evidence
remain protected. Retirement preserves the login and acquisition budget; it
never deletes business history to make a workspace eligible.

Requires the LIF-1590 Functions migration before member retirement is enabled.
Provider disconnects remain explicit operations and are never performed by this
endpoint. Unknown errors and mismatched identity receipts fail closed.

## Company mapping for the local agent

`GET /v1/integrations/hubspot/company-mapping/context?workspace_ref=<uuid>` returns current portal properties, mappings, task instructions and the candidate schema. The optional workspace selector requires current membership and a supported active Lifty workspace; omission retains the single-workspace default. `POST /v1/integrations/hubspot/company-mapping` executes the deterministic workflow in **lifty-api**. The local agent calls the CLI, the CLI calls this API, and the API uses HubSpot plus one narrowly authorized storage RPC. It no longer invokes the company Edge Function.

The API validates a locally generated plan, makes additive property changes, atomically inserts missing mappings and reads them back before returning `verified: true`. It has a 55-second operation deadline and 15-second provider request deadlines; the CLI allows 65 seconds. A timeout or partial provider failure requires fresh context before another apply. Existing operator mappings are never replaced.

`DASHBOARD_READ_ONLY_MODE=1` or `CONSUMER_READ_ONLY_MODE=true` blocks apply with `503 MAINTENANCE_READ_ONLY` before storage/provider calls, while context stays readable. Configure the same maintenance flag on the API service when cutting over from Edge; deployment environments are separate.

Storage requires **both** the caller's verified user JWT/current workspace membership and a separate `LIFTY_CRM_SERVER_KEY`. This capability permits only company mapping state/publication and the selected integration's credential resolution/rotation/reconnect state. It grants no arbitrary SQL, Vault or tenant access. The API remains forbidden from holding a Supabase service-role key. Credentials are parsed by the shared HubSpot grant policy, portal-bound before provider writes, and rotation uses a credential-version compare-and-swap.

Rollout: apply `20260916115048_lif858_company_api_capability.sql`, provision a cryptographically random dedicated key in API secret configuration and only its SHA-256 in `private.lifty_crm_server_config`, then deploy the API. `/readyz/crm` must return `{status:"ready",capability:"lifty-crm-company.v1"}`; `scripts/digitalocean.sh smoke` enforces that independently of general health. It validates the installed RPC/version/key without reading tenant data or contacting HubSpot. A missing/mismatched key fails this probe and company requests return 503. Release the matching CLI after verifying an authenticated workspace context/apply/readback canary. Keep the old Edge deployment only for rollback during this rollout; disable/remove it after API cutover is verified. Never copy production tokens into canary output.

### Company cutover rollback

1. Set `CONSUMER_READ_ONLY_MODE=true` in the API deployment to stop new company apply operations. Context remains available; already accepted HubSpot changes require a fresh readback.
2. Keep the additive CRM migration and the previously deployed Edge Function. Do not roll back the entire API once new receipt/config Jobs are live: older API schemas cannot read their contracts.
3. Prepare a forward rollback on a branch from **current main**: revert only the native company migration commit (`11cf448`, excluding later receipt/config changes), resolve integrations with the current tree, and restore the previous caller-scoped Edge adapter. Keep company apply frozen while validating. The rollback restores the old single-workspace behavior; explicit multi-workspace requests must fail clearly instead of selecting another workspace.
4. Run `npm run verify`, verify the restored Edge with an authenticated nonproduction context/apply/readback canary, and merge the reviewed rollback. Deploy its **new main SHA** by following the automatically triggered `Deploy` workflow. Use `bash scripts/digitalocean.sh deploy <full-new-main-sha>` only for an intentional manual redeploy, not alongside CI. The deployment script deliberately rejects old/non-head commits; do not bypass that protection. The company-only revert restores the previous smoke script (health, readiness, OpenAPI and failed-closed authentication); use the Edge canary as the company capability proof for this rollback, since that API revision has no native `/readyz/crm` route.
5. Remove the maintenance flag only after readback verifies the intended workspace/portal. Existing DB mappings and provider properties remain intact. Never delete additive provider fields to simulate a rollback.

Company setup guidance is served through the current v6 CRM stage context.
Earlier client profiles are retired; the response envelope remains
`lifty-context.v1`. The company mapping backend must be available before use.

## General CRM mapping and verified record links (LIF-897)

Current v6 clients discover the full mapper through `context crm`. Its
`mapping_catalog`, `mapping_sources`, `mapping_preview`, `mapping_apply`,
`property_create`, `mapping_sync` and `mapping_status` operations reuse the
existing CRM mapping contract. The bounded company onboarding flow remains
available. `records` returns contact/company links only after live identity
checks in the currently connected portal. Saved person location is distinct
from company headquarters; no enrichment purchase is part of these reads.

Mapping edits do not update records. Replay requires the selected cohort of
at most 25 leads, current scope/version, a fresh preview digest and a stable
request reference. The `lifty-crm-mapping-sync` worker uses the saved ledger
plan and reports per-field readback. Queue acceptance is not verified success.
Maintenance mode blocks mapping apply, property creation and replay submission;
read operations remain available.

Release the LIF-897 database migration through its owning CI, then deploy the
matching Jobs task before this API. The existing dedicated CRM capability key
also gates `lifty_crm_mapping_tools`; no API service-role key is introduced.
`/readyz/crm-mapping` must return
`{status:"ready",capability:"lifty-crm-mapping.v1"}` alongside the existing
`/readyz/crm` capability. Deployment smoke enforces both. This static probe
checks the installed RPC/version/key without reading tenant data, credentials
or HubSpot; it does not prove that the replay worker is deployed. Verify the
Jobs task version separately and use a disposable nonproduction exact-cohort
preview/replay/readback canary under the existing canary policy. Generic v6
clients consume these API-owned operations without a new CLI business registry.

## CRM notes and conversations (LIF-1239)

`get crm preferences` and `patch crm preferences` expose the three founder
choices of the strict v1 `crm_artifact_policy`: research notes
(`none`/`on_complete`), conversations (`none`/`on_reply`/`all`) and their
channels (`email`, `linkedin`). The member RPCs resolve the workspace and its
selected CRM, merge omitted choices, preserve every other metadata key
(including Attio campaign-send history) and reject a stale `expected_version`.
A database trigger records every policy change on a CRM integration, including
operator dashboard writes, so all writers share one version. Jobs reads the
policy on every run; a change applies to future CRM writes only.

Release order: apply Functions migration
`20261006150000_lif1239_crm_preferences.sql` through its owning CI before this
API. Without it both operations return the 502 unavailable error and change
nothing.

## Staged Unipile V2 connections (LIF-916)

V2 is an additive, database-selected transport. Keep the V1 DSN, credentials,
namespace and hosted domain intact. Set `UNIPILE_V2_ACCESS_TOKEN` and
`UNIPILE_V2_APPLICATION_ID` together, with an application-scoped key. The API
uses `https://api.unipile.com/v2` for V2 only. Credentials alone do not select a
workspace or change an existing connection.

Apply the reviewed Functions LIF-916 migration and signed V2 lifecycle endpoint
before selecting pilot workspace/channel routing. The existing email/LinkedIn
RPCs return an immutable `transport` snapshot per intent and the active transport
per connection. Copied accounts preserve canonical V1 connection IDs, mailbox
budgets and LinkedIn history; provider calls use only the verified V2 alias.
Administrative prebinding must verify the provider's `metadata.v1_account_id`,
application, scope and owner against the existing canonical connection. New
V2-only accounts retain their real V2 ID and `unipile:v2:<application_id>`
namespace. They cannot be rolled back onto a fictitious V1 account.

`UNIPILE_V2_HOSTED_AUTH_ORIGINS` is a comma-separated allowlist of Lifty's
verified HTTPS hosted sign-in origins; the provider's default pages are rejected.
The attempt snapshots its origin; the API passes that domain to Unipile, checks
the exact returned origin, and redirects only to an allowlisted origin. Keep
previous origins in the allowlist until their links expire.

The API first claims the intent, persists a channel-separated HMAC state, and
issues one hosted link. Browser return parameters never authorize attachment.
Only a separately authenticated, state-bearing lifecycle event can supply the
account for exact-attempt polling. Polling independently reads the account and
owner, checks application/scope, and submits verified evidence to SQL. SQL
rechecks ownership, current attempt, expiry and disconnect races. Reconnection
never enables sending. Provider health is observed by Jobs, never by API reads.

Currently V2 accepts Google mailbox connections with exactly one verified primary
email sender, and LinkedIn with an exact self-profile match. V2 deliberately
rejects other mailbox providers until equivalent vendor identity evidence exists.

Rollback disables new V2 routing and uses the retained mapping's generation CAS
for copied accounts. Keep V2 credentials, endpoint and domains available while
V2 attempts or retained operations need reconciliation; do not erase mappings or
change the V1 namespace. Jobs must retain each operation's transport separately
so a successful or ambiguous send is never retried against the other version.

Local contract tests prove fail-closed API behavior, not vendor production
readiness. Release still requires independent review, actual signed webhook
validation, copied-account prebinding and a permitted live pilot. Sources:
[Hosted auth](https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth),
[provider features](https://developer.unipile.com/v2.0/docs/list-provider-features),
and the official [Unipile SDK](https://github.com/unipile/unipile-node) schemas at
`f839654cf7c8856635b9dae6032d00a91489560b`.


### LinkedIn disconnect recovery (LIF-1592)

`sending-accounts.resume_campaigns` exposes the confirmed member action as
`POST /v1/workspace/sending-accounts/{id}/resume-campaigns` and
`lifty post sending-accounts resume-campaigns`. The installed CLI discovers the
operation from this API's catalog; no client-contract change is required.

Deploy this API **before** Functions migration
`20261021180000_lif1592_disconnect_campaign_resume.sql`: existing strict account
readers reject the new `disconnect_pause` field. This revision accepts both
shapes. Recovery becomes usable when that migration is active; deploy the
compatible dashboard after both. Reconnecting and account Resume remain
separate from explicit campaign recovery.

## Isolated connection profile

**Verified:** LIF-1619 source and local contract checks, 2026-10-25.

`LIFTY_RUNTIME_PROFILE=connections` composes the same Auth, sender, email and
LinkedIn connection handlers and shared confirmation controller. Initial
connections use the isolated Unipile V2 application and distinct email/LinkedIn
capabilities. It accepts no CRM, Mailivery or Trigger credentials. Its route boundary closes campaigns,
research, warmup, placement and notification sends before any handler can queue
work. Its OpenAPI response lists only enabled operations. The default `full`
profile retains all existing required settings and behavior.

`/readyz` checks Auth, the installed database catalog, replay heartbeat and both
channel capabilities. LIF-1619 requires Functions' guarded LinkedIn profile
migration `20261025010000_pilot_linkedin_connections.sql` and its verified staging
artifact before this API. The deployment preflight checks both capabilities;
the previous email-only API remains compatible during database rollout. A real
session, signed authorization and provider identity verification are still
required to establish a connected account. Connecting never enables sending.

`.do/pilot-app.json` describes the separate `lifty-api-pilot` App Platform app at
`api.pilot.liftygtm.com`, using one 0.5 GB instance. `scripts/prepare-pilot.mjs`
pins it to the approved staging Supabase project and pilot Unipile application,
checks runtime configuration and writes a private spec outside the checkout. It
never creates or updates resources. The API and Functions release workflows need
the same dedicated `STAGING_LINKEDIN_SERVER_KEY`, distinct from the email key.
When installing the capability, the owning deployment updates the app spec with
`--update-sources` so the new configuration and current staging code deploy
together. A spec-only update reuses the previous source and can fail startup.
Deploy the Functions profile, then API, then dashboard. See the runbook before
provisioning.

## Mailbox use changes (LIF-1603)

`sending-accounts.declare` exposes
`POST /v1/workspace/sending-accounts/{id}/declare` and
`lifty post sending-accounts declare` with
`{"mailbox_use":"habitual"|"dedicated","confirm":true}`. It calls Functions'
`declare_lifty_sending_account_use`, so deploy this API after migration
`20261023213000_lif1603_declare_mailbox_use.sql` is live; account reads are
unchanged. The email connect page no longer preselects a mailbox use.

## Inbox verdict (LIF-1603)

Every `email-deliverability.v1` inbox carries one member-facing `status` and a
`next_step` (`code`, `owner`, `label`, `description`) built from the current
account first, then the shared sender gate's reason, then campaigns. A missing
send-time safety check (`email_safety_check_required`, the gate's last check)
is not a blocker: such an inbox is `ready_idle` without an active campaign. New
status codes are `disconnected`, `needs_reconnect`, `on_hold` and
`setup_needed`. A LIFT pause never changes the verdict; `account.outreach` and
`connections[].controls` still report it. The dashboard reads status codes as
strings, so either deploy order is safe; deploy the dashboard that renders
`next_step` after this revision.
