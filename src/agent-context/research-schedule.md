# Weekly research

Purpose: explain and change how many researched people this workspace receives
each week, and turn weekly research on or off. Read `references.common` first.

## How weekly volume works

- Every workspace has a weekly research limit set by its explicit plan.
  `get` returns it as `limit` with its `source` and `effective_from`; it is
  read-only.
- The week runs from Monday 00:00 UTC to the next Monday 00:00 UTC for every
  workspace. There is no timezone, start day or run-day setting. `resets_at` is
  the end of the week.
- A person counts once, when their first research completes, whatever their
  grade (A, B or C). `qualified` reports the A and B people separately.
  Researching a known person again never counts again.
- A person counts in the week their research was admitted, even if it
  finishes after Monday. Research that fails is released and does not count.
  Unused volume does not carry over to the next week.
- The five-person sample (`sample-review`) uses the same weekly volume: a
  complete sample leaves 20 of 25, 95 of 100 or 145 of 150. With fewer than
  five left, the sample is refused with `RESEARCH_LIMIT_REACHED` and its
  `resets_at`; nothing is borrowed from the next week. A sample after a
  targeting change uses five new people.
- When research runs during the week is managed by the platform. Customers do
  not choose days or times, and there is no calendar to configure.

## The schedule

The schedule is `weekly_target` plus `active` or `paused`. It exists from
workspace creation at version 0, paused, following the plan: until the founder
chooses a number, `weekly_target` reads as the limit and moves with it when the
plan changes. `effective_target` is the lower of `weekly_target` and the limit.
A plan change applies its new limit at once; it never rewrites a number the
founder chose, so a chosen target below a new, higher limit stays as it is.

- `patch` takes `{expected_version, weekly_target}` and nothing else. The
  target is a whole number from 1 up to the limit (above it returns
  `TARGET_ABOVE_LIMIT` with `limit`), or `null` to follow the plan's full limit
  again. The change applies to the current week; people already completed or
  reserved stay counted. Patching never activates.
- `activate` and `pause` take `{expected_version}`. Activating requires saved
  targeting and research criteria (`RESEARCH_NOT_CONFIGURED` otherwise). It
  does not require a sample, a CRM or outreach. Pausing stops new admissions;
  research already running finishes and its results stay. Repeating the
  current state returns it unchanged. Neither changes outreach, CRM sync or
  the sample.
- A stale `expected_version` returns `VERSION_CONFLICT` with
  `current_version` and writes nothing: read `get` again, then decide.

Ask the founder before activating, pausing or changing the target. Weekly
research costs volume every week; confirm the number and that research should
start, in their words. Activation never sends messages or starts outreach.

## Weekly status

`status` reads one week (default: the current one; pass `week` as its Monday,
`YYYY-MM-DD`). It reports `completed`, `qualified`, `reserved`, `remaining`
(effective target minus completed and reserved, never below zero), a `daily`
list that always adds up to `completed`, and `policy_version`, the schedule
version the latest admission used. After a change, a newer `policy_version`
shows the platform has adopted it.

A closed week below its effective target has `shortfall` with a count and a
reason, once the workspace existed for the whole week (its first, partial week
and any week before it have none):

- `search_exhausted`: the targeting ran out of new matching people. Suggest
  one specific way to widen targeting.
- `research_failed`: research could not finish for technical reasons. LIFT
  monitors it; nothing for the founder to change.
- `paused`: the schedule was paused during the week.

A failed read (`RESEARCH_STATUS_UNAVAILABLE`, `RESEARCH_SCHEDULE_UNAVAILABLE`)
means unknown: retry it. Never report it as zero, paused or failed.
