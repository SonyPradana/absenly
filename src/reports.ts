// Shared report selection: display names, active employees, and filters.
// Pure: the API, CLI JSON, and workbook use this instead of their own policies.

import type { EmployeeView } from "./employees.ts";
import {
  buildDaily,
  matchesPresence,
  matchesPunctuality,
  sortByDateThenName,
  type DailyRow,
  type PresenceFilter,
  type PunctualityFilter,
  type Punch,
} from "./recap.ts";
import type { ScheduleCalendar } from "./schedule.ts";
import { resolveSchedule } from "./schedule.ts";
import { applyWorkExceptions } from "./work-exceptions.ts";
import type { WorkExceptionSpan } from "./work-exceptions.ts";

export interface ReportOptions {
  idNumbers?: string[];
  presence?: PresenceFilter;
  punctuality?: PunctualityFilter;
}

export function employeeNames(employees: EmployeeView[]): Map<string, string> {
  return new Map(employees.map((employee) => [employee.idNumber, employee.name]));
}

export function composeDailyRows(
  punches: Punch[],
  employees: EmployeeView[],
  calendar: ScheduleCalendar,
  workExceptions: WorkExceptionSpan[] = [],
): DailyRow[] {
  const names = employeeNames(employees);
  const daily = buildDaily(
    punches.map((punch) => ({ ...punch, name: names.get(punch.idNumber) ?? punch.name })),
    calendar,
  );
  // Exceptions only waive sanctions and mark piket days; they never invent punches.
  return sortByDateThenName(
    applyWorkExceptions(daily, workExceptions, {
      isWorkdayOn: (date) => resolveSchedule(calendar, date) !== null,
      nameOf: (idNumber) => names.get(idNumber),
    }),
  );
}

// No explicit ids = active employees only. Explicit ids include inactive employees.
export function selectReportRows(
  rows: DailyRow[],
  employees: EmployeeView[],
  options: ReportOptions = {},
): DailyRow[] {
  const requested =
    options.idNumbers === undefined || options.idNumbers.length === 0
      ? null
      : new Set(options.idNumbers);
  const active = new Set(
    employees.filter((employee) => employee.active).map((employee) => employee.idNumber),
  );
  return rows.filter(
    (row) =>
      (requested === null ? active.has(row.idNumber) : requested.has(row.idNumber)) &&
      matchesPresence(row, options.presence ?? "all") &&
      matchesPunctuality(row, options.punctuality ?? "all"),
  );
}

export function buildReportRows(input: {
  punches: Punch[];
  employees: EmployeeView[];
  calendar: ScheduleCalendar;
  workExceptions?: WorkExceptionSpan[];
  options?: ReportOptions;
}): DailyRow[] {
  return selectReportRows(
    composeDailyRows(input.punches, input.employees, input.calendar, input.workExceptions),
    input.employees,
    input.options,
  );
}

export function visibleEmployees(employees: EmployeeView[], requested?: string[]): EmployeeView[] {
  if (requested === undefined || requested.length === 0) {
    return employees.filter((employee) => employee.active);
  }
  return requested.map((idNumber) => {
    const employee = employees.find((item) => item.idNumber === idNumber);
    return employee ?? { idNumber, name: idNumber, active: true };
  });
}
