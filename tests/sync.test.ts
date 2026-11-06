import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openMemoryDb, type Db } from "../src/db.ts";
import { DeviceError, type DeviceGateway } from "../src/device.ts";
import { syncNow, SyncError } from "../src/sync.ts";
import type { AppLogger } from "../src/log.ts";
import {
  FakeDevice,
  makeCounts,
  type DeviceAttendance as FakeAttendance,
  type DeviceUser as FakeUser,
} from "./support/fake-device.ts";

const USERS: FakeUser[] = [
  { uid: 501, idNumber: "9001", name: "Dummy Satu", privilege: 0, card: 0, groupId: "" },
  { uid: 502, idNumber: "9002", name: "Dummy Dua", privilege: 0, card: 0, groupId: "" },
  { uid: 503, idNumber: "9003", name: "Dummy Tiga", privilege: 0, card: 0, groupId: "" },
];

const BASE: FakeAttendance[] = [
  {
    uid: 1,
    idNumber: "9001",
    name: "Dummy Satu",
    date: "2026-10-05",
    time: "07:30:00",
    punch: 0,
    verify: 15,
  },
  {
    uid: 2,
    idNumber: "9001",
    name: "Dummy Satu",
    date: "2026-10-05",
    time: "17:00:00",
    punch: 1,
    verify: 15,
  },
  {
    uid: 3,
    idNumber: "9002",
    name: "Dummy Dua",
    date: "2026-10-05",
    time: "08:05:00",
    punch: 0,
    verify: 15,
  },
  {
    uid: 4,
    idNumber: "9002",
    name: "Dummy Dua",
    date: "2026-10-05",
    time: "16:55:00",
    punch: 1,
    verify: 15,
  },
  {
    uid: 5,
    idNumber: "9003",
    name: "Dummy Tiga",
    date: "2026-10-05",
    time: "12:00:00",
    punch: 0,
    verify: 15,
  },
];

const LIVE: FakeAttendance[] = [
  ...BASE,
  {
    uid: 6,
    idNumber: "9002",
    name: "Dummy Dua",
    date: "2026-10-05",
    time: "17:10:00",
    punch: 1,
    verify: 15,
  },
  {
    uid: 7,
    idNumber: "9003",
    name: "Dummy Tiga",
    date: "2026-10-05",
    time: "13:00:00",
    punch: 1,
    verify: 15,
  },
];

function gateway(device: FakeDevice): DeviceGateway {
  return device as unknown as DeviceGateway;
}

function collectLogger(): { logger: AppLogger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { info: (line) => lines.push(line) }, lines };
}

let db: Db;

beforeEach(() => {
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
});

describe("syncNow", () => {
  test("writes a full snapshot and a successful sync log", async () => {
    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    const result = await syncNow({ device: gateway(fake), db });

    expect(result).toMatchObject({
      ok: true,
      users: 3,
      records: 5,
      firstDate: "2026-10-05",
      lastDate: "2026-10-05",
      attempts: 1,
    });
    expect(db.countEmployees()).toBe(3);
    expect(db.countAttendance()).toBe(5);
    expect(db.lastSync()).toMatchObject({ ok: true, users: 3, records: 5 });
    expect(fake.calls).toEqual(["connect", "readSnapshot", "disconnect"]);
  });

  test("is idempotent across repeated syncs", async () => {
    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    await syncNow({ device: gateway(fake), db });
    await syncNow({ device: gateway(fake), db });

    expect(db.countEmployees()).toBe(3);
    expect(db.countAttendance()).toBe(5);
    expect(db.lastSync()?.ok).toBe(true);
    expect(db.tryAcquireSyncLock("after-success", Date.now(), 1_000)).toBe(true);
  });

  test("rejects a sync while another owner holds the lock", async () => {
    expect(db.tryAcquireSyncLock("other-process", Date.now(), 60_000)).toBe(true);
    const fake = new FakeDevice({ users: USERS, attendance: BASE });

    try {
      await syncNow({ device: gateway(fake), db });
      throw new Error("expected sync to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe("SYNC_IN_PROGRESS");
    }

    expect(fake.calls).toEqual([]);
    expect(db.lastSync()).toBeNull();
    db.releaseSyncLock("other-process");
  });

  test("retries the whole sync after a count mismatch", async () => {
    const fake = new FakeDevice({
      users: USERS,
      attendance: BASE,
      countsSequence: [makeCounts(3, 7), makeCounts(3, 7)],
      attendanceSequence: [BASE, LIVE],
    });

    const result = await syncNow({ device: gateway(fake), db });

    expect(result).toMatchObject({ ok: true, records: 7, attempts: 2 });
    expect(db.countAttendance()).toBe(7);
    expect(fake.calls.filter((call) => call === "readSnapshot")).toHaveLength(2);
    expect(fake.calls.filter((call) => call === "connect")).toHaveLength(2);
    expect(fake.calls.filter((call) => call === "disconnect")).toHaveLength(2);
  });

  test("writes no rows and logs a failure after repeated mismatches", async () => {
    const fake = new FakeDevice({
      users: USERS,
      attendance: BASE,
      countsSequence: [makeCounts(3, 7)],
      attendanceSequence: [BASE],
    });

    try {
      await syncNow({ device: gateway(fake), db });
      throw new Error("expected sync to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceError);
      expect((error as DeviceError).code).toBe("ZK_COUNT_MISMATCH");
    }

    expect(db.countEmployees()).toBe(0);
    expect(db.countAttendance()).toBe(0);
    expect(db.lastSync()).toMatchObject({ ok: false });
    expect(db.lastSync()?.error).toContain("ZK_COUNT_MISMATCH");
    expect(fake.calls.filter((call) => call === "readSnapshot")).toHaveLength(3);
    expect(fake.calls.filter((call) => call === "connect")).toHaveLength(3);
  });

  test("logs a connect failure without writing rows", async () => {
    const fake = new FakeDevice({
      users: USERS,
      attendance: BASE,
      failConnect: new Error("network down"),
    });

    await expect(syncNow({ device: gateway(fake), db })).rejects.toThrow("network down");
    expect(db.countAttendance()).toBe(0);
    expect(db.lastSync()).toMatchObject({ ok: false });
    expect(db.tryAcquireSyncLock("after-failure", Date.now(), 1_000)).toBe(true);
  });

  test("logs start, retries, success, and failures without personal data", async () => {
    const ok = collectLogger();
    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    await syncNow({ device: gateway(fake), db, logger: ok.logger });
    expect(ok.lines[0]).toBe("sync start");
    expect(ok.lines[1]).toContain("sync done: 3 users, 5 records");
    expect(ok.lines.join("\n")).not.toContain("9001");
    expect(ok.lines.join("\n")).not.toContain("Dummy");

    const retry = collectLogger();
    const flaky = new FakeDevice({
      users: USERS,
      attendance: BASE,
      countsSequence: [makeCounts(3, 7), makeCounts(3, 7)],
      attendanceSequence: [BASE, LIVE],
    });
    await syncNow({ device: gateway(flaky), db, logger: retry.logger });
    expect(retry.lines.some((line) => line.includes("retry after count mismatch"))).toBe(true);

    const failure = collectLogger();
    const failing = new FakeDevice({
      users: USERS,
      attendance: BASE,
      failConnect: new Error("network down"),
    });
    await expect(syncNow({ device: gateway(failing), db, logger: failure.logger })).rejects.toThrow(
      "network down",
    );
    expect(failure.lines.some((line) => line.startsWith("sync error: network down"))).toBe(true);
  });
});
