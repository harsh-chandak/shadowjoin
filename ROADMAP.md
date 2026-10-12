# Roadmap

Ordered by what each one fixes, not by effort. Nothing here is committed to a
date; it's the list of things that would make shadowjoin better, written down so
they don't get lost.

## 1. Browser playground

Drop two CSVs on a page, get the report. No install, no database, no trust
decision.

The engine is zero-dependency TypeScript with nothing Node-specific in `scan()`,
so it runs in a browser unchanged — only the Postgres/MySQL/SQLite adapters are
server-side, and the playground doesn't need them.

**Fixes:** the activation energy. Today the first step is "install this and point
it at your data." It should be "look at this and see your own file's loss in ten
seconds."

## 2. Benchmark against labelled datasets

Run against standard entity-resolution benchmarks that ship a gold standard —
Abt-Buy, Amazon-Google, DBLP-ACM — and report **true pair completeness**, not
just the floor.

**Fixes:** the one limitation currently conceded in the README — *the loss is at
least X, and I cannot say how far above X the truth is.* With labelled data,
that becomes answerable: how much of the real loss does the floor actually
capture? If the answer is "most of it," that is a publishable result and the
strongest single claim this project could make.

## 3. Composite keys

One column per side was a scoping decision. Real joins are `(name, city)` or
`(sku, vendor)`, and partial agreement — name matches, city doesn't — is the most
useful signal available.

**Fixes:** the most likely reason someone tries it and stops.

## 4. Learned rules

The near-miss pairs are already collected. Mine the edit patterns between them to
propose dataset-specific rules, rather than only running the eight hand-written
ones.

**Fixes:** the ceiling on what a fixed rule list can find. "The tool proposed a
normalization rule I hadn't thought of" is a materially stronger claim than
"the tool ran my list."

## 5. Alias table support

The semantic residue — `Vatican City` / `Holy See`, `North Korea` /
`Democratic People's Republic of Korea` — is currently a dead end: the tool
identifies the problem and stops. Accept an alias file, and measure what it
recovers.

**Fixes:** closes the loop on the half of the residue no string transform will
ever reach.

## Smaller

- `pg_trgm` as an optional backend for the residue pass, for people who would
  rather push that work into the database.
- Exhaustive subset search instead of greedy when the rule count is small; greedy
  is not guaranteed optimal.
- Streaming and sampling for tables beyond a few million rows — everything is
  currently in memory in one process.
- Continuous mode: store runs and chart the floor over time, so it becomes a
  regression test rather than a point check.
- A listing in the GitHub Actions marketplace for the CI check.
