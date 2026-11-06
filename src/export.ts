// Export service: raw punches + daily recap -> JSON envelope or XLSX workbook. No HTTP, no device.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { utils, write, type WorkSheet } from "xlsx";
import { toRecapDto, type RecapDto } from "./api/dto.ts";
import type { EmployeeView } from "./employees.ts";
import { dateRange, MAX_RANGE_DAYS, monthRange, PeriodError } from "./period.ts";
import {
  PRESENCE_FILTERS,
  PUNCTUALITY_FILTERS,
  type DailyRow,
  type PresenceFilter,
  type PunctualityFilter,
  type Punch,
} from "./recap.ts";
import { employeeNames, visibleEmployees } from "./reports.ts";
import { resolveSchedule, type ScheduleCalendar } from "./schedule.ts";
import { SPLIT_TIME, today } from "./time.ts";

export type ExportMode = "raw" | "recap" | "user" | "poin";

export const EXPORT_MODES: ExportMode[] = ["raw", "recap", "user", "poin"];
export const FACE_VERIFY = 15;

export type ExportErrorCode = "INVALID_ARGS" | "NO_DATA";

export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportOptions {
  from: string;
  to: string;
  month: string | null;
  users: string[];
  presence: PresenceFilter;
  punctuality: PunctualityFilter;
  format: "json" | "excel";
  modes: ExportMode[];
  out: string | null;
}

export interface ExportMeta {
  month?: string;
  from: string;
  to: string;
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ExportEnvelope {
  data: RecapDto[];
  meta: ExportMeta;
}

const GRID_TOTALS = {
  in: ["Total terlambat", "Total hari terlambat", "Total absen"],
  out: ["Total pulang awal", "Total tidak absen pulang"],
} as const;

function invalid(message: string): never {
  throw new ExportError("INVALID_ARGS", message);
}

function monthBounds(month: string): { from: string; to: string } {
  try {
    return monthRange(month);
  } catch (error) {
    if (error instanceof PeriodError) invalid(`--for-month must be YYYY-MM: ${month}`);
    throw error;
  }
}

function validateRange(from: string, to: string): void {
  try {
    dateRange(from, to);
  } catch (error) {
    if (!(error instanceof PeriodError)) throw error;
    if (error.code === "DATE") {
      if (error.field === "from") invalid(`--from must be YYYY-MM-DD: ${from}`);
      invalid(`--to must be YYYY-MM-DD: ${to}`);
    }
    if (error.code === "ORDER") invalid("--from must not be after --to");
    invalid(`range must not exceed ${MAX_RANGE_DAYS} days`);
  }
}

export function parseExportOptions(args: string[]): ExportOptions {
  let month: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  const users: string[] = [];
  let presence: PresenceFilter = "all";
  let punctuality: PunctualityFilter = "all";
  let format: "json" | "excel" | null = null;
  let out: string | null = null;
  const modes: ExportMode[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || next === "") invalid(`${arg} requires a value`);
      return next;
    };

    switch (arg) {
      case "--for-month":
        month = value();
        break;
      case "--from":
        from = value();
        break;
      case "--to":
        to = value();
        break;
      case "--user":
        for (const part of value().split(",")) {
          const id = part.trim();
          if (id === "") invalid("--user must not be empty");
          if (!users.includes(id)) users.push(id);
        }
        break;
      case "--mode":
        for (const part of value().split(",")) {
          const mode = part.trim();
          if (!EXPORT_MODES.includes(mode as ExportMode)) {
            invalid(`--mode must be a comma list of ${EXPORT_MODES.join("|")}: ${part}`);
          }
          const typed = mode as ExportMode;
          if (!modes.includes(typed)) modes.push(typed);
        }
        break;
      case "--presence":
        presence = value() as PresenceFilter;
        break;
      case "--punctuality":
        punctuality = value() as PunctualityFilter;
        break;
      case "--out":
        out = value();
        break;
      case "--json":
        if (format === "excel") invalid("--json cannot be combined with --excel");
        format = "json";
        break;
      case "--excel":
        if (format === "json") invalid("--json cannot be combined with --excel");
        format = "excel";
        break;
      default:
        invalid(`unexpected argument: ${arg}`);
    }
  }

  if (month !== null && (from !== null || to !== null)) {
    invalid("--for-month cannot be combined with --from/--to");
  }
  if (month === null && (from === null || to === null)) {
    invalid("exactly one of --for-month or --from/--to is required");
  }
  if (format === null) invalid("one of --json or --excel is required");
  if (format === "json" && out !== null) invalid("--out can only be used with --excel");
  if (format === "json" && modes.length > 0) invalid("--mode can only be used with --excel");
  if (format === "excel") {
    if (users.length > 0 && !modes.includes("user") && !modes.includes("poin")) {
      invalid("--user with --excel requires --mode user or poin");
    }
    if (presence !== "all" || punctuality !== "all") {
      invalid("--presence/--punctuality only apply to --json");
    }
  }
  if (!PRESENCE_FILTERS.includes(presence))
    invalid(`--presence must be one of ${PRESENCE_FILTERS.join("|")}`);
  if (!PUNCTUALITY_FILTERS.includes(punctuality)) {
    invalid(`--punctuality must be one of ${PUNCTUALITY_FILTERS.join("|")}`);
  }

  const resolvedModes: ExportMode[] =
    format === "excel" && modes.length === 0 ? ["recap"] : [...modes];

  if (month !== null) {
    const bounds = monthBounds(month);
    return {
      from: bounds.from,
      to: bounds.to,
      month,
      users,
      presence,
      punctuality,
      format,
      modes: resolvedModes,
      out,
    };
  }

  validateRange(from!, to!);
  return {
    from: from!,
    to: to!,
    month: null,
    users,
    presence,
    punctuality,
    format,
    modes: resolvedModes,
    out,
  };
}

