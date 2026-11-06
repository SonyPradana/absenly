// Legacy reference validator for fixtures. Production tests use src/schedule.ts.
// Rules:
// - Per-day shape; production now uses calendar JSON + flat fallback.
// - IN and OUT must be set as a pair, or both empty.
// - Time format HH:MM (24-hour).
// - OUT must be after IN.
// - At least one workday.
// - A day off is determined by an empty pair, not by the day name.

import { DAY_KEYS, type DayKey, type WeeklySchedule } from "./recap-reference.ts";

export type ScheduleErrorCode =
  | "SCHEDULE_PAIR"
  | "SCHEDULE_ORDER"
  | "SCHEDULE_TIME"
  | "SCHEDULE_EMPTY"
  | "SCHEDULE_DAY";

export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

const DAY_SET = new Set<string>(DAY_KEYS);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function validateWeeklySchedule(input: Record<string, unknown>): WeeklySchedule {
  for (const key of Object.keys(input)) {
    if (!DAY_SET.has(key)) {
      throw new ScheduleError("SCHEDULE_DAY", `hari tidak dikenal: ${key}`);
    }
  }

  const schedule: WeeklySchedule = {};
  let workdays = 0;

  for (const day of DAY_KEYS) {
    const raw = input[day];
    if (raw === undefined || raw === null) {
      schedule[day] = null;
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ScheduleError("SCHEDULE_TIME", `${day}: entri jadwal harus objek`);
    }

    const entry = raw as Record<string, unknown>;
    const inRaw = entry.in;
    const outRaw = entry.out;
    const inValue = inRaw === undefined || inRaw === null ? "" : inRaw;
    const outValue = outRaw === undefined || outRaw === null ? "" : outRaw;

    if (inValue === "" && outValue === "") {
      schedule[day] = null;
      continue;
    }
    if (inValue === "" || outValue === "") {
      throw new ScheduleError("SCHEDULE_PAIR", `${day}: IN dan OUT harus diisi berpasangan`);
    }
    if (typeof inValue !== "string" || typeof outValue !== "string") {
      throw new ScheduleError("SCHEDULE_TIME", `${day}: jam harus string HH:MM`);
    }

    const inTime = inValue.trim();
    const outTime = outValue.trim();
    if (!TIME_RE.test(inTime) || !TIME_RE.test(outTime)) {
      throw new ScheduleError("SCHEDULE_TIME", `${day}: jam harus HH:MM 24 jam`);
    }
    if (toMinutes(outTime) <= toMinutes(inTime)) {
      throw new ScheduleError("SCHEDULE_ORDER", `${day}: OUT harus setelah IN`);
    }

    schedule[day] = { in: inTime, out: outTime };
    workdays++;
  }

  if (workdays === 0) {
    throw new ScheduleError("SCHEDULE_EMPTY", "minimal satu hari kerja");
  }
  return schedule;
}

export function scheduleFromEnv(env: Record<string, string | undefined>): WeeklySchedule {
  const input: Record<string, { in: string; out: string } | null> = {};
  for (const day of DAY_KEYS) {
    const inKey = `ABSEN_SCHEDULE_${day}_IN`;
    const outKey = `ABSEN_SCHEDULE_${day}_OUT`;
    const inValue = env[inKey];
    const outValue = env[outKey];
    if (inValue === undefined && outValue === undefined) {
      input[day] = null;
      continue;
    }
    input[day] = { in: inValue ?? "", out: outValue ?? "" };
  }
  return validateWeeklySchedule(input);
}

export function scheduleToEnv(schedule: WeeklySchedule): Record<string, string> {
  const env: Record<string, string> = {};
  for (const day of DAY_KEYS) {
    const entry = schedule[day as DayKey];
    env[`ABSEN_SCHEDULE_${day}_IN`] = entry?.in ?? "";
    env[`ABSEN_SCHEDULE_${day}_OUT`] = entry?.out ?? "";
  }
  return env;
}
