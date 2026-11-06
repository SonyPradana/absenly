// WIB helpers. Device dates/times are stored as-is; these are for server timestamps only.

export const TIME_ZONE = "Asia/Jakarta";
export const SPLIT_TIME = "10:00:00";

export function wibParts(now: Date): Record<string, string> {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  return Object.fromEntries(formatted.map((part) => [part.type, part.value]));
}

export function today(now = new Date()): string {
  const p = wibParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

export function stamp(now = new Date()): string {
  const p = wibParts(now);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+07:00`;
}

/** WIB clock as `HH:MM`, for window comparisons. */
export function clockMinutes(now = new Date()): number {
  const p = wibParts(now);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** WIB weekday index, 0 = Sunday, matching `DAY_KEYS`. */
export function wibDayIndex(now = new Date()): number {
  const p = wibParts(now);
  // Date.UTC on the WIB calendar date is a safe way to read its weekday.
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getUTCDay();
}

/** Minutes since midnight parsed from a stored `HH:MM` string, or null when malformed. */
export function minutesOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
