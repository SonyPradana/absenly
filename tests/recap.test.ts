import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDaily, sortByDateThenName, summarizeDaily, type DailyRow } from "../src/recap.ts";
import { DAY_KEYS, parseWeeklySchedule, type ScheduleCalendar } from "../src/schedule.ts";
import { loadEdge, loadWorkExceptions } from "./support/fixtures.ts";

function calendarFromWeekly(
  weekly: Record<string, { in: string; out: string } | null>,
): ScheduleCalendar {
  const filled: Record<string, { in: string; out: string } | null> = {};
  for (const day of DAY_KEYS) filled[day] = weekly[day] ?? null;
  return { version: 1, base: parseWeeklySchedule(filled), overrides: [] };
}

function toFixtureRow(row: DailyRow) {
  return {
    date: row.date,
    id_number: row.idNumber,
    name: row.name,
    in_time: row.inTime,
    out_time: row.outTime,
    late_minutes: row.lateMinutes,
    early_minutes: row.earlyMinutes,
    is_workday: row.isWorkday,
    punches: row.punches,
    status: row.status,
  };
}

const WORK_WEEK: Record<string, { in: string; out: string } | null> = {
  MONDAY: { in: "07:00", out: "16:00" },
  TUESDAY: { in: "07:00", out: "16:00" },
  WEDNESDAY: { in: "07:00", out: "16:00" },
  THURSDAY: { in: "07:00", out: "16:00" },
  FRIDAY: { in: "07:00", out: "16:00" },
  SATURDAY: { in: "07:00", out: "12:00" },
  SUNDAY: null,
};

function punch(idNumber: string, date: string, time: string, name = "Dummy") {
  return { idNumber, name, date, time };
}

function daily(
  overrides: Partial<DailyRow> & Pick<DailyRow, "date" | "idNumber" | "name">,
): DailyRow {
  return {
    inTime: null,
    outTime: null,
    inVerify: null,
    outVerify: null,
    lateSeconds: null,
    earlySeconds: null,
    lateMinutes: null,
    earlyMinutes: null,
    isWorkday: true,
    isPiket: false,
    punches: 1,
    status: "tanpa_masuk",
    ...overrides,
  };
}

