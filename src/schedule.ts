// Core schedule: base week + inclusive date-range overrides.
// Pure: no env, filesystem, DB, HTTP, or device access.

import { isValidDate } from "./period.ts";

export const DAY_KEYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export interface DaySchedule {
  in: string;
  out: string;
}

export type WeeklySchedule = Record<DayKey, DaySchedule | null>;

export interface ScheduleOverride {
  id: string;
  from: string;
  to: string;
  priority: number;
  note?: string;
  schedule: WeeklySchedule | null;
}

export interface ScheduleCalendar {
  version: 1;
  base: WeeklySchedule;
  overrides: ScheduleOverride[];
}

export type ScheduleErrorCode =
  | "SCHEDULE_JSON"
  | "SCHEDULE_READ"
  | "SCHEDULE_SHAPE"
  | "SCHEDULE_VERSION"
  | "SCHEDULE_DAY"
  | "SCHEDULE_TIME"
  | "SCHEDULE_ORDER"
  | "SCHEDULE_PAIR"
  | "SCHEDULE_EMPTY"
  | "SCHEDULE_OVERRIDE_ID"
  | "SCHEDULE_DATE"
  | "SCHEDULE_RANGE"
  | "SCHEDULE_PRIORITY"
  | "SCHEDULE_OVERLAP"
  | "SCHEDULE_FALLBACK"
  | "SCHEDULE_READONLY"
  | "SCHEDULE_WRITE";

