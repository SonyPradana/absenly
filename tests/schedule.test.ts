import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScheduleConfig } from "../src/config.ts";
import {
  DAY_KEYS,
  ScheduleError,
  dayKeyForDate,
  parseScheduleCalendar,
  parseScheduleJson,
  resolveSchedule,
  scheduleFromEnv,
  type ScheduleCalendar,
  type ScheduleErrorCode,
  type ScheduleOverride,
  type WeeklySchedule,
} from "../src/schedule.ts";

const BASE: WeeklySchedule = {
  SUNDAY: null,
  MONDAY: { in: "07:00", out: "16:00" },
  TUESDAY: { in: "07:00", out: "16:00" },
  WEDNESDAY: { in: "07:00", out: "16:00" },
  THURSDAY: { in: "07:00", out: "16:00" },
  FRIDAY: { in: "07:00", out: "16:00" },
  SATURDAY: { in: "07:00", out: "12:00" },
};

const RAMADAN: WeeklySchedule = {
  SUNDAY: null,
  MONDAY: { in: "08:00", out: "15:00" },
  TUESDAY: { in: "08:00", out: "15:00" },
  WEDNESDAY: { in: "08:00", out: "15:00" },
  THURSDAY: { in: "08:00", out: "15:00" },
  FRIDAY: { in: "08:00", out: "15:00" },
  SATURDAY: { in: "08:00", out: "12:00" },
};

const RAMADAN_OVERRIDE: ScheduleOverride = {
  id: "ramadan-2027",
  from: "2027-02-18",
  to: "2027-03-19",
  priority: 10,
  note: "Ramadan",
  schedule: RAMADAN,
};

function calendar(overrides: ScheduleOverride[] = []): ScheduleCalendar {
  return { version: 1, base: BASE, overrides };
}

function errorCode(fn: () => unknown): ScheduleErrorCode {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScheduleError) return error.code;
    throw error;
  }
  throw new Error("expected ScheduleError");
}

function missingFile(): never {
  const error = new Error("missing") as Error & { code: string };
  error.code = "ENOENT";
  throw error;
}

describe("JSON calendar validation", () => {
  test("base and date overrides are inclusive", () => {
    const parsed = parseScheduleCalendar({
      version: 1,
      base: BASE,
      overrides: [RAMADAN_OVERRIDE],
    });

    expect(resolveSchedule(parsed, "2027-02-17")).toEqual(BASE.WEDNESDAY);
    expect(resolveSchedule(parsed, "2027-02-18")).toEqual(RAMADAN.THURSDAY);
    expect(resolveSchedule(parsed, "2027-03-19")).toEqual(RAMADAN.FRIDAY);
    expect(resolveSchedule(parsed, "2027-03-20")).toEqual(BASE.SATURDAY);
  });

  test("null override means a full day off; priority picks the winner", () => {
    const holiday: ScheduleOverride = {
      id: "holiday-2027-03-10",
      from: "2027-03-10",
      to: "2027-03-10",
      priority: 20,
      schedule: null,
    };
    const parsed = parseScheduleCalendar({
      version: 1,
      base: BASE,
      overrides: [RAMADAN_OVERRIDE, holiday],
    });

    expect(resolveSchedule(parsed, "2027-03-10")).toBeNull();
    expect(resolveSchedule(parsed, "2027-03-11")).toEqual(RAMADAN.THURSDAY);
  });

  test("higher priority wins without changing other days", () => {
    const special: ScheduleOverride = {
      id: "special-2027-03-11",
      from: "2027-03-11",
      to: "2027-03-11",
      priority: 20,
      schedule: {
        ...RAMADAN,
        THURSDAY: { in: "09:00", out: "14:00" },
      },
    };
    const parsed = parseScheduleCalendar({
      version: 1,
      base: BASE,
      overrides: [RAMADAN_OVERRIDE, special],
    });

    expect(resolveSchedule(parsed, "2027-03-11")).toEqual({ in: "09:00", out: "14:00" });
    expect(resolveSchedule(parsed, "2027-03-12")).toEqual(RAMADAN.FRIDAY);
  });

  test("invalid dates are rejected during resolve", () => {
    const parsed = calendar();
    expect(errorCode(() => resolveSchedule(parsed, "2027-02-30"))).toBe("SCHEDULE_DATE");
    expect(errorCode(() => dayKeyForDate("20-10-2026"))).toBe("SCHEDULE_DATE");
  });
});

