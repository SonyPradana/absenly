import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureAttendance, FixtureUser, ParsedAttendance } from "./device-codec.ts";
import type { ReferenceDailyRow, ReferenceSummary, WeeklySchedule } from "./recap-reference.ts";
import type { WorkExceptionInput } from "./work-exceptions.ts";
import type { ScheduleErrorCode } from "./schedule.ts";

export const FIXTURE_ROOT = join(import.meta.dir, "..", "fixtures");

export interface NamedFixtureAttendance extends FixtureAttendance {
  name: string;
}

export interface UsersFile {
  schema: string;
  meta: {
    source: string;
    generated_at: string;
    seed: number;
    counts: { users: number; attendance: number };
    note: string;
  };
  users: FixtureUser[];
}

export interface AttendanceFile {
  schema: string;
  meta: {
    source: string;
    generated_at: string;
    seed: number;
    counts: {
      users: number;
      attendance: number;
      first_date: string | null;
      last_date: string | null;
    };
    note: string;
  };
  records: NamedFixtureAttendance[];
}

export interface EdgeFile {
  schema: string;
  meta: {
    source: string;
    generated_at: string;
    note: string;
  };
  schedule: WeeklySchedule;
  users: FixtureUser[];
  attendance: NamedFixtureAttendance[];
  expected_daily: ReferenceDailyRow[];
  expected_summary: ReferenceSummary;
}

export interface LegacyFile {
  schema: string;
  meta: { source: string; generated_at: string; note: string };
  users: FixtureUser[];
  attendance8: NamedFixtureAttendance[];
  attendance16: NamedFixtureAttendance[];
  expected_users: FixtureUser[];
  expected_attendance8: ParsedAttendance[];
  expected_attendance16: ParsedAttendance[];
  files: {
    users28: string;
    attendance8: string;
    attendance16: string;
  };
}

export interface ScenarioStep {
  name: string;
  counts: { users: number; records: number };
  attendance: NamedFixtureAttendance[];
  expect: "ok" | "ZK_COUNT_MISMATCH";
}

export interface SyncScenarioFile {
  schema: string;
  meta: { name: string; note: string };
  users: FixtureUser[];
  base_attendance: NamedFixtureAttendance[];
  live_attendance: NamedFixtureAttendance[];
  steps: ScenarioStep[];
  expected: {
    attempts: number;
    final_employees: number;
    final_attendance: number;
    after_repeat_attendance: number;
    first_date: string | null;
    last_date: string | null;
  };
}

export interface WorkExceptionsFile {
  schema: string;
  meta: { source: string; generated_at: string; note: string };
  employees: string[];
  valid: WorkExceptionInput[];
  boundary_non_overlap: WorkExceptionInput[];
  invalid: Array<{ input: Record<string, unknown>; code: string }>;
  recap_unaffected: {
    schedule: WeeklySchedule;
    attendance: NamedFixtureAttendance[];
    expected_daily: ReferenceDailyRow[];
  };
}

export interface SchedulesFile {
  schema: string;
  meta: { source: string; generated_at: string; note: string };
  valid: Array<{ name: string; schedule: WeeklySchedule }>;
  invalid: Array<{ name: string; schedule: Record<string, unknown>; code: ScheduleErrorCode }>;
  env_valid: Array<{ name: string; env: Record<string, string>; schedule: WeeklySchedule }>;
  env_invalid: Array<{ name: string; env: Record<string, string>; code: ScheduleErrorCode }>;
}

export interface FixtureManifest {
  schema: string;
  generated_at: string;
  source: {
    captured_at: string;
    counts: {
      users: number;
      records: number;
      usersCap: number;
      recordsCap: number;
      fingers: number;
    };
    stats: Record<string, unknown>;
  };
  anonymization: Record<string, unknown>;
  schedule: WeeklySchedule;
  counts: {
    users: number;
    attendance: number;
    edge_users: number;
    edge_attendance: number;
    legacy_users: number;
    legacy_attendance8: number;
    legacy_attendance16: number;
    work_exceptions: number;
    schedules_valid: number;
    schedules_invalid: number;
  };
  invariants: Record<string, unknown>;
  files: Record<string, { bytes: number; sha256: string }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), "utf8")) as T;
}

export function fixturePath(relativePath: string): string {
  return join(FIXTURE_ROOT, relativePath);
}

export function readFixtureBytes(relativePath: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, relativePath));
}

export function loadManifest(): FixtureManifest {
  return readJson<FixtureManifest>("manifest.json");
}

export function loadUsers(): UsersFile {
  return readJson<UsersFile>("users.json");
}

export function loadAttendance(): AttendanceFile {
  return readJson<AttendanceFile>("attendance.json");
}

export function loadEdge(): EdgeFile {
  return readJson<EdgeFile>("edge-cases.json");
}

export function loadLegacy(): LegacyFile {
  return readJson<LegacyFile>("legacy.json");
}

export function loadSyncScenario(): SyncScenarioFile {
  return readJson<SyncScenarioFile>("scenarios/sync-race.json");
}

export function loadWorkExceptions(): WorkExceptionsFile {
  return readJson<WorkExceptionsFile>("work-exceptions.json");
}

export function loadSchedules(): SchedulesFile {
  return readJson<SchedulesFile>("schedules.json");
}