export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function fail(code: ScheduleErrorCode, message: string): never {
  throw new ScheduleError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail("SCHEDULE_SHAPE", `${label}: field tidak dikenal: ${key}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function dayKeyForDate(date: string): DayKey {
  if (!isValidDate(date)) {
    fail("SCHEDULE_DATE", `tanggal tidak valid: ${date}`);
  }
  return DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function parseDaySchedule(raw: unknown, label: string): DaySchedule | null {
  if (raw === null) return null;
  if (!isRecord(raw)) {
    fail("SCHEDULE_SHAPE", `${label}: harus objek {in,out} atau null`);
  }
  assertAllowedKeys(raw, ["in", "out"], label);

  if (raw.in === undefined || raw.in === null || raw.out === undefined || raw.out === null) {
    fail("SCHEDULE_PAIR", `${label}: IN dan OUT harus diisi berpasangan`);
  }
  if (typeof raw.in !== "string" || typeof raw.out !== "string") {
    fail("SCHEDULE_TIME", `${label}: jam harus string HH:MM`);
  }

  const inTime = raw.in.trim();
  const outTime = raw.out.trim();
  if (inTime === "" || outTime === "") {
    fail("SCHEDULE_PAIR", `${label}: IN dan OUT tidak boleh kosong; pakai null untuk libur`);
  }
  if (!TIME_RE.test(inTime) || !TIME_RE.test(outTime)) {
    fail("SCHEDULE_TIME", `${label}: jam harus HH:MM 24 jam`);
  }
  if (toMinutes(outTime) <= toMinutes(inTime)) {
    fail("SCHEDULE_ORDER", `${label}: OUT harus setelah IN`);
  }

  return { in: inTime, out: outTime };
}

export function parseWeeklySchedule(input: unknown, label = "schedule"): WeeklySchedule {
  if (!isRecord(input)) {
    fail("SCHEDULE_SHAPE", `${label}: harus objek`);
  }

  const daySet = new Set<string>(DAY_KEYS);
  for (const key of Object.keys(input)) {
    if (!daySet.has(key)) {
      fail("SCHEDULE_DAY", `${label}: hari tidak dikenal: ${key}`);
    }
  }

  const schedule = {} as WeeklySchedule;
  let workdays = 0;

  for (const day of DAY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, day)) {
      fail("SCHEDULE_DAY", `${label}: hari ${day} wajib ada (null untuk libur)`);
    }
    const parsed = parseDaySchedule(input[day], `${label}.${day}`);
    schedule[day] = parsed;
    if (parsed !== null) workdays++;
  }

  if (workdays === 0) {
    fail("SCHEDULE_EMPTY", `${label}: minimal satu hari kerja`);
  }

  return schedule;
}

function parseOverride(input: unknown, label: string): ScheduleOverride {
  if (!isRecord(input)) {
    fail("SCHEDULE_SHAPE", `${label}: harus objek`);
  }
  assertAllowedKeys(input, ["id", "from", "to", "priority", "note", "schedule"], label);

  if (typeof input.id !== "string" || input.id.trim() === "") {
    fail("SCHEDULE_OVERRIDE_ID", `${label}: id wajib string tidak kosong`);
  }
  const id = input.id.trim();

  if (!isValidDate(input.from) || !isValidDate(input.to)) {
    fail("SCHEDULE_DATE", `${label}: from/to harus tanggal valid YYYY-MM-DD`);
  }
  if (input.from > input.to) {
    fail("SCHEDULE_RANGE", `${label}: from tidak boleh setelah to`);
  }

  const priorityRaw = input.priority;
  if (
    priorityRaw !== undefined &&
    (typeof priorityRaw !== "number" || !Number.isInteger(priorityRaw) || priorityRaw < 0)
  ) {
    fail("SCHEDULE_PRIORITY", `${label}: priority harus integer >= 0`);
  }
  const priority = priorityRaw === undefined ? 0 : priorityRaw;

  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    fail("SCHEDULE_SHAPE", `${label}: note harus string atau null`);
  }

  if (input.schedule === undefined) {
    fail("SCHEDULE_SHAPE", `${label}: schedule wajib ada (null untuk libur total)`);
  }
  const schedule =
    input.schedule === null ? null : parseWeeklySchedule(input.schedule, `${label}.schedule`);

  return {
    id,
    from: input.from,
    to: input.to,
    priority,
    ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
    schedule,
  };
}

export function parseScheduleCalendar(input: unknown): ScheduleCalendar {
  if (!isRecord(input)) {
    fail("SCHEDULE_SHAPE", "calendar: harus objek");
  }
  assertAllowedKeys(input, ["version", "base", "overrides"], "calendar");

  if (input.version !== 1) {
    fail("SCHEDULE_VERSION", "calendar: version harus 1");
  }
  if (input.base === undefined) {
    fail("SCHEDULE_SHAPE", "calendar: base wajib ada");
  }

  const base = parseWeeklySchedule(input.base, "base");

  let overrides: ScheduleOverride[] = [];
  if (input.overrides !== undefined) {
    if (!Array.isArray(input.overrides)) {
      fail("SCHEDULE_SHAPE", "calendar: overrides harus array");
    }
    overrides = input.overrides.map((item, index) => parseOverride(item, `overrides[${index}]`));
  }

  const ids = new Set<string>();
  for (const override of overrides) {
    if (ids.has(override.id)) {
      fail("SCHEDULE_OVERRIDE_ID", `id override duplikat: ${override.id}`);
    }
    ids.add(override.id);
  }

  for (let i = 0; i < overrides.length; i++) {
    const a = overrides[i]!;
    for (let j = i + 1; j < overrides.length; j++) {
      const b = overrides[j]!;
      if (a.priority !== b.priority) continue;
      if (a.from <= b.to && b.from <= a.to) {
        fail("SCHEDULE_OVERLAP", `override ${a.id} dan ${b.id} overlap dengan priority yang sama`);
      }
    }
  }

  return { version: 1, base, overrides };
}

export function parseScheduleJson(text: string): ScheduleCalendar {
  let raw: unknown;
  try {
    // A UTF-8 BOM is invisible and breaks JSON.parse; accept files saved by Windows editors.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    fail("SCHEDULE_JSON", `JSON tidak valid: ${messageOf(error)}`);
  }
  return parseScheduleCalendar(raw);
}

export function resolveSchedule(calendar: ScheduleCalendar, date: string): DaySchedule | null {
  const day = dayKeyForDate(date);

  let chosen: ScheduleOverride | null = null;
  for (const override of calendar.overrides) {
    if (override.from <= date && date <= override.to) {
      if (chosen === null || override.priority > chosen.priority) {
        chosen = override;
      }
    }
  }

  if (chosen !== null) {
    return chosen.schedule === null ? null : chosen.schedule[day];
  }
  return calendar.base[day];
}

// Emergency fallback when schedule.json is missing: one flat shift for every day.
// There is no day-off concept here; use schedule.json for days off or overrides.
export function scheduleFromEnv(env: Record<string, string | undefined>): WeeklySchedule {
  const inRaw = env.ABSEN_SCHEDULE_IN;
  const outRaw = env.ABSEN_SCHEDULE_OUT;

  if (inRaw === undefined && outRaw === undefined) {
    fail("SCHEDULE_FALLBACK", "schedule.json tidak ada dan ABSEN_SCHEDULE_IN/OUT tidak diisi");
  }
  if (inRaw === undefined || outRaw === undefined) {
    fail("SCHEDULE_PAIR", "ABSEN_SCHEDULE_IN dan ABSEN_SCHEDULE_OUT harus diisi berpasangan");
  }

  const inTime = inRaw.trim();
  const outTime = outRaw.trim();
  if (inTime === "" || outTime === "") {
    fail("SCHEDULE_PAIR", "ABSEN_SCHEDULE_IN dan ABSEN_SCHEDULE_OUT tidak boleh kosong");
  }
  if (!TIME_RE.test(inTime) || !TIME_RE.test(outTime)) {
    fail("SCHEDULE_TIME", "ABSEN_SCHEDULE_IN/OUT harus HH:MM 24 jam");
  }
  if (toMinutes(outTime) <= toMinutes(inTime)) {
    fail("SCHEDULE_ORDER", "ABSEN_SCHEDULE_OUT harus setelah ABSEN_SCHEDULE_IN");
  }

  const schedule = {} as WeeklySchedule;
  for (const day of DAY_KEYS) {
    schedule[day] = { in: inTime, out: outTime };
  }
  return schedule;
}