describe("recap daily rules", () => {
  const edge = loadEdge();
  const calendar = calendarFromWeekly(edge.schedule);
  const rows = buildDaily(
    edge.attendance.map((row) => ({
      idNumber: row.idNumber,
      name: row.name,
      date: row.date,
      time: row.time,
    })),
    calendar,
  );

  test("edge fixture matches the golden daily rows", () => {
    expect(rows.map(toFixtureRow)).toEqual(edge.expected_daily);
  });

  test("edge summary matches the golden summary", () => {
    expect(summarizeDaily(rows)).toEqual({
      rows: edge.expected_summary.rows,
      present: edge.expected_summary.present,
      late: edge.expected_summary.late,
      early: edge.expected_summary.early,
      incomplete: edge.expected_summary.incomplete,
      lateMinutes: edge.expected_summary.late_minutes,
      earlyMinutes: edge.expected_summary.early_minutes,
      statusCounts: edge.expected_summary.status_counts,
    });
  });

  test("10:00 boundary: 09:59:59 is IN, 10:00:00 is OUT", () => {
    const [row] = buildDaily(
      [punch("001", "2026-10-05", "09:59:59"), punch("001", "2026-10-05", "10:00:00")],
      calendarFromWeekly(WORK_WEEK),
    );
    expect(row?.inTime).toBe("09:59:59");
    expect(row?.outTime).toBe("10:00:00");
    expect(row?.lateMinutes).toBe(179);
    expect(row?.earlyMinutes).toBe(360);
    expect(row?.status).toBe("telat");
  });

  test("late by one minute and early by one minute", () => {
    const [late] = buildDaily(
      [punch("001", "2026-10-05", "07:01"), punch("001", "2026-10-05", "16:00")],
      calendarFromWeekly(WORK_WEEK),
    );
    expect(late?.lateMinutes).toBe(1);
    expect(late?.earlyMinutes).toBe(0);
    expect(late?.status).toBe("telat");

    const [early] = buildDaily(
      [punch("001", "2026-10-05", "07:00"), punch("001", "2026-10-05", "15:59")],
      calendarFromWeekly(WORK_WEEK),
    );
    expect(early?.lateMinutes).toBe(0);
    expect(early?.earlyMinutes).toBe(1);
    expect(early?.status).toBe("pulang_cepat");
  });

  test("earliest and latest punch win, extra punches are counted", () => {
    const times = ["08:00", "06:30", "12:00", "18:00", "10:00", "09:00", "15:00", "11:00", "07:00"];
    const [row] = buildDaily(
      times.map((time) => punch("001", "2026-10-05", time)),
      calendarFromWeekly(WORK_WEEK),
    );
    expect(row?.inTime).toBe("06:30");
    expect(row?.outTime).toBe("18:00");
    expect(row?.punches).toBe(9);
    expect(row?.status).toBe("lengkap");
  });

  test("missing IN and missing OUT are reported separately", () => {
    const [noIn] = buildDaily([punch("001", "2026-10-05", "12:00")], calendarFromWeekly(WORK_WEEK));
    expect(noIn?.inTime).toBeNull();
    expect(noIn?.outTime).toBe("12:00");
    expect(noIn?.lateMinutes).toBeNull();
    expect(noIn?.status).toBe("tanpa_masuk");

    const [noOut] = buildDaily(
      [punch("001", "2026-10-05", "07:45")],
      calendarFromWeekly(WORK_WEEK),
    );
    expect(noOut?.inTime).toBe("07:45");
    expect(noOut?.outTime).toBeNull();
    expect(noOut?.earlyMinutes).toBeNull();
    expect(noOut?.status).toBe("belum_pulang");
  });

  test("a day off is libur and never late", () => {
    const [sunday] = buildDaily(
      [punch("001", "2026-10-04", "07:00"), punch("001", "2026-10-04", "12:00")],
      calendarFromWeekly(WORK_WEEK),
    );
    expect(sunday?.isWorkday).toBe(false);
    expect(sunday?.status).toBe("libur");
    expect(sunday?.lateMinutes).toBe(0);
    expect(sunday?.earlyMinutes).toBe(0);
  });

  test("a date-range override wins over the base week", () => {
    const base = calendarFromWeekly(WORK_WEEK);
    const withHoliday: ScheduleCalendar = {
      version: 1,
      base: base.base,
      overrides: [
        {
          id: "ramadan",
          from: "2026-10-05",
          to: "2026-10-07",
          priority: 10,
          schedule: null,
        },
      ],
    };

    const [holiday] = buildDaily(
      [punch("001", "2026-10-05", "07:00"), punch("001", "2026-10-05", "16:00")],
      withHoliday,
    );
    expect(holiday?.isWorkday).toBe(false);
    expect(holiday?.status).toBe("libur");
    expect(holiday?.lateMinutes).toBe(0);

    const [normal] = buildDaily(
      [punch("001", "2026-10-08", "07:00"), punch("001", "2026-10-08", "16:00")],
      withHoliday,
    );
    expect(normal?.isWorkday).toBe(true);
    expect(normal?.status).toBe("lengkap");
  });

  test("the higher priority override wins on an overlapping range", () => {
    const base = calendarFromWeekly(WORK_WEEK);
    const lateShift: Record<string, { in: string; out: string } | null> = {
      ...WORK_WEEK,
      MONDAY: { in: "09:00", out: "17:00" },
    };
    const shifted: ScheduleCalendar = {
      version: 1,
      base: base.base,
      overrides: [
        {
          id: "low",
          from: "2026-10-01",
          to: "2026-10-31",
          priority: 1,
          schedule: parseWeeklySchedule(
            Object.fromEntries(DAY_KEYS.map((day) => [day, WORK_WEEK[day] ?? null])),
          ),
        },
        {
          id: "high",
          from: "2026-10-05",
          to: "2026-10-06",
          priority: 5,
          schedule: parseWeeklySchedule(
            Object.fromEntries(DAY_KEYS.map((day) => [day, lateShift[day] ?? null])),
          ),
        },
      ],
    };

    // Inside the high-priority range the 09:00 shift applies: not late.
    const [inside] = buildDaily(
      [punch("001", "2026-10-05", "09:00"), punch("001", "2026-10-05", "17:00")],
      shifted,
    );
    expect(inside?.lateMinutes).toBe(0);
    expect(inside?.earlyMinutes).toBe(0);

    // Outside it only the low-priority override applies: still 07:00, so 120 min late.
    const [outside] = buildDaily(
      [punch("001", "2026-10-12", "09:00"), punch("001", "2026-10-12", "17:00")],
      shifted,
    );
    expect(outside?.lateMinutes).toBe(120);
  });

  test("work_exceptions do not change the normal recap", () => {
    const fixture = loadWorkExceptions();
    const rows = buildDaily(
      fixture.recap_unaffected.attendance.map((row) => ({
        idNumber: row.idNumber,
        name: row.name,
        date: row.date,
        time: row.time,
      })),
      calendarFromWeekly(fixture.recap_unaffected.schedule),
    );
    expect(rows.map(toFixtureRow)).toEqual(fixture.recap_unaffected.expected_daily);
  });

  test("output order is date, then name, then id_number", () => {
    const sorted = sortByDateThenName([
      daily({ date: "2026-10-05", idNumber: "002", name: "Budi" }),
      daily({ date: "2026-10-05", idNumber: "001", name: "Budi" }),
      daily({ date: "2026-10-04", idNumber: "003", name: "Andi" }),
    ]);
    expect(sorted.map((row) => `${row.date}|${row.name}|${row.idNumber}`)).toEqual([
      "2026-10-04|Andi|003",
      "2026-10-05|Budi|001",
      "2026-10-05|Budi|002",
    ]);
  });

  test("seconds are exact and verify comes from the chosen punch", () => {
    const calendar = calendarFromWeekly(WORK_WEEK);
    const [row] = buildDaily(
      [
        { idNumber: "001", name: "Budi", date: "2026-10-05", time: "07:00:30", verify: 1 },
        { idNumber: "001", name: "Budi", date: "2026-10-05", time: "15:58:59", verify: 15 },
      ],
      calendar,
    );
    expect(row?.lateSeconds).toBe(30);
    expect(row?.lateMinutes).toBe(0);
    expect(row?.earlySeconds).toBe(61);
    expect(row?.earlyMinutes).toBe(1);
    expect(row?.inVerify).toBe(1);
    expect(row?.outVerify).toBe(15);
  });

  test("recap stays pure: no db, http, or device imports", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "recap.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/db\.ts"/);
    expect(source).not.toMatch(/from "\.\/zk\.ts"/);
    expect(source).not.toMatch(/from "\.\/device\.ts"/);
    expect(source).not.toMatch(/from "\.\/sync\.ts"/);
    expect(source).not.toMatch(/bun:sqlite/);
  });
});