export function toExportEnvelope(rows: DailyRow[], options: ExportOptions): ExportEnvelope {
  const total = rows.length;
  return {
    data: rows.map(toRecapDto),
    meta: {
      ...(options.month === null ? {} : { month: options.month }),
      from: options.from,
      to: options.to,
      total,
      page: 1,
      per_page: total,
      total_pages: total === 0 ? 0 : 1,
    },
  };
}

export function toExportJson(rows: DailyRow[], options: ExportOptions): string {
  return JSON.stringify(toExportEnvelope(rows, options));
}

export function defaultExportPath(options: ExportOptions): string {
  const period = options.month === null ? `${options.from}_${options.to}` : options.month;
  return resolve(`exports/rekap-${period}.xlsx`);
}

export function formatDate(date: string): string {
  const [year = "", month = "", day = ""] = date.split("-");
  return `${day}/${month}/${year.slice(2)}`;
}

// "3 menit 1 detik", "1 jam 2 menit", "12 detik". Callers handle the zero case.
export function humanDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} detik`);
  return parts.join(" ");
}

export function verificationLabel(verify: number | null): string {
  if (verify === null) return "";
  return verify === FACE_VERIFY ? "Face" : "Unverified";
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildRawSheet(punches: Punch[], names?: ReadonlyMap<string, string>): unknown[][] {
  const sorted = [...punches].sort(
    (a, b) =>
      compareStrings(a.date, b.date) ||
      compareStrings(a.time, b.time) ||
      compareStrings(a.idNumber, b.idNumber),
  );

  return [
    ["No", "ID", "Date", "Name", "Time", "Status", "Verification"],
    ...sorted.map((punch, index) => [
      index + 1,
      punch.idNumber,
      formatDate(punch.date),
      names?.get(punch.idNumber) ?? punch.name,
      punch.time,
      punch.time < SPLIT_TIME ? "IN" : "OUT",
      verificationLabel(punch.verify ?? null),
    ]),
  ];
}

function timeNote(row: DailyRow, kind: "in" | "out"): string {
  if (!row.isWorkday) return "Libur";
  const seconds = kind === "in" ? row.lateSeconds : row.earlySeconds;
  if ((seconds ?? 0) <= 0) return "ok";
  const value = humanDuration(seconds!);
  return kind === "in" ? `Telat ${value}` : `Pulang awal ${value}`;
}

function scheduleTime(calendar: ScheduleCalendar, date: string, kind: "in" | "out"): string {
  const day = resolveSchedule(calendar, date);
  return day === null ? "Libur" : day[kind];
}

export function buildUserSheet(
  rows: DailyRow[],
  names?: ReadonlyMap<string, string>,
  calendar?: ScheduleCalendar,
): unknown[][] {
  const sorted = [...rows].sort((a, b) => compareStrings(a.date, b.date));
  const sheet: unknown[][] = [
    ["Date", "Name", "Jadwal", "Time", "Status", "Verification", "Keterangan Waktu"],
  ];

  for (const row of sorted) {
    const name = names?.get(row.idNumber) ?? row.name;
    if (row.inTime !== null) {
      sheet.push([
        formatDate(row.date),
        name,
        calendar === undefined ? "" : scheduleTime(calendar, row.date, "in"),
        row.inTime,
        "IN",
        verificationLabel(row.inVerify),
        timeNote(row, "in"),
      ]);
    }
    if (row.outTime !== null) {
      sheet.push([
        formatDate(row.date),
        name,
        calendar === undefined ? "" : scheduleTime(calendar, row.date, "out"),
        row.outTime,
        "OUT",
        verificationLabel(row.outVerify),
        timeNote(row, "out"),
      ]);
    }
  }

  return sheet;
}

const POIN_STATUS: Record<DailyRow["status"], string> = {
  lengkap: "Lengkap",
  telat: "Telat",
  pulang_cepat: "Pulang cepat",
  tanpa_masuk: "Tanpa masuk",
  belum_pulang: "Belum pulang",
  piket: "Piket",
  libur: "Libur",
};

// Same wording as the HTML daily table: "5 mnt", "1 jam", "1 jam 2 mnt".
function minuteText(minutes: number): string {
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} jam` : `${hours} jam ${rest} mnt`;
}

