# Weekly reports and measurement

Purpose: answer how outreach is performing, with the figures the weekly digest shows. Read `references.common` first. Everything here is read-only and computed by Lifty: quote the figures you read, and never add, average or estimate your own.

Pick the read by the period:

- A closed Monday-to-Monday UTC week: `reports_get` with `start` and `end`, both Mondays, at most 735 days apart. `end` is excluded, so one week is that Monday and the next. These are the stored reports the digest reads.
- The week in progress, an exact range such as the last 30 days, or a closed week `reports_get` does not return: `reports_measurements` with `start` and `end` as timestamps with their offset, at most 731 days apart. Same metric ids. A live range is not a stored report and can change.
- The people and records behind one figure: `reports_details` with the week, the `metric` id and the report's `calculated_at`, unchanged. Limit 1 to 500, default 100. Pass `next_offset` as `offset` until it is null.

A correction replaces a closed week, and its `calculated_at` changes. When a details page returns `stale: true`, or a `calculated_at` other than the report you hold, read `reports_get` again and reload the count and its details together. Do not mix an old count with a new page. `REPORT_NOT_FOUND` means no report is stored for that week; use `reports_measurements` for it.

Every metric carries its `availability`, and only `complete` and `partial` are measured numbers:

- `complete`: measured.
- `partial`: measured, but its history starts inside the period; say so.
- `collecting`: a 28-day cohort still maturing, until `matures_at`. Too early to judge, not a low result.
- `unavailable`: Lifty cannot say, because history is missing or a CRM has not synced or failed. Not zero.
- `not_applicable`: the channel is unused or no CRM is connected. Not zero and not poor.

A complete value of 0 is a real zero. `reason` is the code for the state. `REPORTS_UNAVAILABLE` means the read could not be verified, which is not zero: retry it.

`research-schedule status` counts the research admitted into a week against its limit, an operational figure. `research.*` here counts people when their first research completed. They can differ for the same week; do not reconcile or swap them.

Tell the founder what the figures mean in plain words. Do not show ids, and do not read out metric ids or `reason` codes.
