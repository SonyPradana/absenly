import { describe, expect, test } from "bun:test";
import type { DailyRow } from "../src/recap.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import {
  elapsedWorkdays,
  previousMonth,
  shareMonthMetrics,
  stateFor,
  workdayCutoff,
} from "../src/share-report.ts";

const CALENDAR: ScheduleCalendar = {
  version: 1,
  base: {
    MONDAY: { in: "08:00", out: "16:00" },
    TUESDAY: { in: "08:00", out: "16:00" },
    WEDNESDAY: { in: "08:00", out: "16:00" },
    THURSDAY: { in: "08:00", out: "16:00" },
    FRIDAY: { in: "08:00", out: "16:00" },
    SATURDAY: null,
    SUNDAY: null,
  },
  overrides: [{ id: "holiday", from: "2026-10-05", to: "2026-10-05", priority: 1, schedule: null }],
};

function row(date: string, lateMinutes: number, earlyMinutes: number | null = 0): DailyRow {
  return {
    date,
    idNumber: "992",
    name: "Dummy Siti",
    inTime: lateMinutes > 0 ? "08:10:00" : "07:55:00",
    outTime: "16:05:00",
    inVerify: 15,
    outVerify: 15,
    lateSeconds: lateMinutes * 60,
    earlySeconds: earlyMinutes === null ? null : earlyMinutes * 60,
    lateMinutes,
    earlyMinutes,
    isWorkday: true,
    isPiket: false,
    punches: 2,
    status:
      lateMinutes > 0
        ? "telat"
        : earlyMinutes !== null && earlyMinutes > 0
          ? "pulang_cepat"
          : "lengkap",
  };
}

describe("share report", () => {
  test("maps late minutes to states", () => {
    expect([0, 29, 30, 59, 60, 89, 90, 200].map(stateFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  test("walks months, workdays, and cutoffs", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
    expect(elapsedWorkdays(CALENDAR, "2026-10", "2026-10-07")).toBe(4);
    expect(workdayCutoff(CALENDAR, "2026-10", 3)).toBe("2026-10-06");
    expect(workdayCutoff(CALENDAR, "2026-10", 0)).toBeNull();
  });

  test("skips a defined holiday but breaks the streak on absence", () => {
    const full = shareMonthMetrics(
      [row("2026-10-01", 10), row("2026-10-02", 10), row("2026-10-06", 10), row("2026-10-07", 10)],
      CALENDAR,
      "2026-10",
      "2026-10-07",
    );
    expect(full).toMatchObject({
      workdays: 4,
      presentDays: 4,
      lateDays: 4,
      onTimeDays: 0,
      lateRate: 1,
      onTimeRate: 0,
      lateMinutes: 40,
      state: 1,
    });
    expect(full.longestLateStreak).toEqual({
      days: 4,
      from: "2026-10-01",
      to: "2026-10-07",
    });

    const absent = shareMonthMetrics(
      [row("2026-10-01", 10), row("2026-10-02", 10), row("2026-10-07", 10)],
      CALENDAR,
      "2026-10",
      "2026-10-07",
    );
    expect(absent.presentDays).toBe(3);
    expect(absent.longestLateStreak).toEqual({
      days: 2,
      from: "2026-10-01",
      to: "2026-10-02",
    });
  });

  test("counts early leave separately", () => {
    const metrics = shareMonthMetrics(
      [row("2026-10-01", 0, 30), row("2026-10-02", 0, 0)],
      CALENDAR,
      "2026-10",
      "2026-10-02",
    );
    expect(metrics).toMatchObject({
      presentDays: 2,
      lateDays: 0,
      onTimeDays: 2,
      onTimeRate: 1,
      earlyDays: 1,
      earlyMinutes: 30,
      state: 0,
    });
  });

  test("leaves both rates undefined without attendance", () => {
    const metrics = shareMonthMetrics([], CALENDAR, "2026-10", "2026-10-07");
    expect(metrics).toMatchObject({
      presentDays: 0,
      lateDays: 0,
      onTimeDays: 0,
      lateRate: null,
      onTimeRate: null,
    });
  });

  test("derives punctuality from the same present-day denominator", () => {
    const metrics = shareMonthMetrics(
      [row("2026-10-01", 10), row("2026-10-02", 0)],
      CALENDAR,
      "2026-10",
      "2026-10-02",
    );
    expect(metrics).toMatchObject({
      presentDays: 2,
      lateDays: 1,
      onTimeDays: 1,
      lateRate: 0.5,
      onTimeRate: 0.5,
    });
  });
});
