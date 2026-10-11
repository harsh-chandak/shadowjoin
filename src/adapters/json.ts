import { readFile } from "node:fs/promises";
import type { Row } from "../types.js";
import type { CsvOptions } from "./csv.js";

export function rowsFromJsonText(text: string, options: CsvOptions): Row[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Expected the JSON file to contain an array of objects.");
  const rows: Row[] = [];
  parsed.forEach((rec, i) => {
    if (typeof rec !== "object" || rec === null) return;
    const obj = rec as Record<string, unknown>;
    const key = String(obj[options.keyColumn] ?? "").trim();
    if (!key) return;
    const truth = options.truthColumn ? String(obj[options.truthColumn] ?? "").trim() : "";
    rows.push({
      id: options.idColumn ? String(obj[options.idColumn] ?? i) : String(i),
      key,
      ...(truth ? { truth } : {}),
    });
  });
  return rows;
}

export async function rowsFromJson(path: string, options: CsvOptions): Promise<Row[]> {
  return rowsFromJsonText(await readFile(path, "utf8"), options);
}
