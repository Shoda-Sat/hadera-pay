export type DateValue = string | number | Date | null | undefined;

function parsedDate(value: DateValue): Date | null {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDate(value: DateValue, fallback = "-"): string {
  const date = parsedDate(value);
  if (!date) return fallback;
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatDateTime(value: DateValue, fallback = "-"): string {
  const date = parsedDate(value);
  if (!date) return fallback;
  return `${formatDate(date, fallback)} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

export function formatMonthYear(monthKey: string, fallback = "Unknown month"): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || month < 1 || month > 12) return fallback;
  return `${twoDigits(month)}/${year}`;
}
