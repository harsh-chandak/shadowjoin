/** A single record on one side of the join. */
export interface Row {
  /** Stable identifier for this row (primary key, line number — anything unique). */
  id: string;
  /** The value actually used as the join key today. */
  key: string;
  /**
   * Optional ground truth. When both sides carry it, every recovered match is
   * verified rather than asserted, and the report gains a precision figure.
   * In the bundled example this is the ticker symbol.
   */
  truth?: string;
}

/** A reversible-in-spirit string transform used to build a looser blocking key. */
export interface Rule {
  id: string;
  label: string;
  apply(value: string): string;
  /** The same transform as a Postgres expression, so it can be pasted into a pipeline. */
  sql(expr: string): string;
}

export type Verification = "verified" | "contradicted" | "ambiguous" | "unverifiable";

export interface RuleContribution {
  rule: string;
  label: string;
  /** Rows recovered by BASE + this rule alone, measured against the exact-match baseline. */
  recovered: number;
  verified: number;
  contradicted: number;
  ambiguous: number;
}

/** One step of the greedy stack: the rule, and what adding it actually bought. */
export interface StackStep {
  rule: string;
  label: string;
  /** Rows recovered by adding this rule that the preceding ones did not already cover. */
  marginal: number;
  /** Total rows recovered by this rule plus everything before it. */
  cumulative: number;
}

export interface SamplePair {
  /** Which rule (or "combined") first explained this recovery. */
  rule: string;
  leftId: string;
  leftKey: string;
  rightId: string;
  rightKey: string;
  /** Number of right-hand rows that collapsed onto the same normalized key. */
  candidates: number;
  verification: Verification;
}

export interface Report {
  generatedAt: string;
  leftRows: number;
  rightRows: number;

  /** Rows matched by the join exactly as it runs today. */
  exactMatches: number;
  exactMatchRate: number;

  /** Rows the shadow matcher recovered on top of the exact baseline. */
  recovered: number;
  /** Recovered rows with no candidate under any enabled rule. */
  unexplained: number;
  /** exactMatches + recovered, over leftRows. */
  reachableMatchRate: number;
  /**
   * Lower bound on the share of left rows whose match the exact join is losing.
   * A FLOOR, not an estimate: the shadow matcher's own recall is unknown, so the
   * true loss can only be larger.
   */
  lowerBoundLossPct: number;

  byRule: RuleContribution[];
  /**
   * Rules in the order worth adopting, chosen greedily by marginal recovery.
   * This is the actionable half of the report: most recoveries need a
   * combination, so the individual figures in `byRule` under-state them.
   */
  stack: StackStep[];

  verified: number;
  contradicted: number;
  ambiguous: number;
  unverifiable: number;
  /** verified / (verified + contradicted), or null when no ground truth was supplied. */
  precision: number | null;

  samplePairs: SamplePair[];
  warnings: string[];
  rulesApplied: string[];
}
