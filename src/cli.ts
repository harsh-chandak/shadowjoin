#!/usr/bin/env node
import { parseArgs } from "node:util";
import { extname } from "node:path";
import { scan } from "./scan.js";
import { formatReport } from "./format.js";
import { ALL_RULE_IDS, OPTIONAL_RULES } from "./normalize.js";
import { rowsFromCsv } from "./adapters/csv.js";
import { rowsFromJson } from "./adapters/json.js";
import type { Row } from "./types.js";

const USAGE = `
shadowjoin — measure the matches your exact join is silently dropping.

  npx shadowjoin scan --left <src> --left-key <col> --right <src> --right-key <col>

Sources are .csv, .json (array of objects), .db/.sqlite, or a postgres:// or
mysql:// connection string. Database sources also need --left-table/--right-table.

  --left, --right              file path, or postgres:// / mysql:// URL
  --left-key, --right-key      column holding the join key          (required)
  --left-id, --right-id        column holding a stable id
  --left-truth, --right-truth  column holding ground truth; supply it on BOTH
                               sides and every recovery is verified, not guessed
  --left-table, --right-table  table name (database sources only)

  --rules <a,b,c>   limit to these rules (default: all; see \`shadowjoin rules\`)
  --samples <n>     example recoveries to print            (default 20)
  --redact          hash key values in samples; counts unaffected
  --limit <n>       max rows per side                      (default 100000)
  --json            emit the raw report as JSON
  --max-loss <pct>  exit 1 if the lower bound exceeds this (for CI)

  shadowjoin rules  list the normalization rules

The figure it reports is a FLOOR. The shadow matcher's own recall is unknown,
so the true loss is at least this large and may be larger.
`;

async function load(
  src: string, kind: "left" | "right",
  v: Record<string, string | undefined>, limit: number,
): Promise<Row[]> {
  const keyColumn = v[`${kind}-key`];
  if (!keyColumn) throw new Error(`--${kind}-key is required`);
  const opts = { keyColumn, idColumn: v[`${kind}-id`], truthColumn: v[`${kind}-truth`] };

  const table = v[`${kind}-table`];
  const needsTable = () => {
    if (!table) throw new Error(`--${kind}-table is required for a database source`);
    return table;
  };

  if (src.startsWith("postgres://") || src.startsWith("postgresql://")) {
    const { rowsFromPostgres } = await import("./adapters/postgres.js");
    return rowsFromPostgres({ connectionString: src, table: needsTable(), limit, ...opts });
  }
  if (src.startsWith("mysql://")) {
    const { rowsFromMysql } = await import("./adapters/mysql.js");
    return rowsFromMysql({ connectionString: src, table: needsTable(), limit, ...opts });
  }
  const ext = extname(src).toLowerCase();
  if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") {
    const { rowsFromSqlite } = await import("./adapters/sqlite.js");
    return rowsFromSqlite({ file: src, table: needsTable(), limit, ...opts });
  }
  if (ext === ".json") return rowsFromJson(src, opts);
  if (ext === ".csv" || ext === ".tsv" || ext === "") return rowsFromCsv(src, opts);
  throw new Error(`Unsupported source "${src}". Use .csv, .json, .db/.sqlite, or a postgres:// or mysql:// connection string.`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      left: { type: "string" }, "left-key": { type: "string" }, "left-id": { type: "string" },
      "left-truth": { type: "string" }, "left-table": { type: "string" },
      right: { type: "string" }, "right-key": { type: "string" }, "right-id": { type: "string" },
      "right-truth": { type: "string" }, "right-table": { type: "string" },
      rules: { type: "string" }, samples: { type: "string" }, limit: { type: "string" },
      redact: { type: "boolean" }, json: { type: "boolean" },
      "max-loss": { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0] ?? (values.left ? "scan" : "help");

  if (values.help || command === "help") { console.log(USAGE); return 0; }

  if (command === "rules") {
    console.log("\n  Normalization rules (each measured independently against the exact baseline):\n");
    for (const r of OPTIONAL_RULES) console.log(`    ${r.id.padEnd(24)}${r.label}`);
    console.log("");
    return 0;
  }

  if (command !== "scan") { console.error(`Unknown command "${command}".`); console.log(USAGE); return 2; }
  if (!values.left || !values.right) { console.error("Both --left and --right are required.\n"); console.log(USAGE); return 2; }

  const v = values as Record<string, string | undefined>;
  const limit = values.limit ? Number(values.limit) : 100_000;
  const [left, right] = await Promise.all([
    load(values.left, "left", v, limit),
    load(values.right, "right", v, limit),
  ]);

  const report = scan(left, right, {
    rules: values.rules ? values.rules.split(",").map((s) => s.trim()).filter(Boolean) : ALL_RULE_IDS,
    maxSamplePairs: values.samples ? Number(values.samples) : 20,
    redactSamples: Boolean(values.redact),
  });

  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));

  if (values["max-loss"] !== undefined) {
    const threshold = Number(values["max-loss"]);
    if (report.lowerBoundLossPct > threshold) {
      console.error(`\nFAIL: lower bound on lost matches is ${report.lowerBoundLossPct}%, above the --max-loss threshold of ${threshold}%.`);
      return 1;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => { console.error(`\nshadowjoin: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); },
);
