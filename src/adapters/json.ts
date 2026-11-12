import { readFile } from "node:fs/promises";
import { DISPLAY_SEPARATOR } from "../keys.js";
import type { Row } from "../types.js";
import { keyColumns } from "./csv.js";
import type { CsvOptions } from "./csv.js";

export function rowsFromJsonText(text: string, options: CsvOptions): Row[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Expected the JSON file to contain an array of objects.");
  const columns = keyColumns(options.keyColumn);
  const rows: Row[] = [];
  parsed.forEach((rec, i) => {
    if (typeof rec !== "object" || rec === null) return;
    const obj = rec as Record<string, unknown>;
    const components = columns.map((c) => String(obj[c] ?? "").trim());
    if (components.some((value) => !value)) return;
    const truth = options.truthColumn ? String(obj[options.truthColumn] ?? "").trim() : "";
    rows.push({
      id: options.idColumn ? String(obj[options.idColumn] ?? i) : String(i),
      key: components.join(DISPLAY_SEPARATOR),
      ...(components.length > 1 ? { keys: components } : {}),
      ...(truth ? { truth } : {}),
    });
  });
  return rows;
}

export async function rowsFromJson(path: string, options: CsvOptions): Promise<Row[]> {
  return rowsFromJsonText(await readFile(path, "utf8"), options);
}
