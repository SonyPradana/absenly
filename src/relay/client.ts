// Viewer relay client: read raw rows from the collector over HTTP.
// It never imports the device, sync, web, or API modules.

import type {
  AttendancePage,
  AttendancePageOptions,
  AttendanceWithNameRow,
  AppUserCredential,
  AppUserInput,
  AppUserRow,
  EmployeeProfileRow,
  EmployeeRow,
  EventRow,
  PunchRow,
  RawAttendanceRow,
  SyncLogRow,
  WebhookRow,
  WorkExceptionPage,
  WorkExceptionPageOptions,
  WorkExceptionRow,
} from "../db.ts";
import { SPLIT_TIME } from "../time.ts";
import { parseScheduleCalendar, ScheduleError, type ScheduleCalendar } from "../schedule.ts";
import type { ScheduleSource } from "../schedule-store.ts";
import type { AppStore, ReadCounts, ReadFilter, ReadSnapshot } from "../store.ts";
import type { WorkExceptionInput, WorkExceptionSpan } from "../work-exceptions.ts";
import type { SyncScheduleInput, SyncScheduleRow } from "../auto-sync.ts";
import type { RelayAttendanceDto, RelayEmployeeDto, RelayMetaDto } from "./dto.ts";

export type RelayClientErrorCode =
  | "RELAY_UNAVAILABLE"
  | "RELAY_AUTH"
  | "RELAY_TIMEOUT"
  | "RELAY_BAD_RESPONSE"
  | "RELAY_READ_ONLY";

export class RelayClientError extends Error {
  constructor(
    readonly code: RelayClientErrorCode,
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "RelayClientError";
  }
}

export interface RelayReadStoreOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RelaySnapshot extends ReadSnapshot {
  schedule: ScheduleCalendar;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new RelayClientError("RELAY_BAD_RESPONSE", "Respons collector tidak valid.");
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key];
  if (typeof field !== "string") invalidResponse();
  return field;
}

function numberField(value: RecordValue, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) invalidResponse();
  return field;
}

function booleanField(value: RecordValue, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") invalidResponse();
  return field;
}

function nullableStringField(value: RecordValue, key: string): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") invalidResponse();
  return field;
}

function optionalNullableStringField(value: RecordValue, key: string): string | null {
  const field = value[key];
  if (field === undefined || field === null) return null;
  if (typeof field !== "string") invalidResponse();
  return field;
}

function optionalStringField(value: RecordValue, key: string): string {
  const field = value[key];
  if (field === undefined) return "";
  if (typeof field !== "string") invalidResponse();
  return field;
}

function optionalBooleanField(value: RecordValue, key: string, fallback: boolean): boolean {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "boolean") invalidResponse();
  return field;
}

