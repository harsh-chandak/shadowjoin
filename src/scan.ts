import { ALL_RULE_IDS, normalize, rulesByIds } from "./normalize.js";
import { TrigramIndex } from "./similarity.js";
import type { NearMiss, Report, Row, Rule, SamplePair, StackStep, Verification } from "./types.js";

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

function buildIndex(rows: Row[], rules: Rule[] | null): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    const key = rules === null ? row.key : normalize(row.key, rules);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

function verify(left: Row, candidates: Row[]): Verification {
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
 * Compare an exact join against a shadow matcher and report what the exact
 * join is losing.
 *
 * The figure this produces is a FLOOR. The shadow matcher has unknown recall of
 * its own, so the true loss is at least this large and may be larger.
 */
export function scan(left: Row[], right: Row[], options: ScanOptions = {}): Report {
  const ruleIds = options.rules ?? ALL_RULE_IDS;
  const rules = rulesByIds(ruleIds);
  const maxSamples = options.maxSamplePairs ?? 20;
  const warnings: string[] = [];

  if (left.length === 0 || right.length === 0) {
    warnings.push("One side of the join is empty; there is nothing to measure.");
  }

  // 1. The baseline: the join exactly as it runs today.
  const exactIndex = buildIndex(right, null);
  const missed: Row[] = [];
  let exactMatches = 0;
  for (const row of left) {
    if (exactIndex.has(row.key)) exactMatches++;
    else missed.push(row);
  }

  // 2. Each rule measured independently against that baseline, so the number
  //    beside a rule is what the rule alone buys and not a product of ordering.
  const attribution = new Map<string, { rule: string; candidates: Row[] }>();
  const byRule = rules.map((rule) => {
    const index = buildIndex(right, [rule]);
    let recovered = 0, verified = 0, contradicted = 0, ambiguous = 0;
    for (const row of missed) {
      const candidates = index.get(normalize(row.key, [rule]));
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
      const index = buildIndex(right, trial);
      const matched = new Set<string>();
      for (const row of missed) {
        if (index.has(normalize(row.key, trial))) matched.add(row.id);
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
  const greedyIndex = buildIndex(right, chosen);
  for (const row of missed) {
    if (attribution.has(row.id)) continue;
    const candidates = greedyIndex.get(normalize(row.key, chosen));
    if (candidates && candidates.length > 0) {
      attribution.set(row.id, { rule: "combined", candidates });
    }
  }

  const fullIndex = buildIndex(right, rules);
  let fullStackRecovered = 0;
  for (const row of missed) {
    const candidates = fullIndex.get(normalize(row.key, rules));
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
      samplePairs.push({
        rule,
        leftId: row.id,
        leftKey: options.redactSamples ? redact(row.key) : row.key,
        rightId: best.id,
        rightKey: options.redactSamples ? redact(best.key) : best.key,
        candidates: candidates.length,
        verification: verdict,
      });
    }
  }

  const recovered = attribution.size;
  const unexplained = missed.length - recovered;

  // 6. The residue. No normalization rule explains these, so look for the
  //    closest trigram neighbour instead. Reported as advice, never counted:
  //    a suggestion that has not cleared the rule bar must not move the floor.
  const nearMisses: NearMiss[] = [];
  let noCandidate = 0;
  if (options.nearMisses !== false && unexplained > 0) {
    const index = new TrigramIndex(right);
    const maxNear = options.maxNearMisses ?? 25;
    for (const row of missed) {
      if (attribution.has(row.id)) continue;
      const hit = index.best(row.key, { threshold: options.nearMissThreshold ?? 0.45 });
      if (!hit) { noCandidate++; continue; }
      if (nearMisses.length < maxNear) {
        nearMisses.push({
          leftId: row.id,
          leftKey: options.redactSamples ? redact(row.key) : row.key,
          rightId: hit.row.id,
          rightKey: options.redactSamples ? redact(hit.row.key) : hit.row.key,
          similarity: hit.similarity,
          verification: verify(row, [hit.row]),
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
  };
}
