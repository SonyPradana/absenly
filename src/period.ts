// Date/month/range validation shared by the API, CLI, export, and schedule. Pure.

export const MAX_RANGE_DAYS = 366;

export type PeriodField = "month" | "from" | "to" | "range";
export type PeriodErrorCode = "MONTH" | "DATE" | "ORDER" | "RANGE";

export class PeriodError extends Error {
  constructor(
    readonly code: PeriodErrorCode,
    readonly field: PeriodField,
    message: string,
  ) {
    super(message);
    this.name = "PeriodError";
  }
}

export interface DateRange {
  from: string;
  to: string;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function monthRange(month: string): DateRange {
  const match = MONTH_RE.exec(month);
  if (match === null) {
    throw new PeriodError("MONTH", "month", "month must be in YYYY-MM format");
  }
  const year = Number(match[1]);
  if (year < 1) {
    throw new PeriodError("MONTH", "month", "month must be in YYYY-MM format");
  }
  const monthNumber = Number(match[2]);
  return {
    from: `${month}-01`,
    to: `${month}-${pad(daysInMonth(year, monthNumber))}`,
  };
}

export function dateRange(from: string, to: string): DateRange {
  if (!isValidDate(from)) {
    throw new PeriodError("DATE", "from", "from must be a valid YYYY-MM-DD date");
  }
  if (!isValidDate(to)) {
    throw new PeriodError("DATE", "to", "to must be a valid YYYY-MM-DD date");
  }
  if (from > to) {
    throw new PeriodError("ORDER", "from", "from must be before or equal to to");
  }
  const days =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new PeriodError("RANGE", "range", `date range must be at most ${MAX_RANGE_DAYS} days`);
  }
  return { from, to };
}
