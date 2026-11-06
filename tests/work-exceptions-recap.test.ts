// Piket/overtime (work_exceptions) applied to the daily recap. Pure, no DB.
import { describe, expect, test } from "bun:test";
import { buildDaily, summarizeDaily, matchesPresence } from "../src/recap.ts";
import { applyWorkExceptions, type WorkExceptionSpan } from "../src/work-exceptions.ts";
import { parseScheduleCalendar, type ScheduleCalendar } from "../src/schedule.ts";
import { isDue } from "../src/auto-sync.ts";

const calendar: ScheduleCalendar = parseScheduleCalendar({
  version: 1,
  base: {
    SUNDAY: null,
    MONDAY: { in: "07:00", out: "16:00" },
    TUESDAY: { in: "07:00", out: "16:00" },
    WEDNESDAY: { in: "07:00", out: "16:00" },
    THURSDAY: { in: "07:00", out: "16:00" },
    FRIDAY: { in: "07:00", out: "16:00" },
    SATURDAY: { in: "07:00", out: "16:00" },
  },
  overrides: [],
});

function punch(date: string, time: string, idNumber = "00123") {
  return { idNumber, name: "Budi", date, time };
}

function piket(overrides: Partial<WorkExceptionSpan> = {}): WorkExceptionSpan {
  return {
    idNumber: "00123",
    startDate: "2026-10-05",
    startTime: "21:00:00",
    endDate: "2026-10-06",
    endTime: "07:00:00",
    ...overrides,
  };
}

describe("work exceptions in the recap", () => {
  test("a late arrival after a night shift is not late", () => {
    // Piket Mon 21:00 -> Tue 07:00; punches 09:30 in, 17:00 out (late by 2h30).
    const daily = buildDaily(
      [punch("2026-10-06", "09:30:00"), punch("2026-10-06", "17:00:00")],
      calendar,
    );
    const before = daily[0]!;
    expect(before.status).toBe("telat");
    expect(before.lateMinutes).toBe(150);

    const [after] = applyWorkExceptions(daily, [piket()]);
    // Tuesday is excused, not flagged: it is an ordinary workday earned back.
    expect(after!.status).toBe("lengkap");
    expect(after!.lateMinutes).toBe(0);
    expect(after!.isPiket).toBe(false);
    // The punch is preserved; nothing is invented.
    expect(after!.inTime).toBe("09:30:00");
  });

  test("an early departure after a night shift is not early", () => {
    const daily = buildDaily(
      [punch("2026-10-06", "06:00:00"), punch("2026-10-06", "15:00:00")],
      calendar,
    );
    expect(daily[0]!.earlyMinutes).toBe(60);
    const [after] = applyWorkExceptions(daily, [piket()]);
    expect(after!.earlyMinutes).toBe(0);
    expect(after!.status).toBe("lengkap");
  });

  test("a piket day with no punch at all still counts as present", () => {
    const daily = buildDaily([], calendar);
    expect(daily).toHaveLength(0);
    const rows = applyWorkExceptions(daily, [piket()], {
      isWorkdayOn: (date) => date !== "2026-10-04", // Sunday off
      nameOf: () => "Budi",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Piket Mon 21:00 -> Tue 07:00 marks Monday, the evening it begins.
    expect(row.date).toBe("2026-10-05");
    expect(row.status).toBe("piket");
    expect(row.punches).toBe(0);
    expect(row.isPiket).toBe(true);
    expect(row.name).toBe("Budi");
    expect(summarizeDaily(rows).present).toBe(1);
    expect(matchesPresence(row, "missing_in")).toBe(false);
  });

  test("a piket on a day off is not libur", () => {
    // 2026-10-04 is a Sunday: piket Sun 21:00 -> Mon 07:00 marks the Sunday.
    const daily = buildDaily([], calendar);
    const rows = applyWorkExceptions(
      daily,
      [piket({ startDate: "2026-10-04", endDate: "2026-10-05" })],
      { isWorkdayOn: (date) => date !== "2026-10-04" },
    );
    expect(rows[0]!.date).toBe("2026-10-04");
    expect(rows[0]!.isWorkday).toBe(false);
    expect(rows[0]!.status).toBe("piket");
  });

  test("one night shift counts one duty day, never two", () => {
    // Piket Mon 21:00 -> Tue 07:00: only Monday is flagged piket.
    const daily = buildDaily([], calendar);
    const rows = applyWorkExceptions(daily, [piket()], {
      isWorkdayOn: () => true,
    });
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.isPiket)).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-10-05");
  });

  test("a plain workday punch is untouched by another employee's piket", () => {
    const daily = buildDaily(
      [punch("2026-10-06", "09:30:00"), punch("2026-10-06", "17:00:00")],
      calendar,
    );
    const rows = applyWorkExceptions(daily, [piket({ idNumber: "99999" })]);
    expect(rows[0]!.status).toBe("telat");
    expect(rows[0]!.lateMinutes).toBe(150);
    expect(rows[0]!.isPiket).toBe(false);
  });

  test("no exceptions means no change", () => {
    const daily = buildDaily(
      [punch("2026-10-06", "09:30:00"), punch("2026-10-06", "17:00:00")],
      calendar,
    );
    expect(applyWorkExceptions(daily, [])).toEqual(daily);
  });

  test("an overtime span waives sanctions on the same day", () => {
    const daily = buildDaily(
      [punch("2026-10-07", "09:00:00"), punch("2026-10-07", "17:00:00")],
      calendar,
    );
    expect(daily[0]!.status).toBe("telat");
    const [after] = applyWorkExceptions(daily, [
      piket({
        startDate: "2026-10-07",
        startTime: "13:00:00",
        endDate: "2026-10-07",
        endTime: "17:00:00",
      }),
    ]);
    expect(after!.status).toBe("piket");
    expect(after!.lateMinutes).toBe(0);
  });
});

// Guard: the auto-sync rules must stay independent of the recap change.
describe("unrelated sanity", () => {
  test("isDue still imports and evaluates", () => {
    expect(typeof isDue).toBe("function");
  });
});
