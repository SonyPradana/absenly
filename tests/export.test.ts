import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, utils } from "xlsx";
import type { RecapDto } from "../src/api/dto.ts";
import type { EmployeeView } from "../src/employees.ts";
import {
  buildGridSheet,
  buildPoinSheet,
  buildRawSheet,
  buildUserSheet,
  defaultExportPath,
  ExportError,
  humanDuration,
  parseExportOptions,
  toExportEnvelope,
  toExportJson,
  verificationLabel,
  writeWorkbook,
} from "../src/export.ts";
import { buildDaily, sortByDateThenName } from "../src/recap.ts";
import { DAY_KEYS, parseWeeklySchedule, type ScheduleCalendar } from "../src/schedule.ts";
import { loadEdge } from "./support/fixtures.ts";

const edge = loadEdge();
const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "expected", "cli-export-edge.json"), "utf8"),
) as {
  data: RecapDto[];
  meta: { total: number; per_page: number; total_pages: number };
};

const WORK_WEEK: Record<string, { in: string; out: string } | null> = {
  MONDAY: { in: "07:00", out: "16:00" },
  TUESDAY: { in: "07:00", out: "16:00" },
  WEDNESDAY: { in: "07:00", out: "16:00" },
  THURSDAY: { in: "07:00", out: "16:00" },
  FRIDAY: { in: "07:00", out: "16:00" },
  SATURDAY: { in: "07:00", out: "12:00" },
  SUNDAY: null,
};

function calendarFromWeekly(
  weekly: Record<string, { in: string; out: string } | null>,
): ScheduleCalendar {
  const filled: Record<string, { in: string; out: string } | null> = {};
  for (const day of DAY_KEYS) filled[day] = weekly[day] ?? null;
  return { version: 1, base: parseWeeklySchedule(filled), overrides: [] };
}

function employee(idNumber: string, name: string, active = true): EmployeeView {
  return { idNumber, name, active };
}

const calendar = calendarFromWeekly(WORK_WEEK);
const employees = [employee("001", "Budi"), employee("002", "Sari")];
const punches = [
  { idNumber: "001", name: "Budi", date: "2026-10-04", time: "08:00:00", verify: 15 },
  { idNumber: "001", name: "Budi", date: "2026-10-05", time: "07:00:30", verify: 15 },
  { idNumber: "001", name: "Budi", date: "2026-10-05", time: "16:00:00", verify: 15 },
  { idNumber: "002", name: "Sari", date: "2026-10-05", time: "07:05:00", verify: 1 },
  { idNumber: "002", name: "Sari", date: "2026-10-05", time: "15:59:00", verify: 15 },
  { idNumber: "002", name: "Sari", date: "2026-10-06", time: "12:00:00", verify: 15 },
];
const daily = buildDaily(punches, calendar);
const dates = ["2026-10-04", "2026-10-05", "2026-10-06"];

function edgeRows() {
  return sortByDateThenName(
    buildDaily(
      edge.attendance.map((row) => ({
        idNumber: row.idNumber,
        name: row.name,
        date: row.date,
        time: row.time,
        verify: row.verify,
      })),
      calendarFromWeekly(edge.schedule),
    ),
  );
}

const jsonOptions = parseExportOptions(["--for-month", "2026-10", "--json"]);

