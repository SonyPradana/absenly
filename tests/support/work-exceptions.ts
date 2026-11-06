// Reference validator for the work_exceptions ledger. Test-only.
// Rules follow docs/ARCHITECTURE.md and docs/API.md:
// - kind: overtime | night_shift | holiday_work | other
// - end may be the next day (piket 21:00-07:00)
// - overlap is checked as a half-open interval [start, end) per id_number
// - work_exceptions never change the normal recap

export type WorkExceptionKind = "overtime" | "night_shift" | "holiday_work" | "other";

export interface WorkExceptionInput {
  id_number: string;
  kind: WorkExceptionKind;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  note?: string | null;
}

export interface WorkExceptionRow extends WorkExceptionInput {
  id: number;
  created_at: string;
}

export type WorkExceptionErrorCode =
  | "INVALID_ARGS"
  | "UNKNOWN_EMPLOYEE"
  | "WORK_EXCEPTION_KIND"
  | "WORK_EXCEPTION_OVERLAP";

export class WorkExceptionError extends Error {
  constructor(
    readonly code: WorkExceptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkExceptionError";
  }
}

const KINDS = new Set<WorkExceptionKind>(["overtime", "night_shift", "holiday_work", "other"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function localStamp(date: string, time: string): string {
  return `${date}T${time}`;
}

export function overlaps(a: WorkExceptionInput, b: WorkExceptionInput): boolean {
  if (a.id_number !== b.id_number) return false;
  const aStart = localStamp(a.start_date, a.start_time);
  const aEnd = localStamp(a.end_date, a.end_time);
  const bStart = localStamp(b.start_date, b.start_time);
  const bEnd = localStamp(b.end_date, b.end_time);
  return aStart < bEnd && bStart < aEnd;
}

export function validateWorkException(
  input: WorkExceptionInput,
  existing: WorkExceptionInput[],
  employeeIds: Set<string>,
): WorkExceptionInput {
  if (!input.id_number.trim()) {
    throw new WorkExceptionError("INVALID_ARGS", "id_number wajib diisi");
  }
  if (!employeeIds.has(input.id_number)) {
    throw new WorkExceptionError("UNKNOWN_EMPLOYEE", `employee tidak dikenal: ${input.id_number}`);
  }
  if (!KINDS.has(input.kind)) {
    throw new WorkExceptionError("WORK_EXCEPTION_KIND", `kind tidak dikenal: ${input.kind}`);
  }
  if (!isValidDate(input.start_date) || !isValidDate(input.end_date)) {
    throw new WorkExceptionError("INVALID_ARGS", "tanggal harus YYYY-MM-DD yang valid");
  }
  if (!isValidTime(input.start_time) || !isValidTime(input.end_time)) {
    throw new WorkExceptionError("INVALID_ARGS", "jam harus HH:MM:SS yang valid");
  }
  if (
    localStamp(input.end_date, input.end_time) <= localStamp(input.start_date, input.start_time)
  ) {
    throw new WorkExceptionError("INVALID_ARGS", "end harus setelah start");
  }
  for (const row of existing) {
    if (overlaps(input, row)) {
      throw new WorkExceptionError(
        "WORK_EXCEPTION_OVERLAP",
        `overlap dengan ${row.id_number} ${row.start_date} ${row.start_time} - ${row.end_date} ${row.end_time}`,
      );
    }
  }
  return {
    ...input,
    note: input.note ?? null,
  };
}

export function addWorkException(
  existing: WorkExceptionInput[],
  input: WorkExceptionInput,
  employeeIds: Set<string>,
  createdAt = "2026-10-20T00:00:00+07:00",
): WorkExceptionRow[] {
  validateWorkException(input, existing, employeeIds);
  const next: WorkExceptionRow[] = existing.map((row, i) => ({
    ...row,
    id: (row as WorkExceptionRow).id ?? i + 1,
    created_at: (row as WorkExceptionRow).created_at ?? createdAt,
  }));
  next.push({
    ...input,
    note: input.note ?? null,
    id: next.length + 1,
    created_at: createdAt,
  });
  return next;
}
