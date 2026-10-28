# Section 1 · Find and research five leads

Goal: five researched people under the confirmed target, shown to the founder
as they land. Do `actions` from `next_step` in order.

1. The sample uses five people of this week's research volume. With fewer
   than five left, `sample_review_post` returns `RESEARCH_LIMIT_REACHED` with
   `resets_at`: give that reset time and offer outreach setup with saved leads
   meanwhile.
2. `sample_review_post` with body `{}` starts or returns the bounded first run.
   Keep its `run_ref`.
3. Tell the founder you are finding and researching five people who match,
   that it takes a few minutes, and that you will share each one as it lands.
4. `sample_review_progress` with `run_ref`; then pass the returned `cursor`
   and `wait_seconds: 25` until `terminal` is true. Keep one request open at
   a time. Narrate each newly researched person in one line: name, company,
   grade, why. No fixed sleeps; never POST again to check progress.
5. When terminal, call `next_step` for the review.

A failed run is terminal; a read error is not. Retry a failed read with the
same run and cursor. Use `sample_review_get` to read a failure and explain its
`error_code` reason: `research_failed` may be retried once with
`sample_review_post`; `research_limit_reached` reports its reset time;
`search_exhausted` calls for one specific wider targeting change;
`targeting_matched_nobody` names lanes whose filters matched nobody, so repair
that lane's filter within the founder's market instead of widening it. Never
buy new leads to chase better grades.
