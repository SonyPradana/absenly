// Generate offline fixtures from a device snapshot JSON.
//
// The snapshot is not part of the repo (it contains PII). This generator replaces
// identities, clears passwords/cards, and writes fixtures that are safe to commit.
// Capture a snapshot with a separate read-only tool, then run:
//
//   bun run tests/fixtures/generate.ts --snapshot <snapshot.json>
//
// After that, tests need no device or network.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  decodeAttendance,
  decodeUsers,
  encodeAttendance,
  encodeUsers,
  type FixtureUser,
} from "../support/device-codec.ts";
import {
  buildDaily,
  byDateThenName,
  summarizeDaily,
  toApiDaily,
  type WeeklySchedule,
} from "../support/recap-reference.ts";
import type {
  AttendanceFile,
  EdgeFile,
  FixtureManifest,
  LegacyFile,
  NamedFixtureAttendance,
  SchedulesFile,
  SyncScenarioFile,
  UsersFile,
  WorkExceptionsFile,
} from "../support/fixtures.ts";
import type { WorkExceptionInput } from "../support/work-exceptions.ts";
import { scheduleToEnv } from "../support/schedule.ts";

interface RealSnapshot {
  schema: string;
  captured_at: string;
  counts: { users: number; records: number; usersCap: number; recordsCap: number; fingers: number };
  stats: Record<string, unknown>;
  users: FixtureUser[];
  attendance: NamedFixtureAttendance[];
  raw: {
    users_base64: string;
    attendance_base64: string;
    users_sha256: string;
    attendance_sha256: string;
  };
}

// Per-day schedule. Saturday is intentionally shorter so tests catch code that
// still hardcodes Monday-Saturday 07:00-16:00. Sunday null = day off.
const SCHEDULE: WeeklySchedule = {
  MONDAY: { in: "07:00", out: "16:00" },
  TUESDAY: { in: "07:00", out: "16:00" },
  WEDNESDAY: { in: "07:00", out: "16:00" },
  THURSDAY: { in: "07:00", out: "16:00" },
  FRIDAY: { in: "07:00", out: "16:00" },
  SATURDAY: { in: "07:00", out: "12:00" },
  SUNDAY: null,
};
const SPLIT_TIME = "10:00:00";

