/**
 * Format a date-type answer value for display. Accepts either a date-only
 * ISO string (`YYYY-MM-DD`) or a datetime-local ISO string (`YYYY-MM-DDTHH:mm`).
 * Falls back to the raw string if it can't be parsed — covers anything saved
 * before the date type existed.
 */
export function formatDateAnswerValue(value: string): string {
  if (!value) return value;

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);

  if (!dateOnly && !dateTime) return value;

  // For date-only strings, append T00:00 to avoid the JS Date constructor
  // interpreting the bare date as UTC and shifting the day on display.
  const parsed = new Date(dateOnly ? `${value}T00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;

  if (dateOnly) {
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
