// Offline parity tests for the src/zk.ts port.
// Raw fixture bytes only; no network and no live device.

import { describe, expect, test } from "bun:test";
import { DeviceError, type DeviceAttendance, type DeviceErrorCode } from "../src/device.ts";
import { decodeTime, parseAttendance, parseUsers } from "../src/zk.ts";
import {
  encodeAttendance,
  encodeUsers,
  encodeZkTime,
  u32,
  type FixtureUser,
} from "./support/device-codec.ts";
import {
  loadAttendance,
  loadEdge,
  loadLegacy,
  loadManifest,
  loadUsers,
  readFixtureBytes,
} from "./support/fixtures.ts";

const manifest = loadManifest();
const mainUsersBytes = readFixtureBytes("device/users-72.bin");
const mainAttendanceBytes = readFixtureBytes("device/attendance-40.bin");

function stripUid(
  rows: Array<{
    uid: number;
    idNumber: string;
    name: string;
    date: string;
    time: string;
    punch: number;
    verify: number;
  }>,
): DeviceAttendance[] {
  return rows.map(({ uid: _uid, ...rest }) => ({ ...rest, punch: rest.punch as 0 | 1 }));
}

function expectDeviceError(fn: () => unknown, code: DeviceErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeviceError);
  expect((caught as DeviceError).code).toBe(code);
}

function truncate(buffer: Buffer, records: number, size: number): Buffer {
  return buffer.subarray(0, 4 + records * size);
}

function singleUser(overrides: Partial<FixtureUser> = {}): FixtureUser {
  return {
    uid: 1,
    idNumber: "1001",
    name: "Satu",
    privilege: 0,
    card: 0,
    groupId: "",
    ...overrides,
  };
}

describe("decodeTime", () => {
  test("round-trips a device timestamp", () => {
    expect(decodeTime(encodeZkTime("2026-10-20", "07:28:34"))).toEqual({
      date: "2026-10-20",
      time: "07:28:34",
    });
  });

  test("rejects a short buffer", () => {
    expectDeviceError(() => decodeTime(Buffer.alloc(3)), "ZK_PARSE");
  });

  // Device timestamps can encode impossible calendar dates; reject at the
  // parser boundary instead of passing them to the recap.
  test("rejects an impossible calendar date", () => {
    expectDeviceError(() => decodeTime(encodeZkTime("2026-02-31", "07:00:00")), "ZK_PARSE");
  });

  test("rejects a year outside 2000-2100", () => {
    expectDeviceError(() => decodeTime(encodeZkTime("2101-01-01", "00:00:00")), "ZK_PARSE");
  });
});

describe("parseUsers", () => {
  test("decodes the main 72-byte fixture", () => {
    expect(parseUsers(mainUsersBytes, manifest.counts.users)).toEqual(loadUsers().users);
  });

  test("decodes the edge 72-byte fixture", () => {
    expect(
      parseUsers(readFixtureBytes("device/edge-users-72.bin"), manifest.counts.edge_users),
    ).toEqual(loadEdge().users);
  });

  test("decodes the legacy 28-byte layout", () => {
    const legacy = loadLegacy();
    expect(
      parseUsers(readFixtureBytes(legacy.files.users28), manifest.counts.legacy_users),
    ).toEqual(legacy.expected_users);
  });

  test("returns empty when the device reports zero users", () => {
    expect(parseUsers(Buffer.alloc(0), 0)).toEqual([]);
  });

  test("rejects a short buffer", () => {
    expectDeviceError(() => parseUsers(Buffer.alloc(3), 1), "ZK_PARSE");
  });

  test("rejects an unknown packet size", () => {
    const data = Buffer.concat([u32(100), Buffer.alloc(100)]);
    expectDeviceError(() => parseUsers(data, 1), "ZK_PARSE");
  });

  test("aborts when parsed users do not match the device count", () => {
    expectDeviceError(
      () => parseUsers(truncate(mainUsersBytes, 10, 72), manifest.counts.users),
      "ZK_COUNT_MISMATCH",
    );
  });

  test("falls back to uid when id_number is empty", () => {
    const users = parseUsers(encodeUsers([singleUser({ uid: 42, idNumber: "" })]), 1);
    expect(users[0]?.idNumber).toBe("42");
  });
});

