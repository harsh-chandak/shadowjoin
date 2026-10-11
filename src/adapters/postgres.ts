import type { Row } from "../types.js";

export interface PostgresSource {
  /** Postgres connection string. Prefer a replica and a read-only role. */
  connectionString: string;
  /** Table, optionally schema-qualified. */
  table: string;
  /** Column holding the join key. */
  keyColumn: string;
  idColumn?: string;
  truthColumn?: string;
  /** Row cap. Default 100000. */
  limit?: number;
  /** Per-statement timeout in ms. Default 30000. */
  statementTimeoutMs?: number;
  /**
   * shadowjoin refuses a role that can write to the table it is about to read.
   * A measurement tool has no business holding write capability.
   */
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
  return parts.map((p) => `"${p}"`).join(".");
}

/**
 * Read join keys out of Postgres. Opens a READ ONLY transaction with a
 * statement and lock timeout, so it cannot write, cannot block a writer, and
 * cannot run away with your CPU.
 *
 * Requires the optional peer dependency `pg`.
 */
export async function rowsFromPostgres(source: PostgresSource): Promise<Row[]> {
  let pg: typeof import("pg");
  try {
    pg = await import("pg");
  } catch {
    throw new Error("The Postgres adapter needs the optional peer dependency `pg`. Install it with: npm i pg");
  }

  const table = quoteIdent(source.table);
  const key = quoteIdent(source.keyColumn);
  const id = source.idColumn ? quoteIdent(source.idColumn) : null;
  const truth = source.truthColumn ? quoteIdent(source.truthColumn) : null;
  const limit = Math.max(1, Math.min(source.limit ?? 100_000, 5_000_000));
  const timeout = source.statementTimeoutMs ?? 30_000;

  const client = new pg.Client({ connectionString: source.connectionString });
  await client.connect();
  try {
    if (!source.allowWritableRole) {
      const { rows } = await client.query<{ writable: boolean }>(
        `SELECT (has_table_privilege($1,'INSERT')
              OR has_table_privilege($1,'UPDATE')
              OR has_table_privilege($1,'DELETE')) AS writable`,
        [source.table],
      );
      if (rows[0]?.writable) {
        throw new Error(
          `The connected role can write to ${source.table}. shadowjoin only reads — point it at a read-only role (see the README) or pass allowWritableRole: true to override.`,
        );
      }
    }

    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(timeout)}`);
    await client.query("SET LOCAL lock_timeout = 1000");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 60000");

    const select = [
      `${key} AS key`,
      id ? `${id}::text AS id` : `row_number() OVER ()::text AS id`,
      truth ? `${truth}::text AS truth` : `NULL::text AS truth`,
    ].join(", ");

    const { rows } = await client.query<{ id: string; key: string | null; truth: string | null }>(
      `SELECT ${select} FROM ${table} WHERE ${key} IS NOT NULL LIMIT ${limit}`,
    );
    await client.query("COMMIT");

    return rows
      .filter((r) => (r.key ?? "").trim() !== "")
      .map((r) => ({
        id: r.id,
        key: String(r.key).trim(),
        ...(r.truth ? { truth: r.truth.trim() } : {}),
      }));
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    await client.end();
  }
}
