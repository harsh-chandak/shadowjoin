import { ALL_RULE_IDS, normalize, rulesByIds } from "./normalize.js";
import { encodeTuple, resolveLabels, toKeyed, tupleKey } from "./keys.js";
import type { Keyed } from "./keys.js";
import { TrigramIndex } from "./similarity.js";
import type {
  AgreementBucket, ComponentAgreement, NearMiss, PartialPair, Report, Row, Rule, SamplePair,
  ScanRow, StackStep, Verification,
} from "./types.js";

export interface ScanOptions {
  /** Rule ids to enable. Defaults to every rule. */
  rules?: string[];
  /** How many example recoveries to include for human review. Default 20. */
  maxSamplePairs?: number;
  /** Replace key values in samples with a short hash. Counts are unaffected. */
  redactSamples?: boolean;
  /** Look for trigram neighbours among rows no rule explains. Default true. */
  nearMisses?: boolean;
  /** Minimum Dice score for a near miss. Default 0.45. */
  nearMissThreshold?: number;
  /** Cap on near misses reported. Default 25. */
  maxNearMisses?: number;
  /**
   * Labels for the key components, in column order — the left-hand column names,
   * typically. One per component. Defaults to "key 1", "key 2", ...
   */
  keyLabels?: string[];
  /**
   * For a composite key, report WHICH components agree and which do not.
   * Default true. Costs one index per subset of the key columns, so turn it off
   * for a wide key over a large table.
   */
  agreement?: boolean;
  /** Called as each phase begins, so a CLI can show progress. */
  onPhase?: (label: string) => void;
}

/** Tickers, SKUs and ids differ cosmetically across sources; compare them loosely. */
function canonicalTruth(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();
}

