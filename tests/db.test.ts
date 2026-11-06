import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Db,
  DbError,
  assertSafeDbPath,
  openDb,
  openMemoryDb,
  type AttendanceInput,
  type EmployeeInput,
} from "../src/db.ts";

const SYNCED_AT = "2026-10-20T07:00:00+07:00";

function employee(idNumber: string, name = `Dummy ${idNumber}`): EmployeeInput {
  return { uid: Number(idNumber), idNumber, name, privilege: 0, card: 0, groupId: "1" };
}

function attendance(
  idNumber: string,
  date: string,
  time: string,
  punch: 0 | 1 = 0,
): AttendanceInput {
  return { idNumber, date, time, punch, verify: 15 };
}

let db: Db;

beforeEach(() => {
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
});

describe("database schema", () => {
  test("migrates an empty database to the latest version", () => {
    expect(db.schemaVersion).toBe(8);
    expect(db.countEmployees()).toBe(0);
    expect(db.countAttendance()).toBe(0);
    expect(db.lastSync()).toBeNull();
  });

  test("rejects the default production DB in test/staging mode", () => {
    expect(() => assertSafeDbPath("absen.sqlite", "test")).toThrow(DbError);
    expect(() => assertSafeDbPath("absen.sqlite", "staging")).toThrow(DbError);
    expect(() => assertSafeDbPath(":memory:", "test")).not.toThrow();
    expect(() => assertSafeDbPath("absen.sqlite", "production")).not.toThrow();
  });
});

describe("employee profiles", () => {
  test("defaults to the device name and active", () => {
    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);

    expect(db.listEmployeeProfiles()).toEqual([
      {
        idNumber: "992",
        deviceName: "Dummy Siti",
        displayName: null,
        prefixTitle: "",
        suffixTitle: "",
        active: true,
        updatedAt: SYNCED_AT,
      },
    ]);
    expect(db.getEmployeeProfile("404")).toBeNull();
  });

  test("upserts the mapping without touching the employee row", () => {
    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: false,
      updatedAt: "2026-10-21T10:00:00+07:00",
    });

    expect(db.getEmployeeProfile("992")).toEqual({
      idNumber: "992",
      deviceName: "Dummy Siti",
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: false,
      updatedAt: "2026-10-21T10:00:00+07:00",
    });
    expect(db.listEmployees()[0]?.name).toBe("Dummy Siti");

    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: null,
      prefixTitle: "",
      suffixTitle: "",
      active: true,
      updatedAt: "2026-10-21T11:00:00+07:00",
    });
    expect(db.getEmployeeProfile("992")).toMatchObject({
      displayName: null,
      active: true,
      updatedAt: "2026-10-21T11:00:00+07:00",
    });
  });
});

