# Session fence and tenant isolation (LIF-627/628)

Every protected REST request validates signature, expiry, issuer, audience and
role, then checks the caller's active Auth session with its own JWT through
`lifty_session_active` (Functions migration
`20260916111819_lif627_active_session_fence.sql`). The same session predicate
runs as PostgREST's pre-request hook, covering direct Data API calls and
rechecking authorization before each database operation. An expired, revoked,
foreign, missing or malformed session, a deleted/banned user, or an unavailable
upstream returns the generic `invalid_session` result. Affirmative session
checks are not cached. This adds one bounded RPC per REST request.

The migration preserves the existing anonymous capability and backend contracts.
It refuses to replace a different pre-request hook. It grants no Auth table
access to founders and exposes only the current session's boolean status.

## Verification

Database tenant isolation is proven by the Functions CI pipeline: the clean
migration replay, the core tenant and SECURITY DEFINER tests and the live drift
tripwire, followed by its `production-database` job. There is no local database
verification (LIF-1636). The API side is covered by `npm run verify`, whose
route tests exercise protected operations with missing, malformed and expired
JWTs before any upstream work.

The LIF-628 local evidence receipt remains in git history. The Functions replay
script its fixture needed was removed with LIF-1636, so that fixture is no
longer a verification path.

## Rollback boundary

For an API-only rollback, restore the previous reviewed API release while keeping
the database fence. Deploying an API without its session RPC deliberately fails
closed for authenticated requests. Removing the database fence needs a
separately reviewed recovery plan: simply disabling it restores the revoked-JWT
exposure. Do not relax grants, RLS or the session predicate to make a test pass.