describe("calendar config validation", () => {
  test("valid schema is accepted; overrides may be empty", () => {
    const parsed = parseScheduleCalendar({ version: 1, base: BASE });
    expect(parsed.overrides).toEqual([]);
    expect(parsed.base.SUNDAY).toBeNull();
  });

  test("schema errors use stable codes", () => {
    expect(errorCode(() => parseScheduleCalendar({ version: 2, base: BASE }))).toBe(
      "SCHEDULE_VERSION",
    );

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: { ...BASE, FUNDAY: { in: "07:00", out: "16:00" } },
        }),
      ),
    ).toBe("SCHEDULE_DAY");

    const withoutSaturday = Object.fromEntries(
      Object.entries(BASE).filter(([day]) => day !== "SATURDAY"),
    );
    expect(errorCode(() => parseScheduleCalendar({ version: 1, base: withoutSaturday }))).toBe(
      "SCHEDULE_DAY",
    );

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: { ...BASE, MONDAY: { in: "07:00" } },
        }),
      ),
    ).toBe("SCHEDULE_PAIR");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: { ...BASE, MONDAY: { in: "7:00", out: "16:00" } },
        }),
      ),
    ).toBe("SCHEDULE_TIME");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: { ...BASE, MONDAY: { in: "16:00", out: "07:00" } },
        }),
      ),
    ).toBe("SCHEDULE_ORDER");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: Object.fromEntries(DAY_KEYS.map((day) => [day, null])),
        }),
      ),
    ).toBe("SCHEDULE_EMPTY");
  });

  test("invalid overrides are rejected", () => {
    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: BASE,
          overrides: [RAMADAN_OVERRIDE, { ...RAMADAN_OVERRIDE, id: "ramadan-2027" }],
        }),
      ),
    ).toBe("SCHEDULE_OVERRIDE_ID");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: BASE,
          overrides: [{ ...RAMADAN_OVERRIDE, from: "2027-02-30" }],
        }),
      ),
    ).toBe("SCHEDULE_DATE");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: BASE,
          overrides: [{ ...RAMADAN_OVERRIDE, from: "2027-03-20", to: "2027-03-19" }],
        }),
      ),
    ).toBe("SCHEDULE_RANGE");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: BASE,
          overrides: [{ ...RAMADAN_OVERRIDE, priority: -1 }],
        }),
      ),
    ).toBe("SCHEDULE_PRIORITY");

    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: BASE,
          overrides: [
            RAMADAN_OVERRIDE,
            {
              id: "overlap",
              from: "2027-03-01",
              to: "2027-03-02",
              priority: 10,
              schedule: RAMADAN,
            },
          ],
        }),
      ),
    ).toBe("SCHEDULE_OVERLAP");
  });

  test("malformed JSON is rejected with SCHEDULE_JSON", () => {
    expect(errorCode(() => parseScheduleJson("{"))).toBe("SCHEDULE_JSON");
  });

  test("a UTF-8 BOM is ignored", () => {
    const text = `\uFEFF${JSON.stringify({ version: 1, base: BASE })}`;
    expect(parseScheduleJson(text).base.MONDAY).toEqual(BASE.MONDAY);
  });

  test("a null note is treated as absent", () => {
    const parsed = parseScheduleCalendar({
      version: 1,
      base: BASE,
      overrides: [{ ...RAMADAN_OVERRIDE, note: null }],
    });
    expect(parsed.overrides[0]?.note).toBeUndefined();
  });

  test("a non-object day is a shape error", () => {
    expect(
      errorCode(() =>
        parseScheduleCalendar({
          version: 1,
          base: { ...BASE, MONDAY: "07:00-16:00" },
        }),
      ),
    ).toBe("SCHEDULE_SHAPE");
  });

  test("same-priority overrides may be adjacent without overlapping", () => {
    const parsed = parseScheduleCalendar({
      version: 1,
      base: BASE,
      overrides: [
        { ...RAMADAN_OVERRIDE, id: "first", from: "2027-01-01", to: "2027-01-02", priority: 5 },
        { ...RAMADAN_OVERRIDE, id: "second", from: "2027-01-03", to: "2027-01-04", priority: 5 },
      ],
    });
    expect(parsed.overrides.map((override) => override.id)).toEqual(["first", "second"]);
  });
});

