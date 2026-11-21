/**
 * Column recognition shared by adapters: find the header row, map known headers to standard fields, and keep every
 * other column by name so nothing a report carries is lost.
 */
import type { CanonicalField, Detection, ReportType } from "./types";
import type { SourceTable } from "./tables";

export function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Header texts made unique: a repeated name gets " (2)", " (3)"; an empty header becomes "column N". The first
 * occurrence keeps the plain name, so a mapping never lands on a second, differently-meant copy.
 */
export function uniqueHeaders(row: string[]): string[] {
  const seen = new Map<string, number>();
  return row.map((cell, index) => {
    const base = cell.trim() || `column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function mapColumns(headers: string[], aliases: Partial<Record<CanonicalField, string[]>>): Partial<Record<CanonicalField, string>> {
  const map: Partial<Record<CanonicalField, string>> = {};
  const used = new Set<string>();
  for (const [field, names] of Object.entries(aliases) as Array<[CanonicalField, string[]]>) {
    for (const name of names) {
      const wanted = headerKey(name);
      const found = headers.find(header => !used.has(header) && !/\(\d+\)$/.test(header) && headerKey(header) === wanted);
      if (found) {
        map[field] = found;
        used.add(found);
        break;
      }
    }
  }
  return map;
}

/** The row among the first fifteen that names the most known columns. */
export function findHeaderRow(table: SourceTable, aliases: Partial<Record<CanonicalField, string[]>>): { index: number; hits: number } {
  const known = new Set(Object.values(aliases).flat().map(name => headerKey(name ?? "")));
  let best = { index: 0, hits: -1 };
  table.rows.slice(0, 15).forEach((row, index) => {
    const hits = row.filter(cell => known.has(headerKey(cell))).length;
    if (hits > best.hits) best = { index, hits };
  });
  return best;
}

export function detectionFor(
  table: SourceTable,
  aliases: Partial<Record<CanonicalField, string[]>>,
  mandatory: CanonicalField[],
  reportType: (headers: string[], map: Partial<Record<CanonicalField, string>>, table: SourceTable) => ReportType,
): Detection {
  const { index, hits } = findHeaderRow(table, aliases);
  const headers = uniqueHeaders(table.rows[index] ?? []);
  const columnMap = mapColumns(headers, aliases);
  const type = reportType(headers, columnMap, table);
  const mapped = new Set(Object.values(columnMap));
  const unknownColumns = headers.filter(header => !mapped.has(header) && !/^column \d+$/.test(header));
  const needed = type === "sales" || type === "returns" || type === "combined" ? mandatory : [];
  return {
    reportType: type,
    headerIndex: index,
    headers,
    columnMap,
    missing: needed.filter(field => !columnMap[field]),
    unknownColumns,
    confidence: headers.length ? Math.min(1, Math.max(0, hits) / Math.max(6, Object.keys(columnMap).length)) : 0,
  };
}

/** Applies a mapping chosen by a person on top of what was detected. Unknown headers are refused. */
export function applyMapping(detection: Detection, chosen: Partial<Record<CanonicalField, string>>, mandatory: CanonicalField[]): Detection {
  const columnMap = { ...detection.columnMap };
  for (const [field, header] of Object.entries(chosen) as Array<[CanonicalField, string]>) {
    if (!header) continue;
    if (!detection.headers.includes(header)) throw new Error(`"${header}" is not a column in this file.`);
    columnMap[field] = header;
  }
  const mapped = new Set(Object.values(columnMap));
  const needed = detection.reportType === "unknown" ? [] : mandatory;
  return {
    ...detection,
    columnMap,
    missing: needed.filter(field => !columnMap[field]),
    unknownColumns: detection.headers.filter(header => !mapped.has(header) && !/^column \d+$/.test(header)),
  };
}
