import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "../src/schedule-store.ts";
import { ScheduleError, type ScheduleCalendar } from "../src/schedule.ts";

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
  overrides: [],
};

let dirs: string[] = [];

function tempFile(text = JSON.stringify(CALENDAR)): string {
  const dir = mkdtempSync(join(tmpdir(), "rekap-schedule-"));
  dirs.push(dir);
  const path = join(dir, "schedule.json");
  writeFileSync(path, text, "utf8");
  return path;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("schedule store", () => {
  test("reloads a changed file and keeps the old calendar on bad JSON", () => {
    const path = tempFile();
    let mtime = 1;
    let text = JSON.stringify(CALENDAR);
    const store = new ScheduleStore({
      calendar: CALENDAR,
      source: "file",
      filePath: path,
      statMtime: () => mtime,
      readFile: () => text,
    });

    expect(store.reloadIfChanged()).toBe(false);

    const changed = structuredClone(CALENDAR);
    changed.base.SATURDAY = { in: "08:00", out: "12:00" };
    text = JSON.stringify(changed);
    mtime = 2;
    expect(store.reloadIfChanged()).toBe(true);
    expect(store.calendar.base.SATURDAY).toEqual({ in: "08:00", out: "12:00" });

    text = "{not json";
    mtime = 3;
    expect(store.reloadIfChanged()).toBe(false);
    expect(store.calendar.base.SATURDAY).toEqual({ in: "08:00", out: "12:00" });
    expect(store.lastError?.code).toBe("SCHEDULE_JSON");
  });

  test("saves atomically and updates the in-memory calendar", () => {
    const path = tempFile();
    const store = new ScheduleStore({ calendar: CALENDAR, source: "file", filePath: path });
    const next = structuredClone(CALENDAR);
    next.base.SUNDAY = { in: "09:00", out: "12:00" };

    const saved = store.save(next);
    expect(saved.base.SUNDAY).toEqual({ in: "09:00", out: "12:00" });
    expect(store.calendar.base.SUNDAY).toEqual({ in: "09:00", out: "12:00" });
    expect(JSON.parse(readFileSync(path, "utf8")).base.SUNDAY).toEqual({
      in: "09:00",
      out: "12:00",
    });
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  test("refuses to write an env-backed schedule", () => {
    const store = new ScheduleStore({ calendar: CALENDAR, source: "env", filePath: null });
    let error: unknown;
    try {
      store.save(CALENDAR);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ScheduleError);
    expect((error as ScheduleError).code).toBe("SCHEDULE_READONLY");
  });
});
