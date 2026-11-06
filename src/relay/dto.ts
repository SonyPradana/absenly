// Relay wire DTOs: raw device rows and the calendar only. No recap fields.

import type { EmployeeProfileRow, EmployeeRow, RawAttendanceRow, SyncLogRow } from "../db.ts";
import type { ScheduleCalendar } from "../schedule.ts";
import type { ReadCounts, ReadSnapshot } from "../store.ts";

export interface RelayMetaDto {
  app_version: string;
  schema_version: number;
  last_sync: {
    at: string;
    ok: boolean;
    users: number;
    records: number;
    duration_ms: number;
    first_date: string | null;
    last_date: string | null;
    error: string | null;
  } | null;
  counts: ReadCounts;
}

export interface RelayEmployeeDto {
  id_number: string;
  name: string;
  card: number;
  group_id: string;
  privilege: number;
  device_uid: number | null;
  display_name: string | null;
  prefix_title: string;
  suffix_title: string;
  active: boolean;
  updated_at: string | null;
}

export interface RelayAttendanceDto {
  id_number: string;
  date: string;
  time: string;
  punch: number;
  verify: number;
}

export interface RelaySnapshotDto {
  meta: RelayMetaDto;
  employees: RelayEmployeeDto[];
  schedule: ScheduleCalendar;
  attendance: RelayAttendanceDto[];
}

export function toRelayMetaDto(
  lastSync: SyncLogRow | null,
  schemaVersion: number,
  counts: ReadCounts,
  appVersion: string,
): RelayMetaDto {
  return {
    app_version: appVersion,
    schema_version: schemaVersion,
    last_sync:
      lastSync === null
        ? null
        : {
            at: lastSync.finishedAt,
            ok: lastSync.ok,
            users: lastSync.users,
            records: lastSync.records,
            duration_ms: lastSync.durationMs,
            first_date: lastSync.firstDate,
            last_date: lastSync.lastDate,
            error: lastSync.error,
          },
    counts,
  };
}

export function toRelayEmployeeDto(
  row: EmployeeRow,
  profile: EmployeeProfileRow | undefined,
): RelayEmployeeDto {
  return {
    id_number: row.idNumber,
    name: row.name,
    card: row.card,
    group_id: row.groupId,
    privilege: row.privilege,
    device_uid: row.deviceUid,
    display_name: profile?.displayName ?? null,
    prefix_title: profile?.prefixTitle ?? "",
    suffix_title: profile?.suffixTitle ?? "",
    active: profile?.active ?? true,
    updated_at: profile?.updatedAt ?? null,
  };
}

export function toRelayAttendanceDto(row: RawAttendanceRow): RelayAttendanceDto {
  return {
    id_number: row.idNumber,
    date: row.date,
    time: row.time,
    punch: row.punch,
    verify: row.verify,
  };
}

export function toRelaySnapshotDto(
  snapshot: ReadSnapshot,
  calendar: ScheduleCalendar,
  appVersion: string,
): RelaySnapshotDto {
  return {
    meta: toRelayMetaDto(snapshot.lastSync, snapshot.schemaVersion, snapshot.counts, appVersion),
    employees: snapshot.employees.map((row) =>
      toRelayEmployeeDto(
        row,
        snapshot.profiles.find((profile) => profile.idNumber === row.idNumber),
      ),
    ),
    schedule: calendar,
    attendance: snapshot.attendance.map(toRelayAttendanceDto),
  };
}