describe("export options", () => {
  test("--for-month expands to the full month", () => {
    expect(jsonOptions.from).toBe("2026-10-01");
    expect(jsonOptions.to).toBe("2026-10-31");
    expect(jsonOptions.month).toBe("2026-10");
    expect(jsonOptions.format).toBe("json");
    expect(jsonOptions.modes).toEqual([]);
  });

  test("--excel defaults to the recap package", () => {
    const options = parseExportOptions(["--for-month", "2026-10", "--excel"]);
    expect(options.modes).toEqual(["recap"]);
  });

  test("--mode accepts a comma list and drops duplicates", () => {
    const options = parseExportOptions([
      "--for-month",
      "2026-10",
      "--excel",
      "--mode",
      "raw,user,raw",
    ]);
    expect(options.modes).toEqual(["raw", "user"]);
  });

  test("--user accepts a comma list", () => {
    const options = parseExportOptions([
      "--for-month",
      "2026-10",
      "--excel",
      "--mode",
      "user",
      "--user",
      "001, 002",
    ]);
    expect(options.users).toEqual(["001", "002"]);
  });

  test("invalid arguments are rejected with INVALID_ARGS", () => {
    const cases: Array<[string[], string]> = [
      [
        ["--for-month", "2026-10", "--from", "2026-10-01", "--to", "2026-10-02", "--json"],
        "--for-month cannot be combined with --from/--to",
      ],
      [["--json"], "exactly one of --for-month or --from/--to is required"],
      [["--for-month", "2026-10"], "one of --json or --excel is required"],
      [["--for-month", "2026-10", "--json", "--excel"], "--json cannot be combined with --excel"],
      [
        ["--for-month", "2026-10", "--json", "--out", "x.xlsx"],
        "--out can only be used with --excel",
      ],
      [
        ["--for-month", "2026-10", "--json", "--mode", "raw"],
        "--mode can only be used with --excel",
      ],
      [
        ["--for-month", "2026-10", "--excel", "--mode", "pdf"],
        "--mode must be a comma list of raw|recap|user|poin: pdf",
      ],
      [
        ["--for-month", "2026-10", "--excel", "--user", "001"],
        "--user with --excel requires --mode user or poin",
      ],
      [
        ["--for-month", "2026-10", "--excel", "--presence", "late"],
        "--presence/--punctuality only apply to --json",
      ],
      [["--for-month", "2026-13", "--json"], "--for-month must be YYYY-MM: 2026-13"],
      [["--for-month", "0000-02", "--json"], "--for-month must be YYYY-MM: 0000-02"],
      [["--from", "2026-10-20", "--to", "2026-10-01", "--json"], "--from must not be after --to"],
      [
        ["--from", "0000-01-01", "--to", "0000-01-02", "--json"],
        "--from must be YYYY-MM-DD: 0000-01-01",
      ],
      [
        ["--from", "2026-10-01", "--to", "2026-02-31", "--json"],
        "--to must be YYYY-MM-DD: 2026-02-31",
      ],
      [["--from", "2026-10-01", "--to", "2027-10-02", "--json"], "range must not exceed 366 days"],
      [
        ["--for-month", "2026-10", "--json", "--presence", "maybe"],
        "--presence must be one of all|complete|missing_in|missing_out",
      ],
      [
        ["--for-month", "2026-10", "--json", "--punctuality", "maybe"],
        "--punctuality must be one of all|late|ontime",
      ],
      [["--for-month", "2026-10", "--json", "--user"], "--user requires a value"],
      [["--for-month", "2026-10", "--json", "--nope"], "unexpected argument: --nope"],
    ];

    for (const [args, message] of cases) {
      let thrown: unknown;
      try {
        parseExportOptions(args);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExportError);
      expect((thrown as ExportError).code).toBe("INVALID_ARGS");
      expect((thrown as ExportError).message).toBe(message);
    }
  });
});

