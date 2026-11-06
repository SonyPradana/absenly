// Daily recap rules. Pure: no DB, no HTTP, no device.
//
// IN = the earliest punch before 10:00, OUT = the latest punch at/after 10:00.
// The device punch flag (0/1) is unreliable, so the stored status is never trusted here.
// Late = IN after the resolved day's "in"; early = OUT before the resolved day's "out".

import { resolveSchedule, type ScheduleCalendar } from "./schedule.ts";
import { SPLIT_TIME } from "./time.ts";

export type DailyStatus =
  | "lengkap"
  | "telat"
  | "pulang_cepat"
  | "tanpa_masuk"
  | "belum_pulang"
  | "piket"
  | "libur";

export interface Punch {
  idNumber: string;
  name: string;
  date: string;
  time: string;
  verify?: number;
}

export interface DailyRow {
  date: string;
  idNumber: string;
  name: string;
  inTime: string | null;
  outTime: string | null;
  inVerify: number | null;
  outVerify: number | null;
  lateSeconds: number | null;
  earlySeconds: number | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  isWorkday: boolean;
  // True on the date a work exception (piket/overtime) starts: the day counts
  // as present even with no punch, and sanctions are waived.
  isPiket: boolean;
  punches: number;
  status: DailyStatus;
}

export type PresenceFilter = "all" | "complete" | "missing_in" | "missing_out";
export type PunctualityFilter = "all" | "late" | "ontime";

export const PRESENCE_FILTERS: PresenceFilter[] = ["all", "complete", "missing_in", "missing_out"];
export const PUNCTUALITY_FILTERS: PunctualityFilter[] = ["all", "late", "ontime"];

export interface RecapSummary {
  rows: number;
  present: number;
  late: number;
  early: number;
  incomplete: number;
  lateMinutes: number;
  earlyMinutes: number;
  statusCounts: Record<string, number>;
}

export function timeToSeconds(time: string): number {
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dailyStatus(
  isWorkday: boolean,
  inTime: string | null,
  outTime: string | null,
  lateMinutes: number | null,
  earlyMinutes: number | null,
  isPiket: boolean,
): DailyStatus {
  // A piket day is present and sanction-free whether or not a punch exists.
  if (isPiket) return "piket";
  if (!isWorkday) return "libur";
  if (inTime === null) return "tanpa_masuk";
  if (outTime === null) return "belum_pulang";
  if ((lateMinutes ?? 0) > 0) return "telat";
  if ((earlyMinutes ?? 0) > 0) return "pulang_cepat";
  return "lengkap";
}

export function buildDaily(
  punches: Punch[],
  calendar: ScheduleCalendar,
  splitTime: string = SPLIT_TIME,
): DailyRow[] {
  const groups = new Map<string, Punch[]>();
  for (const punch of punches) {
    const key = `${punch.date}|${punch.idNumber}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [punch]);
    else list.push(punch);
  }

  const rows: DailyRow[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => compare(a.time, b.time));
    const first = sorted[0]!;
    const daySchedule = resolveSchedule(calendar, first.date);
    const isWorkday = daySchedule !== null;
    const inPunch = sorted.find((punch) => punch.time < splitTime);
    const outPunch = [...sorted].reverse().find((punch) => punch.time >= splitTime);
    const inTime = inPunch?.time ?? null;
    const outTime = outPunch?.time ?? null;

    // Seconds are the source of truth; minutes stay for the API/JSON contract.
    let lateSeconds: number | null = null;
    let earlySeconds: number | null = null;
    if (daySchedule === null) {
      lateSeconds = 0;
      earlySeconds = 0;
    } else {
      if (inTime !== null) {
        lateSeconds = Math.max(0, timeToSeconds(inTime) - timeToSeconds(daySchedule.in));
      }
      if (outTime !== null) {
        earlySeconds = Math.max(0, timeToSeconds(daySchedule.out) - timeToSeconds(outTime));
      }
    }
    const lateMinutes = lateSeconds === null ? null : Math.floor(lateSeconds / 60);
    const earlyMinutes = earlySeconds === null ? null : Math.floor(earlySeconds / 60);

    rows.push({
      date: first.date,
      idNumber: first.idNumber,
      name: first.name,
      inTime,
      outTime,
      inVerify: inPunch?.verify ?? null,
      outVerify: outPunch?.verify ?? null,
      lateSeconds,
      earlySeconds,
      lateMinutes,
      earlyMinutes,
      isWorkday,
      isPiket: false,
      punches: sorted.length,
      status: dailyStatus(isWorkday, inTime, outTime, lateMinutes, earlyMinutes, false),
    });
  }

  return rows.sort(
    (a, b) => compare(a.date, b.date) || compare(a.idNumber, b.idNumber) || compare(a.name, b.name),
  );
}

// Output order for the API and the CLI: date, then name, then id_number.
export function sortByDateThenName(rows: DailyRow[]): DailyRow[] {
  return [...rows].sort(
    (a, b) => compare(a.date, b.date) || compare(a.name, b.name) || compare(a.idNumber, b.idNumber),
  );
}

export function matchesPresence(row: DailyRow, presence: PresenceFilter): boolean {
  // A piket day counts as present even without a punch.
  const present = row.inTime !== null || row.isPiket;
  if (presence === "complete") return present && row.outTime !== null;
  if (presence === "missing_in") return !present;
  if (presence === "missing_out") return present && row.outTime === null;
  return true;
}

export function matchesPunctuality(row: DailyRow, punctuality: PunctualityFilter): boolean {
  if (punctuality === "late") return (row.lateMinutes ?? 0) > 0;
  // A missing IN is neither late nor on time.
  if (punctuality === "ontime") return row.lateMinutes !== null && row.lateMinutes <= 0;
  return true;
}

export function summarizeDaily(rows: DailyRow[]): RecapSummary {
  const statusCounts: Record<string, number> = {};
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }

  return {
    rows: rows.length,
    present: rows.filter((row) => row.punches > 0 || row.isPiket).length,
    late: rows.filter((row) => (row.lateMinutes ?? 0) > 0).length,
    early: rows.filter((row) => (row.earlyMinutes ?? 0) > 0).length,
    incomplete: rows.filter((row) => (row.inTime === null && !row.isPiket) || row.outTime === null)
      .length,
    lateMinutes: rows.reduce((sum, row) => sum + (row.lateMinutes ?? 0), 0),
    earlyMinutes: rows.reduce((sum, row) => sum + (row.earlyMinutes ?? 0), 0),
    statusCounts,
  };
}
