export { scan } from "./scan.js";
export type { ScanOptions } from "./scan.js";
export { BASE_RULES, OPTIONAL_RULES, ALL_RULE_IDS, normalize, rulesByIds, toSql } from "./normalize.js";
export { formatReport } from "./format.js";
export { parseCsv, rowsFromCsv, rowsFromCsvText } from "./adapters/csv.js";
export type { CsvOptions } from "./adapters/csv.js";
export { trigrams, dice, TrigramIndex } from "./similarity.js";
export type { NearMiss, Report, Row, Rule, RuleContribution, SamplePair, StackStep, Verification } from "./types.js";