describe("export JSON", () => {
  test("data and meta match the golden contract", () => {
    const rows = edgeRows();
    const envelope = toExportEnvelope(rows, jsonOptions);

    expect(envelope.data).toEqual(golden.data);
    expect(envelope.meta.total).toBe(golden.meta.total);
    expect(envelope.meta.per_page).toBe(golden.meta.per_page);
    expect(envelope.meta.total_pages).toBe(golden.meta.total_pages);
    expect(envelope.meta.page).toBe(1);
    expect(envelope.meta.from).toBe("2026-10-01");
    expect(envelope.meta.to).toBe("2026-10-31");
    expect(envelope.meta.month).toBe("2026-10");
  });

  test("the JSON is one line and parses back to the same envelope", () => {
    const json = toExportJson(edgeRows(), jsonOptions);
    expect(json).not.toContain("\n");
    expect(JSON.parse(json)).toEqual(toExportEnvelope(edgeRows(), jsonOptions));
  });

  test("an empty period is a success with total 0", () => {
    const empty = toExportEnvelope([], jsonOptions);
    expect(empty.data).toEqual([]);
    expect(empty.meta.total).toBe(0);
    expect(empty.meta.per_page).toBe(0);
    expect(empty.meta.total_pages).toBe(0);
  });

  test("--user keeps only the listed id_numbers", () => {
    const options = parseExportOptions(["--for-month", "2026-10", "--json", "--user", "00123"]);
    const rows = edgeRows().filter((row) => options.users.includes(row.idNumber));
    expect(rows.length).toBe(golden.data.filter((row) => row.id_number === "00123").length);
    expect(rows.every((row) => row.idNumber === "00123")).toBe(true);
  });
});

describe("human formatting", () => {
  test("durations use Indonesian units", () => {
    expect(humanDuration(0)).toBe("0 detik");
    expect(humanDuration(1)).toBe("1 detik");
    expect(humanDuration(60)).toBe("1 menit");
    expect(humanDuration(61)).toBe("1 menit 1 detik");
    expect(humanDuration(3600)).toBe("1 jam");
    expect(humanDuration(3661)).toBe("1 jam 1 menit 1 detik");
  });

  test("only face is verified", () => {
    expect(verificationLabel(15)).toBe("Face");
    expect(verificationLabel(1)).toBe("Unverified");
    expect(verificationLabel(null)).toBe("");
  });
});

describe("raw sheet", () => {
  test("one row per punch, sorted by date and time, with a guard id", () => {
    const sheet = buildRawSheet(punches);
    expect(sheet[0]).toEqual(["No", "ID", "Date", "Name", "Time", "Status", "Verification"]);
    expect(sheet.length).toBe(punches.length + 1);
    expect(sheet[1]).toEqual([1, "001", "04/10/26", "Budi", "08:00:00", "IN", "Face"]);
    expect(sheet[2]).toEqual([2, "001", "05/10/26", "Budi", "07:00:30", "IN", "Face"]);
    expect(sheet[4]).toEqual([4, "002", "05/10/26", "Sari", "15:59:00", "OUT", "Face"]);
    expect(sheet[3]?.[6]).toBe("Unverified");
  });
});

describe("grid sheets", () => {
  test("late seconds, blanks, and formulas with cached values", () => {
    const sheet = buildGridSheet({ kind: "in", dates, employees, rows: daily, calendar });

    expect(sheet["A1"]?.v).toBe("Nama");
    expect(sheet["B1"]?.v).toBe("04/10/26");
    expect(sheet["E1"]?.v).toBe("Total terlambat");
    expect(sheet["F1"]?.v).toBe("Total hari terlambat");
    expect(sheet["G1"]?.v).toBe("Total absen");

    // Hidden workday helper: Sunday 0, Monday/Tuesday 1.
    expect(sheet["A2"]?.v).toBe("hari kerja");
    expect(sheet["B2"]?.v).toBe(0);
    expect(sheet["C2"]?.v).toBe(1);
    expect(sheet["D2"]?.v).toBe(1);

    // Holiday and no-punch days stay empty; present-but-late is seconds.
    expect(sheet["B3"]).toBeUndefined();
    expect(sheet["C3"]?.v).toBe(30);
    expect(sheet["D3"]).toBeUndefined();

    expect(sheet["E3"]).toMatchObject({ f: "SUM(B3:D3)", v: 30 });
    expect(sheet["F3"]).toMatchObject({ f: 'COUNTIF(B3:D3,">0")', v: 1 });
    expect(sheet["G3"]).toMatchObject({ f: 'COUNTIFS(B$2:D$2,1,B3:D3,"")', v: 1 });

    expect(sheet["C4"]?.v).toBe(300);
    expect(sheet["E4"]).toMatchObject({ f: "SUM(B4:D4)", v: 300 });
    expect(sheet["G4"]).toMatchObject({ v: 1 });
  });

  test("pulang sheet totals early seconds and missing OUT", () => {
    const sheet = buildGridSheet({ kind: "out", dates, employees, rows: daily, calendar });

    expect(sheet["E1"]?.v).toBe("Total pulang awal");
    expect(sheet["F1"]?.v).toBe("Total tidak absen pulang");
    expect(sheet["C3"]?.v).toBe(0);
    expect(sheet["C4"]?.v).toBe(60);
    expect(sheet["D4"]?.v).toBe(14400);
    expect(sheet["E4"]).toMatchObject({ f: "SUM(B4:D4)", v: 14460 });
    expect(sheet["F4"]).toMatchObject({ f: 'COUNTIFS(B$2:D$2,1,B4:D4,"")', v: 0 });
  });
});