describe("flat env fallback", () => {
  test("one shift is used for every day, including Sunday", () => {
    const fallback = scheduleFromEnv({
      ABSEN_SCHEDULE_IN: "08:00",
      ABSEN_SCHEDULE_OUT: "17:00",
    });

    for (const day of DAY_KEYS) {
      expect(fallback[day]).toEqual({ in: "08:00", out: "17:00" });
    }
  });

  test("invalid fallback uses stable codes", () => {
    expect(errorCode(() => scheduleFromEnv({}))).toBe("SCHEDULE_FALLBACK");
    expect(errorCode(() => scheduleFromEnv({ ABSEN_SCHEDULE_IN: "08:00" }))).toBe("SCHEDULE_PAIR");
    expect(
      errorCode(() => scheduleFromEnv({ ABSEN_SCHEDULE_IN: "", ABSEN_SCHEDULE_OUT: "17:00" })),
    ).toBe("SCHEDULE_PAIR");
    expect(
      errorCode(() => scheduleFromEnv({ ABSEN_SCHEDULE_IN: "8:00", ABSEN_SCHEDULE_OUT: "17:00" })),
    ).toBe("SCHEDULE_TIME");
    expect(
      errorCode(() => scheduleFromEnv({ ABSEN_SCHEDULE_IN: "17:00", ABSEN_SCHEDULE_OUT: "08:00" })),
    ).toBe("SCHEDULE_ORDER");
  });

  test("env values are trimmed", () => {
    const fallback = scheduleFromEnv({
      ABSEN_SCHEDULE_IN: " 08:00 ",
      ABSEN_SCHEDULE_OUT: "\t17:00 ",
    });
    expect(fallback.SUNDAY).toEqual({ in: "08:00", out: "17:00" });
  });
});

describe("config loader", () => {
  test("a valid file takes precedence", () => {
    const loaded = loadScheduleConfig({
      env: {},
      cwd: "C:/work",
      readFile: () => JSON.stringify({ version: 1, base: BASE, overrides: [RAMADAN_OVERRIDE] }),
    });

    expect(loaded.source).toBe("file");
    expect(loaded.calendar.overrides).toHaveLength(1);
    expect(loaded.filePath).toContain("schedule.json");
    expect(loaded.filePath).not.toContain("config");
  });

  test("a missing file uses the flat env fallback", () => {
    const loaded = loadScheduleConfig({
      env: { ABSEN_SCHEDULE_IN: "08:00", ABSEN_SCHEDULE_OUT: "17:00" },
      readFile: missingFile,
    });

    expect(loaded.source).toBe("env");
    expect(loaded.calendar.overrides).toEqual([]);
    expect(loaded.calendar.base.SUNDAY).toEqual({ in: "08:00", out: "17:00" });
  });

  test("an existing invalid file does not fall back to env", () => {
    expect(
      errorCode(() =>
        loadScheduleConfig({
          env: { ABSEN_SCHEDULE_IN: "08:00", ABSEN_SCHEDULE_OUT: "17:00" },
          readFile: () => "{",
        }),
      ),
    ).toBe("SCHEDULE_JSON");

    expect(
      errorCode(() =>
        loadScheduleConfig({
          env: { ABSEN_SCHEDULE_IN: "08:00", ABSEN_SCHEDULE_OUT: "17:00" },
          readFile: () => JSON.stringify({ version: 2, base: BASE }),
        }),
      ),
    ).toBe("SCHEDULE_VERSION");
  });

  test("read errors other than ENOENT do not fall back to env", () => {
    expect(
      errorCode(() =>
        loadScheduleConfig({
          env: { ABSEN_SCHEDULE_IN: "08:00", ABSEN_SCHEDULE_OUT: "17:00" },
          readFile: () => {
            throw new Error("permission denied");
          },
        }),
      ),
    ).toBe("SCHEDULE_READ");
  });

  test("an absolute schedule path is used as-is", () => {
    const path = join(process.cwd(), "abs-schedule.json");
    let seen = "";
    const loaded = loadScheduleConfig({
      env: { ABSEN_SCHEDULE_FILE: path },
      cwd: "C:/ignored",
      readFile: (file) => {
        seen = file;
        return JSON.stringify({ version: 1, base: BASE });
      },
    });

    expect(seen).toBe(path);
    expect(loaded.filePath).toBe(path);
  });

  test("an empty schedule path falls back to the default", () => {
    let seen = "";
    const loaded = loadScheduleConfig({
      env: { ABSEN_SCHEDULE_FILE: "   " },
      cwd: "C:/work",
      readFile: (file) => {
        seen = file;
        return JSON.stringify({ version: 1, base: BASE });
      },
    });

    expect(seen.endsWith("schedule.json")).toBe(true);
    expect(loaded.source).toBe("file");
    expect(loaded.filePath).toBe(seen);
  });
});

test("root schedule.json starter is valid", () => {
  const text = readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8");
  const parsed = parseScheduleJson(text);
  expect(parsed.base.SUNDAY).toBeNull();
  expect(Object.values(parsed.base).filter((day) => day !== null).length).toBeGreaterThan(0);
  for (const day of Object.values(parsed.base)) {
    if (day === null) continue;
    expect(day.in < day.out).toBe(true);
  }
  expect(parsed.overrides).toEqual([]);
});
