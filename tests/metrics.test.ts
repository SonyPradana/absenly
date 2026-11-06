import { describe, expect, test } from "bun:test";
import {
  chartScale,
  expiredOverrides,
  lateRanking,
  lateStreakRanking,
  monthMetrics,
  scheduleImpact,
  stableRanking,
  todayMetrics,
  withRankMovement,
  workdayCutoff,
} from "../src/web/assets/lib/metrics.js";

const EMPLOYEES = [
  { id_number: "001", name: "Ani", active: true },
  { id_number: "002", name: "Budi", active: true },
  { id_number: "003", name: "Cici", active: false },
];

const TODAY = "2026-10-07";
const MONTH = "2026-10";

interface Shift {
  in: string;
  out: string;
}

type Week = Record<
  "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY",
  Shift | null
>;

function monthMap(): Record<string, Shift | null> {
  const result: Record<string, Shift> = {};
  for (let day = 1; day <= 31; day++) {
    result[`2026-10-${String(day).padStart(2, "0")}`] = { in: "08:00", out: "16:00" };
  }
  return result;
}

const ROWS = [
  {
    date: TODAY,
    id_number: "001",
    name: "Ani",
    in_time: "08:05:00",
    out_time: null,
    late_minutes: 5,
    early_minutes: null,
    status: "telat",
    punches: 1,
  },
  {
    date: TODAY,
    id_number: "002",
    name: "Budi",
    in_time: "07:55:00",
    out_time: "16:01:00",
    late_minutes: 0,
    early_minutes: 0,
    status: "lengkap",
    punches: 2,
  },
  {
    date: TODAY,
    id_number: "003",
    name: "Cici",
    in_time: "07:50:00",
    out_time: null,
    late_minutes: 0,
    early_minutes: null,
    status: "hanya_in",
    punches: 1,
  },
];