function arrayField(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function parseMeta(value: unknown): RelayMetaDto {
  if (!isRecord(value)) invalidResponse();
  const counts = value.counts;
  if (!isRecord(counts)) invalidResponse();
  const lastSync = value.last_sync;
  let parsedLastSync: RelayMetaDto["last_sync"] = null;
  if (lastSync !== null) {
    if (!isRecord(lastSync)) invalidResponse();
    parsedLastSync = {
      at: stringField(lastSync, "at"),
      ok: booleanField(lastSync, "ok"),
      users: numberField(lastSync, "users"),
      records: numberField(lastSync, "records"),
      duration_ms: numberField(lastSync, "duration_ms"),
      first_date: nullableStringField(lastSync, "first_date"),
      last_date: nullableStringField(lastSync, "last_date"),
      error: nullableStringField(lastSync, "error"),
    };
  }

  return {
    app_version: stringField(value, "app_version"),
    schema_version: numberField(value, "schema_version"),
    last_sync: parsedLastSync,
    counts: {
      employees: numberField(counts, "employees"),
      attendance: numberField(counts, "attendance"),
    },
  };
}

function parseEmployee(value: unknown): RelayEmployeeDto {
  if (!isRecord(value)) invalidResponse();
  const deviceUid = value.device_uid;
  if (deviceUid !== null && typeof deviceUid !== "number") invalidResponse();
  return {
    id_number: stringField(value, "id_number"),
    name: stringField(value, "name"),
    card: numberField(value, "card"),
    group_id: stringField(value, "group_id"),
    privilege: numberField(value, "privilege"),
    device_uid: deviceUid,
    display_name: optionalNullableStringField(value, "display_name"),
    prefix_title: optionalStringField(value, "prefix_title"),
    suffix_title: optionalStringField(value, "suffix_title"),
    active: optionalBooleanField(value, "active", true),
    updated_at: optionalNullableStringField(value, "updated_at"),
  };
}

function parseAttendance(value: unknown): RelayAttendanceDto {
  if (!isRecord(value)) invalidResponse();
  return {
    id_number: stringField(value, "id_number"),
    date: stringField(value, "date"),
    time: stringField(value, "time"),
    punch: numberField(value, "punch"),
    verify: numberField(value, "verify"),
  };
}

function parseEmployees(value: unknown): RelayEmployeeDto[] {
  return arrayField(value).map(parseEmployee);
}

function parseAttendanceRows(value: unknown): RelayAttendanceDto[] {
  return arrayField(value).map(parseAttendance);
}

function toEmployeeRow(row: RelayEmployeeDto): EmployeeRow {
  return {
    idNumber: row.id_number,
    name: row.name,
    card: row.card,
    groupId: row.group_id,
    privilege: row.privilege,
    deviceUid: row.device_uid,
    syncedAt: "",
  };
}

function toProfile(row: RelayEmployeeDto): EmployeeProfileRow {
  return {
    idNumber: row.id_number,
    deviceName: row.name,
    displayName: row.display_name,
    prefixTitle: row.prefix_title,
    suffixTitle: row.suffix_title,
    active: row.active,
    updatedAt: row.updated_at,
  };
}

function toSyncRow(meta: RelayMetaDto): SyncLogRow | null {
  const sync = meta.last_sync;
  if (sync === null) return null;
  return {
    id: 0,
    startedAt: sync.at,
    finishedAt: sync.at,
    durationMs: sync.duration_ms,
    users: sync.users,
    records: sync.records,
    firstDate: sync.first_date,
    lastDate: sync.last_date,
    ok: sync.ok,
    error: sync.error,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readOnly(): never {
  throw new RelayClientError(
    "RELAY_READ_ONLY",
    "Viewer hanya membaca data collector; perubahan tidak diizinkan.",
    403,
  );
}

export class RelayReadStore implements AppStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayReadStoreOptions) {
    const url = new URL(options.baseUrl);
    this.baseUrl = url.origin;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async fetchEmployees(): Promise<RelayEmployeeDto[]> {
    return parseEmployees(await this.request("/relay/v1/employees"));
  }

  async listEmployees(): Promise<EmployeeRow[]> {
    return (await this.fetchEmployees()).map(toEmployeeRow);
  }

  async listEmployeeProfiles(): Promise<EmployeeProfileRow[]> {
    return (await this.fetchEmployees()).map(toProfile);
  }

  async getEmployeeProfile(idNumber: string): Promise<EmployeeProfileRow | null> {
    const row = (await this.fetchEmployees()).find((employee) => employee.id_number === idNumber);
    return row === undefined ? null : toProfile(row);
  }

  async listRawAttendance(options: ReadFilter): Promise<RawAttendanceRow[]> {
    const data = await this.request("/relay/v1/attendance", {
      from: options.from,
      to: options.to,
      ...(options.idNumber === undefined ? {} : { employee_id: options.idNumber }),
    });
    return parseAttendanceRows(data).map((row) => ({
      idNumber: row.id_number,
      date: row.date,
      time: row.time,
      punch: row.punch,
      verify: row.verify,
    }));
  }

  async listPunches(options: { from: string; to: string; idNumber?: string }): Promise<PunchRow[]> {
    const [attendance, employees] = await Promise.all([
      this.listRawAttendance(options),
      this.listEmployees(),
    ]);
    // Raw rows carry the device name; report layers apply the display overlay.
    const names = new Map(employees.map((employee) => [employee.idNumber, employee.name]));
    return attendance.map((row) => ({
      idNumber: row.idNumber,
      name: names.get(row.idNumber) ?? row.idNumber,
      date: row.date,
      time: row.time,
      verify: row.verify,
    }));
  }

  async listAttendancePage(options: AttendancePageOptions): Promise<AttendancePage> {
    const [attendance, employees] = await Promise.all([
      this.listRawAttendance(options),
      this.listEmployees(),
    ]);
    // Same contract as the collector: raw attendance names come from the device.
    const names = new Map(employees.map((employee) => [employee.idNumber, employee.name]));
    const rows: AttendanceWithNameRow[] = attendance
      .slice()
      .sort(
        (a, b) =>
          compare(a.date, b.date) || compare(a.time, b.time) || compare(a.idNumber, b.idNumber),
      )
      .map((row, index) => ({
        id: index + 1,
        date: row.date,
        idNumber: row.idNumber,
        name: names.get(row.idNumber) ?? row.idNumber,
        time: row.time,
        status: row.time < SPLIT_TIME ? "IN" : "OUT",
        rawPunch: row.punch,
        verify: row.verify,
        syncedAt: "",
      }));
    const offset = (options.page - 1) * options.perPage;
    return {
      rows: rows.slice(offset, offset + options.perPage),
      total: rows.length,
    };
  }

  async meta(): Promise<RelayMetaDto> {
    const data = await this.request("/relay/v1/meta");
    return parseMeta(data);
  }

  async lastSync(): Promise<SyncLogRow | null> {
    return toSyncRow(await this.meta());
  }

  async counts(): Promise<ReadCounts> {
    return (await this.meta()).counts;
  }

  async getSchedule(): Promise<ScheduleCalendar> {
    const data = await this.request("/relay/v1/schedule");
    try {
      return parseScheduleCalendar(data);
    } catch (error) {
      if (error instanceof ScheduleError) invalidResponse();
      throw error;
    }
  }

  async snapshot(options: ReadFilter): Promise<RelaySnapshot> {
    const data = await this.request("/relay/v1/snapshot", {
      from: options.from,
      to: options.to,
      ...(options.idNumber === undefined ? {} : { employee_id: options.idNumber }),
    });
    if (!isRecord(data)) invalidResponse();
    const meta = parseMeta(data.meta);
    let schedule: ScheduleCalendar;
    try {
      schedule = parseScheduleCalendar(data.schedule);
    } catch (error) {
      if (error instanceof ScheduleError) invalidResponse();
      throw error;
    }
    return {
      schemaVersion: meta.schema_version,
      lastSync: toSyncRow(meta),
      counts: meta.counts,
      employees: parseEmployees(data.employees).map(toEmployeeRow),
      profiles: parseEmployees(data.employees).map(toProfile),
      attendance: parseAttendanceRows(data.attendance).map((row) => ({
        idNumber: row.id_number,
        date: row.date,
        time: row.time,
        punch: row.punch,
        verify: row.verify,
      })),
      schedule,
    };
  }

  async countEmployees(): Promise<number> {
    return (await this.counts()).employees;
  }

  async countAttendance(): Promise<number> {
    return (await this.counts()).attendance;
  }

  async countEmployeeProfiles(): Promise<number> {
    return (await this.listEmployeeProfiles()).length;
  }

  async countActiveProfiles(): Promise<number> {
    return (await this.listEmployeeProfiles()).filter((profile) => profile.active).length;
  }

  async listWorkExceptionsPage(_options: WorkExceptionPageOptions): Promise<WorkExceptionPage> {
    return { rows: [], total: 0 };
  }

  async listWorkExceptionSpans(_idNumber: string): Promise<WorkExceptionSpan[]> {
    return [];
  }

  // Work exceptions are not relayed (read-only relay ships raw rows only), so a
  // viewer cannot waive sanctions; it reports the collector's raw recap.
  async listWorkExceptionSpansInRange(
    _from: string,
    _to: string,
    _idNumber?: string,
  ): Promise<WorkExceptionSpan[]> {
    return [];
  }

  async getWorkException(_id: number): Promise<WorkExceptionRow | null> {
    return null;
  }

  async insertWorkException(_input: WorkExceptionInput, _createdAt: string): Promise<number> {
    return readOnly();
  }

  async deleteWorkException(_id: number): Promise<boolean> {
    return readOnly();
  }

  async getAdminPasswordHash(): Promise<string | null> {
    return null;
  }

  // Employee accounts are collector-only; a viewer keeps no local DB.
  async getAppUserByUsername(_username: string): Promise<AppUserCredential | null> {
    return null;
  }

  async listAppUsers(): Promise<AppUserRow[]> {
    return [];
  }

  async saveAppUser(_input: AppUserInput): Promise<void> {
    return readOnly();
  }

  async deleteAppUser(_username: string): Promise<boolean> {
    return readOnly();
  }

  async saveEmployeeProfile(_profile: unknown): Promise<void> {
    return readOnly();
  }

  async saveAdminPasswordHash(_passwordHash: string, _updatedAt: string): Promise<void> {
    return readOnly();
  }

  async insertShareLink(_link: unknown): Promise<void> {
    return readOnly();
  }

  async getShareLink(_token: string): Promise<null> {
    return null;
  }

  async deleteExpiredShareLinks(_nowMs: number): Promise<number> {
    return 0;
  }

  // Auto-sync is collector-only: a viewer has no device and no local DB.
  async listSyncSchedules(): Promise<SyncScheduleRow[]> {
    return [];
  }

  async insertSyncSchedule(_input: SyncScheduleInput, _createdAt: string): Promise<number> {
    return readOnly();
  }

  async deleteSyncSchedule(_id: number): Promise<boolean> {
    return readOnly();
  }

  async setSyncScheduleEnabled(_id: number, _enabled: boolean): Promise<boolean> {
    return readOnly();
  }

  // Hooks are collector-only: a viewer relays no events and owns no webhooks.
  async listEvents(_options: { since: number; limit: number }): Promise<EventRow[]> {
    return [];
  }

  async listWebhooks(): Promise<WebhookRow[]> {
    return [];
  }

  async insertWebhook(_input: unknown): Promise<number> {
    return readOnly();
  }

  async updateWebhook(_id: number, _patch: unknown): Promise<boolean> {
    return readOnly();
  }

  async deleteWebhook(_id: number): Promise<boolean> {
    return readOnly();
  }

  async recordWebhookAttempt(
    _id: number,
    _status: number | null,
    _at: string,
    _error: string | null,
  ): Promise<void> {
    return readOnly();
  }

  async backupTo(_path: string): Promise<void> {
    return readOnly();
  }

  private async request(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        ((error as { name?: unknown }).name === "AbortError" ||
          (error as { name?: unknown }).name === "TimeoutError")
      ) {
        throw new RelayClientError("RELAY_TIMEOUT", "Collector tidak merespons (timeout).", 504);
      }
      throw new RelayClientError("RELAY_UNAVAILABLE", "Collector tidak dapat dihubungi.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new RelayClientError("RELAY_AUTH", "Token relay ditolak collector.", 502);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RelayClientError("RELAY_BAD_RESPONSE", "Respons collector tidak valid.");
    }

    if (!response.ok) {
      throw new RelayClientError(
        "RELAY_UNAVAILABLE",
        `Collector mengembalikan HTTP ${response.status}.`,
      );
    }
    if (!isRecord(body) || !("data" in body)) {
      throw new RelayClientError("RELAY_BAD_RESPONSE", "Respons collector tidak valid.");
    }
    return body.data;
  }
}

export class RelayScheduleStore implements ScheduleSource {
  readonly source = "relay" as const;
  readonly filePath = null;
  private current: ScheduleCalendar | null = null;
  private error: ScheduleError | null = null;

  constructor(private readonly client: RelayReadStore) {}

  get calendar(): ScheduleCalendar {
    if (this.current === null) {
      throw new RelayClientError("RELAY_UNAVAILABLE", "Jadwal collector belum dimuat.");
    }
    return this.current;
  }

  get lastError(): ScheduleError | null {
    return this.error;
  }

  async refresh(): Promise<void> {
    try {
      this.current = await this.client.getSchedule();
      this.error = null;
    } catch (error) {
      this.error =
        error instanceof ScheduleError
          ? error
          : new ScheduleError(
              "SCHEDULE_READ",
              error instanceof Error ? error.message : String(error),
            );
      throw error;
    }
  }

  reloadIfChanged(): boolean {
    return false;
  }

  save(): ScheduleCalendar {
    throw new ScheduleError(
      "SCHEDULE_READONLY",
      "jadwal viewer berasal dari collector dan tidak bisa diedit",
    );
  }
}
