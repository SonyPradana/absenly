// Auto-sync rules and ticker. Pure rules plus a fake sync; no device, no DB.

import { describe, expect, test } from "bun:test";
import {
  createAutoSync,
  formatDays,
  isDue,
  parseDays,
  parseSyncSchedule,
  SyncScheduleError,
  type SyncScheduleRule,
} from "../src/auto-sync.ts";
import { NOOP_LOGGER, type AppLogger } from "../src/log.ts";

const ANY: SyncScheduleRule = {
  days: "*",
  startTime: "07:00",
  endTime: "09:00",
  everyMinutes: 5,
  enabled: true,
};

/** WIB is UTC+7; these helpers keep the test times readable. */
function wib(text: string): Date {
  return new Date(`${text}+07:00`);
}

describe("parseDays", () => {
  test("accepts *, a name list, and normalizes order", () => {
    expect(parseDays("*")).toEqual([
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
    ]);
    expect(parseDays("saturday,monday")).toEqual(["MONDAY", "SATURDAY"]);
    expect(parseDays("MONDAY,MONDAY")).toEqual(["MONDAY"]);
    expect(formatDays(parseDays("monday,saturday")!)).toBe("MONDAY,SATURDAY");
    expect(formatDays(parseDays("*")!)).toBe("*");
  });

  test("rejects empty, unknown, and non-string days", () => {
    expect(parseDays("")).toBeNull();
    expect(parseDays("MONDAY,")).toBeNull();
    expect(parseDays("SENIN")).toBeNull();
    expect(parseDays(null)).toBeNull();
    expect(parseDays(7)).toBeNull();
  });
});

