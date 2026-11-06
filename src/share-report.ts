// Pure monthly metrics for the public individual share page.
// Workdays come from the calendar; a defined holiday is skipped, an absence breaks a streak.

import { monthRange } from "./period.ts";
import type { DailyRow } from "./recap.ts";
import { resolveSchedule, type ScheduleCalendar } from "./schedule.ts";

export type ShareState = 0 | 1 | 2 | 3;

export interface ShareStreak {
  days: number;
  from: string;
  to: string;
}

export interface ShareMonthMetrics {
  workdays: number;
  presentDays: number;
  lateDays: number;
  onTimeDays: number;
  lateRate: number | null;
  onTimeRate: number | null;
  lateMinutes: number;
  earlyDays: number;
  earlyMinutes: number;
  longestLateStreak: ShareStreak | null;
  state: ShareState;
}

function datesInMonth(month: string): string[] {
  const range = monthRange(month);
  const last = Number(range.to.slice(8));
  return Array.from(
    { length: last },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

export function previousMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, value! - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function elapsedWorkdays(
  calendar: ScheduleCalendar,
  month: string,
  through: string,
): number {
  return datesInMonth(month).filter(
    (date) => date <= through && resolveSchedule(calendar, date) !== null,
  ).length;
}

// Date of the Nth workday in the month, or null when there is no such workday.
export function workdayCutoff(
  calendar: ScheduleCalendar,
  month: string,
  count: number,
): string | null {
  if (count <= 0) return null;
  let seen = 0;
  for (const date of datesInMonth(month)) {
    if (resolveSchedule(calendar, date) === null) continue;
    seen += 1;
    if (seen >= count) return date;
  }
  return null;
}

export function stateFor(lateMinutes: number): ShareState {
  if (lateMinutes >= 90) return 3;
  if (lateMinutes >= 60) return 2;
  if (lateMinutes >= 30) return 1;
  return 0;
}

export function shareMonthMetrics(
  rows: DailyRow[],
  calendar: ScheduleCalendar,
  month: string,
  through: string,
): ShareMonthMetrics {
  // A piket day counts as present even when there is no punch at all.
  const present = rows.filter((row) => row.punches > 0 || row.isPiket);
  const late = present.filter((row) => (row.lateMinutes ?? 0) > 0);
  const onTime = present.filter((row) => (row.lateMinutes ?? 0) === 0);
  const early = present.filter((row) => (row.earlyMinutes ?? 0) > 0);
  const lateMinutes = late.reduce((sum, row) => sum + (row.lateMinutes ?? 0), 0);
  const byDate = new Map(present.map((row) => [row.date, row]));

  let run = 0;
  let runStart: string | null = null;
  let longest: ShareStreak | null = null;
  for (const date of datesInMonth(month)) {
    if (date > through) break;
    if (resolveSchedule(calendar, date) === null) continue;
    const row = byDate.get(date);
    if ((row?.lateMinutes ?? 0) > 0) {
      if (run === 0) runStart = date;
      run += 1;
      if (longest === null || run > longest.days) {
        longest = { days: run, from: runStart!, to: date };
      }
    } else {
      run = 0;
      runStart = null;
    }
  }

  return {
    workdays: elapsedWorkdays(calendar, month, through),
    presentDays: present.length,
    lateDays: late.length,
    onTimeDays: onTime.length,
    lateRate: present.length === 0 ? null : late.length / present.length,
    onTimeRate: present.length === 0 ? null : onTime.length / present.length,
    lateMinutes,
    earlyDays: early.length,
    earlyMinutes: early.reduce((sum, row) => sum + (row.earlyMinutes ?? 0), 0),
    longestLateStreak: longest,
    state: stateFor(lateMinutes),
  };
}
