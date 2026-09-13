/**
 * Minimal CSV reader for bulk idiom import.
 *
 * Lives in `lib` rather than beside the import action because a `"use server"`
 * module may only export async functions, and this is a pure parser.
 *
 * It handles the one case a naive `split(",")` gets wrong and that this data hits
 * constantly: quoted fields containing commas, because example sentences have
 * them ("Hi, how are you?").
 */
export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'; // an escaped quote inside a quoted field
          i++;
        } else inQuotes = false;
      } else cell += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  const keys = header.map((h) => h.trim());

  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => {
      const obj: Record<string, string> = {};
      keys.forEach((key, index) => {
        obj[key] = (r[index] ?? "").trim();
      });
      return obj;
    });
}
