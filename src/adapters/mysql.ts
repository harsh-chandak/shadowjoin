import { DISPLAY_SEPARATOR } from "../keys.js";
import { keyColumns } from "./csv.js";
import type { Row } from "../types.js";

export interface MysqlSource {
  /** mysql:// connection string. Prefer a replica and a read-only user. */
  connectionString: string;
  table: string;
  /**
   * Column holding the join key, or several for a composite key — `(name, city)`,
   * `(sku, vendor)`. The same number of columns, in the same order, on both sides.
   */
  keyColumn: string | string[];
  idColumn?: string;
  truthColumn?: string;
  limit?: number;
  /** Per-statement cap in ms. Default 30000. */
  statementTimeoutMs?: number;
  /** shadowjoin refuses a user that can write to the table it is about to read. */
  allowWritableRole?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function quoteIdent(name: string): string {
  const parts = name.split(".");
  for (const part of parts) {
    if (!IDENT.test(part)) {
      throw new Error(
        `Refusing identifier "${name}". Use a plain table or column name; shadowjoin does not accept arbitrary SQL.`,
      );
    }
  }
  return parts.map((p) => `\`${p}\``).join(".");
}

/**
 * Read join keys out of MySQL inside a READ ONLY transaction with a statement
 * timeout, and refuse a user that holds write privileges on the target.
 *
 * Requires the optional peer dependency `mysql2`.
 */
export async function rowsFromMysql(source: MysqlSource): Promise<Row[]> {
  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch {
    throw new Error("The MySQL adapter needs the optional peer dependency `mysql2`. Install it with: npm i mysql2");
  }

  const table = quoteIdent(source.table);
  const keys = keyColumns(source.keyColumn).map(quoteIdent);
  const id = source.idColumn ? quoteIdent(source.idColumn) : null;
  const truth = source.truthColumn ? quoteIdent(source.truthColumn) : null;
  const limit = Math.max(1, Math.min(source.limit ?? 100_000, 5_000_000));
  const timeout = source.statementTimeoutMs ?? 30_000;

  const conn = await mysql.createConnection(source.connectionString);
  try {
    if (!source.allowWritableRole) {
      const [grants] = await conn.query<any[]>("SHOW GRANTS FOR CURRENT_USER()");
      const writable = grants.some((g) => {
        const text = String(Object.values(g)[0] ?? "").toUpperCase();
        if (!/\bON\b/.test(text)) return false;
        return /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE)\b/.test(text);
      });
      if (writable) {
        throw new Error(
          `The connected MySQL user holds write privileges. shadowjoin only reads — use a SELECT-only user (see the README) or pass allowWritableRole: true to override.`,
        );
      }
    }

    await conn.query(`SET SESSION max_execution_time = ${Number(timeout)}`);
    await conn.query("START TRANSACTION READ ONLY");

    const select = [
      ...keys.map((key, i) => `${key} AS \`key${i}\``),
      id ? `CAST(${id} AS CHAR) AS \`id\`` : `CAST(ROW_NUMBER() OVER () AS CHAR) AS \`id\``,
      truth ? `CAST(${truth} AS CHAR) AS \`truth\`` : `NULL AS \`truth\``,
    ].join(", ");
    // A row missing any part of its key cannot be joined on that key at all.
    const present = keys.map((key) => `${key} IS NOT NULL`).join(" AND ");

    const [rows] = await conn.query<any[]>(
      `SELECT ${select} FROM ${table} WHERE ${present} LIMIT ${limit}`,
    );
    await conn.query("COMMIT");

    return rows
      .map((r) => ({ row: r, components: keys.map((_, i) => String(r[`key${i}`] ?? "").trim()) }))
      .filter(({ components }) => components.every((value) => value !== ""))
      .map(({ row, components }) => ({
        id: String(row.id),
        key: components.join(DISPLAY_SEPARATOR),
        ...(components.length > 1 ? { keys: components } : {}),
        ...(row.truth ? { truth: String(row.truth).trim() } : {}),
      }));
  } catch (err) {
    try { await conn.query("ROLLBACK"); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    await conn.end();
  }
}