// Mode poin: one row per day, mirroring the HTML daily table on /share and /me.
// Minutes stay text on purpose so the sheet reads like the page. The employee
// name repeats on every row so a filtered or re-sorted sheet stays readable.
export function buildPoinSheet(rows: DailyRow[], names?: ReadonlyMap<string, string>): unknown[][] {
  const sorted = [...rows].sort((a, b) => compareStrings(a.date, b.date));
  const sheet: unknown[][] = [
    ["Tanggal", "Nama", "Masuk", "Pulang", "Telat", "Pulang cepat", "Status"],
  ];

  for (const row of sorted) {
    sheet.push([
      formatDate(row.date),
      names?.get(row.idNumber) ?? row.name,
      row.inTime ?? "—",
      row.outTime ?? "—",
      (row.lateMinutes ?? 0) > 0 ? minuteText(row.lateMinutes!) : "—",
      (row.earlyMinutes ?? 0) > 0 ? minuteText(row.earlyMinutes!) : "—",
      POIN_STATUS[row.status],
    ]);
  }

  return sheet;
}

function columnName(index: number): string {
  let name = "";
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export interface GridInput {
  kind: "in" | "out";
  dates: string[];
  employees: EmployeeView[];
  rows: DailyRow[];
  calendar: ScheduleCalendar;
}

// Rows: header, hidden workday helper (1/0), then one row per employee.
export function buildGridSheet(input: GridInput): WorkSheet {
  const { kind, dates, employees, rows, calendar } = input;
  const secondsOf =
    kind === "in" ? (row: DailyRow) => row.lateSeconds : (row: DailyRow) => row.earlySeconds;
  const totals = GRID_TOTALS[kind];
  const workdays = dates.map((date) => (resolveSchedule(calendar, date) === null ? 0 : 1));
  const byKey = new Map<string, DailyRow>();
  for (const row of rows) byKey.set(`${row.idNumber}|${row.date}`, row);

  const header: unknown[] = ["Nama", ...dates.map(formatDate), ...totals];
  const helper: unknown[] = ["hari kerja", ...workdays, ...totals.map(() => null)];
  const sheet: unknown[][] = [header, helper];
  const values: Array<Array<number | null>> = [];

  for (const employee of employees) {
    const line = dates.map((date, day) => {
      // Holidays stay empty even if somebody punched.
      if (workdays[day] === 0) return null;
      const row = byKey.get(`${employee.idNumber}|${date}`);
      return row === undefined ? null : secondsOf(row);
    });
    values.push(line);
    sheet.push([employee.name || employee.idNumber, ...line, ...totals.map(() => null)]);
  }

  const worksheet = utils.aoa_to_sheet(sheet);
  worksheet["!rows"] = [{}, { hidden: true }];
  const nameWidth = Math.min(
    Math.max(...sheet.slice(2).map((line) => String(line[0] ?? "").length), 10) + 2,
    40,
  );
  worksheet["!cols"] = [
    { wch: nameWidth },
    ...dates.map(() => ({ wch: 10 })),
    ...totals.map((total) => ({ wch: Math.max(total.length + 2, 18) })),
  ];

  const lastDateColumn = 1 + dates.length;
  const firstLetter = columnName(2);
  const lastLetter = columnName(lastDateColumn);
  const totalColumn = lastDateColumn + 1;

  employees.forEach((_employee, index) => {
    const rowNumber = 3 + index;
    const line = values[index]!;
    const range = `${firstLetter}${rowNumber}:${lastLetter}${rowNumber}`;
    const workdayRange = `${firstLetter}$2:${lastLetter}$2`;
    const sum = line.reduce<number>((total, value) => total + (value ?? 0), 0);
    const lateDays = line.filter((value) => (value ?? 0) > 0).length;
    const absent = line.filter((value, day) => value === null && workdays[day] === 1).length;

    const cells: Array<{ formula: string; value: number }> =
      kind === "in"
        ? [
            { formula: `SUM(${range})`, value: sum },
            { formula: `COUNTIF(${range},">0")`, value: lateDays },
            { formula: `COUNTIFS(${workdayRange},1,${range},"")`, value: absent },
          ]
        : [
            { formula: `SUM(${range})`, value: sum },
            { formula: `COUNTIFS(${workdayRange},1,${range},"")`, value: absent },
          ];

    cells.forEach((cell, offset) => {
      worksheet[`${columnName(totalColumn + offset)}${rowNumber}`] = {
        t: "n",
        f: cell.formula,
        v: cell.value,
      };
    });
  });

  return worksheet;
}

function uniqueSheetName(base: string, used: Set<string>): string {
  const clean = base.replace(/[\\/?*[\]:]/g, "").trim() || "Sheet";
  let name = clean.slice(0, 31);
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    const tag = ` (${suffix++})`;
    name = clean.slice(0, 31 - tag.length) + tag;
  }
  used.add(name.toLowerCase());
  return name;
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function applyWidths(sheet: WorkSheet, rows: unknown[][]): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((value, column) => {
      if (value === null || value === undefined || value === "") return;
      widths[column] = Math.max(widths[column] ?? 0, String(value).length);
    });
  }
  sheet["!cols"] = widths.map((width) => ({ wch: Math.min(Math.max(width + 2, 8), 40) }));
}

