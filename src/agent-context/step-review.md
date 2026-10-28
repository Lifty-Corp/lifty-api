# Section 1 · Review the leads, sync the CRM, close the section

Goal: the founder sees real leads, tunes the target if needed, optionally gets
them into their CRM, and leaves Section 1 knowing what was done and what comes
next. Do `actions` from `next_step` in order; skip what the conversation has
already covered.

## 1. Show the leads

Use the finished cohort (`sample_review_get` if it is not already in this
conversation). Open with your read: the strongest lead and the pattern across
the five. Then a table: person, company, grade, LinkedIn profile URL, fit
rationale, evidence gaps. Every researched profile counts, including C; say
why lower-fit leads missed. Use only returned profile URLs.

## 2. Tune the target

Ask one question: does this sample confirm the targeting, or what should
change? A change clarifies only the affected decision, then follows
`summary_context` task `targeting` or `research-criteria` (synchronous versioned PATCH,
readback) and reruns the sample. Never relabel grades, widen the
market or invent fit. When several leads missed for the same reason a search
filter can express (industry, company size, location), propose that Targeting
filter: research costs time and budget, and the filter keeps it on people who
can fit. A lane that matched nobody (`matching_people: 0` in `lanes`) needs
its filter repaired, never a wider market. `references.calibration` covers
diagnosis.

When the founder confirms the sample, or moves on without asking for changes,
record it once with `sample_review_confirm` and the sample's `run_ref`.
`next_step` returns this review until you do. A new sample after a targeting
change needs its own confirmation.

## 3. CRM and existing customers (optional)

Follow the CRM action in `actions`; ask about it once. HubSpot and Attio
connect here; for another CRM say it is not supported yet and continue.
Connecting a CRM to receive leads does not authorize reading its customers.
Separately read `customer_exclusions_source_choice_get`. If it is `unselected`,
offer selected CRM customer sources, a customer file, or neither once. Save
their explicit choice with `customer_exclusions_source_choice_post` and the
read's version (summary_context task customer-exclusions). A saved CRM, file or
neither choice answers this question; keep it and do not ask again. If the
read is unavailable, retry it without assuming consent or blocking setup.
Read `customer_exclusions_status` for existing protections before a file
import with `customer_exclusions_import`. Importing never changes source
choice or grants CRM access. A file can complement CRM exclusions. Neither
allows setup to continue; explain that unknown existing customers will not be
excluded. Saved exclusions and do-not-contact rules remain active in every mode.

- Connect: `crm_post` with the founder's `provider` (`hubspot` or `attio`), show the returned link right away as a Markdown link,
  and after the founder finishes, `crm_get` with that `attempt_ref`. Only
  `connected` with `verified: true` confirms it.
- HubSpot company setup before the first sync: `crm_mapping_context`; if it is
  not ready, prepare the bounded plan per `references.company_mapping` and
  apply it with `crm_patch`. Attio needs no company setup.
- Notes and conversations before the first sync: `crm_preferences_get`, show
  the saved choices and ask whether they want research notes and
  conversations (all, or only once a lead replies; email, LinkedIn or both) in
  their CRM. Save only what they change with `crm_preferences_patch`.
- Sync: `crm_sync_start`, then `crm_sync_status` for that `run_ref` until it
  finishes. Report contacts, research notes and companies delivered
  separately; partial delivery is not full success.

## 4. Close Section 1

Once the founder is happy with the leads (and the CRM question is answered),
close the section in at most six lines: who Lifty targets and why, the five
leads and their grade mix, what reached their CRM, and that Lifty can keep
finding leads like these. If the founder already connected LinkedIn or a
mailbox, or saved a campaign, while the sample ran, `actions` says so: do not
offer it again, and call `next_step` after the confirmation to continue there.
Otherwise ask one question: set up LinkedIn outreach for
these leads now? LinkedIn goes first; email comes later, once a mailbox is
ready. If yes, connect their LinkedIn as the close action in `actions` says:
find the founder's sender in `senders_get` (create it only when absent), then
show the connection link from `sending_accounts_connect` for that sender. The
templates come after the account connects; `next_step` leads there. A
founder who would rather start with email connects a mailbox the same way,
with channel `email`; `next_step` then guides its preparation.
If "not now", accept it and do not ask again this session.

Section 1 never sends messages or activates outreach. The confirmation records
only that the founder accepted this sample; it does not approve a campaign or
authorize sending.
