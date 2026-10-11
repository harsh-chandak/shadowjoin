import type { Row } from "../types.js";

export interface SqliteSource {
  /** Path to the database file. */
  file: string;
  table: string;
  keyColumn: string;
  idColumn?: string;
  truthColumn?: string;
  limit?: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(
      `Refusing identifier "${name}". Use a plain table or column name; shadowjoin does not accept arbitrary SQL.`,
    );
  }
  return `"${name}"`;
}

/**
 * Read join keys out of a SQLite file. Opens the database READ ONLY.
 *
 * Uses Node's built-in `node:sqlite`, so there is nothing to install — but that
 * module landed in Node 22.5, so older runtimes get a clear error rather than a
 * confusing one.
 */
export async function rowsFromSqlite(source: SqliteSource): Promise<Row[]> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error(
      `The SQLite adapter needs Node's built-in node:sqlite, added in Node 22.5. This process is ${process.version}. Upgrade Node, or export the table to CSV and point shadowjoin at that.`,
    );
  }

  const table = quoteIdent(source.table);
  const key = quoteIdent(source.keyColumn);
  const id = source.idColumn ? quoteIdent(source.idColumn) : null;
  const truth = source.truthColumn ? quoteIdent(source.truthColumn) : null;
  const limit = Math.max(1, Math.min(source.limit ?? 100_000, 5_000_000));

  const db = new DatabaseSync(source.file, { readOnly: true });
  try {
    const select = [
      `${key} AS key`,
      id ? `CAST(${id} AS TEXT) AS id` : `CAST(rowid AS TEXT) AS id`,
      truth ? `CAST(${truth} AS TEXT) AS truth` : `NULL AS truth`,
    ].join(", ");
    const rows = db
      .prepare(`SELECT ${select} FROM ${table} WHERE ${key} IS NOT NULL LIMIT ${limit}`)
      .all() as Array<{ id: string; key: string | null; truth: string | null }>;

    return rows
      .filter((r) => String(r.key ?? "").trim() !== "")
      .map((r) => ({
        id: String(r.id),
        key: String(r.key).trim(),
        ...(r.truth ? { truth: String(r.truth).trim() } : {}),
      }));
  } finally {
    db.close();
  }
}
