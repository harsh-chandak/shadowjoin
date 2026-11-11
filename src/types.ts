/** A single record on one side of the join. */
export interface Row {
  /** Stable identifier for this row (primary key, line number — anything unique). */
  id: string;
  /**
   * The value actually used as the join key today. When `keys` is present too,
   * this is only a display form of the tuple; `keys` is what gets compared.
   */
  key: string;
  /**
   * The join key's components, in column order, for a join on several columns
   * per side — `(name, city)`, `(sku, vendor)`. When present it defines the
   * join and `key` is ignored for matching. Both sides must carry the same
   * number of components, in the same order.
   */
  keys?: string[];
  /**
   * Optional ground truth. When both sides carry it, every recovered match is
   * verified rather than asserted, and the report gains a precision figure.
   * In the bundled example this is the ticker symbol.
   */
  truth?: string;
}

/**
 * A record whose join key spans several columns, built by hand.
 *
 * Identical to `Row` except that `key` is optional: the components are the join
 * key, so there is nothing for a single-column key to say. The adapters return
 * plain `Row`s with `keys` filled in and `key` set to a readable join of the
 * components, so callers keep the field they have always read.
 */
export interface CompositeRow {
  id: string;
  /** The join key's components, in column order. */
  keys: string[];
  /** Optional display form. Derived from `keys` when omitted. */
  key?: string;
  truth?: string;
}

/** What `scan()` takes on either side: single-column rows, composite rows, or both. */
export type ScanRow = Row | CompositeRow;

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
  /** The key components, in column order. Present only for a composite key. */
  leftKeys?: string[];
  rightKeys?: string[];
  /** Number of right-hand rows that collapsed onto the same normalized key. */
  candidates: number;
  verification: Verification;
}

/** One key component of a pair, and whether the two sides agree on it. */
export interface ComponentAgreement {
  /** The component's label — by default the left-hand column name. */
  label: string;
  leftValue: string;
  rightValue: string;
  /**
   * True when both values normalize to the same NON-EMPTY string under the
   * enabled rules. A component that normalizes to empty never agrees: two
   * blanks are not evidence of a match.
   */
  agrees: boolean;
}

/**
 * The rows the exact join missed, grouped by WHICH key components agree.
 *
 * This is the point of a composite key. "The name agrees and the city does not"
 * is a different problem from "neither agrees" — the first says a column is
 * dirty, the second says the row is simply absent — and an exact join reports
 * both as the same silence.
 *
 * The buckets partition the missed rows, so they sum to
 * `leftRows - exactMatches`. At most one has `full: true`, and its `leftRows`
 * equals `recovered`: it is the only bucket counted in the floor. Every other
 * bucket is PARTIAL agreement, deliberately NOT counted, because agreeing on
 * the name is no evidence that two cities are the same place.
 */
export interface AgreementBucket {
  /** Indices of the agreeing components, ascending. Empty when nothing agrees. */
  components: number[];
  /** Those components' labels, for display. */
  labels: string[];
  /** Left rows whose largest agreement is exactly this set of components. */
  leftRows: number;
  /**
   * The most right rows that agreed with any one left row here.
   *
   * 1 means these components identify a row on their own, and a key of just
   * them would be worth measuring. A large number means they BLOCK rather than
   * identify — half the table shares a city — and those rows are not pairs.
   */
  maxCandidates: number;
  /** True for the one bucket where every component agrees. */
  full: boolean;
  /**
   * Ground truth over the pairs in this bucket. For a partial bucket these are
   * the numbers worth reading: rows that agree on the name and are confirmed
   * the same entity say the disagreeing column is dirty, not that the row is
   * absent.
   */
  verified: number;
  contradicted: number;
  ambiguous: number;
}

/**
 * An example of partial agreement: a pair agreeing on some key components and
 * not others.
 *
 * Advisory, exactly like `nearMisses`. Never counted in `recovered` or
 * `lowerBoundLossPct`.
 */
export interface PartialPair {
  leftId: string;
  rightId: string;
  /** Every component, in column order, with both values and the verdict. */
  components: ComponentAgreement[];
  /** Right rows agreeing on exactly the same components. More than a few is a block, not a pair. */
  candidates: number;
  verification: Verification;
}

/**
 * A row no rule explains, paired with its closest trigram neighbour.
 *
 * Deliberately NOT counted in `recovered` or `lowerBoundLossPct`: these are
 * unverified suggestions below the confidence bar, and letting them inflate the
 * headline would turn a defensible floor into a guess.
 */
export interface NearMiss {
  leftId: string;
  leftKey: string;
  rightId: string;
  rightKey: string;
  /** The key components, in column order. Present only for a composite key. */
  leftKeys?: string[];
  rightKeys?: string[];
  /** Sørensen-Dice over character trigrams. 1 is identical. */
  similarity: number;
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
  /** Closest trigram neighbours for rows no rule explains. Advisory, not counted. */
  nearMisses: NearMiss[];
  /** Unexplained rows with no trigram neighbour at all — these need an alias table. */
  noCandidate: number;
  warnings: string[];
  rulesApplied: string[];

  /**
   * The key components' labels, in column order.
   *
   * Present only when the join key spans several columns, so a single-column
   * scan reports exactly the fields it always has and existing consumers see no
   * change at all. Same for `agreement` and `partialPairs`.
   */
  keyComponents?: string[];
  /** How the missed rows split by which key components agree. Composite keys only. */
  agreement?: AgreementBucket[];
  /** Examples of partial agreement, a few per bucket. Advisory, never counted. */
  partialPairs?: PartialPair[];
}
