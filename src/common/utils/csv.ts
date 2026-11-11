/**
 * CSV utilities with RFC 4180 quoting and spreadsheet formula-injection protection.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(
  columns: Array<{ key: string; header: string }>,
  rows: Array<Record<string, unknown>>,
): string {
  const header = columns.map((column) => csvEscape(column.header)).join(',');
  const lines = rows.map((row) => columns.map((column) => csvEscape(row[column.key])).join(','));
  return [header, ...lines].join('\r\n');
}