describe("user sheet", () => {
  test("one IN and one OUT row per day, with the schedule as reference", () => {
    const rows = buildUserSheet(
      daily.filter((row) => row.idNumber === "001"),
      undefined,
      calendar,
    );
    expect(rows[0]).toEqual([
      "Date",
      "Name",
      "Jadwal",
      "Time",
      "Status",
      "Verification",
      "Keterangan Waktu",
    ]);
    expect(rows[1]).toEqual(["04/10/26", "Budi", "Libur", "08:00:00", "IN", "Face", "Libur"]);
    expect(rows[2]).toEqual([
      "05/10/26",
      "Budi",
      "07:00",
      "07:00:30",
      "IN",
      "Face",
      "Telat 30 detik",
    ]);
    expect(rows[3]).toEqual(["05/10/26", "Budi", "16:00", "16:00:00", "OUT", "Face", "ok"]);
  });

  test("early leave and hours are spelled out", () => {
    const rows = buildUserSheet(
      daily.filter((row) => row.idNumber === "002"),
      undefined,
      calendar,
    );
    expect(rows[1]).toEqual([
      "05/10/26",
      "Sari",
      "07:00",
      "07:05:00",
      "IN",
      "Unverified",
      "Telat 5 menit",
    ]);
    expect(rows[2]).toEqual([
      "05/10/26",
      "Sari",
      "16:00",
      "15:59:00",
      "OUT",
      "Face",
      "Pulang awal 1 menit",
    ]);
    expect(rows[3]).toEqual([
      "06/10/26",
      "Sari",
      "16:00",
      "12:00:00",
      "OUT",
      "Face",
      "Pulang awal 4 jam",
    ]);
  });

  test("a mapped display name replaces the device name", () => {
    const names = new Map([["001", "H. Budi S.Kom"]]);
    const rows = buildUserSheet(
      daily.filter((row) => row.idNumber === "001"),
      names,
      calendar,
    );
    expect(rows[1]?.[1]).toBe("H. Budi S.Kom");

    const raw = buildRawSheet(punches, names);
    expect(raw[2]?.[3]).toBe("H. Budi S.Kom");
  });

  test("without a calendar the Jadwal cell is blank, never a guess", () => {
    const rows = buildUserSheet(daily.filter((row) => row.idNumber === "001"));
    expect(rows[1]?.[2]).toBe("");
  });
});