describe("share links", () => {
  test("stores, reads, and purges expired links", () => {
    db.upsertEmployees([employee("992")], SYNCED_AT);
    db.insertShareLink({
      token: "11111111-1111-4111-8111-111111111111",
      idNumber: "992",
      month: "2026-10",
      createdAt: SYNCED_AT,
      expiresAt: 1_000,
    });

    expect(db.getShareLink("11111111-1111-4111-8111-111111111111")).toEqual({
      token: "11111111-1111-4111-8111-111111111111",
      idNumber: "992",
      month: "2026-10",
      createdAt: SYNCED_AT,
      expiresAt: 1_000,
    });
    expect(db.getShareLink("missing")).toBeNull();
    expect(db.deleteExpiredShareLinks(999)).toBe(0);
    expect(db.deleteExpiredShareLinks(1_000)).toBe(1);
    expect(db.getShareLink("11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});

describe("sync lock", () => {
  test("allows one owner and releases only the owner's lock", () => {
    expect(db.tryAcquireSyncLock("first", 1_000, 100)).toBe(true);
    expect(db.tryAcquireSyncLock("second", 1_001, 100)).toBe(false);

    db.releaseSyncLock("second");
    expect(db.tryAcquireSyncLock("second", 1_002, 100)).toBe(false);

    db.releaseSyncLock("first");
    expect(db.tryAcquireSyncLock("second", 1_003, 100)).toBe(true);
  });

  test("takes over an expired lock", () => {
    expect(db.tryAcquireSyncLock("first", 1_000, 100)).toBe(true);
    expect(db.tryAcquireSyncLock("second", 1_099, 100)).toBe(false);
    expect(db.tryAcquireSyncLock("second", 1_100, 100)).toBe(true);
  });

  test("shares the lock across database connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "absenly-lock-"));
    const path = join(dir, "test.sqlite");
    const first = new Db(new Database(path, { create: true }));
    const second = new Db(new Database(path, { create: true }));

    try {
      expect(first.tryAcquireSyncLock("first", 1_000, 100)).toBe(true);
      expect(second.tryAcquireSyncLock("second", 1_001, 100)).toBe(false);

      first.releaseSyncLock("first");
      expect(second.tryAcquireSyncLock("second", 1_002, 100)).toBe(true);
      second.releaseSyncLock("second");
    } finally {
      first.close();
      second.close();
      // Windows keeps the SQLite handle briefly after close, so the temp dir may
      // still be busy. Cleanup must never fail the test: a leaked dir under TEMP
      // is harmless, a red build is not. No sleep here; rmSync already retries.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Best effort only.
      }
    }
  }, 20_000);
});

describe("attendance writes", () => {
  test("upserts employees and attendance idempotently", () => {
    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);
    db.upsertAttendance(
      [attendance("992", "2026-10-20", "07:28:34"), attendance("992", "2026-10-20", "16:30:15")],
      SYNCED_AT,
    );

    expect(db.countEmployees()).toBe(1);
    expect(db.countAttendance()).toBe(2);
    expect(db.listAttendance().map((row) => row.status)).toEqual(["IN", "OUT"]);

    db.upsertAttendance(
      [attendance("992", "2026-10-20", "07:28:34", 1)],
      "2026-10-20T08:00:00+07:00",
    );

    expect(db.countAttendance()).toBe(2);
    expect(db.listAttendance()[0]).toMatchObject({ rawPunch: 1, verify: 15 });
  });

  test("creates a placeholder employee for an unknown attendance ID", () => {
    db.upsertAttendance([attendance("999", "2026-10-20", "07:00:00")], SYNCED_AT);

    expect(db.listEmployees()).toEqual([
      {
        idNumber: "999",
        name: "999",
        card: 0,
        groupId: "",
        privilege: 0,
        deviceUid: null,
        syncedAt: SYNCED_AT,
      },
    ]);
  });

  test("uses the 10:00 boundary for stored status", () => {
    db.upsertEmployees([employee("992")], SYNCED_AT);
    db.upsertAttendance(
      [attendance("992", "2026-10-20", "09:59:59"), attendance("992", "2026-10-20", "10:00:00")],
      SYNCED_AT,
    );

    expect(db.listAttendance().map((row) => row.status)).toEqual(["IN", "OUT"]);
  });

  test("rolls back a failed transaction", () => {
    expect(() =>
      db.transaction(() => {
        db.upsertEmployees([employee("992")], SYNCED_AT);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(db.countEmployees()).toBe(0);
  });
});

describe("queries", () => {
  test("filters attendance by an inclusive date range", () => {
    db.upsertEmployees([employee("992")], SYNCED_AT);
    db.upsertAttendance(
      [
        attendance("992", "2026-10-19", "16:00:00"),
        attendance("992", "2026-10-20", "07:00:00"),
        attendance("992", "2026-10-21", "07:00:00"),
      ],
      SYNCED_AT,
    );

    expect(db.listAttendance("2026-10-20", "2026-10-20").map((row) => row.date)).toEqual([
      "2026-10-20",
    ]);
  });

  test("pages attendance with the employee name and full total", () => {
    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);
    db.upsertAttendance(
      [
        attendance("992", "2026-10-20", "07:00:00"),
        attendance("992", "2026-10-20", "16:00:00"),
        attendance("992", "2026-10-21", "07:00:00"),
      ],
      SYNCED_AT,
    );

    const page = db.listAttendancePage({
      from: "2026-10-01",
      to: "2026-10-31",
      idNumber: "992",
      page: 2,
      perPage: 2,
    });

    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      date: "2026-10-21",
      time: "07:00:00",
      name: "Dummy Siti",
      idNumber: "992",
    });
  });

  test("stores success and failure sync logs", () => {
    db.recordSync({
      startedAt: "2026-10-20T07:00:00+07:00",
      finishedAt: "2026-10-20T07:00:01+07:00",
      durationMs: 1000,
      users: 56,
      records: 2518,
      firstDate: "2026-09-28",
      lastDate: "2026-10-20",
      ok: true,
    });
    db.recordSync({
      startedAt: "2026-10-20T08:00:00+07:00",
      finishedAt: "2026-10-20T08:00:02+07:00",
      durationMs: 2000,
      users: 0,
      records: 0,
      firstDate: null,
      lastDate: null,
      ok: false,
      error: "ZK_COUNT_MISMATCH",
    });

    expect(db.lastSync()).toMatchObject({
      ok: false,
      error: "ZK_COUNT_MISMATCH",
      users: 0,
      records: 0,
    });
    expect(db.lastSync()?.firstDate).toBeNull();
  });
});

test("openDb opens an in-memory database in test mode", () => {
  const memory = openDb(":memory:", "test");
  expect(memory.schemaVersion).toBe(8);
  memory.close();
});

describe("sync schedules", () => {
  test("inserts, lists, toggles, and deletes rows", () => {
    expect(db.listSyncSchedules()).toEqual([]);

    const morning = db.insertSyncSchedule(
      {
        days: "MONDAY,FRIDAY",
        startTime: "07:00",
        endTime: "09:00",
        everyMinutes: 5,
        enabled: true,
      },
      SYNCED_AT,
    );
    const evening = db.insertSyncSchedule(
      {
        days: "*",
        startTime: "19:00",
        endTime: "21:00",
        everyMinutes: 30,
        enabled: false,
      },
      SYNCED_AT,
    );
    expect(morning).toBe(1);
    expect(evening).toBe(2);

    expect(db.listSyncSchedules()).toEqual([
      {
        id: 1,
        days: "MONDAY,FRIDAY",
        startTime: "07:00",
        endTime: "09:00",
        everyMinutes: 5,
        enabled: true,
        createdAt: SYNCED_AT,
      },
      {
        id: 2,
        days: "*",
        startTime: "19:00",
        endTime: "21:00",
        everyMinutes: 30,
        enabled: false,
        createdAt: SYNCED_AT,
      },
    ]);

    expect(db.setSyncScheduleEnabled(2, true)).toBe(true);
    expect(db.listSyncSchedules()[1]!.enabled).toBe(true);
    expect(db.setSyncScheduleEnabled(99, true)).toBe(false);

    expect(db.deleteSyncSchedule(1)).toBe(true);
    expect(db.deleteSyncSchedule(1)).toBe(false);
    expect(db.listSyncSchedules().map((row) => row.id)).toEqual([2]);
  });

  test("rejects an interval outside the CHECK range", () => {
    expect(() =>
      db.insertSyncSchedule(
        { days: "*", startTime: "07:00", endTime: "09:00", everyMinutes: 0, enabled: true },
        SYNCED_AT,
      ),
    ).toThrow();
  });
});

describe("work exception spans by date range", () => {
  test("returns spans that touch the range, including one starting the day before", () => {
    db.upsertEmployees([employee("00123", "Budi")], SYNCED_AT);
    db.insertWorkException(
      {
        idNumber: "00123",
        kind: "night_shift",
        startDate: "2026-10-04",
        startTime: "21:00:00",
        endDate: "2026-10-05",
        endTime: "07:00:00",
        note: "Piket",
      },
      SYNCED_AT,
    );
    db.insertWorkException(
      {
        idNumber: "00123",
        kind: "overtime",
        startDate: "2026-10-20",
        startTime: "13:00:00",
        endDate: "2026-10-20",
        endTime: "17:00:00",
        note: null,
      },
      SYNCED_AT,
    );

    // October 5 only: the piket that started on the 4th still applies.
    const spans = db.listWorkExceptionSpansInRange("2026-10-05", "2026-10-05");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({
      idNumber: "00123",
      startDate: "2026-10-04",
      startTime: "21:00:00",
      endDate: "2026-10-05",
      endTime: "07:00:00",
    });

    expect(db.listWorkExceptionSpansInRange("2026-10-01", "2026-10-31")).toHaveLength(2);
    expect(db.listWorkExceptionSpansInRange("2026-10-01", "2026-10-31", "99999")).toHaveLength(0);
    expect(db.listWorkExceptionSpansInRange("2026-11-01", "2026-11-30")).toHaveLength(0);
  });
});

describe("admin credentials and backup", () => {
  test("stores, replaces, and clears the admin password hash", () => {
    expect(db.getAdminPasswordHash()).toBeNull();
    db.saveAdminPasswordHash("hash-1", SYNCED_AT);
    expect(db.getAdminPasswordHash()).toBe("hash-1");
    db.saveAdminPasswordHash("hash-2", SYNCED_AT);
    expect(db.getAdminPasswordHash()).toBe("hash-2");
    expect(db.clearAdminPasswordHash()).toBe(true);
    expect(db.getAdminPasswordHash()).toBeNull();
    expect(db.clearAdminPasswordHash()).toBe(false);
  });

  test("seeds profiles for all employees without overwriting edits", () => {
    db.upsertEmployees([employee("992", "Dummy Siti"), employee("993", "Dummy Budi")], SYNCED_AT);
    expect(db.countEmployeeProfiles()).toBe(2);
    expect(db.countActiveProfiles()).toBe(2);

    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: false,
      updatedAt: SYNCED_AT,
    });

    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);
    expect(db.getEmployeeProfile("992")).toMatchObject({
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: false,
    });
    expect(db.countEmployeeProfiles()).toBe(2);
    expect(db.countActiveProfiles()).toBe(1);
  });

  test("VACUUM INTO writes a readable consistent snapshot", () => {
    db.upsertEmployees([employee("992", "Dummy Siti")], SYNCED_AT);
    db.saveAdminPasswordHash("hash", SYNCED_AT);

    const dir = mkdtempSync(join(tmpdir(), "rekap-db-backup-"));
    const path = join(dir, "copy.sqlite");
    try {
      db.backupTo(path);
      const copy = openDb(path, "test");
      try {
        expect(copy.schemaVersion).toBe(8);
        expect(copy.countEmployees()).toBe(1);
        expect(copy.getAdminPasswordHash()).toBe("hash");
      } finally {
        copy.close();
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows may keep the SQLite file locked until the handle is collected.
      }
    }
  });
});
