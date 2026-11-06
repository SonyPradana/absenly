import { describe, expect, test } from "bun:test";
import type { EmployeeView } from "../src/employees.ts";
import {
  buildReportRows,
  composeDailyRows,
  employeeNames,
  selectReportRows,
  visibleEmployees,
} from "../src/reports.ts";
import type { Punch } from "../src/recap.ts";
import { DAY_KEYS, parseWeeklySchedule, type ScheduleCalendar } from "../src/schedule.ts";

function calendar(): ScheduleCalendar {
  const weekly: Record<string, { in: string; out: string } | null> = {};
  for (const day of DAY_KEYS) weekly[day] = { in: "07:00", out: "16:00" };
  weekly.SUNDAY = null;
  return { version: 1, base: parseWeeklySchedule(weekly), overrides: [] };
}

const employees: EmployeeView[] = [
  { idNumber: "001", name: "Budi Active", active: true },
  { idNumber: "002", name: "Sari Inactive", active: false },
  { idNumber: "003", name: "Ahmad Active", active: true },
];

const punches: Punch[] = [
  { idNumber: "001", name: "Device Budi", date: "2026-10-05", time: "08:00:00" },
  { idNumber: "001", name: "Device Budi", date: "2026-10-05", time: "17:00:00" },
  { idNumber: "002", name: "Device Sari", date: "2026-10-05", time: "07:00:00" },
  { idNumber: "002", name: "Device Sari", date: "2026-10-05", time: "16:00:00" },
  { idNumber: "003", name: "Device Ahmad", date: "2026-10-05", time: "07:00:00" },
];

describe("shared report rows", () => {
  test("compose maps display names and sorts by date then name", () => {
    const rows = composeDailyRows(punches, employees, calendar());
    expect(rows.map((row) => row.name)).toEqual(["Ahmad Active", "Budi Active", "Sari Inactive"]);
    expect(employeeNames(employees).get("001")).toBe("Budi Active");
  });

  test("default selection hides inactive employees and applies filters", () => {
    const rows = composeDailyRows(punches, employees, calendar());
    expect(selectReportRows(rows, employees).map((row) => row.idNumber)).toEqual(["003", "001"]);
    expect(
      selectReportRows(rows, employees, { presence: "missing_out" }).map((row) => row.idNumber),
    ).toEqual(["003"]);
    expect(
      selectReportRows(rows, employees, { punctuality: "late" }).map((row) => row.idNumber),
    ).toEqual(["001"]);
  });

  test("explicit ids include inactive employees", () => {
    const rows = buildReportRows({
      punches,
      employees,
      calendar: calendar(),
      options: { idNumbers: ["002"] },
    });
    expect(rows.map((row) => row.idNumber)).toEqual(["002"]);
    expect(rows[0]?.name).toBe("Sari Inactive");
  });

  test("visible employees use active by default and can name an unknown explicit id", () => {
    expect(visibleEmployees(employees).map((employee) => employee.idNumber)).toEqual([
      "001",
      "003",
    ]);
    expect(visibleEmployees(employees, ["002", "unknown"])).toEqual([
      { idNumber: "002", name: "Sari Inactive", active: false },
      { idNumber: "unknown", name: "unknown", active: true },
    ]);
  });
});
