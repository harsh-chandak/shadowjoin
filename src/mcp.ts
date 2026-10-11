#!/usr/bin/env node
/**
 * shadowjoin MCP server.
 *
 * Two deliberate constraints, because this points at databases:
 *   1. There is NO tool that executes arbitrary SQL. An agent can name a
 *      configured source plus a table and column, and nothing else.
 *   2. No tool accepts a connection string. Credentials live in a local config
 *      file and never enter a tool call, because tool calls land in transcripts.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { scan } from "./scan.js";
import { ALL_RULE_IDS, OPTIONAL_RULES, rulesByIds, toSql } from "./normalize.js";
import { rowsFromCsv } from "./adapters/csv.js";
import { rowsFromJson } from "./adapters/json.js";
import type { Report, Row } from "./types.js";

type SourceDef =
  | { type: "postgres"; connectionString: string }
  | { type: "csv"; path: string }
  | { type: "json"; path: string };

interface Config { sources: Record<string, SourceDef> }

const CONFIG_PATH = resolve(process.env.SHADOWJOIN_CONFIG ?? "shadowjoin.config.json");

async function loadConfig(): Promise<Config> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
    if (!parsed.sources || typeof parsed.sources !== "object") throw new Error("missing `sources`");
    return parsed;
  } catch (err) {
    throw new Error(
      `Could not read ${CONFIG_PATH}. Create it with your named sources, e.g.\n` +
        `{"sources":{"prod":{"type":"postgres","connectionString":"postgres://readonly@host/db"}}}\n` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

interface SideArgs { source: string; table?: string; column: string; truthColumn?: string; idColumn?: string }

async function loadSide(side: SideArgs, config: Config, limit: number): Promise<Row[]> {
  const def = config.sources[side.source];
  if (!def) {
    throw new Error(`Unknown source "${side.source}". Configured: ${Object.keys(config.sources).join(", ") || "(none)"}`);
  }
  const opts = { keyColumn: side.column, idColumn: side.idColumn, truthColumn: side.truthColumn };
  if (def.type === "postgres") {
    if (!side.table) throw new Error(`Source "${side.source}" is a database; "table" is required.`);
    const { rowsFromPostgres } = await import("./adapters/postgres.js");
    return rowsFromPostgres({ connectionString: def.connectionString, table: side.table, limit, ...opts });
  }
  return def.type === "json" ? rowsFromJson(def.path, opts) : rowsFromCsv(def.path, opts);
}

const runs = new Map<string, { report: Report; left: SideArgs; right: SideArgs }>();

function summarize(runId: string, report: Report) {
  return {
    runId,
    leftRows: report.leftRows,
    rightRows: report.rightRows,
    exactMatches: report.exactMatches,
    exactMatchRate: report.exactMatchRate,
    recovered: report.recovered,
    lowerBoundLossPct: report.lowerBoundLossPct,
    reachableMatchRate: report.reachableMatchRate,
    unexplained: report.unexplained,
    precision: report.precision,
    verified: report.verified,
    contradicted: report.contradicted,
    ambiguous: report.ambiguous,
    topRules: report.stack.slice(0, 5).map((s) => ({ rule: s.rule, marginal: s.marginal })),
    warnings: report.warnings,
    note: "lowerBoundLossPct is a FLOOR, not an estimate: the shadow matcher's own recall is unknown, so the true loss is at least this large. Call explain_misses and show the user real pairs before acting on it.",
  };
}

const SIDE_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", description: "Name of a source from shadowjoin.config.json. Not a connection string." },
    table: { type: "string", description: "Table name (database sources only). Plain identifier; arbitrary SQL is rejected." },
    column: { type: "string", description: "Column holding the join key." },
    idColumn: { type: "string", description: "Column holding a stable row id." },
    truthColumn: { type: "string", description: "Column holding ground truth. Supply on BOTH sides to get verified precision." },
  },
  required: ["source", "column"],
} as const;

const TOOLS = [
  {
    name: "scan_join",
    description:
      "Measure how many matches an exact join is silently dropping. Returns a compact summary including a FLOOR on lost matches and the rules worth adopting. Read-only. Call this before changing matching logic, and again after, to prove the change helped.",
    inputSchema: {
      type: "object",
      properties: {
        left: SIDE_SCHEMA,
        right: SIDE_SCHEMA,
        rules: { type: "array", items: { type: "string" }, description: `Rule ids to enable. Default all: ${ALL_RULE_IDS.join(", ")}` },
        limit: { type: "number", description: "Max rows per side. Default 100000." },
      },
      required: ["left", "right"],
    },
  },
  {
    name: "explain_misses",
    description:
      "Return concrete example pairs from a previous scan, with the real key values and the rule that recovered each. Use this to show a human actual evidence instead of a percentage. May return key values, so prefer redact:true when the data is sensitive.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        rule: { type: "string", description: "Only pairs attributed to this rule." },
        limit: { type: "number", description: "Default 20." },
      },
      required: ["runId"],
    },
  },
  {
    name: "suggest_normalization",
    description:
      "Turn a scan into a concrete fix: the rules worth adopting in order, each as a Postgres expression and a JavaScript function ready to paste into the matching pipeline.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, column: { type: "string", description: "Column name to build the SQL around. Default 'key'." } },
      required: ["runId"],
    },
  },
  {
    name: "compare_runs",
    description:
      "Compare two scans to prove whether a change to matching logic actually helped. Reports the change in recovered matches, reachable match rate and precision. Use after editing matching logic — never claim an improvement without this.",
    inputSchema: {
      type: "object",
      properties: { baselineRunId: { type: "string" }, candidateRunId: { type: "string" } },
      required: ["baselineRunId", "candidateRunId"],
    },
  },
];

const server = new Server({ name: "shadowjoin", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, any>;
  const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });

  try {
    if (name === "scan_join") {
      const config = await loadConfig();
      const limit = typeof args.limit === "number" ? args.limit : 100_000;
      const [left, right] = await Promise.all([
        loadSide(args.left as SideArgs, config, limit),
        loadSide(args.right as SideArgs, config, limit),
      ]);
      const report = scan(left, right, {
        rules: Array.isArray(args.rules) && args.rules.length ? args.rules : ALL_RULE_IDS,
        maxSamplePairs: 50,
      });
      const runId = randomUUID().slice(0, 8);
      runs.set(runId, { report, left: args.left, right: args.right });
      return ok(summarize(runId, report));
    }

    if (name === "explain_misses") {
      const run = runs.get(String(args.runId));
      if (!run) throw new Error(`Unknown runId "${args.runId}". Call scan_join first.`);
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const pairs = run.report.samplePairs
        .filter((p) => !args.rule || p.rule === args.rule)
        .slice(0, limit);
      return ok({
        runId: args.runId,
        pairs,
        legend: {
          verified: "ground truth confirms this pair",
          contradicted: "ground truth says this pair is WRONG — the matcher over-merged",
          ambiguous: "several right-hand rows collapsed onto one key; needs a tie-breaker, not a rule",
          unverifiable: "no ground truth available for this pair",
        },
      });
    }

    if (name === "suggest_normalization") {
      const run = runs.get(String(args.runId));
      if (!run) throw new Error(`Unknown runId "${args.runId}". Call scan_join first.`);
      const column = typeof args.column === "string" ? args.column : "key";
      const chosen = run.report.stack.map((s) => s.rule);
      const steps = run.report.stack.map((step, i) => {
        const upto = rulesByIds(chosen.slice(0, i + 1));
        return { ...step, sql: toSql(column, upto) };
      });
      return ok({
        runId: args.runId,
        recommended: chosen,
        steps,
        fullSql: toSql(column, rulesByIds(chosen)),
        javascript:
          "import { normalize, rulesByIds } from 'shadowjoin';\n" +
          `const rules = rulesByIds(${JSON.stringify(chosen)});\n` +
          "const key = (value) => normalize(value, rules);",
        caution:
          "Adopting a rule widens matching and can merge records that should stay separate. Re-run scan_join afterwards and compare_runs to confirm precision did not fall.",
      });
    }

    if (name === "compare_runs") {
      const a = runs.get(String(args.baselineRunId));
      const b = runs.get(String(args.candidateRunId));
      if (!a || !b) throw new Error("Both runIds must come from scan_join calls in this session.");
      const delta = (x: number, y: number) => Number((y - x).toFixed(2));
      return ok({
        baseline: summarize(String(args.baselineRunId), a.report),
        candidate: summarize(String(args.candidateRunId), b.report),
        delta: {
          exactMatches: delta(a.report.exactMatches, b.report.exactMatches),
          recovered: delta(a.report.recovered, b.report.recovered),
          reachableMatchRate: delta(a.report.reachableMatchRate, b.report.reachableMatchRate),
          lowerBoundLossPct: delta(a.report.lowerBoundLossPct, b.report.lowerBoundLossPct),
          precision: a.report.precision !== null && b.report.precision !== null ? delta(a.report.precision, b.report.precision) : null,
          contradicted: delta(a.report.contradicted, b.report.contradicted),
        },
        verdict:
          b.report.exactMatchRate > a.report.exactMatchRate
            ? "The exact join matches more rows than before."
            : "The exact join does not match more rows than before. If you changed the matching logic, it did not take effect.",
      });
    }

    throw new Error(`Unknown tool "${name}"`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

await server.connect(new StdioServerTransport());
