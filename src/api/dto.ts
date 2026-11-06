// Wire format for /api/v1 and CLI JSON. Keep snake_case here only.

import type {
  AttendanceWithNameRow,
  EmployeeProfileRow,
  EmployeeRow,
  EventRow,
  SyncLogRow,
  WebhookRow,
  WorkExceptionRow,
} from "../db.ts";
import { composeDisplayName } from "../employees.ts";
import type { DailyRow, DailyStatus, RecapSummary } from "../recap.ts";
import type { SyncResult } from "../sync.ts";
import type { SyncScheduleRow } from "../auto-sync.ts";
import type { WorkExceptionKind } from "../work-exceptions.ts";

export interface AttendanceDto {
  id: number;
  date: string;
  name: string;
  time: string;
  status: "IN" | "OUT";
  verify: number;
  id_number: string;
  raw_punch: number;
}

export interface EmployeeDto {
  id_number: string;
  name: string;
  card: number;
  group_id: string;
  privilege: number;
  active: boolean;
  device_name: string;
  display_name: string | null;
  prefix_title: string;
  suffix_title: string;
}

export interface ListMeta {
  from: string;
  to: string;
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface RecapDto {
  date: string;
  id_number: string;
  name: string;
  in_time: string | null;
  out_time: string | null;
  late_minutes: number | null;
  early_minutes: number | null;
  status: DailyStatus;
  punches: number;
}

export interface SummaryDto {
  rows: number;
  present: number;
  late: number;
  early: number;
  incomplete: number;
  late_minutes: number;
  early_minutes: number;
}

export interface WorkExceptionDto {
  id: number;
  id_number: string;
  name: string;
  kind: WorkExceptionKind;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  note: string | null;
  created_at: string;
}

export interface SyncStatusDto {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  users: number;
  records: number;
  first_date: string | null;
  last_date: string | null;
  ok: boolean;
  error: string | null;
}

export interface SyncResultDto {
  ok: true;
  users: number;
  records: number;
  first_date: string | null;
  last_date: string | null;
  duration_ms: number;
  synced_at: string;
}

export function toAttendanceDto(row: AttendanceWithNameRow): AttendanceDto {
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    time: row.time,
    status: row.status,
    verify: row.verify,
    id_number: row.idNumber,
    raw_punch: row.rawPunch,
  };
}

export function toRecapDto(row: DailyRow): RecapDto {
  return {
    date: row.date,
    id_number: row.idNumber,
    name: row.name,
    in_time: row.inTime,
    out_time: row.outTime,
    late_minutes: row.lateMinutes,
    early_minutes: row.earlyMinutes,
    status: row.status,
    punches: row.punches,
  };
}

export function toEmployeeDto(
  row: EmployeeRow,
  profile: EmployeeProfileRow | undefined,
): EmployeeDto {
  return {
    id_number: row.idNumber,
    name: profile === undefined ? row.name : composeDisplayName(profile),
    card: row.card,
    group_id: row.groupId,
    privilege: row.privilege,
    active: profile?.active ?? true,
    device_name: row.name,
    display_name: profile?.displayName ?? null,
    prefix_title: profile?.prefixTitle ?? "",
    suffix_title: profile?.suffixTitle ?? "",
  };
}

export function toSummaryDto(summary: RecapSummary): SummaryDto {
  return {
    rows: summary.rows,
    present: summary.present,
    late: summary.late,
    early: summary.early,
    incomplete: summary.incomplete,
    late_minutes: summary.lateMinutes,
    early_minutes: summary.earlyMinutes,
  };
}

export function toWorkExceptionDto(row: WorkExceptionRow, name?: string): WorkExceptionDto {
  return {
    id: row.id,
    id_number: row.idNumber,
    name: name ?? row.name,
    kind: row.kind,
    start_date: row.startDate,
    start_time: row.startTime,
    end_date: row.endDate,
    end_time: row.endTime,
    note: row.note,
    created_at: row.createdAt,
  };
}

export interface SyncScheduleDto {
  id: number;
  days: string;
  start_time: string;
  end_time: string;
  every_minutes: number;
  enabled: boolean;
  created_at: string;
}

export function toSyncScheduleDto(row: SyncScheduleRow): SyncScheduleDto {
  return {
    id: row.id,
    days: row.days,
    start_time: row.startTime,
    end_time: row.endTime,
    every_minutes: row.everyMinutes,
    enabled: row.enabled,
    created_at: row.createdAt,
  };
}

export function toSyncStatusDto(row: SyncLogRow): SyncStatusDto {
  return {
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    duration_ms: row.durationMs,
    users: row.users,
    records: row.records,
    first_date: row.firstDate,
    last_date: row.lastDate,
    ok: row.ok,
    error: row.error,
  };
}

export function toSyncResultDto(result: SyncResult): SyncResultDto {
  return {
    ok: true,
    users: result.users,
    records: result.records,
    first_date: result.firstDate,
    last_date: result.lastDate,
    duration_ms: result.durationMs,
    synced_at: result.syncedAt,
  };
}

export interface EventDto {
  id: number;
  event: string;
  at: string;
  data: unknown;
  delivered_at: string | null;
  attempts: number;
  last_error: string | null;
}

export function toEventDto(row: EventRow): EventDto {
  // payload is validated JSON written by this app; a malformed row must not 500.
  let data: unknown = null;
  try {
    data = JSON.parse(row.payload) as unknown;
  } catch {
    data = null;
  }
  return {
    id: row.id,
    event: row.event,
    at: row.at,
    data,
    delivered_at: row.deliveredAt,
    attempts: row.attempts,
    last_error: row.lastError,
  };
}

export interface WebhookDto {
  id: number;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  last_status: number | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

export function toWebhookDto(row: WebhookRow): WebhookDto {
  return {
    id: row.id,
    url: row.url,
    events: row.events.split(",").filter((name) => name !== ""),
    enabled: row.enabled,
    created_at: row.createdAt,
    last_status: row.lastStatus,
    last_attempt_at: row.lastAttemptAt,
    last_error: row.lastError,
  };
}