describe("dashboard metrics", () => {
  test("today excludes inactive employees from active denominators", () => {
    const metrics = todayMetrics(ROWS, EMPLOYEES, TODAY, true);
    expect(metrics).toMatchObject({
      active: 2,
      hadir: 2,
      belumPulang: 1,
      sudahPulang: 1,
      belumAbsen: 0,
      late: 1,
      punctualityPresent: 0.5,
      punctualityActive: 0.5,
    });
  });

  test("month metrics use elapsed workdays and late occurrences", () => {
    const metrics = monthMetrics(ROWS, EMPLOYEES, monthMap(), MONTH, TODAY);
    expect(metrics).toMatchObject({
      workdaysElapsed: 7,
      workdaysTotal: 31,
      workdaysRemaining: 24,
      active: 2,
      presentEmployeeDays: 2,
      uniqueLate: 1,
      lateEmployeeDays: 1,
      lateMinutes: 5,
      avgLatePerLateDay: 5,
      attendanceRate: 2 / 14,
      worstDay: { date: TODAY, minutes: 5, lateDays: 1 },
    });
  });

  test("rankings prefer stable attendance, then late frequency", () => {
    const stable = stableRanking(ROWS, EMPLOYEES, MONTH);
    expect(stable.map((item) => item.id)).toEqual(["002"]);
    expect(stable[0]).toMatchObject({ days: 1, avgInSeconds: 28500 });

    const late = lateRanking(ROWS, EMPLOYEES, MONTH);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ id: "001", lateDays: 1, minutes: 5, worst: 5 });
  });

  test("rank movement compares positions and marks new entries", () => {
    const previous = [
      { id: "002", name: "Budi" },
      { id: "001", name: "Ani" },
      { id: "004", name: "Dedi" },
    ];
    const current = [
      { id: "001", name: "Ani" },
      { id: "002", name: "Budi" },
      { id: "003", name: "Cici" },
    ];
    expect(
      withRankMovement(current, previous).map((item: { id: string; movement: number | null }) => [
        item.id,
        item.movement,
      ]),
    ).toEqual([
      ["001", 1],
      ["002", -1],
      ["003", null],
    ]);
  });

  test("workday cutoff uses the configured weekly calendar", () => {
    expect(workdayCutoff({ version: 1, base: monthMapBase(), overrides: [] }, "2026-10", 3)).toBe(
      "2026-10-05",
    );
  });

  test("late streak uses the longest run, skips defined holidays, and breaks on absence", () => {
    const map = monthMap();
    map["2026-10-03"] = null;
    const rows = [
      { date: "2026-10-01", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-02", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-04", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-05", id_number: "001", name: "Ani", late_minutes: 0 },
      { date: "2026-10-06", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-07", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-01", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-02", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-04", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-05", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-06", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-07", id_number: "002", name: "Budi", late_minutes: 5 },
      { date: "2026-10-01", id_number: "003", name: "Cici", late_minutes: 5 },
    ];

    const ranking = lateStreakRanking(rows, EMPLOYEES, map, MONTH, TODAY);
    expect(ranking.map((item) => item.id)).toEqual(["002", "001"]);
    expect(ranking[0]).toMatchObject({ days: 6, from: "2026-10-01", to: "2026-10-07" });
    expect(ranking[1]).toMatchObject({ days: 3, from: "2026-10-01", to: "2026-10-04" });
  });

  test("late streak resets on a missing workday", () => {
    const rows = [
      { date: "2026-10-01", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-02", id_number: "001", name: "Ani", late_minutes: 5 },
      { date: "2026-10-04", id_number: "001", name: "Ani", late_minutes: 5 },
    ];

    const ranking = lateStreakRanking(rows, EMPLOYEES, monthMap(), MONTH, TODAY);
    expect(ranking[0]).toMatchObject({
      days: 2,
      from: "2026-10-01",
      to: "2026-10-02",
    });
  });

  test("schedule impact only reports resolved changes", () => {
    const before = {
      version: 1,
      base: monthMapBase(),
      overrides: [],
    };
    const after = structuredClone(before);
    after.base.SATURDAY = { in: "08:00", out: "12:00" };
    const impact = scheduleImpact(before, after, TODAY);
    expect(impact.added).toBeGreaterThan(0);
    expect(impact.removed).toBe(0);
    expect(impact.changed).toBe(0);

    const calendar = {
      version: 1,
      base: monthMapBase(),
      overrides: [
        {
          id: "old",
          from: "2026-01-01",
          to: "2026-01-02",
          priority: 0,
          schedule: null,
        },
      ],
    };
    expect(expiredOverrides(calendar, TODAY).map((item: { id: string }) => item.id)).toEqual([
      "old",
    ]);
  });
});

function monthMapBase(): Week {
  return {
    MONDAY: { in: "08:00", out: "16:00" },
    TUESDAY: { in: "08:00", out: "16:00" },
    WEDNESDAY: { in: "08:00", out: "16:00" },
    THURSDAY: { in: "08:00", out: "16:00" },
    FRIDAY: { in: "08:00", out: "16:00" },
    SATURDAY: null,
    SUNDAY: null,
  };
}

describe("chart scaling", () => {
  test("an ordinary spread stays linear so the axis is easy to read", () => {
    // 20..120 is a 6x spread: still linear.
    const scale = chartScale([20, 40, 80, 0, 120, 60, 30]);
    expect(scale.mode).toBe("linear");
    expect(scale.max).toBe(120);
    expect(scale.heightOf(120)).toBeCloseTo(1);
    expect(scale.heightOf(60)).toBeCloseTo(0.5);
    expect(scale.heightOf(0)).toBe(0);
  });

  test("near-identical high values keep their real proportions while linear", () => {
    // 182/190 differ by ~4%: still linear because the spread is small.
    const scale = chartScale([182, 185, 190, 0, 0, 0, 0]);
    expect(scale.mode).toBe("linear");
    expect(scale.heightOf(185)).toBeCloseTo(185 / 190);
  });

  test("an extreme spread switches to log so small values stay visible", () => {
    // 5 vs 190 is a 38x spread.
    const scale = chartScale([190, 185, 182, 5, 0, 0, 0]);
    expect(scale.mode).toBe("log");
    expect(scale.heightOf(190)).toBeCloseTo(1);
    // Linear would put 5 at 2.6%; log lifts it well above that.
    expect(scale.heightOf(5)).toBeGreaterThan(0.2);
    expect(scale.heightOf(5)).toBeLessThan(scale.heightOf(182));
  });

  test("zero stays at zero and heights stay in range", () => {
    const scale = chartScale([0, 0, 500, 3, 0, 0, 0]);
    expect(scale.heightOf(0)).toBe(0);
    for (const value of [-10, 0, 3, 250, 500, 9999]) {
      const height = scale.heightOf(value);
      expect(height).toBeGreaterThanOrEqual(0);
      expect(height).toBeLessThanOrEqual(1);
    }
  });

  test("a single value or all zeros stays linear", () => {
    expect(chartScale([0, 0, 0, 0, 0, 0, 0]).mode).toBe("linear");
    expect(chartScale([0, 0, 0, 0, 0, 0, 0]).heightOf(0)).toBe(0);
    expect(chartScale([0, 7, 0, 0, 0, 0, 0]).mode).toBe("linear");
    expect(chartScale([0, 7, 0, 0, 0, 0, 0]).heightOf(7)).toBe(1);
  });

  test("heights increase with the value", () => {
    const scale = chartScale([190, 185, 182, 5, 0, 0, 0]);
    expect(scale.heightOf(5)).toBeLessThan(scale.heightOf(182));
    expect(scale.heightOf(182)).toBeLessThan(scale.heightOf(185));
    expect(scale.heightOf(185)).toBeLessThan(scale.heightOf(190));
  });
});