describe("poin sheet", () => {
  test("one row per day mirroring the HTML recap table", () => {
    const rows = buildPoinSheet(daily.filter((row) => row.idNumber === "001"));
    expect(rows[0]).toEqual([
      "Tanggal",
      "Nama",
      "Masuk",
      "Pulang",
      "Telat",
      "Pulang cepat",
      "Status",
    ]);
    expect(rows[1]).toEqual(["04/10/26", "Budi", "08:00:00", "—", "—", "—", "Libur"]);
    expect(rows[2]).toEqual(["05/10/26", "Budi", "07:00:30", "16:00:00", "—", "—", "Lengkap"]);
  });

  test("late and early minutes use the page wording", () => {
    const rows = buildPoinSheet(daily.filter((row) => row.idNumber === "002"));
    expect(rows[1]).toEqual([
      "05/10/26",
      "Sari",
      "07:05:00",
      "15:59:00",
      "5 mnt",
      "1 mnt",
      "Telat",
    ]);
    // A lone OUT punch is "Belum pulang" upstream? No: missing IN is "Tanpa masuk".
    expect(rows[2]?.[2]).toBe("—");
    expect(rows[2]?.at(-1)).toBe("Tanpa masuk");
  });

  test("a display-name override wins over the device name", () => {
    const rows = buildPoinSheet(
      daily.filter((row) => row.idNumber === "001"),
      new Map([["001", "H. Budi, S.Kom"]]),
    );
    expect(rows[1]?.[1]).toBe("H. Budi, S.Kom");
    expect(rows[2]?.[1]).toBe("H. Budi, S.Kom");
  });

  test("long durations switch to hours, zero stays a dash", () => {
    const row = daily.find((item) => item.date === "2026-10-06" && item.idNumber === "002");
    expect(row?.earlyMinutes).toBe(240);
    const rows = buildPoinSheet([row!]);
    expect(rows[1]?.[5]).toBe("4 jam");
    expect(rows[1]?.[4]).toBe("—");
  });
});

