# Review targeting while progressing outreach setup

Apply this workflow after the initial lead run and after every targeting or
research-criteria change. The review sample is five researched candidates
under the current confirmed ICP, each with its actual LinkedIn profile URL
and a concrete fit rationale. **Every recorded tier, including C, counts for
review.** A sample with three A, one B and one C is complete; even five C
candidates are valid evidence for reviewing the targeting. Preserve grades
and explain the distribution. Completion means the evidence is ready, not
that every candidate fits or that the founder has accepted the targeting.

The sample measures targeting quality; it is not a prerequisite for outreach
setup. If the founder wants to continue, help choose a channel, connect their
account and draft outreach while calibration remains pending. This also
applies after an ICP change, with fewer than five leads, no A leads, a reached
weekly research limit or no CRM. Pause only the operation that needs a missing
input. Exact campaign approval and authorization to send remain separate.

The tier-independent rule applies to `calibration_policy: researched_v1`.
Historical `tier_a_v1` and `qualified_ab_v1` runs keep their recorded policies.
An explicit retry of a failed run adopts the current policy and reuses its
saved candidates and completed research. Do not describe that as new research.
If an older backend still returns a quality checkpoint instead of upgrading,
report the compatibility blocker; do not buy replacements or relabel leads.
Unknown policies must not be treated as proof of readiness.

## Read the evidence before changing the search

A means strong positive company and buyer fit, supported by evidence or
credible proxies, without a confirmed hard exclusion. B means meaningful
positive fit whose company fit or buyer relevance is less convincing. C means
a confirmed hard exclusion or clear mismatch with the confirmed target.

For each criterion, distinguish required conditions, preferences, and hard
exclusions. Evidence can support a criterion, contradict it, or leave it
unknown. Missing ARR or sales-leadership evidence is not itself a failed gate,
an automatic downgrade, or proof of A. Require positive fit for A and B.
Keep estimates and unknowns visible. Research retrieval failures are technical
failures, not evidence against a company. Do not silently change grades to
fill the sample.

Aim to surface strong Tier A candidates on the first research run. If that
misses, identify the cause from saved evidence and recommend one specific
targeting or research-instruction correction for a second run, subject to the
founder's intent and remaining weekly research volume. This is a quality objective, not a
promise of A grades or permission to relax confirmed limits. Never relabel
leads, invent fit, or acquire repeated waves to satisfy the objective.

## Review the first cohort

1. Wait for setup or the targeting update to finish. The sample uses five
   people of this week's research volume (`context research-schedule`).
   Fetch `context sample-review`, then use `lifty post sample-review --input -`
   with `{ "body": {} }` to research the initial five candidates. With fewer
   than five people left this week it returns `RESEARCH_LIMIT_REACHED` and
   `resets_at`. Keep its `run_ref` and use `lifty get sample-review progress`
   as described in the sample guide. Pass the returned cursor on the next wait and report newly completed
   research between calls; do not insert fixed two-minute sleeps. Once five profiles have current research and
   rationale, the cohort is ready regardless of its tier distribution. The
   service does not acquire repeated waves to replace low-fit candidates.
2. Open with your read: the strongest lead and the pattern across the returned
   cohort. Then present it as a table with person, company, actual grade,
   **LinkedIn profile URL**, fit rationale, and evidence gaps. Include C leads
   with their mismatch reasons; they are part of the review. Distinguish
   profiles missing a valid LinkedIn URL or rationale as incomplete evidence.
   Use only returned profile URLs. Optional research/dashboard
   links never replace them. Preserve discovery and research counts and show
   how many of the required five sample places are filled.