function redact(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `#${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function buildIndex(rows: Keyed[], rules: Rule[] | null): Map<string, Keyed[]> {
  const index = new Map<string, Keyed[]>();
  for (const row of rows) {
    const key = tupleKey(row.components, rules);
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/** Look a row up in an index built with the same rules. */
function probe(index: Map<string, Keyed[]>, row: Keyed, rules: Rule[] | null): Keyed[] | undefined {
  const key = tupleKey(row.components, rules);
  return key === null ? undefined : index.get(key);
}

function verify(left: Keyed, candidates: Keyed[]): Verification {
  if (left.truth === undefined) return "unverifiable";
  const known = candidates.filter((c) => c.truth !== undefined);
  if (known.length === 0) return "unverifiable";
  const target = canonicalTruth(left.truth);
  const agreeing = known.filter((c) => canonicalTruth(c.truth!) === target);
  if (agreeing.length === 0) return "contradicted";
  if (agreeing.length === known.length) return "verified";
  return "ambiguous";
}

/**
 * Ground truth over a bucket too large to read all of.
 *
 * A component with few distinct values — a city, a vendor — puts thousands of
 * rows in one bucket, and checking every one of them per left row is quadratic.
 * `sample` is the first `VERIFY_CAP` of a bucket of `total` rows. Past the cap
 * both "all of them agree" and "none of them agree" are claims the sample
 * cannot support, so say "ambiguous" rather than overstate either.
 */
const VERIFY_CAP = 50;

function verifyCapped(left: Keyed, sample: Keyed[], total: number): Verification {
  if (total <= VERIFY_CAP) return verify(left, sample);
  const verdict = verify(left, sample);
  return verdict === "unverifiable" ? verdict : "ambiguous";
}

function popcount(mask: number): number {
  let n = 0;
  for (let m = mask; m !== 0; m >>>= 1) n += m & 1;
  return n;
}

/** Subsets of the key columns worth indexing, largest first. */
function subsetMasks(arity: number): number[] {
  // The full set is the recovery test, already answered by the rule passes, and
  // the empty set is the fallback. Only proper, non-empty subsets need an index.
  const full = (1 << arity) - 1;
  const all: number[] = [];
  for (let mask = 1; mask < full; mask++) all.push(mask);
  // A wide key would mean 2^n indexes. Past five columns, report agreement one
  // column at a time instead of quietly costing the user a gigabyte.
  const masks = arity <= 5 ? all : all.filter((m) => popcount(m) === 1);
  return masks.sort((a, b) => popcount(b) - popcount(a) || a - b);
}

/** The subset of a normalized tuple named by `mask`, or null if any of it is empty. */
function selectTuple(normalized: readonly string[], mask: number): string | null {
  const parts: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    if (normalized[i] === "") return null;
    parts.push(normalized[i]);
  }
  return encodeTuple(parts);
}

function componentView(
  left: Keyed, right: Keyed, labels: string[],
  leftNorm: readonly string[], rightNorm: readonly string[], hide: boolean,
): ComponentAgreement[] {
  return labels.map((label, i) => ({
    label,
    leftValue: hide ? redact(left.components[i]) : left.components[i],
    rightValue: hide ? redact(right.components[i]) : right.components[i],
    agrees: leftNorm[i] !== "" && leftNorm[i] === rightNorm[i],
  }));
}

/**
 * Group the rows the exact join missed by WHICH key components agree.
 *
 * Partial agreement is the whole reason to join on a tuple: "the name agrees and
 * the city does not" says a column is dirty, "neither agrees" says the row is
 * absent, and an exact join reports both as the same silence.
 *
 * None of it moves the floor. Only the bucket where every component agrees is
 * counted, and that bucket is `recovered`, measured by the rule passes above
 * rather than here.
 */
function analyseAgreement(
  missed: Keyed[], right: Keyed[], rules: Rule[], labels: string[],
  recoveredIds: Set<string>,
  full: { leftRows: number; maxCandidates: number; verified: number; contradicted: number; ambiguous: number },
  maxPairs: number, hide: boolean,
): { buckets: AgreementBucket[]; pairs: PartialPair[] } {
  const arity = labels.length;
  const masks = subsetMasks(arity);

  // Each right row lands in exactly one bucket per subset, so an index costs one
  // entry per row — the same shape as the per-rule indexes above.
  const rightNorm = right.map((row) => row.components.map((c) => normalize(c, rules)));
  const indexes = new Map<number, Map<string, number[]>>();
  for (const mask of masks) {
    const index = new Map<string, number[]>();
    for (let i = 0; i < right.length; i++) {
      const key = selectTuple(rightNorm[i], mask);
      if (key === null) continue;
      const bucket = index.get(key);
      if (bucket) bucket.push(i);
      else index.set(key, [i]);
    }
    indexes.set(mask, index);
  }

  const tally = new Map<number, { leftRows: number; maxCandidates: number; verified: number; contradicted: number; ambiguous: number }>();
  const examples = new Map<number, PartialPair[]>();
  const PER_PATTERN = 3;

  for (const row of missed) {
    if (recoveredIds.has(row.id)) continue;   // every component agrees: that is `recovered`.
    const leftNorm = row.components.map((c) => normalize(c, rules));

    let hitMask = 0;
    let candidates: number[] | undefined;
    for (const mask of masks) {
      const key = selectTuple(leftNorm, mask);
      if (key === null) continue;
      const bucket = indexes.get(mask)!.get(key);
      if (bucket && bucket.length > 0) {
        // Masks come largest first, so the first hit is the most that agrees.
        hitMask = mask;
        candidates = bucket;
        break;
      }
    }

    const verdict = candidates === undefined
      ? "unverifiable"
      : verifyCapped(row, candidates.slice(0, VERIFY_CAP).map((i) => right[i]), candidates.length);
    const counts = tally.get(hitMask) ?? { leftRows: 0, maxCandidates: 0, verified: 0, contradicted: 0, ambiguous: 0 };
    counts.leftRows++;
    counts.maxCandidates = Math.max(counts.maxCandidates, candidates?.length ?? 0);
    if (verdict === "verified") counts.verified++;
    else if (verdict === "contradicted") counts.contradicted++;
    else if (verdict === "ambiguous") counts.ambiguous++;
    tally.set(hitMask, counts);

    const seen = examples.get(hitMask) ?? [];
    if (candidates !== undefined && seen.length < PER_PATTERN) {
      const best = candidates[0];
      seen.push({
        leftId: row.id,
        rightId: right[best].id,
        components: componentView(row, right[best], labels, leftNorm, rightNorm[best], hide),
        candidates: candidates.length,
        verification: verdict,
      });
      examples.set(hitMask, seen);
    }
  }

  const named = (mask: number) => {
    const components: number[] = [];
    for (let i = 0; i < arity; i++) if (mask & (1 << i)) components.push(i);
    return { components, labels: components.map((i) => labels[i]) };
  };

  const buckets: AgreementBucket[] = [];
  if (full.leftRows > 0) {
    buckets.push({ ...named((1 << arity) - 1), leftRows: full.leftRows, maxCandidates: full.maxCandidates, full: true, verified: full.verified, contradicted: full.contradicted, ambiguous: full.ambiguous });
  }
  for (const [mask, counts] of tally) {
    buckets.push({ ...named(mask), leftRows: counts.leftRows, maxCandidates: counts.maxCandidates, full: false, verified: counts.verified, contradicted: counts.contradicted, ambiguous: counts.ambiguous });
  }
  buckets.sort((a, b) =>
    b.components.length - a.components.length ||
    b.leftRows - a.leftRows ||
    a.components.join().localeCompare(b.components.join()));

  const pairs = [...examples.entries()]
    .sort((a, b) => popcount(b[0]) - popcount(a[0]) || a[0] - b[0])
    .flatMap(([, list]) => list)
    .slice(0, maxPairs);

  return { buckets, pairs };
}

/**
 * Compare an exact join against a shadow matcher and report what the exact
 * join is losing.
 *
 * The join key may be one column per side or several: give a row a `key` for one
 * column, or `keys` for a tuple. With a composite key the report also says which
 * components agree and which do not, because partial agreement is the most
 * useful thing a composite join has to tell you.
 *
 * The figure this produces is a FLOOR. The shadow matcher has unknown recall of
 * its own, so the true loss is at least this large and may be larger.
 */
export function scan(left: readonly ScanRow[], right: readonly ScanRow[], options: ScanOptions = {}): Report {
  const ruleIds = options.rules ?? ALL_RULE_IDS;
  const rules = rulesByIds(ruleIds);
  const maxSamples = options.maxSamplePairs ?? 20;
  const warnings: string[] = [];

  if (left.length === 0 || right.length === 0) {
    warnings.push("One side of the join is empty; there is nothing to measure.");
  }

  const phase = options.onPhase ?? (() => {});

  // 0. Reduce both sides to tuples. One column per side is the one-component
  //    case, so nothing below is written twice.
  const leftSide = toKeyed(left, "left");
  const rightSide = toKeyed(right, "right");
  if (leftSide.arity > 0 && rightSide.arity > 0 && leftSide.arity !== rightSide.arity) {
    throw new Error(
      `The left side joins on ${leftSide.arity} key column(s) and the right side on ${rightSide.arity}. A composite join needs the same number of components on both sides, in the same order.`,
    );
  }
  // With rows on neither side there is no key width to read off the data, so
  // fall back to what the caller said the key was.
  const arity = Math.max(leftSide.arity, rightSide.arity, options.keyLabels?.length ?? 0, 1);
  const labels = resolveLabels(arity, options.keyLabels);
  const composite = arity > 1;
  const leftKeyed = leftSide.rows;
  const rightKeyed = rightSide.rows;

  // 1. The baseline: the join exactly as it runs today.
  phase("measuring the join as it runs today");
  const exactIndex = buildIndex(rightKeyed, null);
  const missed: Keyed[] = [];
  let exactMatches = 0;
  for (const row of leftKeyed) {
    if (probe(exactIndex, row, null) !== undefined) exactMatches++;
    else missed.push(row);
  }

  // 2. Each rule measured independently against that baseline, so the number
  //    beside a rule is what the rule alone buys and not a product of ordering.
  phase(`testing ${rules.length} rules against that baseline`);
  const attribution = new Map<string, { rule: string; candidates: Keyed[] }>();
  const byRule = rules.map((rule) => {
    const index = buildIndex(rightKeyed, [rule]);
    let recovered = 0, verified = 0, contradicted = 0, ambiguous = 0;
    for (const row of missed) {
      const candidates = probe(index, row, [rule]);
      if (!candidates || candidates.length === 0) continue;
      recovered++;
      const verdict = verify(row, candidates);
      if (verdict === "verified") verified++;
      else if (verdict === "contradicted") contradicted++;
      else if (verdict === "ambiguous") ambiguous++;
      if (!attribution.has(row.id)) attribution.set(row.id, { rule: rule.id, candidates });
    }
    return { rule: rule.id, label: rule.label, recovered, verified, contradicted, ambiguous };
  });

  // 3. Greedy forward selection: which rules, in which order, actually pay.
  //    Most recoveries need a combination, so per-rule figures alone are not
  //    enough to act on.
  phase("selecting the rules worth adopting");
  const stack: StackStep[] = [];
  const covered = new Set<string>();
  const chosen: Rule[] = [];
  let pool = [...rules];
  while (pool.length > 0) {
    let best: Rule | null = null;
    let bestGain = 0;
    let bestMatched: Set<string> | null = null;
    for (const candidate of pool) {
      const trial = [...chosen, candidate];
      const index = buildIndex(rightKeyed, trial);
      const matched = new Set<string>();
      for (const row of missed) {
        if (probe(index, row, trial) !== undefined) matched.add(row.id);
      }
      let gain = 0;
      for (const id of matched) if (!covered.has(id)) gain++;
      if (gain > bestGain) { bestGain = gain; best = candidate; bestMatched = matched; }
    }
    if (best === null || bestGain === 0) break;
    chosen.push(best);
    for (const id of bestMatched!) covered.add(id);
    stack.push({ rule: best.id, label: best.label, marginal: bestGain, cumulative: covered.size });
    pool = pool.filter((r) => r !== best);
  }

  // 4. Attribute what only a COMBINATION explains. The greedy stack is tried
  //    first, because applying every rule can recover fewer rows than the best
  //    subset does — over-normalization merges keys that should stay apart.
  const greedyIndex = buildIndex(rightKeyed, chosen);
  for (const row of missed) {
    if (attribution.has(row.id)) continue;
    const candidates = probe(greedyIndex, row, chosen);
    if (candidates && candidates.length > 0) {
      attribution.set(row.id, { rule: "combined", candidates });
    }
  }

  const fullIndex = buildIndex(rightKeyed, rules);
  let fullStackRecovered = 0;
  for (const row of missed) {
    const candidates = probe(fullIndex, row, rules);
    if (candidates && candidates.length > 0) {
      fullStackRecovered++;
      if (!attribution.has(row.id)) attribution.set(row.id, { rule: "combined", candidates });
    }
  }

  // 5. Tally and collect examples.
  let verified = 0, contradicted = 0, ambiguous = 0, unverifiable = 0;
  const samplePairs: SamplePair[] = [];
  const missedById = new Map(missed.map((r) => [r.id, r]));
  for (const [leftId, { rule, candidates }] of attribution) {
    const row = missedById.get(leftId)!;
    const verdict = verify(row, candidates);
    if (verdict === "verified") verified++;
    else if (verdict === "contradicted") contradicted++;
    else if (verdict === "ambiguous") ambiguous++;
    else unverifiable++;

    if (samplePairs.length < maxSamples) {
      const best = candidates[0];
      const show = (value: string) => (options.redactSamples ? redact(value) : value);
      samplePairs.push({
        rule,
        leftId: row.id,
        leftKey: show(row.display),
        rightId: best.id,
        rightKey: show(best.display),
        ...(composite
          ? { leftKeys: row.components.map(show), rightKeys: best.components.map(show) }
          : {}),
        candidates: candidates.length,
        verification: verdict,
      });
    }
  }

  const recovered = attribution.size;
  const unexplained = missed.length - recovered;

  // 6. Which components agree, for a composite key. This is the signal a
  //    composite join exists to produce, and none of it moves the floor: only
  //    the bucket where every component agrees is counted, and that bucket is
  //    step 5's `recovered`.
  let agreement: AgreementBucket[] | undefined;
  let partialPairs: PartialPair[] | undefined;
  if (composite && options.agreement !== false) {
    phase(`comparing the ${arity} key components`);
    let widest = 0;
    for (const { candidates } of attribution.values()) widest = Math.max(widest, candidates.length);
    const analysis = analyseAgreement(
      missed, rightKeyed, rules, labels, new Set(attribution.keys()),
      { leftRows: recovered, maxCandidates: widest, verified, contradicted, ambiguous },
      maxSamples, Boolean(options.redactSamples),
    );
    agreement = analysis.buckets;
    partialPairs = analysis.pairs;
  }

  // 7. The residue. No normalization rule explains these, so look for the
  //    closest trigram neighbour instead. Reported as advice, never counted:
  //    a suggestion that has not cleared the rule bar must not move the floor.
  const nearMisses: NearMiss[] = [];
  let noCandidate = 0;
  if (options.nearMisses !== false && unexplained > 0) {
    phase(`analysing the ${unexplained} rows no rule explains`);
    // Positional ids, so a hit maps back to its tuple even when the source data
    // repeats an id.
    const index = new TrigramIndex(rightKeyed.map((row, i): Row => ({
      id: String(i),
      key: row.display,
      ...(row.truth === undefined ? {} : { truth: row.truth }),
    })));
    const maxNear = options.maxNearMisses ?? 25;
    for (const row of missed) {
      if (attribution.has(row.id)) continue;
      const hit = index.best(row.display, { threshold: options.nearMissThreshold ?? 0.45 });
      if (!hit) { noCandidate++; continue; }
      if (nearMisses.length < maxNear) {
        const neighbour = rightKeyed[Number(hit.row.id)];
        const show = (value: string) => (options.redactSamples ? redact(value) : value);
        nearMisses.push({
          leftId: row.id,
          leftKey: show(row.display),
          rightId: neighbour.id,
          rightKey: show(neighbour.display),
          ...(composite
            ? { leftKeys: row.components.map(show), rightKeys: neighbour.components.map(show) }
            : {}),
          similarity: hit.similarity,
          verification: verify(row, [neighbour]),
        });
      }
    }
  }
  const pct = (n: number) => (left.length === 0 ? 0 : Number(((n / left.length) * 100).toFixed(2)));

  if (rules.length > 1) {
    warnings.push(
      "Per-rule counts are measured independently against the exact baseline, so they overlap and will not sum to the total.",
    );
  }
  if (chosen.length > 0 && chosen.length < rules.length && fullStackRecovered < covered.size) {
    warnings.push(
      `Applying every rule recovers ${covered.size - fullStackRecovered} fewer match(es) than the best subset. Over-normalization is costing you matches — rerun with --rules ${chosen.map((r) => r.id).join(",")}`,
    );
  }
  if (agreement !== undefined) {
    const partial = agreement.filter((b) => !b.full && b.components.length > 0);
    const partialRows = partial.reduce((n, b) => n + b.leftRows, 0);
    if (partialRows > 0) {
      const biggest = [...partial].sort((a, b) => b.leftRows - a.leftRows)[0];
      const absent = labels.filter((_, i) => !biggest.components.includes(i));
      warnings.push(
        `${partialRows} missed row(s) agree on some key components but not all — see \`agreement\`. Those are NOT counted in the floor: agreeing on part of the key is no evidence that the rest of it matches.`,
      );
      const confirmed = biggest.verified > 0 ? `, ${biggest.verified} of them confirmed the same entity by ground truth` : "";
      warnings.push(
        biggest.maxCandidates <= 1
          ? `The most common partial agreement is ${biggest.labels.join(" + ")} (${biggest.leftRows} row(s)), disagreeing on ${absent.join(" + ")}${confirmed}. Each of those agreed with exactly one right row, so ${biggest.labels.join(" + ")} identifies a row on its own — if ${absent.join(" + ")} is dirty rather than load-bearing, re-run keyed on ${biggest.labels.join(",")} alone to measure what the narrower key recovers.`
          : `The most common partial agreement is ${biggest.labels.join(" + ")} (${biggest.leftRows} row(s)), disagreeing on ${absent.join(" + ")}${confirmed}. Up to ${biggest.maxCandidates} right rows agreed with a single left row, so ${biggest.labels.join(" + ")} blocks rather than identifies: those are candidate sets, not pairs, and a key without ${absent.join(" + ")} would not be a key.`,
      );
    }
  }
  if (nearMisses.length > 0) {
    warnings.push(
      `${nearMisses.length} unexplained row(s) have a close trigram neighbour. These are suggestions, NOT counted in the floor — confirm them before adding an alias.`,
    );
  }
  if (noCandidate > 0) {
    warnings.push(
      `${noCandidate} unexplained row(s) have no string similarity to anything on the right (e.g. "Vatican City" vs "Holy See"). No normalization rule will ever recover those; they need an alias table.`,
    );
  }
  if (contradicted > 0) {
    warnings.push(
      `${contradicted} recovered match(es) are contradicted by ground truth — the shadow matcher is over-merging. Review samplePairs before acting.`,
    );
  }
  if (ambiguous > 0) {
    warnings.push(
      `${ambiguous} recovered match(es) collapsed onto a key shared by several right-hand rows (e.g. share classes or product variants). These need a tie-breaker, not a normalization rule.`,
    );
  }
  if (unverifiable > 0 && verified + contradicted === 0) {
    warnings.push(
      "No ground truth was supplied, so recoveries are unverified candidates. Supply a `truth` field on both sides to turn this figure into a verified floor.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    leftRows: left.length,
    rightRows: right.length,
    exactMatches,
    exactMatchRate: pct(exactMatches),
    recovered,
    unexplained,
    reachableMatchRate: pct(exactMatches + recovered),
    lowerBoundLossPct: pct(recovered),
    byRule: byRule.sort((a, b) => b.recovered - a.recovered),
    stack,
    verified,
    contradicted,
    ambiguous,
    unverifiable,
    precision:
      verified + contradicted === 0
        ? null
        : Number(((verified / (verified + contradicted)) * 100).toFixed(2)),
    samplePairs,
    nearMisses,
    noCandidate,
    warnings,
    rulesApplied: ruleIds,
    ...(composite ? { keyComponents: labels } : {}),
    ...(agreement === undefined ? {} : { agreement }),
    ...(partialPairs === undefined ? {} : { partialPairs }),
  };
}
