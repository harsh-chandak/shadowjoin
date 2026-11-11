import { normalize } from "./normalize.js";
import type { CompositeRow, Row, Rule, ScanRow } from "./types.js";

/**
 * Key handling for one column per side and for several, in one place.
 *
 * A single-column join is the one-component case of a composite one, so every
 * pass in `scan()` is written once against `Keyed` and the arity only changes
 * how many strings a row carries. Nothing here touches Node: the browser
 * playground on the roadmap needs `scan()` to run unchanged.
 */

/** A row reduced to the tuple the join actually compares. */
export interface Keyed {
  id: string;
  /** The key's components, in column order. Length 1 for a single-column join. */
  components: string[];
  /** The tuple as one string, for samples and for trigram comparison. */
  display: string;
  truth?: string;
}

/** Used in the display form only, never for comparison. */
export const DISPLAY_SEPARATOR = " | ";

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

function describe(row: ScanRow, position: number): string {
  const id = row?.id;
  return id === undefined || id === "" ? `at position ${position}` : `"${id}"`;
}

/** One row's key components, in column order. `keys` wins when both are present. */
function componentsOf(row: ScanRow, side: string, position: number): string[] {
  if (row === null || row === undefined) {
    throw new Error(`The ${side} side has no row at position ${position}. Every entry must be a row object.`);
  }
  const composite = (row as CompositeRow).keys;
  if (composite !== undefined) {
    if (!Array.isArray(composite) || composite.length === 0) {
      throw new Error(
        `The ${side} row ${describe(row, position)} has an empty \`keys\`. Supply one entry per key column, or use \`key\` for a single-column join.`,
      );
    }
    return composite.map(text);
  }
  const single = (row as Row).key;
  if (single === undefined || single === null) {
    throw new Error(
      `The ${side} row ${describe(row, position)} carries no join key. Supply \`key\` for a single column, or \`keys\` for a composite one.`,
    );
  }
  return [text(single)];
}

/**
 * Reduce one side to `Keyed` rows, and report how wide its key is.
 *
 * Mixed widths within a side are refused rather than padded: a tuple of a
 * different length is a different join, and quietly comparing `(name)` against
 * `(name, city)` would produce a figure that means nothing.
 */
export function toKeyed(rows: readonly ScanRow[], side: "left" | "right"): { rows: Keyed[]; arity: number } {
  const out: Keyed[] = [];
  let arity = 0;
  rows.forEach((row, i) => {
    const components = componentsOf(row, side, i);
    if (arity === 0) arity = components.length;
    else if (components.length !== arity) {
      throw new Error(
        `The ${side} row ${describe(row, i)} has ${components.length} key component(s) where earlier ${side} rows have ${arity}. Every row on a side must carry the same key columns, in the same order.`,
      );
    }
    const supplied = (row as CompositeRow).key;
    const display = components.length > 1 && supplied !== undefined && supplied !== null
      ? text(supplied)
      : components.join(DISPLAY_SEPARATOR);
    out.push({ id: row.id, components, display, ...(row.truth === undefined ? {} : { truth: row.truth }) });
  });
  return { rows: out, arity };
}

/**
 * Pack components into one index key.
 *
 * Length-prefixed, so two different tuples can never encode to the same string:
 * `("ab", "c")` and `("a", "bc")` must stay apart, or the report would claim a
 * match that does not exist.
 */
export function encodeTuple(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0];
  let out = "";
  for (const part of parts) out += `${part.length}\u001f${part}`;
  return out;
}

/**
 * The key a tuple is indexed and looked up under, or `null` when it cannot take
 * part in a match at all.
 *
 * `rules === null` is the exact baseline: values are compared exactly as they
 * are, so the figure reproduces the join as it runs today. A row with nothing in
 * any component has no join key and drops out, which is what the single-column
 * path has always done with an empty key.
 *
 * With rules this is the shadow matcher, and here a component that normalizes to
 * empty counts as NO evidence of agreement — two blanks are not a match. That is
 * deliberately the stricter of the two tests: it can only ever lower
 * `recovered`, and `recovered` is the floor.
 */
export function tupleKey(components: readonly string[], rules: Rule[] | null): string | null {
  if (rules === null) {
    for (const component of components) if (component !== "") return encodeTuple(components);
    return null;
  }
  const parts: string[] = [];
  for (const component of components) {
    const normalized = normalize(component, rules);
    if (normalized === "") return null;
    parts.push(normalized);
  }
  return encodeTuple(parts);
}

/** Labels for the key components: the caller's, or positional ones. */
export function resolveLabels(arity: number, labels: string[] | undefined): string[] {
  const positional = (i: number) => `key ${i + 1}`;
  if (labels === undefined) return Array.from({ length: arity }, (_, i) => positional(i));
  if (labels.length !== arity) {
    throw new Error(
      `keyLabels has ${labels.length} entry(s) but the rows carry ${arity} key component(s). Supply one label per key column.`,
    );
  }
  return labels.map((label, i) => (label.trim() === "" ? positional(i) : label.trim()));
}