describe("parseSyncSchedule", () => {
  test("fills defaults and shapes a valid row", () => {
    expect(
      parseSyncSchedule({
        days: "monday",
        start_time: "07:00",
        end_time: "09:00",
        every_minutes: 5,
      }),
    ).toEqual({
      days: "MONDAY",
      startTime: "07:00",
      endTime: "09:00",
      everyMinutes: 5,
      enabled: true,
    });
    expect(
      parseSyncSchedule({
        start_time: "08:00",
        end_time: "08:05",
        every_minutes: 5,
        enabled: false,
      }),
    ).toEqual({
      days: "*",
      startTime: "08:00",
      endTime: "08:05",
      everyMinutes: 5,
      enabled: false,
    });
  });

  test("rejects malformed times, inverted windows, and bad intervals", () => {
    const base = { days: "*", start_time: "07:00", end_time: "09:00", every_minutes: 5 };
    const bad = (patch: Record<string, unknown>) => () => parseSyncSchedule({ ...base, ...patch });

    expect(bad({ start_time: "7:00" })).toThrow(SyncScheduleError);
    expect(bad({ start_time: "24:00" })).toThrow(SyncScheduleError);
    expect(bad({ end_time: "07:00:00" })).toThrow(SyncScheduleError);
    // A window crossing midnight is rejected, not guessed.
    expect(bad({ start_time: "22:00", end_time: "02:00" })).toThrow(SyncScheduleError);
    expect(bad({ every_minutes: 0 })).toThrow(SyncScheduleError);
    expect(bad({ every_minutes: 1441 })).toThrow(SyncScheduleError);
    expect(bad({ every_minutes: 2.5 })).toThrow(SyncScheduleError);
    expect(bad({ every_minutes: "5" })).toThrow(SyncScheduleError);
    // Longer than the window itself would never fire twice.
    expect(bad({ start_time: "07:00", end_time: "07:04", every_minutes: 5 })).toThrow(
      SyncScheduleError,
    );
    expect(bad({ days: "SENIN" })).toThrow(SyncScheduleError);
    expect(bad({ enabled: "yes" })).toThrow(SyncScheduleError);
    expect(() => parseSyncSchedule(null)).toThrow(SyncScheduleError);
  });

  test("carries the field name on the error", () => {
    try {
      parseSyncSchedule({ start_time: "07:00", end_time: "09:00", every_minutes: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncScheduleError);
      expect((error as SyncScheduleError).field).toBe("every_minutes");
    }
  });
});

describe("isDue", () => {
  test("fires inside the window and not outside it", () => {
    // 2026-11-04 is a Wednesday.
    expect(isDue([ANY], null, wib("2026-11-04T07:00")).due).toBe(true);
    expect(isDue([ANY], null, wib("2026-11-04T08:59")).due).toBe(true);
    // end_time is exclusive.
    expect(isDue([ANY], null, wib("2026-11-04T09:00")).due).toBe(false);
    expect(isDue([ANY], null, wib("2026-11-04T06:59")).due).toBe(false);
    expect(isDue([ANY], null, wib("2026-11-04T21:00")).due).toBe(false);
  });

  test("respects every_minutes since the last attempt", () => {
    const rule = { ...ANY, everyMinutes: 15 };
    const last = wib("2026-11-04T07:10");

    const early = isDue([rule], last, wib("2026-11-04T07:20"));
    expect(early.due).toBe(false);
    expect(early.waitingForInterval).toBe(true);
    expect(early.nextAt?.toISOString()).toBe(wib("2026-11-04T07:25").toISOString());

    expect(isDue([rule], last, wib("2026-11-04T07:25")).due).toBe(true);
    expect(isDue([rule], last, wib("2026-11-04T07:40")).due).toBe(true);
  });

  test("treats a failed attempt as an attempt", () => {
    // lastAttemptAt comes from sync_log, so a failure still rate-limits.
    const last = wib("2026-11-04T07:02");
    expect(isDue([ANY], last, wib("2026-11-04T07:03")).due).toBe(false);
    expect(isDue([ANY], last, wib("2026-11-04T07:07")).due).toBe(true);
  });

  test("only matches the listed weekdays", () => {
    const weekend = { ...ANY, days: "SATURDAY,SUNDAY" };
    expect(isDue([weekend], null, wib("2026-11-04T08:00")).due).toBe(false); // Wednesday
    expect(isDue([weekend], null, wib("2026-11-07T08:00")).due).toBe(true); // Saturday
    expect(isDue([weekend], null, wib("2026-11-08T08:00")).due).toBe(true); // Sunday

    const monday = { ...ANY, days: "MONDAY" };
    expect(isDue([monday], null, wib("2026-11-04T08:00")).due).toBe(false);
    expect(isDue([monday], null, wib("2026-11-09T08:00")).due).toBe(true);
  });

  test("unions many rows and ignores disabled ones", () => {
    const morning = { ...ANY, startTime: "07:00", endTime: "09:00" };
    const evening = { ...ANY, startTime: "19:00", endTime: "21:00" };

    expect(isDue([morning, evening], null, wib("2026-11-04T08:00")).due).toBe(true);
    expect(isDue([morning, evening], null, wib("2026-11-04T20:00")).due).toBe(true);
    expect(isDue([morning, evening], null, wib("2026-11-04T12:00")).due).toBe(false);

    const off = { ...evening, enabled: false };
    expect(isDue([off], null, wib("2026-11-04T20:00")).due).toBe(false);
    expect(isDue([], null, wib("2026-11-04T08:00")).due).toBe(false);
  });

  test("lets the most permissive row win", () => {
    // One row every 60m and one every 5m open: the 5m row decides.
    const slow = { ...ANY, everyMinutes: 60 };
    const fast = { ...ANY, everyMinutes: 5 };
    const last = wib("2026-11-04T07:30");
    expect(isDue([slow, fast], last, wib("2026-11-04T07:36")).due).toBe(true);
    expect(isDue([slow, fast], last, wib("2026-11-04T07:32")).due).toBe(false);
  });

  test("reports the next window start when nothing is open", () => {
    const morning = { ...ANY, days: "MONDAY", startTime: "07:00", endTime: "09:00" };
    // Wednesday 12:00 -> next Monday 07:00 WIB.
    const decision = isDue([morning], null, wib("2026-11-04T12:00"));
    expect(decision.due).toBe(false);
    expect(decision.nextAt?.toISOString()).toBe(wib("2026-11-09T07:00").toISOString());

    const everyDay = { ...ANY, startTime: "19:00", endTime: "21:00" };
    const later = isDue([everyDay], null, wib("2026-11-04T12:00"));
    expect(later.nextAt?.toISOString()).toBe(wib("2026-11-04T19:00").toISOString());
  });

  test("returns a null nextAt when nothing can ever match", () => {
    expect(isDue([], null, wib("2026-11-04T08:00")).nextAt).toBeNull();
    expect(isDue([{ ...ANY, enabled: false }], null, wib("2026-11-04T08:00")).nextAt).toBeNull();
  });
});

describe("createAutoSync", () => {
  interface Fake {
    schedules: SyncScheduleRule[];
    last: { startedAt: string } | null;
    calls: number;
    fail: Error | null;
    lines: string[];
    clockAt: string;
  }

  function harness(initial: Partial<Fake> = {}) {
    const state: Fake = {
      schedules: [],
      last: null,
      calls: 0,
      fail: null,
      lines: [],
      clockAt: "",
      ...initial,
    };
    const clock = { at: wib("2026-11-04T07:30:30") };
    const logger: AppLogger = {
      info(message) {
        state.lines.push(message);
      },
    };
    const auto = createAutoSync({
      db: {
        listSyncSchedules: () =>
          state.schedules.map((rule, index) => ({
            ...rule,
            id: index + 1,
            createdAt: "2026-11-04T00:00:00+07:00",
          })),
        lastSync: () =>
          state.last === null
            ? null
            : {
                id: 1,
                startedAt: state.last.startedAt,
                finishedAt: state.last.startedAt,
                durationMs: 1,
                users: 1,
                records: 1,
                firstDate: null,
                lastDate: null,
                ok: true,
                error: null,
              },
      },
      sync: async () => {
        state.calls += 1;
        if (state.fail !== null) {
          state.last = { startedAt: state.last?.startedAt ?? state.clockAt };
          throw state.fail;
        }
        state.last = { startedAt: state.clockAt };
      },
      logger,
      now: () => clock.at,
    });
    state.clockAt = clock.at.toISOString();
    return {
      state,
      auto,
      advance: (minutes: number) => {
        clock.at = new Date(clock.at.getTime() + minutes * 60_000);
        state.clockAt = clock.at.toISOString();
      },
    };
  }

  test("syncs when a schedule is open", async () => {
    const { state, auto } = harness({ schedules: [ANY] });
    await auto.tick();
    expect(state.calls).toBe(1);
    expect(state.lines).toEqual(["auto sync start"]);
    expect(auto.started).toBe(false);
  });

  test("does nothing without an open schedule", async () => {
    const { state, auto } = harness({ schedules: [] });
    await auto.tick();
    expect(state.calls).toBe(0);
    expect(state.lines).toEqual([]);
  });

  test("skips a busy sync without raising", async () => {
    const { state, auto } = harness({ schedules: [ANY] });
    state.fail = new Error("SYNC_IN_PROGRESS: another sync is already running");
    await auto.tick();
    expect(state.lines.some((line) => line.includes("skipped (busy)"))).toBe(true);
  });

  test("logs a device failure and keeps the ticker alive", async () => {
    const { state, auto, advance } = harness({ schedules: [ANY] });
    state.fail = new Error("device unavailable");
    await auto.tick();
    expect(state.lines.some((line) => line.includes("auto sync error: device unavailable"))).toBe(
      true,
    );

    // The failed attempt still counts, so the next tick waits out the interval.
    state.fail = null;
    await auto.tick();
    expect(state.calls).toBe(1);
    advance(5);
    await auto.tick();
    expect(state.calls).toBe(2);
  });

  test("start and stop are idempotent", () => {
    const { auto } = harness({ schedules: [ANY] });
    auto.start();
    expect(auto.started).toBe(true);
    auto.start();
    expect(auto.started).toBe(true);
    auto.stop();
    auto.stop();
    expect(auto.started).toBe(false);
    expect(NOOP_LOGGER).toBeDefined();
  });
});
