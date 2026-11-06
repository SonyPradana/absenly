// Reference recap rules for fixture/golden tests. Not a production module.
// Production must use src/recap.ts; this helper is used to check
// whether fixtures and expected JSON match docs/ARCHITECTURE.md.

export const SPLIT_TIME = "10:00:00";

export type DailyStatus =
  | "lengkap"
  | "telat"
  | "pulang_cepat"
  | "tanpa_masuk"
  | "belum_pulang"
  | "libur";

export type DayKey =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export interface DaySchedule {
  in: string;
  out: string;
}

export type WeeklySchedule = Partial<Record<DayKey, DaySchedule | null>>;

export const DAY_KEYS: DayKey[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export interface PunchInput {
  idNumber: string;
  name: string;
  date: string;
  time: string;
  punch?: number;
  verify?: number;
  uid?: number;
}

export interface ReferenceDailyRow {
  date: string;
  id_number: string;
  name: string;
  in_time: string | null;
  out_time: string | null;
  late_minutes: number | null;
  early_minutes: number | null;
  is_workday: boolean;
  punches: number;
  status: DailyStatus;
}

export interface ReferenceSummary {
  rows: number;
  present: number;
  late: number;
  early: number;
  incomplete: number;
  late_minutes: number;
  early_minutes: number;
  status_counts: Record<string, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function timeToSeconds(time: string): number {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

export function dayKey(date: string): DayKey {
  return DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

export function isSunday(date: string): boolean {
  return dayKey(date) === "SUNDAY";
}

// Workday = a day with a valid IN/OUT pair. Never hardcode Monday-Saturday.
export function scheduleFor(date: string, schedule: WeeklySchedule): DaySchedule | null {
  const day = schedule[dayKey(date)];
  if (!day || !day.in || !day.out) return null;
  if (timeToSeconds(day.out) <= timeToSeconds(day.in)) return null;
  return day;
}

export function buildDaily(
  punches: PunchInput[],
  schedule: WeeklySchedule,
  splitTime = SPLIT_TIME,
): ReferenceDailyRow[] {
  const groups = new Map<string, PunchInput[]>();
  for (const punch of punches) {
    const key = `${punch.date}|${punch.idNumber}`;
    const list = groups.get(key) ?? [];
    list.push(punch);
    groups.set(key, list);
  }

  const rows: ReferenceDailyRow[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => cmp(a.time, b.time));
    const first = sorted[0]!;
    const date = first.date;
    const daySchedule = scheduleFor(date, schedule);
    const isWorkday = daySchedule !== null;
    const inTime = sorted.find((p) => p.time < splitTime)?.time ?? null;
    const outTime = [...sorted].reverse().find((p) => p.time >= splitTime)?.time ?? null;

    let lateMinutes: number | null;
    let earlyMinutes: number | null;
    if (!daySchedule) {
      lateMinutes = 0;
      earlyMinutes = 0;
    } else {
      lateMinutes =
        inTime === null
          ? null
          : Math.max(0, Math.floor((timeToSeconds(inTime) - timeToSeconds(daySchedule.in)) / 60));
      earlyMinutes =
        outTime === null
          ? null
          : Math.max(0, Math.floor((timeToSeconds(daySchedule.out) - timeToSeconds(outTime)) / 60));
    }

    let status: DailyStatus;
    if (!isWorkday) status = "libur";
    else if (inTime === null) status = "tanpa_masuk";
    else if (outTime === null) status = "belum_pulang";
    else if ((lateMinutes ?? 0) > 0) status = "telat";
    else if ((earlyMinutes ?? 0) > 0) status = "pulang_cepat";
    else status = "lengkap";

    rows.push({
      date,
      id_number: first.idNumber,
      name: first.name,
      in_time: inTime,
      out_time: outTime,
      late_minutes: lateMinutes,
      early_minutes: earlyMinutes,
      is_workday: isWorkday,
      punches: sorted.length,
      status,
    });
  }

  return rows.sort(
    (a, b) => cmp(a.date, b.date) || cmp(a.id_number, b.id_number) || cmp(a.name, b.name),
  );
}

export function summarizeDaily(rows: ReferenceDailyRow[]): ReferenceSummary {
  const statusCounts: Record<string, number> = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  return {
    rows: rows.length,
    present: rows.filter((r) => r.punches > 0).length,
    late: rows.filter((r) => (r.late_minutes ?? 0) > 0).length,
    early: rows.filter((r) => (r.early_minutes ?? 0) > 0).length,
    incomplete: rows.filter((r) => r.in_time === null || r.out_time === null).length,
    late_minutes: rows.reduce((sum, r) => sum + (r.late_minutes ?? 0), 0),
    early_minutes: rows.reduce((sum, r) => sum + (r.early_minutes ?? 0), 0),
    status_counts: statusCounts,
  };
}

export function byDateThenName(a: ReferenceDailyRow, b: ReferenceDailyRow): number {
  return cmp(a.date, b.date) || cmp(a.name, b.name) || cmp(a.id_number, b.id_number);
}

export function toApiDaily(row: ReferenceDailyRow) {
  return {
    date: row.date,
    id_number: row.id_number,
    name: row.name,
    in_time: row.in_time,
    out_time: row.out_time,
    late_minutes: row.late_minutes,
    early_minutes: row.early_minutes,
    status: row.status,
    punches: row.punches,
  };
}