describe("parseAttendance", () => {
  test("decodes the main 40-byte fixture", () => {
    const users = parseUsers(mainUsersBytes, manifest.counts.users);
    expect(parseAttendance(mainAttendanceBytes, manifest.counts.attendance, users)).toEqual(
      stripUid(loadAttendance().records),
    );
  });

  test("decodes the edge 40-byte fixture", () => {
    const edge = loadEdge();
    const users = parseUsers(
      readFixtureBytes("device/edge-users-72.bin"),
      manifest.counts.edge_users,
    );
    expect(
      parseAttendance(
        readFixtureBytes("device/edge-attendance-40.bin"),
        manifest.counts.edge_attendance,
        users,
      ),
    ).toEqual(stripUid(edge.attendance));
  });

  test("decodes legacy 8-byte records through the user UID map", () => {
    const legacy = loadLegacy();
    const users = parseUsers(readFixtureBytes(legacy.files.users28), manifest.counts.legacy_users);
    expect(
      parseAttendance(
        readFixtureBytes(legacy.files.attendance8),
        manifest.counts.legacy_attendance8,
        users,
      ),
    ).toEqual(stripUid(legacy.expected_attendance8));
  });

  test("decodes legacy 16-byte records", () => {
    const legacy = loadLegacy();
    const users = parseUsers(readFixtureBytes(legacy.files.users28), manifest.counts.legacy_users);
    expect(
      parseAttendance(
        readFixtureBytes(legacy.files.attendance16),
        manifest.counts.legacy_attendance16,
        users,
      ),
    ).toEqual(stripUid(legacy.expected_attendance16));
  });

  test("returns empty when the device reports zero records", () => {
    expect(parseAttendance(Buffer.alloc(0), 0, [])).toEqual([]);
  });

  test("rejects a short buffer", () => {
    expectDeviceError(() => parseAttendance(Buffer.alloc(3), 1, []), "ZK_PARSE");
  });

  test("rejects an unknown packet size", () => {
    const data = Buffer.concat([u32(100), Buffer.alloc(100)]);
    expectDeviceError(() => parseAttendance(data, 1, []), "ZK_PARSE");
  });

  test("aborts when parsed attendance does not match the device count", () => {
    const users = parseUsers(mainUsersBytes, manifest.counts.users);
    expectDeviceError(
      () =>
        parseAttendance(truncate(mainAttendanceBytes, 10, 40), manifest.counts.attendance, users),
      "ZK_COUNT_MISMATCH",
    );
  });

  test("joins 40-byte records by id_number, not the unreliable uid", () => {
    const users = parseUsers(encodeUsers([singleUser()]), 1);
    const rows = parseAttendance(
      encodeAttendance([
        {
          uid: 999,
          idNumber: "1001",
          name: "",
          date: "2026-10-20",
          time: "07:00:00",
          punch: 0,
          verify: 15,
        },
      ]),
      1,
      users,
    );
    expect(rows[0]).toMatchObject({ idNumber: "1001", name: "Satu" });
  });

  test("falls back to uid when a 40-byte record has no id_number", () => {
    const rows = parseAttendance(
      encodeAttendance([
        {
          uid: 42,
          idNumber: "",
          name: "",
          date: "2026-10-20",
          time: "07:00:00",
          punch: 0,
          verify: 15,
        },
      ]),
      1,
      [],
    );
    expect(rows[0]?.idNumber).toBe("42");
  });

  test("uses id_number as name when the user master has no match", () => {
    const rows = parseAttendance(
      encodeAttendance([
        {
          uid: 1,
          idNumber: "777",
          name: "",
          date: "2026-10-20",
          time: "07:00:00",
          punch: 0,
          verify: 15,
        },
      ]),
      1,
      [],
    );
    expect(rows[0]?.name).toBe("777");
  });
});