const FIRST_NAMES = [
  "Adi",
  "Andi",
  "Anisa",
  "Bayu",
  "Bintang",
  "Citra",
  "Dewi",
  "Dimas",
  "Eka",
  "Fajar",
  "Fitri",
  "Gilang",
  "Hana",
  "Indah",
  "Joko",
  "Kartika",
  "Lestari",
  "Mega",
  "Nanda",
  "Putra",
  "Rani",
  "Rizky",
  "Sari",
  "Sinta",
  "Taufik",
  "Wahyu",
  "Yuni",
  "Zaki",
];
const LAST_NAMES = [
  "Pratama",
  "Saputra",
  "Wijaya",
  "Nugroho",
  "Hidayat",
  "Ramadhan",
  "Kusuma",
  "Pertiwi",
  "Maharani",
  "Handayani",
  "Siregar",
  "Simbolon",
  "Nasution",
  "Lubis",
  "Santoso",
  "Gunawan",
  "Halim",
  "Ismail",
  "Putri",
  "Anggraini",
];
const TITLES = ["S.T.", "S.Kom", "S.ST", "S.H.", "A.Md", "S.Pd", "S.E.", "M.M.", "S.KM", "S.Psi"];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function wibStamp(d = new Date()): string {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${s.replace(" ", "T")}+07:00`;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeFixed(
  buf: Buffer,
  offset: number,
  length: number,
  value: string,
  label: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`${label} ${JSON.stringify(value)} = ${bytes.length} byte, maksimum ${length}`);
  }
  bytes.copy(buf, offset);
  if (bytes.length < length) buf.fill(0, offset + bytes.length, offset + length);
}

function userKey(u: FixtureUser): string {
  return JSON.stringify([u.uid, u.idNumber, u.name, u.privilege, u.card, u.groupId]);
}

function attendanceKey(a: NamedFixtureAttendance): string {
  return JSON.stringify([a.uid, a.idNumber, a.name, a.date, a.time, a.punch, a.verify]);
}

function checkSourceConsistency(
  snapshot: RealSnapshot,
  users: FixtureUser[],
  attendance: NamedFixtureAttendance[],
): void {
  assert(users.length === snapshot.counts.users, "jumlah user raw != counts");
  assert(attendance.length === snapshot.counts.records, "jumlah attendance raw != counts");
  snapshot.users.forEach((u, i) => {
    assert(userKey(u) === userKey(users[i]!), `user ${i} snapshot != raw`);
  });
  snapshot.attendance.forEach((a, i) => {
    assert(attendanceKey(a) === attendanceKey(attendance[i]!), `attendance ${i} snapshot != raw`);
  });
}

function makeSyntheticId(
  realId: string,
  index: number,
  used: Set<string>,
  realIds: Set<string>,
): string {
  const length = realId.length;
  if (length === 1) {
    for (const c of "9876543210") {
      if (!used.has(c) && !realIds.has(c)) {
        used.add(c);
        return c;
      }
    }
    throw new Error("tidak ada ID 1 karakter yang unik");
  }
  let n = index + 1;
  for (let tries = 0; tries < 1_000_000; tries++, n++) {
    const candidate = `9${String(n).padStart(length - 1, "0")}`;
    if (candidate.length !== length) continue;
    if (used.has(candidate) || realIds.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  throw new Error(`tidak bisa membuat ID sintetis untuk ${realId}`);
}

function makeExact24Names(count: number, used: Set<string>): string[] {
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = `Dummy Karyawan ${String(n).padStart(9, "0")}`;
    assert(Buffer.byteLength(name, "utf8") === 24, `nama exact24 salah: ${name}`);
    assert(!name.includes(","), `nama exact24 tidak boleh comma: ${name}`);
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }
  return names;
}

function makeCommaNames(count: number, used: Set<string>): string[] {
  const names: string[] = [];
  for (const first of FIRST_NAMES) {
    for (const title of TITLES) {
      if (names.length >= count) return names;
      const name = `Dummy ${first}, ${title}`;
      const bytes = Buffer.byteLength(name, "utf8");
      if (bytes >= 24 || used.has(name)) continue;
      used.add(name);
      names.push(name);
    }
  }
  throw new Error(`tidak cukup nama comma: butuh ${count}, dapat ${names.length}`);
}

function makeNormalNames(count: number, used: Set<string>): string[] {
  const names: string[] = [];
  for (const first of FIRST_NAMES) {
    for (const last of LAST_NAMES) {
      if (names.length >= count) return names;
      const name = `Dummy ${first} ${last}`;
      const bytes = Buffer.byteLength(name, "utf8");
      if (bytes >= 24 || name.includes(",") || used.has(name)) continue;
      used.add(name);
      names.push(name);
    }
  }
  throw new Error(`tidak cukup nama normal: butuh ${count}, dapat ${names.length}`);
}

function makeNamePlan(realUsers: FixtureUser[]): string[] {
  const used = new Set<string>();
  const exactCount = realUsers.filter((u) => Buffer.byteLength(u.name, "utf8") === 24).length;
  const commaCount = realUsers.filter((u) => u.name.includes(",")).length;
  const normalCount = realUsers.length - exactCount - commaCount;
  const names = [
    ...makeExact24Names(exactCount, used),
    ...makeCommaNames(commaCount, used),
    ...makeNormalNames(normalCount, used),
  ];
  assert(names.length === realUsers.length, "jumlah nama sintetis tidak sama dengan user");
  return names;
}

function summarizeMain(users: FixtureUser[], attendance: NamedFixtureAttendance[]) {
  const dates = [...new Set(attendance.map((a) => a.date))].sort();
  const byUser = new Map<string, number>();
  const byUserDate = new Map<string, NamedFixtureAttendance[]>();
  for (const a of attendance) {
    byUser.set(a.idNumber, (byUser.get(a.idNumber) ?? 0) + 1);
    const key = `${a.idNumber}|${a.date}`;
    const list = byUserDate.get(key) ?? [];
    list.push(a);
    byUserDate.set(key, list);
  }
  let missingIn = 0;
  let missingOut = 0;
  let rawPunchAnomalies = 0;
  const perDay = new Map<number, number>();
  for (const list of byUserDate.values()) {
    const sorted = [...list].sort((a, b) => cmp(a.time, b.time));
    if (!sorted.some((a) => a.time < SPLIT_TIME)) missingIn++;
    if (!sorted.some((a) => a.time >= SPLIT_TIME)) missingOut++;
    perDay.set(sorted.length, (perDay.get(sorted.length) ?? 0) + 1);
  }
  for (const a of attendance) {
    const derived = a.time < SPLIT_TIME ? 0 : 1;
    if (a.punch !== derived) rawPunchAnomalies++;
  }
  const duplicateKeys =
    attendance.length - new Set(attendance.map((a) => `${a.idNumber}|${a.date}|${a.time}`)).size;
  const sundayRecords = attendance.filter(
    (a) => new Date(`${a.date}T00:00:00Z`).getUTCDay() === 0,
  ).length;
  const punchCounts = [...perDay.entries()].sort((a, b) => a[0] - b[0]);
  return {
    users: users.length,
    records: attendance.length,
    users_with_attendance: byUser.size,
    users_without_attendance: users.length - byUser.size,
    first_date: dates[0] ?? null,
    last_date: dates.at(-1) ?? null,
    dates: dates.length,
    sunday_records: sundayRecords,
    user_days: byUserDate.size,
    missing_in: missingIn,
    missing_out: missingOut,
    raw_punch_anomalies: rawPunchAnomalies,
    duplicate_keys: duplicateKeys,
    punches_per_user_day: Object.fromEntries(punchCounts.map(([k, v]) => [String(k), v])),
    min_punches_per_user_day: punchCounts[0]?.[0] ?? 0,
    max_punches_per_user_day: punchCounts.at(-1)?.[0] ?? 0,
    comma_names: users.filter((u) => u.name.includes(",")).length,
    exact_24_byte_names: users.filter((u) => Buffer.byteLength(u.name, "utf8") === 24).length,
    main_names_dummy: users.filter((u) => u.name.startsWith("Dummy ")).length,
    main_ids_start_9: users.filter((u) => u.idNumber.startsWith("9")).length,
  };
}

function makeEdgeData(): { users: FixtureUser[]; attendance: NamedFixtureAttendance[] } {
  const users: FixtureUser[] = [
    {
      uid: 1,
      idNumber: "00123",
      name: "Dummy Budi & <Test>",
      privilege: 0,
      card: 0,
      groupId: "",
    },
    {
      uid: 2,
      idNumber: "A-100",
      name: "Dummy Siti, S.Kom",
      privilege: 0,
      card: 123456,
      groupId: "G1",
    },
    {
      uid: 3,
      idNumber: "EDGE-1",
      name: "Dummy Karyawan 000000001",
      privilege: 14,
      card: 0,
      groupId: "",
    },
    {
      uid: 4,
      idNumber: "123456789012345678901234",
      name: "Dummy Dua Puluh Empat",
      privilege: 0,
      card: 0,
      groupId: "",
    },
    {
      uid: 5,
      idNumber: "EMPTY",
      name: "",
      privilege: 0,
      card: 0,
      groupId: "",
    },
    {
      uid: 6,
      idNumber: "U-24",
      name: "Dummy Nama, S.T.",
      privilege: 0,
      card: 0,
      groupId: "",
    },
  ];

  const row = (
    uid: number,
    idNumber: string,
    date: string,
    time: string,
    punch: number,
    name = users.find((u) => u.idNumber === idNumber)?.name ?? idNumber,
  ): NamedFixtureAttendance => ({ uid, idNumber, name, date, time, punch, verify: 15 });

  const attendance: NamedFixtureAttendance[] = [
    row(40001, "00123", "2026-10-05", "09:59:59", 0),
    row(40002, "00123", "2026-10-05", "10:00:00", 1),
    row(40003, "00123", "2026-10-06", "06:30:00", 0),
    row(40004, "00123", "2026-10-06", "12:00:00", 1),
    row(40005, "00123", "2026-10-06", "15:59:00", 1),
    row(40006, "00123", "2026-10-07", "07:00:00", 0),
    row(40007, "00123", "2026-10-07", "16:00:00", 1),
    row(40008, "00123", "2026-10-08", "12:06:30", 0),
    row(40009, "00123", "2026-10-09", "07:45:00", 0),
    row(40010, "00123", "2026-10-10", "10:00:00", 1),
    row(40011, "A-100", "2026-10-04", "07:00:00", 0),
    row(40012, "A-100", "2026-10-04", "12:00:00", 1),
    row(40013, "A-100", "2026-10-05", "06:59:59", 0),
    row(40014, "A-100", "2026-10-05", "16:00:01", 1),
    row(40015, "A-100", "2026-10-06", "07:01:00", 0),
    row(40016, "A-100", "2026-10-06", "15:59:00", 1),
    row(40017, "A-100", "2026-10-07", "06:30:00", 0),
    row(40018, "A-100", "2026-10-07", "07:00:00", 0),
    row(40019, "A-100", "2026-10-07", "07:30:00", 0),
    row(40020, "A-100", "2026-10-07", "08:00:00", 0),
    row(40021, "A-100", "2026-10-07", "09:59:59", 0),
    row(40022, "A-100", "2026-10-07", "10:00:00", 1),
    row(40023, "A-100", "2026-10-07", "12:00:00", 1),
    row(40024, "A-100", "2026-10-07", "15:00:00", 1),
    row(40025, "A-100", "2026-10-07", "18:00:00", 1),
    row(40026, "A-100", "2026-10-08", "00:00:00", 0),
    row(40027, "A-100", "2026-10-08", "23:59:59", 1),
    row(40028, "A-100", "2026-10-09", "09:59:59", 0),
    row(40029, "A-100", "2026-10-09", "10:00:00", 1),
    row(40030, "A-100", "2026-10-10", "06:30:00", 0),
    row(40031, "A-100", "2026-10-10", "16:00:00", 1),
    row(40032, "A-100", "2026-10-10", "07:00:00", 0),
    row(40033, "A-100", "2026-10-11", "09:00:00", 0),
    row(40034, "EDGE-1", "2026-10-05", "07:00:00", 0),
    row(40035, "EDGE-1", "2026-10-05", "16:00:00", 1),
    row(40036, "123456789012345678901234", "2026-10-05", "07:30:00", 0),
    row(40037, "123456789012345678901234", "2026-10-05", "15:30:00", 1),
    row(40038, "EMPTY", "2026-10-06", "07:00:00", 0),
    row(40039, "EMPTY", "2026-10-06", "16:00:00", 1),
    row(40040, "U-24", "2026-10-06", "06:59:59", 0),
    row(40041, "U-24", "2026-10-06", "16:00:00", 1),
    row(40042, "U-24", "2026-10-08", "10:00:01", 1),
  ];
  return { users, attendance };
}

function makeLegacyData(): {
  users: FixtureUser[];
  attendance8: NamedFixtureAttendance[];
  attendance16: NamedFixtureAttendance[];
} {
  const users: FixtureUser[] = [
    { uid: 1, idNumber: "1001", name: "Legacy", privilege: 0, card: 0, groupId: "3" },
    { uid: 2, idNumber: "1002", name: "Dua", privilege: 0, card: 123, groupId: "0" },
    { uid: 3, idNumber: "1003", name: "Tiga", privilege: 14, card: 0, groupId: "1" },
  ];
  const attendance8: NamedFixtureAttendance[] = [
    {
      uid: 1,
      idNumber: "1001",
      name: "Legacy",
      date: "2026-10-05",
      time: "07:30:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 2,
      idNumber: "1002",
      name: "Dua",
      date: "2026-10-05",
      time: "17:00:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 77,
      idNumber: "77",
      name: "77",
      date: "2026-10-05",
      time: "12:00:00",
      punch: 0,
      verify: 1,
    },
  ];
  const attendance16: NamedFixtureAttendance[] = [
    {
      uid: 0,
      idNumber: "1001",
      name: "Legacy",
      date: "2026-10-05",
      time: "07:30:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 0,
      idNumber: "1002",
      name: "Dua",
      date: "2026-10-05",
      time: "17:00:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 0,
      idNumber: "9999",
      name: "9999",
      date: "2026-10-06",
      time: "08:00:00",
      punch: 0,
      verify: 15,
    },
  ];
  return { users, attendance8, attendance16 };
}

function makeScenario(): SyncScenarioFile {
  const users: FixtureUser[] = [
    { uid: 501, idNumber: "9001", name: "Dummy Sync Satu", privilege: 0, card: 0, groupId: "" },
    { uid: 502, idNumber: "9002", name: "Dummy Sync Dua", privilege: 0, card: 0, groupId: "" },
    { uid: 503, idNumber: "9003", name: "Dummy Sync Tiga", privilege: 0, card: 0, groupId: "" },
  ];
  const base: NamedFixtureAttendance[] = [
    {
      uid: 61001,
      idNumber: "9001",
      name: users[0]!.name,
      date: "2026-10-05",
      time: "07:30:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 61002,
      idNumber: "9001",
      name: users[0]!.name,
      date: "2026-10-05",
      time: "17:00:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 61003,
      idNumber: "9002",
      name: users[1]!.name,
      date: "2026-10-05",
      time: "08:05:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 61004,
      idNumber: "9002",
      name: users[1]!.name,
      date: "2026-10-05",
      time: "16:55:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 61005,
      idNumber: "9003",
      name: users[2]!.name,
      date: "2026-10-05",
      time: "12:00:00",
      punch: 0,
      verify: 15,
    },
  ];
  const live: NamedFixtureAttendance[] = [
    ...base,
    {
      uid: 61006,
      idNumber: "9002",
      name: users[1]!.name,
      date: "2026-10-05",
      time: "17:10:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 61007,
      idNumber: "9003",
      name: users[2]!.name,
      date: "2026-10-05",
      time: "13:00:00",
      punch: 1,
      verify: 15,
    },
  ];
  return {
    schema: "absenly/fixture-sync-scenario/v1",
    meta: {
      name: "sync-race-retry",
      note: "Sync awal 5 record, lalu buffer race 6/7 (retry), lalu 7/7; sync ulang harus idempotent.",
    },
    users,
    base_attendance: base,
    live_attendance: live,
    steps: [
      { name: "initial", counts: { users: 3, records: 5 }, attendance: base, expect: "ok" },
      {
        name: "race",
        counts: { users: 3, records: 7 },
        attendance: live.slice(0, 6),
        expect: "ZK_COUNT_MISMATCH",
      },
      { name: "retry", counts: { users: 3, records: 7 }, attendance: live, expect: "ok" },
      { name: "repeat", counts: { users: 3, records: 7 }, attendance: live, expect: "ok" },
    ],
    expected: {
      attempts: 4,
      final_employees: 3,
      final_attendance: 7,
      after_repeat_attendance: 7,
      first_date: "2026-10-05",
      last_date: "2026-10-05",
    },
  };
}

function makeSchedulesData(generatedAt: string): SchedulesFile {
  const allOff: WeeklySchedule = {
    MONDAY: null,
    TUESDAY: null,
    WEDNESDAY: null,
    THURSDAY: null,
    FRIDAY: null,
    SATURDAY: null,
    SUNDAY: null,
  };
  const singleWorkday: WeeklySchedule = {
    ...allOff,
    WEDNESDAY: { in: "08:00", out: "17:00" },
  };
  const sundayWork: WeeklySchedule = {
    ...SCHEDULE,
    SUNDAY: { in: "07:00", out: "12:00" },
  };

  const invalid: SchedulesFile["invalid"] = [
    {
      name: "missing_out",
      schedule: { MONDAY: { in: "07:00" } },
      code: "SCHEDULE_PAIR",
    },
    {
      name: "missing_in",
      schedule: { MONDAY: { out: "16:00" } },
      code: "SCHEDULE_PAIR",
    },
    {
      name: "out_before_in",
      schedule: { MONDAY: { in: "16:00", out: "07:00" } },
      code: "SCHEDULE_ORDER",
    },
    {
      name: "out_equals_in",
      schedule: { MONDAY: { in: "07:00", out: "07:00" } },
      code: "SCHEDULE_ORDER",
    },
    {
      name: "bad_time",
      schedule: { MONDAY: { in: "7:00", out: "16:00" } },
      code: "SCHEDULE_TIME",
    },
    {
      name: "non_string_time",
      schedule: { MONDAY: { in: 700, out: "16:00" } },
      code: "SCHEDULE_TIME",
    },
    {
      name: "no_workday",
      schedule: allOff,
      code: "SCHEDULE_EMPTY",
    },
    {
      name: "unknown_day",
      schedule: { FUNDAY: { in: "07:00", out: "16:00" } },
      code: "SCHEDULE_DAY",
    },
  ];

  const envInvalid: SchedulesFile["env_invalid"] = [
    {
      name: "missing_out_env",
      env: { ABSEN_SCHEDULE_MONDAY_IN: "07:00" },
      code: "SCHEDULE_PAIR",
    },
    {
      name: "empty_in_env",
      env: { ABSEN_SCHEDULE_MONDAY_IN: "", ABSEN_SCHEDULE_MONDAY_OUT: "16:00" },
      code: "SCHEDULE_PAIR",
    },
    {
      name: "out_before_in_env",
      env: { ABSEN_SCHEDULE_MONDAY_IN: "16:00", ABSEN_SCHEDULE_MONDAY_OUT: "07:00" },
      code: "SCHEDULE_ORDER",
    },
    {
      name: "bad_time_env",
      env: { ABSEN_SCHEDULE_MONDAY_IN: "7:00", ABSEN_SCHEDULE_MONDAY_OUT: "16:00" },
      code: "SCHEDULE_TIME",
    },
    {
      name: "no_workday_env",
      env: scheduleToEnv(allOff),
      code: "SCHEDULE_EMPTY",
    },
  ];

  return {
    schema: "absenly/fixture-schedules/v1",
    meta: {
      source: "hand-built-schedules",
      generated_at: generatedAt,
      note: "Validasi config: pasangan IN/OUT, OUT setelah IN, minimal satu hari kerja, dan hari libur bukan hardcode Minggu.",
    },
    valid: [
      { name: "office", schedule: SCHEDULE },
      { name: "sunday_work", schedule: sundayWork },
      { name: "single_workday", schedule: singleWorkday },
    ],
    invalid,
    env_valid: [
      { name: "office_env", env: scheduleToEnv(SCHEDULE), schedule: SCHEDULE },
      { name: "sunday_work_env", env: scheduleToEnv(sundayWork), schedule: sundayWork },
      {
        name: "single_workday_env",
        env: scheduleToEnv(singleWorkday),
        schedule: singleWorkday,
      },
    ],
    env_invalid: envInvalid,
  };
}

function makeWorkExceptionsData(generatedAt: string): WorkExceptionsFile {
  const employees = ["00123", "A-100", "EDGE-1", "U-24"];
  const valid: WorkExceptionInput[] = [
    {
      id_number: "00123",
      kind: "night_shift",
      start_date: "2026-10-05",
      start_time: "21:00:00",
      end_date: "2026-10-06",
      end_time: "07:00:00",
      note: "Piket",
    },
    {
      id_number: "A-100",
      kind: "overtime",
      start_date: "2026-10-06",
      start_time: "16:00:00",
      end_date: "2026-10-06",
      end_time: "18:00:00",
      note: "Lembur",
    },
    {
      id_number: "EDGE-1",
      kind: "holiday_work",
      start_date: "2026-10-11",
      start_time: "07:00:00",
      end_date: "2026-10-11",
      end_time: "12:00:00",
      note: "Kerja Minggu",
    },
    {
      id_number: "U-24",
      kind: "other",
      start_date: "2026-10-07",
      start_time: "12:00:00",
      end_date: "2026-10-07",
      end_time: "13:00:00",
      note: null,
    },
  ];

  const boundary: WorkExceptionInput[] = [
    {
      id_number: "A-100",
      kind: "overtime",
      start_date: "2026-10-07",
      start_time: "16:00:00",
      end_date: "2026-10-07",
      end_time: "17:00:00",
    },
    {
      id_number: "A-100",
      kind: "overtime",
      start_date: "2026-10-07",
      start_time: "17:00:00",
      end_date: "2026-10-07",
      end_time: "18:00:00",
    },
  ];

  const invalid: Array<{ input: Record<string, unknown>; code: string }> = [
    {
      input: {
        id_number: "00123",
        kind: "night_shift",
        start_date: "2026-10-06",
        start_time: "06:00:00",
        end_date: "2026-10-06",
        end_time: "08:00:00",
      },
      code: "WORK_EXCEPTION_OVERLAP",
    },
    {
      input: {
        id_number: "A-100",
        kind: "overtime",
        start_date: "2026-10-07",
        start_time: "17:00:00",
        end_date: "2026-10-07",
        end_time: "16:00:00",
      },
      code: "INVALID_ARGS",
    },
    {
      input: {
        id_number: "EDGE-1",
        kind: "sick_leave",
        start_date: "2026-10-12",
        start_time: "07:00:00",
        end_date: "2026-10-12",
        end_time: "12:00:00",
      },
      code: "WORK_EXCEPTION_KIND",
    },
    {
      input: {
        id_number: "NOPE",
        kind: "other",
        start_date: "2026-10-12",
        start_time: "07:00:00",
        end_date: "2026-10-12",
        end_time: "08:00:00",
      },
      code: "UNKNOWN_EMPLOYEE",
    },
    {
      input: {
        id_number: "U-24",
        kind: "other",
        start_date: "2026-10-07",
        start_time: "24:00:00",
        end_date: "2026-10-07",
        end_time: "25:00:00",
      },
      code: "INVALID_ARGS",
    },
    {
      input: {
        id_number: "U-24",
        kind: "other",
        start_date: "2026-02-30",
        start_time: "08:00:00",
        end_date: "2026-02-30",
        end_time: "09:00:00",
      },
      code: "INVALID_ARGS",
    },
  ];

  const recapAttendance: NamedFixtureAttendance[] = [
    {
      uid: 41001,
      idNumber: "00123",
      name: "Dummy Budi & <Test>",
      date: "2026-10-05",
      time: "09:59:59",
      punch: 0,
      verify: 15,
    },
    {
      uid: 41002,
      idNumber: "00123",
      name: "Dummy Budi & <Test>",
      date: "2026-10-05",
      time: "10:00:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 41003,
      idNumber: "00123",
      name: "Dummy Budi & <Test>",
      date: "2026-10-06",
      time: "21:00:00",
      punch: 1,
      verify: 15,
    },
    {
      uid: 41004,
      idNumber: "00123",
      name: "Dummy Budi & <Test>",
      date: "2026-10-07",
      time: "06:30:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 41005,
      idNumber: "A-100",
      name: "Dummy Siti, S.Kom",
      date: "2026-10-06",
      time: "07:00:00",
      punch: 0,
      verify: 15,
    },
    {
      uid: 41006,
      idNumber: "A-100",
      name: "Dummy Siti, S.Kom",
      date: "2026-10-06",
      time: "16:30:00",
      punch: 1,
      verify: 15,
    },
  ];

  const expectedDaily = buildDaily(
    recapAttendance.map((a) => ({
      idNumber: a.idNumber,
      name: a.name,
      date: a.date,
      time: a.time,
      punch: a.punch,
      verify: a.verify,
      uid: a.uid,
    })),
    SCHEDULE,
  );

  return {
    schema: "absenly/fixture-work-exceptions/v1",
    meta: {
      source: "hand-built-work-exceptions",
      generated_at: generatedAt,
      note: "Ledger piket/overtime. Overlap setengah terbuka [start,end); recap normal tidak memakai tabel ini.",
    },
    employees,
    valid,
    boundary_non_overlap: boundary,
    invalid,
    recap_unaffected: {
      schedule: SCHEDULE,
      attendance: recapAttendance,
      expected_daily: expectedDaily,
    },
  };
}

function writeJsonFile(root: string, relativePath: string, value: unknown): string {
  const abs = join(root, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return abs;
}

function writeBinFile(root: string, relativePath: string, value: Buffer): string {
  const abs = join(root, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, value);
  return abs;
}

async function main(): Promise<void> {
  const outRoot = resolve(arg("--out", import.meta.dir)!);
  const snapshotArg = arg("--snapshot");
  if (!snapshotArg) {
    throw new Error(
      "pemakaian: bun run tests/fixtures/generate.ts --snapshot <snapshot.json> [--out DIR] [--seed N]\n" +
        "Snapshot tidak disertakan di repo; fixture yang sudah ada tetap bisa dipakai offline.",
    );
  }
  const snapshotPath = resolve(snapshotArg);
  const seed = Number(arg("--seed", "20261020"));
  const generatedAt = wibStamp();

  let rawSnapshot: string;
  try {
    rawSnapshot = readFileSync(snapshotPath, "utf8");
  } catch {
    throw new Error(
      `snapshot tidak ditemukan: ${snapshotPath}\n` +
        "Berikan snapshot JSON hasil capture read-only; fixture yang sudah ada tetap bisa dipakai offline.",
    );
  }
  const snapshot = JSON.parse(rawSnapshot) as RealSnapshot;
  assert(snapshot.schema === "absenly/device-snapshot/v1", "schema snapshot tidak dikenal");

  const sourceUsersRaw = Buffer.from(snapshot.raw.users_base64, "base64");
  const sourceAttendanceRaw = Buffer.from(snapshot.raw.attendance_base64, "base64");
  assert(
    sourceUsersRaw.length === 4 + snapshot.counts.users * 72,
    "ukuran raw users tidak cocok dengan 72 byte/user",
  );
  assert(
    sourceAttendanceRaw.length === 4 + snapshot.counts.records * 40,
    "ukuran raw attendance tidak cocok dengan 40 byte/record",
  );
  const sourceUsers = decodeUsers(sourceUsersRaw, snapshot.counts.users, 72);
  const sourceAttendance = decodeAttendance(
    sourceAttendanceRaw,
    snapshot.counts.records,
    sourceUsers,
    40,
  );
  checkSourceConsistency(snapshot, sourceUsers, sourceAttendance);

  const realIds = new Set(sourceUsers.map((u) => u.idNumber));
  const usedIds = new Set<string>();
  const namePlan = makeNamePlan(sourceUsers);
  const syntheticUsers: FixtureUser[] = sourceUsers.map((real, i) => ({
    uid: 1000 + i * 17,
    idNumber: makeSyntheticId(real.idNumber, i, usedIds, realIds),
    name: namePlan[i]!,
    privilege: real.privilege,
    card: real.card === 0 ? 0 : 800000 + i,
    groupId: real.groupId,
  }));
  const syntheticById = new Map(syntheticUsers.map((u) => [u.idNumber, u]));
  const realToSynthetic = new Map(
    sourceUsers.map((u, i) => [u.idNumber, syntheticUsers[i]!.idNumber]),
  );
  const syntheticAttendance: NamedFixtureAttendance[] = sourceAttendance.map((real, i) => {
    const idNumber = realToSynthetic.get(real.idNumber);
    assert(idNumber, `attendance ${i} tidak punya master user`);
    const user = syntheticById.get(idNumber);
    assert(user, `attendance ${i} tidak punya user sintetis`);
    return {
      uid: 30000 + ((seed + i * 7919 + real.uid * 31) % 30000),
      idNumber,
      name: user.name,
      date: real.date,
      time: real.time,
      punch: real.punch,
      verify: real.verify,
    };
  });

  // Patch raw user records: new identities, zeroed passwords, synthetic cards.
  // Enabled (39) and group (40..47) bytes are preserved because they are not PII and
  // important for testing parser quirks.
  const usersRaw = Buffer.from(sourceUsersRaw);
  sourceUsers.forEach((real, i) => {
    const synthetic = syntheticUsers[i]!;
    const off = 4 + i * 72;
    const realRec = sourceUsersRaw.subarray(off, off + 72);
    const enabled = realRec[39];
    const group = Buffer.from(realRec.subarray(40, 47));
    const pad47 = realRec[47];
    usersRaw.writeUInt16LE(synthetic.uid, off);
    usersRaw[off + 2] = synthetic.privilege;
    usersRaw.fill(0, off + 3, off + 11);
    writeFixed(usersRaw, off + 11, 24, synthetic.name, "nama user");
    usersRaw.writeUInt32LE(synthetic.card >>> 0, off + 35);
    usersRaw[off + 39] = enabled ?? 1;
    group.copy(usersRaw, off + 40);
    usersRaw[off + 47] = pad47 ?? 0;
    writeFixed(usersRaw, off + 48, 24, synthetic.idNumber, "idNumber user");
  });
  usersRaw.writeUInt32LE(usersRaw.length - 4, 0);

  const attendanceRaw = Buffer.from(sourceAttendanceRaw);
  sourceAttendance.forEach((real, i) => {
    const synthetic = syntheticAttendance[i]!;
    const off = 4 + i * 40;
    attendanceRaw.writeUInt16LE(synthetic.uid, off);
    writeFixed(attendanceRaw, off + 2, 24, synthetic.idNumber, "idNumber attendance");
    attendanceRaw[off + 26] = real.verify;
    sourceAttendanceRaw.copy(attendanceRaw, off + 27, off + 27, off + 31);
    attendanceRaw[off + 31] = real.punch;
    attendanceRaw.fill(0, off + 32, off + 40);
  });
  attendanceRaw.writeUInt32LE(attendanceRaw.length - 4, 0);

  const decodedUsers = decodeUsers(usersRaw, syntheticUsers.length, 72);
  decodedUsers.forEach((u, i) => {
    assert(userKey(u) === userKey(syntheticUsers[i]!), `raw user ${i} tidak sama dengan JSON`);
  });
  const decodedAttendance = decodeAttendance(
    attendanceRaw,
    syntheticAttendance.length,
    syntheticUsers,
    40,
  );
  decodedAttendance.forEach((a, i) => {
    assert(
      attendanceKey(a) === attendanceKey(syntheticAttendance[i]!),
      `raw attendance ${i} tidak sama dengan JSON`,
    );
  });

  const files: string[] = [];
  files.push(
    writeJsonFile(outRoot, "users.json", {
      schema: "absenly/fixture-users/v1",
      meta: {
        source: "anonymized-device-snapshot",
        generated_at: generatedAt,
        seed,
        counts: { users: syntheticUsers.length, attendance: syntheticAttendance.length },
        note: "Nama/ID/kartu sintetis; password dikosongkan. Tanggal/jam dipertahankan dari snapshot sumber.",
      },
      users: syntheticUsers,
    } satisfies UsersFile),
  );
  files.push(
    writeJsonFile(outRoot, "attendance.json", {
      schema: "absenly/fixture-attendance/v1",
      meta: {
        source: "anonymized-device-snapshot",
        generated_at: generatedAt,
        seed,
        counts: {
          users: syntheticUsers.length,
          attendance: syntheticAttendance.length,
          first_date: syntheticAttendance[0]?.date ?? null,
          last_date: syntheticAttendance.at(-1)?.date ?? null,
        },
        note: "Record 40-byte asli setelah identitas diganti. UID sengaja tidak cocok dengan user UID.",
      },
      records: syntheticAttendance,
    } satisfies AttendanceFile),
  );
  files.push(writeBinFile(outRoot, "device/users-72.bin", usersRaw));
  files.push(writeBinFile(outRoot, "device/attendance-40.bin", attendanceRaw));

  const edge = makeEdgeData();
  const edgeUsersRaw = encodeUsers(edge.users, 72);
  const edgeAttendanceRaw = encodeAttendance(edge.attendance, 40);
  const edgeDecodedUsers = decodeUsers(edgeUsersRaw, edge.users.length, 72);
  edgeDecodedUsers.forEach((u, i) => {
    assert(userKey(u) === userKey(edge.users[i]!), `edge user ${i} codec tidak konsisten`);
  });
  const edgeDecodedAttendance = decodeAttendance(
    edgeAttendanceRaw,
    edge.attendance.length,
    edge.users,
    40,
  );
  edgeDecodedAttendance.forEach((a, i) => {
    assert(
      attendanceKey(a) === attendanceKey(edge.attendance[i]!),
      `edge attendance ${i} codec tidak konsisten`,
    );
  });
  const edgeDaily = buildDaily(
    edge.attendance.map((a) => ({
      idNumber: a.idNumber,
      name: a.name,
      date: a.date,
      time: a.time,
      punch: a.punch,
      verify: a.verify,
      uid: a.uid,
    })),
    SCHEDULE,
  );
  const edgeSummary = summarizeDaily(edgeDaily);
  files.push(writeBinFile(outRoot, "device/edge-users-72.bin", edgeUsersRaw));
  files.push(writeBinFile(outRoot, "device/edge-attendance-40.bin", edgeAttendanceRaw));
  files.push(
    writeJsonFile(outRoot, "edge-cases.json", {
      schema: "absenly/fixture-edge-cases/v1",
      meta: {
        source: "hand-built-edge-cases",
        generated_at: generatedAt,
        note: "Batas 10:00, Minggu, telat/pulang cepat 1 menit, missing IN/OUT, 1-9 punch, nama 24 byte, ID leading zero.",
      },
      schedule: SCHEDULE,
      users: edge.users,
      attendance: edge.attendance,
      expected_daily: edgeDaily,
      expected_summary: edgeSummary,
    } satisfies EdgeFile),
  );

  const legacy = makeLegacyData();
  const legacyUsersRaw = encodeUsers(legacy.users, 28);
  const legacyAttendance8Raw = encodeAttendance(legacy.attendance8, 8);
  const legacyAttendance16Raw = encodeAttendance(legacy.attendance16, 16);
  const legacyExpectedUsers = decodeUsers(legacyUsersRaw, legacy.users.length, 28);
  const legacyExpectedAttendance8 = decodeAttendance(
    legacyAttendance8Raw,
    legacy.attendance8.length,
    legacy.users,
    8,
  );
  const legacyExpectedAttendance16 = decodeAttendance(
    legacyAttendance16Raw,
    legacy.attendance16.length,
    legacy.users,
    16,
  );
  files.push(writeBinFile(outRoot, "device/legacy/users-28.bin", legacyUsersRaw));
  files.push(writeBinFile(outRoot, "device/legacy/attendance-8.bin", legacyAttendance8Raw));
  files.push(writeBinFile(outRoot, "device/legacy/attendance-16.bin", legacyAttendance16Raw));
  files.push(
    writeJsonFile(outRoot, "legacy.json", {
      schema: "absenly/fixture-legacy/v1",
      meta: {
        source: "hand-built-legacy-layouts",
        generated_at: generatedAt,
        note: "Layout user 28 byte, attendance 8/16 byte. Dipakai untuk menguji fallback parser firmware lain.",
      },
      users: legacy.users,
      attendance8: legacy.attendance8,
      attendance16: legacy.attendance16,
      expected_users: legacyExpectedUsers,
      expected_attendance8: legacyExpectedAttendance8,
      expected_attendance16: legacyExpectedAttendance16,
      files: {
        users28: "device/legacy/users-28.bin",
        attendance8: "device/legacy/attendance-8.bin",
        attendance16: "device/legacy/attendance-16.bin",
      },
    } satisfies LegacyFile),
  );

  const scenario = makeScenario();
  files.push(writeJsonFile(outRoot, "scenarios/sync-race.json", scenario));

  const workExceptions = makeWorkExceptionsData(generatedAt);
  files.push(writeJsonFile(outRoot, "work-exceptions.json", workExceptions));

  const schedules = makeSchedulesData(generatedAt);
  files.push(writeJsonFile(outRoot, "schedules.json", schedules));

  const mainDaily = buildDaily(
    syntheticAttendance.map((a) => ({
      idNumber: a.idNumber,
      name: a.name,
      date: a.date,
      time: a.time,
      punch: a.punch,
      verify: a.verify,
      uid: a.uid,
    })),
    SCHEDULE,
  );
  const mainSummary = summarizeDaily(mainDaily);
  files.push(
    writeJsonFile(outRoot, "expected/main-summary.json", {
      schema: "absenly/fixture-summary/v1",
      generated_at: generatedAt,
      schedule: SCHEDULE,
      source: "attendance.json",
      first_date: mainDaily[0]?.date ?? null,
      last_date: mainDaily.at(-1)?.date ?? null,
      daily_rows: mainDaily.length,
      summary: mainSummary,
    }),
  );

  const sortedUsers = [...syntheticUsers].sort(
    (a, b) => cmp(a.name, b.name) || cmp(a.idNumber, b.idNumber),
  );
  files.push(
    writeJsonFile(outRoot, "expected/api-employees.json", {
      data: sortedUsers.map((u) => ({
        id_number: u.idNumber,
        name: u.name,
        card: u.card,
        group_id: u.groupId,
        privilege: u.privilege,
      })),
      meta: { total: sortedUsers.length },
    }),
  );

  const edgeApiRows = [...edgeDaily].sort(byDateThenName).map(toApiDaily);
  files.push(
    writeJsonFile(outRoot, "expected/api-recap-edge.json", {
      data: edgeApiRows,
      meta: {
        from: "2026-10-04",
        to: "2026-10-11",
        total: edgeApiRows.length,
        page: 1,
        per_page: 50,
        total_pages: Math.ceil(edgeApiRows.length / 50),
      },
    }),
  );
  files.push(
    writeJsonFile(outRoot, "expected/cli-export-edge.json", {
      data: edgeApiRows,
      meta: {
        from: "2026-10-04",
        to: "2026-10-11",
        total: edgeApiRows.length,
        page: 1,
        per_page: edgeApiRows.length,
        total_pages: 1,
      },
    }),
  );

  const mainInvariants = summarizeMain(syntheticUsers, syntheticAttendance);
  assert(
    mainInvariants.comma_names === sourceUsers.filter((u) => u.name.includes(",")).length,
    "jumlah nama comma tidak dipertahankan",
  );
  assert(
    mainInvariants.exact_24_byte_names ===
      sourceUsers.filter((u) => Buffer.byteLength(u.name, "utf8") === 24).length,
    "jumlah nama 24 byte tidak dipertahankan",
  );
  assert(
    mainInvariants.main_names_dummy === syntheticUsers.length,
    "ada nama main yang bukan Dummy",
  );
  assert(
    mainInvariants.main_ids_start_9 === syntheticUsers.length,
    "ada ID main yang bukan prefix 9",
  );

  const fileHashes: Record<string, { bytes: number; sha256: string }> = {};
  for (const abs of files.sort()) {
    const rel = relative(outRoot, abs).split(sep).join("/");
    const bytes = readFileSync(abs);
    fileHashes[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
  }

  const manifest: FixtureManifest = {
    schema: "absenly/fixtures/v1",
    generated_at: generatedAt,
    source: {
      captured_at: snapshot.captured_at,
      counts: snapshot.counts,
      stats: snapshot.stats,
    },
    anonymization: {
      real_names_replaced: true,
      real_ids_replaced: true,
      password_bytes_zeroed: true,
      cards_replaced: true,
      uid_remapped: true,
      attendance_reserved_bytes_zeroed: true,
      timestamps_preserved: true,
      main_name_prefix: "Dummy ",
      main_id_prefix: "9",
      note: "Tanggal/jam dipertahankan agar kalender dan distribusi punch akurat; identitas tidak.",
    },
    schedule: SCHEDULE,
    counts: {
      users: syntheticUsers.length,
      attendance: syntheticAttendance.length,
      edge_users: edge.users.length,
      edge_attendance: edge.attendance.length,
      legacy_users: legacy.users.length,
      legacy_attendance8: legacy.attendance8.length,
      legacy_attendance16: legacy.attendance16.length,
      work_exceptions: workExceptions.valid.length,
      schedules_valid: schedules.valid.length,
      schedules_invalid: schedules.invalid.length + schedules.env_invalid.length,
    },
    invariants: {
      ...mainInvariants,
      edge_rows: edgeDaily.length,
      edge_summary: edgeSummary,
      legacy_users: legacyExpectedUsers.length,
      legacy_attendance8: legacyExpectedAttendance8.length,
      legacy_attendance16: legacyExpectedAttendance16.length,
      work_exceptions_valid: workExceptions.valid.length,
      work_exceptions_boundary: workExceptions.boundary_non_overlap.length,
      work_exceptions_invalid: workExceptions.invalid.length,
      work_exceptions_recap_rows: workExceptions.recap_unaffected.expected_daily.length,
      schedules_valid: schedules.valid.length,
      schedules_invalid: schedules.invalid.length + schedules.env_invalid.length,
    },
    files: Object.fromEntries(Object.entries(fileHashes).sort(([a], [b]) => cmp(a, b))),
  };
  writeJsonFile(outRoot, "manifest.json", manifest);

  console.log(
    JSON.stringify(
      {
        out: outRoot,
        source_snapshot: snapshotPath,
        users: syntheticUsers.length,
        attendance: syntheticAttendance.length,
        edge_rows: edgeDaily.length,
        main_summary: mainSummary,
        edge_summary: edgeSummary,
        files: Object.keys(fileHashes).length,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
