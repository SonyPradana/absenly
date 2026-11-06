import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeAttendance, decodeUsers } from "./support/device-codec.ts";
import {
  fixturePath,
  loadAttendance,
  loadEdge,
  loadLegacy,
  loadManifest,
  loadSchedules,
  loadSyncScenario,
  loadUsers,
  loadWorkExceptions,
  readFixtureBytes,
} from "./support/fixtures.ts";
import { FakeDevice, makeCounts } from "./support/fake-device.ts";
import {
  buildDaily,
  byDateThenName,
  summarizeDaily,
  toApiDaily,
  type ReferenceDailyRow,
  type ReferenceSummary,
} from "./support/recap-reference.ts";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(fixturePath(relativePath), "utf8")) as T;
}

function numberInvariant(key: string): number {
  const value = loadManifest().invariants[key];
  if (typeof value !== "number") throw new Error(`invariant ${key} is not a number`);
  return value;
}

function attendanceByDate(
  rows: ReferenceDailyRow[],
  idNumber: string,
  date: string,
): ReferenceDailyRow {
  const row = rows.find((r) => r.id_number === idNumber && r.date === date);
  if (!row) throw new Error(`row not found: ${idNumber} ${date}`);
  return row;
}

describe("manifest + hashes", () => {
  test("schema and counts", () => {
    const manifest = loadManifest();
    const workExceptions = loadWorkExceptions();
    const schedules = loadSchedules();
    expect(manifest.schema).toBe("absenly/fixtures/v1");
    expect(manifest.counts.users).toBe(numberInvariant("users"));
    expect(manifest.counts.attendance).toBe(numberInvariant("records"));
    expect(manifest.counts.work_exceptions).toBe(workExceptions.valid.length);
    expect(manifest.counts.schedules_valid).toBe(schedules.valid.length);
    expect(manifest.counts.schedules_invalid).toBe(
      schedules.invalid.length + schedules.env_invalid.length,
    );
    expect(manifest.schedule.MONDAY).toEqual({ in: "07:00", out: "16:00" });
    expect(manifest.schedule.SATURDAY).toEqual({ in: "07:00", out: "12:00" });
    expect(manifest.schedule.SUNDAY).toBeNull();
  });

  test("every listed file exists and sha256 matches", () => {
    const manifest = loadManifest();
    const entries = Object.entries(manifest.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [relativePath, expected] of entries) {
      const bytes = readFixtureBytes(relativePath);
      expect(bytes.length).toBe(expected.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
    }
  });
});

describe("main fixture from the device snapshot", () => {
  const manifest = loadManifest();
  const usersFile = loadUsers();
  const attendanceFile = loadAttendance();
  const users = usersFile.users;
  const records = attendanceFile.records;

  test("JSON and raw 72/40-byte data are consistent", () => {
    const usersRaw = readFixtureBytes("device/users-72.bin");
    const attendanceRaw = readFixtureBytes("device/attendance-40.bin");
    expect(usersRaw.length).toBe(4 + users.length * 72);
    expect(attendanceRaw.length).toBe(4 + records.length * 40);
    expect(usersRaw.readUInt32LE(0)).toBe(usersRaw.length - 4);
    expect(attendanceRaw.readUInt32LE(0)).toBe(attendanceRaw.length - 4);

    const decodedUsers = decodeUsers(usersRaw, users.length, 72);
    expect(decodedUsers).toEqual(users);
    const decodedAttendance = decodeAttendance(attendanceRaw, records.length, decodedUsers, 40);
    expect(decodedAttendance).toEqual(records);
  });

  test("main dataset satisfies live-data invariants", () => {
    expect(users.length).toBe(manifest.counts.users);
    expect(records.length).toBe(manifest.counts.attendance);
    expect(new Set(users.map((u) => u.idNumber)).size).toBe(users.length);
    expect(new Set(users.map((u) => u.uid)).size).toBe(users.length);

    const userIds = new Set(users.map((u) => u.idNumber));
    expect(records.every((r) => userIds.has(r.idNumber))).toBe(true);
    expect(records.every((r) => r.verify === 15)).toBe(true);
    expect(records.every((r) => r.punch === 0 || r.punch === 1)).toBe(true);

    const keys = records.map((r) => `${r.idNumber}|${r.date}|${r.time}`);
    expect(new Set(keys).size).toBe(records.length);
    expect(records.filter((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() === 0).length).toBe(0);

    const groups = new Map<string, typeof records>();
    for (const row of records) {
      const key = `${row.idNumber}|${row.date}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    const punchCounts = [...groups.values()].map((rows) => rows.length);
    expect(Math.min(...punchCounts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...punchCounts)).toBeLessThanOrEqual(9);
    expect(Math.min(...punchCounts)).toBe(numberInvariant("min_punches_per_user_day"));
    expect(Math.max(...punchCounts)).toBe(numberInvariant("max_punches_per_user_day"));

    const usersWithAttendance = new Set(records.map((r) => r.idNumber)).size;
    expect(usersWithAttendance).toBe(numberInvariant("users_with_attendance"));
    expect(users.length - usersWithAttendance).toBe(numberInvariant("users_without_attendance"));

    const missingIn = [...groups.values()].filter(
      (rows) => !rows.some((r) => r.time < "10:00:00"),
    ).length;
    const missingOut = [...groups.values()].filter(
      (rows) => !rows.some((r) => r.time >= "10:00:00"),
    ).length;
    expect(missingIn).toBe(numberInvariant("missing_in"));
    expect(missingOut).toBe(numberInvariant("missing_out"));

    const anomalies = records.filter((r) => (r.punch === 0) !== r.time < "10:00:00").length;
    expect(anomalies).toBe(numberInvariant("raw_punch_anomalies"));
    expect(anomalies).toBeGreaterThan(0);
  });

  test("synthetic names/IDs are safe and exercise 24-byte/comma quirks", () => {
    expect(users.every((u) => u.name.startsWith("Dummy "))).toBe(true);
    expect(users.every((u) => u.idNumber.startsWith("9"))).toBe(true);
    expect(users.every((u) => Buffer.byteLength(u.name, "utf8") <= 24)).toBe(true);
    expect(users.every((u) => Buffer.byteLength(u.idNumber, "utf8") <= 24)).toBe(true);
    expect(users.filter((u) => u.name.includes(",")).length).toBe(numberInvariant("comma_names"));
    expect(users.filter((u) => Buffer.byteLength(u.name, "utf8") === 24).length).toBe(
      numberInvariant("exact_24_byte_names"),
    );
    expect(users.filter((u) => u.name.includes(",")).length).toBeGreaterThan(0);
    expect(users.filter((u) => Buffer.byteLength(u.name, "utf8") === 24).length).toBeGreaterThan(0);
  });

  test("attendance UID intentionally cannot be used for joins", () => {
    const userIds = new Set(users.map((u) => u.uid));
    expect(records.some((r) => userIds.has(r.uid))).toBe(false);
  });

  test("password/card/reserved bytes are sanitized", () => {
    const usersRaw = readFixtureBytes("device/users-72.bin");
    const attendanceRaw = readFixtureBytes("device/attendance-40.bin");
    let nonzeroCards = 0;
    for (let i = 0; i < users.length; i++) {
      const off = 4 + i * 72;
      for (let j = off + 3; j < off + 11; j++) expect(usersRaw[j]).toBe(0);
      if (usersRaw.readUInt32LE(off + 35) !== 0) nonzeroCards++;
    }
    expect(nonzeroCards).toBeGreaterThan(0);
    for (let i = 0; i < records.length; i++) {
      const off = 4 + i * 40;
      for (let j = off + 32; j < off + 40; j++) expect(attendanceRaw[j]).toBe(0);
    }
  });

  test("main summary matches the reference recap", () => {
    const expected = readJson<{
      schedule: Parameters<typeof buildDaily>[1];
      daily_rows: number;
      first_date: string;
      last_date: string;
      summary: ReferenceSummary;
    }>("expected/main-summary.json");
    const daily = buildDaily(
      records.map((a) => ({
        idNumber: a.idNumber,
        name: a.name,
        date: a.date,
        time: a.time,
        punch: a.punch,
        verify: a.verify,
        uid: a.uid,
      })),
      expected.schedule,
    );
    expect(daily.length).toBe(expected.daily_rows);
    expect(daily[0]?.date).toBe(expected.first_date);
    expect(daily.at(-1)?.date).toBe(expected.last_date);
    expect(summarizeDaily(daily)).toEqual(expected.summary);
    expect(expected.summary.rows).toBe(numberInvariant("user_days"));
  });
});

describe("edge cases: 10:00, Sunday, and missing punches", () => {
  const edge = loadEdge();
  const daily = buildDaily(
    edge.attendance.map((a) => ({
      idNumber: a.idNumber,
      name: a.name,
      date: a.date,
      time: a.time,
      punch: a.punch,
      verify: a.verify,
      uid: a.uid,
    })),
    edge.schedule,
  );

  test("reference recap matches expected_daily", () => {
    expect(daily).toEqual(edge.expected_daily);
    expect(summarizeDaily(daily)).toEqual(edge.expected_summary);
  });

  test("business rule matrix", () => {
    const boundary = attendanceByDate(daily, "00123", "2026-10-05");
    expect(boundary.in_time).toBe("09:59:59");
    expect(boundary.out_time).toBe("10:00:00");
    expect(boundary.late_minutes).toBe(179);
    expect(boundary.early_minutes).toBe(360);
    expect(boundary.status).toBe("telat");

    const earlyOnly = attendanceByDate(daily, "00123", "2026-10-06");
    expect(earlyOnly.in_time).toBe("06:30:00");
    expect(earlyOnly.out_time).toBe("15:59:00");
    expect(earlyOnly.late_minutes).toBe(0);
    expect(earlyOnly.early_minutes).toBe(1);
    expect(earlyOnly.status).toBe("pulang_cepat");
    expect(earlyOnly.punches).toBe(3);

    const missingIn = attendanceByDate(daily, "00123", "2026-10-08");
    expect(missingIn.in_time).toBeNull();
    expect(missingIn.out_time).toBe("12:06:30");
    expect(missingIn.late_minutes).toBeNull();
    expect(missingIn.early_minutes).toBe(233);
    expect(missingIn.status).toBe("tanpa_masuk");

    const missingOut = attendanceByDate(daily, "00123", "2026-10-09");
    expect(missingOut.in_time).toBe("07:45:00");
    expect(missingOut.out_time).toBeNull();
    expect(missingOut.late_minutes).toBe(45);
    expect(missingOut.early_minutes).toBeNull();
    expect(missingOut.status).toBe("belum_pulang");

    const sunday = attendanceByDate(daily, "A-100", "2026-10-04");
    expect(sunday.is_workday).toBe(false);
    expect(sunday.status).toBe("libur");
    expect(sunday.late_minutes).toBe(0);
    expect(sunday.early_minutes).toBe(0);

    const both = attendanceByDate(daily, "A-100", "2026-10-06");
    expect(both.late_minutes).toBe(1);
    expect(both.early_minutes).toBe(1);
    expect(both.status).toBe("telat");

    const nine = attendanceByDate(daily, "A-100", "2026-10-07");
    expect(nine.punches).toBe(9);
    expect(nine.in_time).toBe("06:30:00");
    expect(nine.out_time).toBe("18:00:00");
    expect(nine.status).toBe("lengkap");

    const midnight = attendanceByDate(daily, "A-100", "2026-10-08");
    expect(midnight.in_time).toBe("00:00:00");
    expect(midnight.out_time).toBe("23:59:59");
    expect(midnight.status).toBe("lengkap");

    const sundayNoOut = attendanceByDate(daily, "A-100", "2026-10-11");
    expect(sundayNoOut.is_workday).toBe(false);
    expect(sundayNoOut.out_time).toBeNull();
    expect(sundayNoOut.status).toBe("libur");
    expect(sundayNoOut.late_minutes).toBe(0);
    expect(sundayNoOut.early_minutes).toBe(0);

    const afterBoundary = attendanceByDate(daily, "U-24", "2026-10-08");
    expect(afterBoundary.in_time).toBeNull();
    expect(afterBoundary.out_time).toBe("10:00:01");
    expect(afterBoundary.status).toBe("tanpa_masuk");

    const exact24 = attendanceByDate(daily, "EDGE-1", "2026-10-05");
    expect(Buffer.byteLength(exact24.name, "utf8")).toBe(24);
    const id24 = attendanceByDate(daily, "123456789012345678901234", "2026-10-05");
    expect(Buffer.byteLength(id24.id_number, "utf8")).toBe(24);
    const emptyName = attendanceByDate(daily, "EMPTY", "2026-10-06");
    expect(emptyName.name).toBe("");
  });

  test("per-day schedule: Saturday is shorter; Sunday is a day off only because it is empty", () => {
    const saturdayMissingIn = attendanceByDate(daily, "00123", "2026-10-10");
    expect(saturdayMissingIn.is_workday).toBe(true);
    expect(saturdayMissingIn.in_time).toBeNull();
    expect(saturdayMissingIn.out_time).toBe("10:00:00");
    expect(saturdayMissingIn.early_minutes).toBe(120);
    expect(saturdayMissingIn.status).toBe("tanpa_masuk");

    const saturdayFull = attendanceByDate(daily, "A-100", "2026-10-10");
    expect(saturdayFull.in_time).toBe("06:30:00");
    expect(saturdayFull.out_time).toBe("16:00:00");
    expect(saturdayFull.early_minutes).toBe(0);
    expect(saturdayFull.status).toBe("lengkap");

    const sundayPunches = edge.attendance
      .filter((a) => a.idNumber === "A-100" && a.date === "2026-10-04")
      .map((a) => ({
        idNumber: a.idNumber,
        name: a.name,
        date: a.date,
        time: a.time,
        punch: a.punch,
        verify: a.verify,
        uid: a.uid,
      }));
    const sundayWork = buildDaily(sundayPunches, {
      ...edge.schedule,
      SUNDAY: { in: "07:00", out: "12:00" },
    });
    expect(sundayWork.length).toBe(1);
    expect(sundayWork[0]?.is_workday).toBe(true);
    expect(sundayWork[0]?.late_minutes).toBe(0);
    expect(sundayWork[0]?.early_minutes).toBe(0);
    expect(sundayWork[0]?.status).toBe("lengkap");
  });

  test("raw edge 72/40-byte data is consistent", () => {
    const usersRaw = readFixtureBytes("device/edge-users-72.bin");
    const attendanceRaw = readFixtureBytes("device/edge-attendance-40.bin");
    const decodedUsers = decodeUsers(usersRaw, edge.users.length, 72);
    expect(decodedUsers).toEqual(edge.users);
    const decoded = decodeAttendance(attendanceRaw, edge.attendance.length, decodedUsers, 40);
    expect(decoded).toEqual(edge.attendance);
    expect(edge.attendance.some((a) => a.name === "")).toBe(true);
    expect(edge.attendance.some((a) => a.name.includes("<"))).toBe(true);
    expect(edge.attendance.some((a) => a.name.includes(","))).toBe(true);
  });

  test("golden edge summary", () => {
    expect(edge.expected_summary).toEqual({
      rows: 19,
      present: 19,
      late: 5,
      early: 8,
      incomplete: 5,
      late_minutes: 434,
      early_minutes: 1464,
      status_counts: {
        libur: 2,
        telat: 4,
        lengkap: 8,
        pulang_cepat: 1,
        tanpa_masuk: 3,
        belum_pulang: 1,
      },
    });
  });

  test("golden API recap and CLI export", () => {
    const expectedApi = readJson<{
      data: ReturnType<typeof toApiDaily>[];
      meta: Record<string, number | string>;
    }>("expected/api-recap-edge.json");
    const expectedCli = readJson<{
      data: ReturnType<typeof toApiDaily>[];
      meta: Record<string, number | string>;
    }>("expected/cli-export-edge.json");
    const apiRows = [...edge.expected_daily].sort(byDateThenName).map(toApiDaily);
    expect(expectedApi.data).toEqual(apiRows);
    expect(expectedApi.meta.total).toBe(apiRows.length);
    expect(expectedApi.meta.total_pages).toBe(1);
    expect(expectedCli.data).toEqual(apiRows);
    expect(expectedCli.meta.total).toBe(apiRows.length);
    expect(expectedCli.meta.per_page).toBe(apiRows.length);
  });
});

describe("legacy packet layouts", () => {
  const legacy = loadLegacy();

  test("28-byte users", () => {
    const raw = readFixtureBytes(legacy.files.users28);
    expect(raw.length).toBe(4 + legacy.users.length * 28);
    expect(decodeUsers(raw, legacy.users.length, 28)).toEqual(legacy.expected_users);
    expect(legacy.expected_users.map((u) => u.groupId)).toEqual(["3", "0", "1"]);
  });

  test("8-byte attendance uses UID -> user", () => {
    const raw = readFixtureBytes(legacy.files.attendance8);
    expect(raw.length).toBe(4 + legacy.attendance8.length * 8);
    const decoded = decodeAttendance(raw, legacy.attendance8.length, legacy.users, 8);
    expect(decoded).toEqual(legacy.expected_attendance8);
    expect(decoded[2]?.idNumber).toBe("77");
    expect(decoded[2]?.name).toBe("77");
  });

  test("16-byte attendance uses id_number", () => {
    const raw = readFixtureBytes(legacy.files.attendance16);
    expect(raw.length).toBe(4 + legacy.attendance16.length * 16);
    const decoded = decodeAttendance(raw, legacy.attendance16.length, legacy.users, 16);
    expect(decoded).toEqual(legacy.expected_attendance16);
    expect(decoded.every((a) => a.uid === 0)).toBe(true);
  });

  test("count mismatch is rejected, not partial data", () => {
    const usersRaw = readFixtureBytes(legacy.files.users28);
    const attendanceRaw = readFixtureBytes(legacy.files.attendance8);
    expect(() => decodeUsers(usersRaw, legacy.users.length + 1, 28)).toThrow(
      "user parsed 3, expected 4",
    );
    expect(() =>
      decodeAttendance(attendanceRaw, legacy.attendance8.length + 1, legacy.users, 8),
    ).toThrow("attendance parsed 3, expected 4");
  });
});

describe("sync race + retry scenario", () => {
  const scenario = loadSyncScenario();

  test("scenario data is consistent", () => {
    expect(scenario.users.length).toBe(3);
    expect(scenario.base_attendance.length).toBe(5);
    expect(scenario.live_attendance.length).toBe(7);
    expect(scenario.steps.length).toBe(4);
    const keys = new Set(scenario.live_attendance.map((r) => `${r.idNumber}|${r.date}|${r.time}`));
    expect(keys.size).toBe(7);
    expect(scenario.expected.final_attendance).toBe(7);
    expect(scenario.expected.after_repeat_attendance).toBe(7);
  });

  test("FakeDevice forces mismatch and retry", async () => {
    for (const step of scenario.steps) {
      const device = new FakeDevice({
        users: scenario.users,
        attendance: step.attendance,
        countsSequence: [
          {
            users: step.counts.users,
            records: step.counts.records,
            usersCap: 2000,
            recordsCap: 100000,
            fingers: 0,
          },
        ],
        validateCounts: true,
      });
      await device.connect();
      expect(device.connected).toBe(true);
      const counts = await device.getCounts();
      expect(counts.records).toBe(step.counts.records);
      const users = await device.getUsers();
      expect(users.length).toBe(3);
      if (step.expect === "ok") {
        const rows = await device.getAttendance();
        expect(rows.length).toBe(step.counts.records);
      } else {
        await expect(device.getAttendance()).rejects.toThrow("ZK_COUNT_MISMATCH");
      }
      await device.disconnect();
      expect(device.connected).toBe(false);
      expect(device.calls).toEqual([
        "connect",
        "getCounts",
        "getUsers",
        "getAttendance",
        "disconnect",
      ]);
    }
  });

  test("FakeDevice default counts follow the data", async () => {
    const device = new FakeDevice({
      users: scenario.users,
      attendance: scenario.base_attendance,
    });
    await device.connect();
    expect(await device.getCounts()).toEqual(makeCounts(3, 5));
    expect((await device.getUsers()).length).toBe(3);
    expect((await device.getAttendance()).length).toBe(5);
    await device.disconnect();
  });
});

describe("privacy fixture", () => {
  test("no real names/IDs leak into the main fixture", () => {
    const users = loadUsers().users;
    expect(users.every((u) => u.name.startsWith("Dummy "))).toBe(true);
    expect(users.every((u) => u.idNumber.startsWith("9"))).toBe(true);
  });

  test("device password is not copied into raw users", () => {
    const raw = readFixtureBytes("device/users-72.bin");
    const users = loadUsers().users;
    for (let i = 0; i < users.length; i++) {
      const off = 4 + i * 72;
      expect(raw.subarray(off + 3, off + 11).toString("latin1")).toBe("\0\0\0\0\0\0\0\0");
    }
  });
});
