---
name: shadowjoin
description: Measure how many matches a join or matching pipeline is silently dropping, and fix it. Use when records "aren't matching", duplicates slipped through, a join returns fewer rows than expected, a dedupe step looks wrong, or before and after editing any matching, joining, dedupe or entity-resolution logic. Requires the shadowjoin MCP server.
---

# shadowjoin

A join that drops rows raises no error. The query returns, the dashboard renders,
and the missing matches are invisible. This skill measures that loss and proves
whether a fix worked.

## When to use it

- The user says records aren't matching, rows are missing from a join, duplicates
  got through, or a dedupe/merge produced the wrong count.
- **Before** you change any matching, joining, normalization or dedupe logic —
  take a baseline first.
- **After** you change it — you cannot otherwise tell whether your edit helped.

## The loop

1. **`scan_join`** — baseline. Note the `runId`, the `exactMatchRate`, and the
   `lowerBoundLossPct`.
2. **`explain_misses`** — pull real pairs. Show the user actual values, not a
   percentage. A reviewer believes `"Altria" -> "Altria Group Inc."`; nobody
   believes "85%".
3. **`suggest_normalization`** — get the ranked rules with pasteable SQL and JS.
   Apply them to the user's pipeline.
4. **`scan_join`** again, then **`compare_runs`** — prove the change landed.

## Rules for reporting this

**The number is a floor, never an estimate.** Say "at least 23% of matches are
being lost", never "23% of matches are lost". The shadow matcher's own recall is
unknown, so the true figure can only be larger.

**Never claim an improvement without `compare_runs`.** If you changed matching
logic and `exactMatchRate` did not move, your change did not take effect — say
that plainly rather than reporting success.

**Always surface contradicted and ambiguous pairs.** `contradicted` means the
matcher merged two records that ground truth says are different. `ambiguous`
means several candidates collapsed onto one key — typically share classes,
product variants or franchise locations. Those need a tie-breaker, not another
normalization rule. Never recommend adopting a rule without showing these counts.

**More rules is not better.** If the report warns that the full rule set recovers
fewer matches than a subset, recommend the subset it names. Over-normalization
merges records that should stay apart.

**Adopting a rule widens matching.** Say so. Recovering 400 matches at the cost
of 12 wrong merges may be a bad trade in a billing system and a fine one in
search. That judgement belongs to the user — give them both numbers.

## Privacy

`explain_misses` returns real key values. If the data looks sensitive — people's
names, emails, account numbers — tell the user before dumping examples into the
conversation, and prefer summarising the *rule* and the count over pasting rows.

## What it will not do

It does not write, fix, migrate or dedupe anything. It measures, and it hands you
expressions to apply yourself. If the user asks it to "fix the matching", the fix
is you editing their pipeline with `suggest_normalization`'s output and then
proving it with `compare_runs`.
