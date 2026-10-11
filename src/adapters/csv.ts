import { readFile } from "node:fs/promises";
import type { Row } from "../types.js";

/** Minimal RFC-4180 parser: quoted fields, embedded commas, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

export interface CsvOptions {
  /** Column holding the join key. */
  keyColumn: string;
  /** Column holding a stable id. Defaults to the row number. */
  idColumn?: string;
  /** Column holding ground truth, if you have one. */
  truthColumn?: string;
}

export function rowsFromCsvText(text: string, options: CsvOptions): Row[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim());
  const at = (name: string) => {
    const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (i === -1) throw new Error(`Column "${name}" not found. Columns: ${header.join(", ")}`);
    return i;
  };
  const k = at(options.keyColumn);
  const idx = options.idColumn ? at(options.idColumn) : -1;
  const t = options.truthColumn ? at(options.truthColumn) : -1;

  const rows: Row[] = [];
  for (let i = 1; i < table.length; i++) {
    const rec = table[i];
    const key = (rec[k] ?? "").trim();
    if (!key) continue;
    rows.push({
      id: idx === -1 ? String(i) : (rec[idx] ?? String(i)).trim(),
      key,
      ...(t === -1 ? {} : { truth: (rec[t] ?? "").trim() || undefined }),
    });
  }
  return rows;
}

export async function rowsFromCsv(path: string, options: CsvOptions): Promise<Row[]> {
  return rowsFromCsvText(await readFile(path, "utf8"), options);
}
