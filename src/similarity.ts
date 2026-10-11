import type { Row } from "./types.js";

/**
 * Trigram similarity, for the rows no normalization rule explains.
 *
 * Implemented in-process rather than delegating to Postgres `pg_trgm`, so the
 * same residue analysis runs on CSVs, on JSON and on databases that have no
 * such extension.
 */

/** Postgres-style padding so short strings and word starts are weighted sensibly. */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value.trim().toLowerCase()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Sørensen–Dice: 2|A∩B| / (|A|+|B|). 1 is identical, 0 shares nothing. */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export interface NearMissOptions {
  /** Minimum Dice score to report. Default 0.45. */
  threshold?: number;
  /** Cap on candidates scored per unexplained row. Default 200. */
  maxCandidates?: number;
}

export interface NearMissHit {
  row: Row;
  similarity: number;
}

/**
 * An inverted trigram index over the right-hand side. Built once, queried per
 * unexplained row, so cost grows with the residue rather than with every pair.
 */
export class TrigramIndex {
  private readonly postings = new Map<string, number[]>();
  private readonly grams: Set<string>[] = [];

  constructor(private readonly rows: Row[]) {
    rows.forEach((row, i) => {
      const g = trigrams(row.key);
      this.grams.push(g);
      for (const gram of g) {
        const bucket = this.postings.get(gram);
        if (bucket) bucket.push(i);
        else this.postings.set(gram, [i]);
      }
    });
  }

  /** Best scoring right-hand row for `key`, or null if nothing clears the bar. */
  best(key: string, options: NearMissOptions = {}): NearMissHit | null {
    const threshold = options.threshold ?? 0.45;
    const maxCandidates = options.maxCandidates ?? 200;

    const query = trigrams(key);
    const overlap = new Map<number, number>();
    for (const gram of query) {
      const bucket = this.postings.get(gram);
      if (!bucket || bucket.length > this.rows.length / 2) continue; // skip near-universal grams
      for (const i of bucket) overlap.set(i, (overlap.get(i) ?? 0) + 1);
    }
    if (overlap.size === 0) return null;

    // Score the most promising candidates only; shared-gram count bounds Dice.
    const ranked = [...overlap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCandidates);

    let best: NearMissHit | null = null;
    for (const [i] of ranked) {
      const score = dice(query, this.grams[i]);
      if (score >= threshold && (best === null || score > best.similarity)) {
        best = { row: this.rows[i], similarity: Number(score.toFixed(3)) };
      }
    }
    return best;
  }
}