describe("workbook", () => {
  const options = parseExportOptions([
    "--for-month",
    "2026-10",
    "--excel",
    "--mode",
    "raw,recap,user",
  ]);
  const path = join(tmpdir(), `rekap-workbook-${process.pid}.xlsx`);

  test("combines the three modes in one file", () => {
    const result = writeWorkbook(
      {
        options: { ...options, from: "2026-10-04", to: "2026-10-06", month: null },
        punches,
        daily,
        employees,
        calendar,
      },
      path,
    );
    expect(result.sheets).toEqual(["Raw", "Masuk", "Pulang", "001 - Budi", "002 - Sari"]);
    expect(existsSync(path)).toBe(true);

    const book = readFile(path);
    expect(book.SheetNames).toEqual(result.sheets);
    expect(book.Sheets["Masuk"]?.["E3"]?.f).toBe("SUM(B3:D3)");
    expect(book.Sheets["Raw"]?.["B2"]).toMatchObject({ t: "s", v: "001" });
    expect(book.Sheets["001 - Budi"]?.["A2"]?.v).toBe("04/10/26");

    unlinkSync(path);
  });

  test("poin mode writes one daily sheet per selected employee", () => {
    const poinOptions = parseExportOptions(["--for-month", "2026-10", "--excel", "--mode", "poin"]);
    const result = writeWorkbook(
      {
        options: { ...poinOptions, from: "2026-10-04", to: "2026-10-06", month: null },
        punches,
        daily,
        employees,
        calendar,
      },
      path,
    );
    expect(result.sheets).toEqual(["001 - Budi", "002 - Sari"]);

    const book = readFile(path);
    const sheet = book.Sheets["002 - Sari"]!;
    expect(sheet["A1"]?.v).toBe("Tanggal");
    expect(sheet["B1"]?.v).toBe("Nama");
    expect(sheet["G1"]?.v).toBe("Status");
    expect(sheet["B2"]?.v).toBe("Sari");
    expect(sheet["E2"]?.v).toBe("5 mnt");
    expect(sheet["G2"]?.v).toBe("Telat");

    unlinkSync(path);
  });

  test("user and poin together keep both sheets per employee", () => {
    const bothOptions = parseExportOptions([
      "--for-month",
      "2026-10",
      "--excel",
      "--mode",
      "user,poin",
      "--user",
      "001",
    ]);
    const result = writeWorkbook(
      {
        options: { ...bothOptions, from: "2026-10-04", to: "2026-10-06", month: null },
        punches,
        daily,
        employees,
        calendar,
      },
      path,
    );
    expect(result.sheets).toEqual(["001 - Budi", "001 - Budi (poin)"]);
    unlinkSync(path);
  });

  test("recap columns stop at today for the current month", () => {
    const result = writeWorkbook(
      {
        options: { ...options, from: "2026-10-04", to: "2026-10-31", month: null },
        punches,
        daily,
        employees,
        calendar,
        today: "2026-10-05",
      },
      path,
    );

    const book = readFile(path);
    const sheet = book.Sheets["Masuk"]!;
    expect(sheet["B1"]?.v).toBe("04/10/26");
    expect(sheet["C1"]?.v).toBe("05/10/26");
    expect(sheet["D1"]?.v).toBe("Total terlambat");
    expect(sheet["D3"]).toMatchObject({ f: "SUM(B3:C3)", v: 30 });
    expect(result.sheets).toEqual(["Raw", "Masuk", "Pulang", "001 - Budi", "002 - Sari"]);

    unlinkSync(path);
  });

  test("inactive employees leave recap and user sheets but stay in raw", () => {
    const extra = employee("003", "Nonaktif", false);
    const rows = [
      ...punches,
      { idNumber: "003", name: "Nonaktif", date: "2026-10-05", time: "07:10:00", verify: 15 },
    ];
    const extraDaily = buildDaily(rows, calendar);
    const result = writeWorkbook(
      {
        options: { ...options, from: "2026-10-04", to: "2026-10-06", month: null },
        punches: rows,
        daily: extraDaily,
        employees: [...employees, extra],
        calendar,
      },
      path,
    );

    expect(result.sheets).toEqual(["Raw", "Masuk", "Pulang", "001 - Budi", "002 - Sari"]);
    const book = readFile(path);
    expect(book.Sheets["Masuk"]?.["!ref"]).toBe("A1:G4");
    const raw = utils.sheet_to_json(book.Sheets["Raw"]!, { header: 1 }) as unknown[][];
    expect(raw.some((line) => line[1] === "003")).toBe(true);

    // An explicit --user still gets its sheet, active or not.
    const selected = parseExportOptions([
      "--for-month",
      "2026-10",
      "--excel",
      "--mode",
      "user",
      "--user",
      "003",
    ]);
    const explicit = writeWorkbook(
      {
        options: selected,
        punches: rows,
        daily: extraDaily,
        employees: [...employees, extra],
        calendar,
      },
      path,
    );
    expect(explicit.sheets).toEqual(["003 - Nonaktif"]);

    unlinkSync(path);
  });

  test("explicit users get a sheet even without punches, and names are sanitized", () => {
    const selected = parseExportOptions([
      "--for-month",
      "2026-10",
      "--excel",
      "--mode",
      "user",
      "--user",
      "999",
    ]);
    const result = writeWorkbook(
      {
        options: selected,
        punches,
        daily,
        employees: [...employees, employee("999", "Nama [A/B] panjang sekali")],
        calendar,
      },
      path,
    );
    expect(result.sheets).toEqual(["999 - Nama AB panjang sekali"]);
    expect(result.sheets[0]!.length).toBeLessThanOrEqual(31);
    expect(utils.sheet_to_json(readFile(path).Sheets[result.sheets[0]!]!, { header: 1 })).toEqual([
      ["Date", "Name", "Jadwal", "Time", "Status", "Verification", "Keterangan Waktu"],
    ]);

    unlinkSync(path);
  });

  test("no punches is NO_DATA and writes no file", () => {
    const target = join(tmpdir(), `rekap-workbook-empty-${process.pid}.xlsx`);
    let thrown: unknown;
    try {
      writeWorkbook({ options, punches: [], daily: [], employees, calendar }, target);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExportError);
    expect((thrown as ExportError).code).toBe("NO_DATA");
    expect(existsSync(target)).toBe(false);
  });

  test("the default path follows the period", () => {
    expect(defaultExportPath(jsonOptions)).toContain(`rekap-${jsonOptions.month}.xlsx`);
    const range = parseExportOptions(["--from", "2026-10-01", "--to", "2026-10-20", "--excel"]);
    expect(defaultExportPath(range)).toContain("rekap-2026-10-01_2026-10-20.xlsx");
  });
});