// The current month stops at today; dates in the future are not absence.
function clampDate(from: string, to: string, cap: string): string {
  const capped = to <= cap ? to : cap;
  return capped < from ? from : capped;
}

export interface WorkbookInput {
  options: ExportOptions;
  punches: Punch[];
  daily: DailyRow[];
  employees: EmployeeView[];
  calendar: ScheduleCalendar;
  today?: string;
}

export interface WorkbookResult {
  path: string;
  sheets: string[];
}

export interface WorkbookBuffer {
  buffer: Buffer;
  sheets: string[];
}

export function buildWorkbook(input: WorkbookInput): WorkbookBuffer {
  const { options } = input;
  if (input.punches.length === 0) {
    throw new ExportError("NO_DATA", "tidak ada baris untuk diekspor (NO_DATA)");
  }

  const book = utils.book_new();
  const used = new Set<string>();
  const sheets: string[] = [];
  const names = employeeNames(input.employees);
  // Raw keeps every punch; recap and user sheets only report active employees.
  // An explicit employee filter narrows the recap/user sheets too.
  const active =
    options.users.length > 0
      ? visibleEmployees(input.employees, options.users)
      : visibleEmployees(input.employees);

  const add = (name: string, sheet: WorkSheet) => {
    const sheetName = uniqueSheetName(name, used);
    utils.book_append_sheet(book, sheet, sheetName);
    sheets.push(sheetName);
  };
  const addAoa = (name: string, rows: unknown[][]) => {
    const sheet = utils.aoa_to_sheet(rows);
    applyWidths(sheet, rows);
    add(name, sheet);
  };

  if (options.modes.includes("raw")) {
    addAoa("Raw", buildRawSheet(input.punches, names));
  }

  if (options.modes.includes("recap")) {
    const lastDate = clampDate(options.from, options.to, input.today ?? today());
    const dates = eachDate(options.from, lastDate);
    for (const kind of ["in", "out"] as const) {
      add(
        kind === "in" ? "Masuk" : "Pulang",
        buildGridSheet({
          kind,
          dates,
          employees: active,
          rows: input.daily,
          calendar: input.calendar,
        }),
      );
    }
  }

  if (options.modes.includes("user") || options.modes.includes("poin")) {
    const byUser = new Map<string, DailyRow[]>();
    for (const row of input.daily) {
      const list = byUser.get(row.idNumber);
      if (list === undefined) byUser.set(row.idNumber, [row]);
      else list.push(row);
    }

    const candidates: EmployeeView[] =
      options.users.length > 0
        ? visibleEmployees(input.employees, options.users)
        : active.filter((employee) => byUser.has(employee.idNumber));

    const both = options.modes.includes("user") && options.modes.includes("poin");

    for (const employee of candidates) {
      const rows = byUser.get(employee.idNumber) ?? [];
      if (rows.length === 0 && options.users.length === 0) continue;
      const base = `${employee.idNumber} - ${employee.name}`;
      if (options.modes.includes("user")) {
        addAoa(base, buildUserSheet(rows, names, input.calendar));
      }
      if (options.modes.includes("poin")) {
        // A "(poin)" tag only when the user sheet also claims the plain name.
        addAoa(both ? `${base} (poin)` : base, buildPoinSheet(rows, names));
      }
    }
  }

  if (sheets.length === 0) {
    throw new ExportError("NO_DATA", "tidak ada karyawan aktif untuk diekspor (NO_DATA)");
  }

  return {
    buffer: write(book, { type: "buffer", bookType: "xlsx" }) as Buffer,
    sheets,
  };
}

export function writeWorkbook(input: WorkbookInput, path: string): WorkbookResult {
  const workbook = buildWorkbook(input);
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, workbook.buffer);
  return { path: target, sheets: workbook.sheets };
}