3. Separate sample completeness from targeting quality. Missing current
   research, a valid profile or a rationale calls for a retry. A C
   verdict is a completed evaluation, not missing research. Wrong industries,
   geography, or company sizes suggest a discovery problem. Positive-fit
   companies downgraded only for unavailable evidence suggest a rubric
   problem. Confirmed exclusions stay excluded. Retrieval failures call for
   technical recovery. Do not remove an exclusion, widen the founder's market,
   invent missing facts, or claim success to fill the table.
   When several people were disqualified for the same reason a search filter
   can express (an industry, company size or location), propose adding that
   filter to Targeting. Explain it in one sentence: research costs time and
   budget, and the filter keeps it on people who can fit. A reason that needs
   evidence to detect stays in the research criteria. A `search_exhausted`
   sample means the targeting ran out of new matching people: propose one
   specific wider change. A lane with `matching_people: 0` in the sample's
   `lanes` (and a `targeting_matched_nobody` sample) matched nobody: a filter
   is wrong, not the market too small, so repair that lane's filter first.
4. A historical `calibration_review_required` result can be retried explicitly
   through `lifty post sample-review` to evaluate its saved cohort under the
   current policy. This is not permission for another acquisition wave.
   A current `calibration_sample_incomplete` result means some profile or
   research evidence is still missing; identify the missing input before retrying.
   For `research_limit_reached`, report the reset time, or offer the paid
   plans when the plan's total ran out (`context research-schedule`). A `research_failed`
   sample may be retried once against the saved candidates, preserving
   completed research and weekly usage. Never blindly retry low-fit results
   or a reached limit. A reset date limits new research, not account
   connection, reviewing saved evidence or drafting outreach.
5. When the five researched profiles are ready, ask: **"Does this sample help
   confirm the targeting,
   or would you like me to change the targeting? We can also prepare outreach
   while refining the sample."** Mirror the founder's language.
   State the actual tier mix and explain lower-fit candidates from their
   evidence. Offer targeting refinement when useful without requiring a
   minimum number of A/B leads to accept the review. Reporting results is not
   sample approval or eligibility to send to every reviewed candidate. If the answer requests
   outreach setup, continue that work instead of repeating the sample question.
6. If the founder requests changes, clarify only the affected business
   decision, fetch `context targeting` or `context research-criteria`, follow its
   synchronous versioned PATCH and saved-resource readback workflow, then repeat the
   sample and review. Approval of an earlier sample never carries across
   targeting or research-criteria changes. Preserve existing connections and
   drafts; only the sample's acceptance is stale. Do not submit setup again for an existing
   configured workspace. If the stage still reports an old completed run after a material
   change, explain the blocker instead of presenting old grades as fresh.
7. After sample acceptance (for example, "looks good"), or when the founder
   asks to continue outreach setup, fetch `context campaigns`. If no explicit
   channel choice exists, offer LinkedIn, email, both, or not right now and wait.
   A connected mailbox is not an email choice. Explain the chosen sequence
   before writing templates, then follow the campaign context's copy choice.
   Reuse the stated channel choice. Read the current `senders` and `sending-accounts` guides to
   connect the sender's Google or Microsoft 365 mailbox or LinkedIn account and verify the exact attempt; the person answers the
   account declarations on Lifty's connect page. Skip an already healthy connection unless reconnecting was
   explicitly requested. If they choose existing B leads,
   review their saved evidence against the current ICP and make the selected
   recipients explicit. Keep recorded grades and calibration status truthful;
   a changed ICP does not make all saved evidence unusable. Missing evidence
   may require a recipient-specific check, not five new leads before setup.
8. Connecting an account does not approve sending. Use the full workspace sequence preview and single confirmation/activation
   from the campaigns stage and its campaign reference. Reuse saved targeting
   and voice; do not require choosing sample recipients or individual times. Calibration sends no messages or invitations.

For example, after an ICP change with this week's research limit reached and
the founder saying "continue with Tier B leads", respond along these lines:
"We can prepare outreach with the B leads you choose. I'll check their saved
research against the updated targeting, and we can connect your account and
draft the messages now. New research can wait for Monday's reset."
Then perform the available next step or ask for its one missing decision.
Do not close with a multi-day wait when useful setup work can proceed now.
