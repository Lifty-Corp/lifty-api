# Sample review

Purpose: inspect the existing bounded lead cohort against confirmed targeting.
Read `references.common` and `references.calibration` in full.

## Read current state

GET returns the existing run, actual grades, evidence/links, its calibration
policy and `reviewed_at`, set once the founder confirmed this sample. `lanes`
lists what each Targeting lane's search matched (`lane_ref` is the lane's
`id`, with each persona's count); `matching_people: 0` means that lane matched
nobody, whatever the run's outcome. It does not invent a review result.
Preserve historical policy and grades; old cohorts are not new research.

## Founder confirmation

When the founder accepts the sample, or moves on without changes, POST
`sample-review confirm` with the sample's `run_ref`. Only the latest finished
sample can be confirmed: an older run returns `RUN_NOT_FOUND`, and a running or
failed one `RUN_NOT_REVIEWABLE`. Repeating it keeps the first confirmation.
`next_step` returns the sample review until the latest sample is confirmed, even
when an account was connected or a campaign saved while it ran. A targeting
change starts a new sample, which needs its own confirmation. The confirmation
does not authorize outreach.

## First setup and required inputs

After setup is imported, POST with an empty object body starts or re-attaches
the five-person sample for the current targeting. It uses five people of this
week's research volume (see `context research-schedule`); with fewer than five
left it returns 409 `RESEARCH_LIMIT_REACHED` with `resets_at` and starts
nothing. Give the founder that reset time, unless the plan's total is what ran
out (`limit.total_remaining` below five): then follow "When the plan's total is
used" in `context research-schedule`. It does not repeatedly research new
people until a desired grade appears. Use the returned `run_ref` with
`sample-review.progress` while work is pending. The first read returns immediately;
pass its `cursor` and `wait_seconds: 25` on the next call to wait for a change.
Keep one request open at a time. Report newly researched people as they appear,
then present the actual cohort when `terminal` is true. Do not sleep for two
minutes or POST again just to check progress.

Each progress response is the complete current cohort (at most 25 people).
`changed: false` means no change during that wait; reuse the cursor. Reconnect
with the same run reference and last cursor. Deduplicate narrated completions
by `run_ref`, `attempt` and `lead_ref`; a new attempt resets that comparison.
Research can become superseded, so retain the returned current snapshot rather
than adding counts from responses. These are observations of saved state, not
a persisted event history: intermediate changes can be coalesced, and partial
research may already exist when an attempt resumes. Preserve every actual grade.

A failed run is terminal; a read error is not. Retry a failed read with the same
run and cursor; never start a new sample automatically. Stop
waiting on terminal success/failure, cancellation, or a founder change of task.
Host tools may buffer output; Lifty returns progress as changes are observed,
but cannot guarantee the host narrates each lead in real time.

## Failure reasons

A failed sample's `error_code` is one of these customer reasons:

- `research_limit_reached`: this week's volume ran out. Give `resets_at`
  from `research-schedule status`; start again after it. When its
  `limit.total_remaining` is below five, the plan's total ran out instead: no
  reset renews it, so offer the paid plans as `context research-schedule`
  describes.
- `search_exhausted`: the targeting ran out of new matching people. Propose
  one specific wider targeting change and, once agreed, a new sample. Repair
  any lane with `matching_people: 0` first.
- `targeting_matched_nobody`: a lane's filters matched nobody, so its places
  could not fill. This is not a small market: never widen it. In `lanes`,
  inspect each lane with `matching_people: 0` (keywords, industries, industry
  codes, titles, seniorities, locations, employee ranges), change the one
  filter most likely to match no one within the founder's market, confirm a
  material change with the founder, then start a new sample.
- `research_failed`: a technical failure. Retry once with POST; it reuses the
  saved people and completed research.
- `calibration_sample_incomplete`: some people lack current research, a valid
  profile URL or a rationale. Explain the gap, then retry once.
- `calibration_review_required`: an older sample stopped for a grade check
  that no longer applies; POST reviews the same people again.

## Later edits

Grades and evidence are not editable, and a confirmation is not withdrawn. A
targeting/rubric change goes through its own stage and starts a new sample.
When several people were disqualified for the same reason a search filter can
express (industry, company size, location), propose that Targeting filter so
research is not spent on people who cannot fit; evidence-only reasons stay in
the research criteria.
A saved shortfall requires diagnosis before more work.

## User-facing behavior and errors

For `researched_v1`, all five researched profiles count regardless of tier,
including C. Three A, one B and one C is a complete sample, as is an all-C
cohort with complete evidence. Show person, company, actual grade, LinkedIn
profile URL, fit rationale and evidence gaps. Readiness to review is distinct
from targeting quality, founder acceptance and outreach eligibility.

Preserve historical policies and actual grades. An explicit POST retry of a
failed `tier_a_v1` or `qualified_ab_v1` run adopts the current review policy
using its saved cohort. Do not acquire replacements to chase A/B grades.
Missing current research, a valid profile or rationale still needs a retry;
`calibration_sample_incomplete` reports that evidence gap. Respect the weekly
research limit. A status error is not a failed
run. No new discovery is required merely to connect an account or draft outreach
with chosen saved leads; exact sending approval remains separate.

## After sample acceptance

"Looks good" after the lead table accepts the sample only; record it with
`sample-review confirm`. When the founder
continues toward outreach, fetch `context campaigns`. If channel intent is
missing, offer LinkedIn, email, both, or not right now and wait. Do not recommend
email simply because a mailbox is connected. Follow the campaign context to
explain the chosen sequence before configuring outreach. Reuse explicit choices;
never turn sample acceptance into campaign activation consent.

In a later session `next_step` returns this stage until the sample is
confirmed, and afterwards while nothing is connected or saved. Once
`reviewed_at` is set, the saved cohort is ready to use: do not present it as new
work or ask for a second review unless the founder wants one. A "not right now" answer about
outreach is not saved, so ask about it at most once per session and accept it.
