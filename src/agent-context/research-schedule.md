# Weekly research

Purpose: explain and change how many researched people this workspace receives
each week, and turn weekly research on or off. Read `references.common` first.

## How weekly volume works

- Every workspace has a weekly research limit set by its explicit plan.
  `get` returns it as `limit` with the plan's name (`plan_name`), its `source`
  and `effective_from`; it is read-only.
- A plan can also have a total: `limit.total_research_limit` and
  `limit.total_remaining`, both null when it has none. Seed, the plan every
  new workspace starts on, gives 25 researched people a week up to 50 in
  total. The total counts the same people as the weekly limit across the
  workspace's whole history, and the weekly reset never renews it.
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
  five left this week or in the plan's total, the sample is refused with
  `RESEARCH_LIMIT_REACHED` and its `resets_at`; nothing is borrowed from the
  next week. A sample after a targeting change uses five new people.
- When research runs during the week is managed by the platform. Customers do
  not choose days or times, and there is no calendar to configure.

## The schedule

The schedule is `weekly_target` plus `active` or `paused`. It exists from
workspace creation at version 0, paused, following the plan: until the founder
chooses a number, `weekly_target` reads as the limit and moves with it when the
plan changes. `effective_target` is the lower of `weekly_target`, the limit and
what was left of the plan's total when the week began. A plan change applies
its new limit at once; it never rewrites a number the founder chose, so a
chosen target below a new, higher limit stays as it is.

## When the plan's total is used

When `limit.total_remaining` is 0 (or below five for a sample), research
stops: weekly research admits nobody and a new sample is refused, even after
the weekly reset. Nothing else stops. Campaigns, senders, sending accounts,
CRM sync, replies and saved leads keep working, and the schedule stays as it
is. Tell the founder they have used the researched leads their plan includes
(the 50 of Seed), ask which paid plan they want to keep getting leads, and
send them to Plan in the Lifty dashboard, where they choose and pay. Never send
them to David or anyone at LIFT for this. Payment moves the workspace to the
new plan's weekly limit, without a total; it activates nothing.

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

A week capped by the plan's total works toward what was left of it, so a used
total is never a shortfall.

A failed read (`RESEARCH_STATUS_UNAVAILABLE`, `RESEARCH_SCHEDULE_UNAVAILABLE`)
means unknown: retry it. Never report it as zero, paused or failed.
