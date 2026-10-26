# HubSpot application project

This directory owns the existing Lifty HubSpot application configuration.
`hsproject.json` selects `src/`; `src/app/app-hsmeta.json` declares the app
identity, OAuth redirects, scope groups and public support metadata. Run any
reviewed HubSpot CLI operation from this directory.

The files were relocated unchanged from Compass's LIF-603 project. Relocation
does not upload the project or change the installed HubSpot application. Compare
the configured project with the intended provider account before an explicitly
authorized upload. Keep account credentials outside the repository.

Hosted authorization is implemented in `src/hubspot-oauth.ts` at the repository
root. The shared grant policy and consumer update procedure live in
[`contracts/hubspot-grant-policy.md`](../../contracts/hubspot-grant-policy.md).
