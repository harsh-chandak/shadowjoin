import type { Rule } from "./types.js";

const strip = (re: RegExp) => (v: string) => v.replace(re, " ");

/**
 * Applied to every candidate key before any optional rule. These are the
 * transforms that are safe on essentially any text: they never merge values
 * that a human would read as different entities.
 */
export const BASE_RULES: Rule[] = [
  { id: "casefold", label: "lowercase", apply: (v) => v.toLowerCase(), sql: (e) => `lower(${e})` },
  {
    id: "deaccent",
    label: "unicode NFKD + strip diacritics",
    apply: (v) => v.normalize("NFKD").replace(/\p{M}+/gu, ""),
    sql: (e) => `unaccent(${e})`,
  },
  { id: "trim", label: "trim and collapse whitespace", apply: (v) => v.replace(/\s+/g, " ").trim(), sql: (e) => `btrim(regexp_replace(${e}, '\\s+', ' ', 'g'))` },
];

/**
 * Each of these is measured INDEPENDENTLY on top of BASE_RULES, so the number
 * next to a rule is what that rule alone buys you — not an artifact of the
 * order rules happen to run in.
 */
export const OPTIONAL_RULES: Rule[] = [
  {
    id: "punctuation",
    label: "strip punctuation",
    apply: strip(/[^\p{L}\p{N}\s]+/gu),
    sql: (e) => `regexp_replace(${e}, '[^[:alnum:][:space:]]+', ' ', 'g')`,
  },
  {
    id: "ampersand",
    label: "& -> and",
    apply: (v) => v.replace(/&/g, " and "),
    sql: (e) => `replace(${e}, '&', ' and ')`,
  },
  {
    id: "leading-zeros",
    label: "strip leading zeros from numeric tokens",
    apply: (v) => v.replace(/\b0+(\d)/g, "$1"),
    sql: (e) => `regexp_replace(${e}, '\\m0+(\\d)', '\\1', 'g')`,
  },
  {
    id: "article",
    label: "strip a leading article",
    apply: (v) => v.replace(/^\s*(the|a|an)\s+/i, " "),
    sql: (e) => `regexp_replace(${e}, '^\\s*(the|a|an)\\s+', ' ', 'i')`,
  },
  {
    id: "corp-suffix",
    label: "strip corporate suffixes (inc, corp, ltd, plc, gmbh ...)",
    apply: strip(
      /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|llp|lp|plc|holdings?|group|gmbh|ag|sa|nv|bv|oyj|ab|as|pte|pty)\b\.?/gi,
    ),
    sql: (e) => `regexp_replace(${e}, '\\m(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|llp|lp|plc|holdings?|group|gmbh|ag|sa|nv|bv|oyj|ab|as|pte|pty)\\M\\.?', ' ', 'gi')`,
  },
  {
    id: "security-boilerplate",
    label: "strip security/listing boilerplate (common stock, ADS, class A ...)",
    apply: strip(
      /\b(common stock|common shares?|ordinary shares?|american depositary (shares?|receipts?)|depositary shares?|class [a-z]\b|series [a-z]\b|when issued|new)\b/gi,
    ),
    sql: (e) => `regexp_replace(${e}, '\\m(common stock|common shares?|ordinary shares?|american depositary (shares?|receipts?)|depositary shares?|class [a-z]\\M|series [a-z]\\M|when issued|new)\\M', ' ', 'gi')`,
  },
  {
    id: "sort-tokens",
    label: "sort tokens (order-insensitive match)",
    apply: (v) => v.split(/\s+/).filter(Boolean).sort().join(" "),
    sql: (e) => `(SELECT string_agg(t, ' ' ORDER BY t) FROM unnest(string_to_array(${e}, ' ')) AS t WHERE t <> '')`,
  },
  {
    id: "despace",
    label: "remove all whitespace",
    apply: (v) => v.replace(/\s+/g, ""),
    sql: (e) => `regexp_replace(${e}, '\\s+', '', 'g')`,
  },
];

export const ALL_RULE_IDS = OPTIONAL_RULES.map((r) => r.id);

export function rulesByIds(ids: string[]): Rule[] {
  const index = new Map(OPTIONAL_RULES.map((r) => [r.id, r]));
  return ids.map((id) => {
    const rule = index.get(id);
    if (!rule) {
      throw new Error(
        `Unknown rule "${id}". Known rules: ${ALL_RULE_IDS.join(", ")}`,
      );
    }
    return rule;
  });
}

/** Apply BASE_RULES, then the supplied rules, in order. */
export function normalize(value: string, rules: Rule[] = []): string {
  let out = value;
  for (const rule of BASE_RULES) out = rule.apply(out);
  for (const rule of rules) out = rule.apply(out);
  // Rules insert spaces where they remove things; tidy up so "3m  company" and
  // "3m company" do not end up as different keys.
  return out.replace(/\s+/g, " ").trim();
}

/** Compose the enabled rules into one Postgres expression over a column. */
export function toSql(column: string, rules: Rule[] = []): string {
  let expr = column;
  for (const rule of BASE_RULES) expr = rule.sql(expr);
  for (const rule of rules) expr = rule.sql(expr);
  return expr;
}
