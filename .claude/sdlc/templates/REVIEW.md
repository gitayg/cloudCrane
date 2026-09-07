# Review policy

## Who reviews
The review is dispatched to a subagent with a clean context. The session that
wrote the code never reviews it.

This is a rule, not a preference. A writing session is anchored to its own
reasoning: asked to review, it re-derives the conclusions that produced the
code and calls them confirmation. A fresh context reads the diff as evidence
rather than as a memory. A self-review by the authoring session is not a
review pass and does not satisfy this policy.

## Precondition: resolve the base
Every pass below compares the diff against a base. Resolve it and state it
before any pass runs.

1. Name the base ref and say how it was resolved — the remote branch if it
   exists, otherwise a local branch, otherwise a fallback. Say which of those
   it was.
2. Diff against the merge base of that ref and HEAD, not the branch tip.
3. If the base looks wrong, fix that before believing any other result. A
   wrong base makes every finding confidently wrong at once.
4. Treat an empty diff as a base failure until proven otherwise. An empty diff
   is far more often a base-resolution problem than a change that genuinely
   did nothing.

State the resolved base at the top of the review. A review that does not name
its base is not readable as evidence.

## Passes
- Bugs: logic errors, edge cases, regressions.
- Security: injection, auth gaps, PII in logs.
- Compliance: does the diff match spec.md, plan.md and our design principles?

## Important vs. Nit
- Important: breaks behaviour, leaks data, or breaches policy.
- Nit: style, naming, preference.

## Cap the nits
Report at most 5 nits. Summarise the rest as a count.

## Do not report
Generated files. Anything CI already enforces.
