// Pure rules for the work_exceptions ledger. No DB, no HTTP, no device.

import { isValidDate } from "./period.ts";
import { dailyStatus, type DailyRow } from "./recap.ts";

export const WORK_EXCEPTION_KINDS = ["overtime", "night_shift", "holiday_work", "other"] as const;

export type WorkExceptionKind = (typeof WORK_EXCEPTION_KINDS)[number];

export type WorkExceptionErrorCode = "INVALID" | "UNKNOWN_EMPLOYEE" | "KIND" | "OVERLAP";

export class WorkExceptionError extends Error {
  constructor(
    readonly code: WorkExceptionErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "WorkExceptionError";
  }
}

export interface WorkExceptionInput {
  idNumber: string;
  kind: WorkExceptionKind;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  note: string | null;
}

export type WorkExceptionSpan = Pick<
  WorkExceptionInput,
  "idNumber" | "startDate" | "startTime" | "endDate" | "endTime"
>;

// One piket/overtime span on the daily rows: sanctions are waived on every date
// it touches, and the row on its start date is flagged piket. A night shift
// 21:00 -> next 07:00 therefore marks the evening it begins: one shift is one
// duty day, never two.
export function applyWorkExceptions(
  rows: DailyRow[],
  spans: WorkExceptionSpan[],
  options: {
    isWorkdayOn?: (date: string) => boolean;
    nameOf?: (idNumber: string) => string | undefined;
  } = {},
): DailyRow[] {
  const isWorkdayOn = options.isWorkdayOn ?? (() => false);
  const nameOf = options.nameOf ?? (() => undefined);
  if (spans.length === 0) return rows;

  const waived = new Set<string>();
  const piketStarts = new Set<string>();
  const missing = new Map<string, string>();

  for (const span of spans) {
    piketStarts.add(`${span.idNumber}|${span.startDate}`);
    for (const date of dateSpan(span.startDate, span.endDate)) {
      waived.add(`${span.idNumber}|${date}`);
    }
    // A piket with no punch still has to show up: remember an anchor row.
    const key = `${span.idNumber}|${span.startDate}`;
    if (!missing.has(key)) missing.set(key, span.idNumber);
  }

  const seen = new Set<string>();
  const out: DailyRow[] = [];
  for (const row of rows) {
    const key = `${row.idNumber}|${row.date}`;
    seen.add(key);
    if (!waived.has(key)) {
      out.push(row);
      continue;
    }
    const isPiket = piketStarts.has(key);
    out.push({
      ...row,
      // Sanctions are waived, then the status is recomputed from scratch.
      lateSeconds: 0,
      earlySeconds: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      isPiket,
      status: dailyStatus(row.isWorkday, row.inTime, row.outTime, 0, 0, isPiket),
    });
  }

  // Piket on a day with no punch at all: synthesize the missing row so the day
  // counts as present instead of vanishing.
  for (const [key, idNumber] of missing) {
    if (seen.has(key)) continue;
    const date = key.slice(key.indexOf("|") + 1);
    out.push({
      date,
      idNumber,
      name: nameOf(idNumber) ?? idNumber,
      inTime: null,
      outTime: null,
      inVerify: null,
      outVerify: null,
      lateSeconds: 0,
      earlySeconds: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      isWorkday: isWorkdayOn(date),
      isPiket: true,
      punches: 0,
      status: "piket",
    });
  }

  return out;
}

// Inclusive date list; dates are WIB calendar strings (YYYY-MM-DD).
function dateSpan(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const MAX_DURATION_MS = 48 * 60 * 60 * 1000;

export function isWorkExceptionKind(value: unknown): value is WorkExceptionKind {
  return typeof value === "string" && (WORK_EXCEPTION_KINDS as readonly string[]).includes(value);
}

export function workExceptionStamp(date: string, time: string): string {
  return `${date}T${time}`;
}

// Half-open [start, end): adjacent spans do not overlap.
export function workExceptionOverlaps(a: WorkExceptionSpan, b: WorkExceptionSpan): boolean {
  if (a.idNumber !== b.idNumber) return false;
  const aStart = workExceptionStamp(a.startDate, a.startTime);
  const aEnd = workExceptionStamp(a.endDate, a.endTime);
  const bStart = workExceptionStamp(b.startDate, b.startTime);
  const bEnd = workExceptionStamp(b.endDate, b.endTime);
  return aStart < bEnd && bStart < aEnd;
}

function milliseconds(date: string, time: string): number {
  // The suffix only fixes the arithmetic; dates/times remain WIB strings.
  return Date.parse(`${date}T${time}Z`);
}

export function validateWorkException(
  input: WorkExceptionInput,
  existing: WorkExceptionSpan[],
  employeeExists: boolean,
): void {
  if (input.idNumber.trim() === "") {
    throw new WorkExceptionError("INVALID", "id_number wajib diisi", "id_number");
  }
  if (!employeeExists) {
    throw new WorkExceptionError(
      "UNKNOWN_EMPLOYEE",
      `employee tidak dikenal: ${input.idNumber}`,
      "id_number",
    );
  }
  if (!isWorkExceptionKind(input.kind)) {
    throw new WorkExceptionError("KIND", `kind tidak dikenal: ${input.kind}`, "kind");
  }
  if (!isValidDate(input.startDate)) {
    throw new WorkExceptionError("INVALID", "start_date harus YYYY-MM-DD yang valid", "start_date");
  }
  if (!isValidDate(input.endDate)) {
    throw new WorkExceptionError("INVALID", "end_date harus YYYY-MM-DD yang valid", "end_date");
  }
  if (!TIME_RE.test(input.startTime)) {
    throw new WorkExceptionError("INVALID", "start_time harus HH:MM:SS yang valid", "start_time");
  }
  if (!TIME_RE.test(input.endTime)) {
    throw new WorkExceptionError("INVALID", "end_time harus HH:MM:SS yang valid", "end_time");
  }

  const start = milliseconds(input.startDate, input.startTime);
  const end = milliseconds(input.endDate, input.endTime);
  if (end <= start) {
    throw new WorkExceptionError("INVALID", "end harus setelah start", "range");
  }
  if (end - start > MAX_DURATION_MS) {
    throw new WorkExceptionError("INVALID", "durasi maksimal 48 jam", "range");
  }

  for (const row of existing) {
    if (workExceptionOverlaps(input, row)) {
      throw new WorkExceptionError(
        "OVERLAP",
        `overlap dengan ${row.idNumber} ${row.startDate} ${row.startTime} - ${row.endDate} ${row.endTime}`,
        "range",
      );
    }
  }
}
