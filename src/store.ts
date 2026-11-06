// Read-only data port shared by the collector relay and the viewer.

import type {
  AttendancePage,
  AttendancePageOptions,
  AppUserCredential,
  AppUserInput,
  AppUserRow,
  Db,
  EmployeeProfileInput,
  EmployeeProfileRow,
  EmployeeRow,
  EventRow,
  PunchRow,
  RawAttendanceRow,
  ShareLinkInput,
  ShareLinkRow,
  SyncLogRow,
  WebhookRow,
  WorkExceptionPage,
  WorkExceptionPageOptions,
  WorkExceptionRow,
} from "./db.ts";
import type { SyncScheduleInput, SyncScheduleRow } from "./auto-sync.ts";
import type { WorkExceptionInput, WorkExceptionSpan } from "./work-exceptions.ts";

export interface ReadFilter {
  from: string;
  to: string;
  idNumber?: string;
}

export interface ReadCounts {
  employees: number;
  attendance: number;
}

export interface ReadSnapshot {
  schemaVersion: number;
  lastSync: SyncLogRow | null;
  counts: ReadCounts;
  employees: EmployeeRow[];
  profiles: EmployeeProfileRow[];
  attendance: RawAttendanceRow[];
}

export interface ReadStore {
  readonly schemaVersion: number;
  listEmployees(): EmployeeRow[];
  listEmployeeProfiles(): EmployeeProfileRow[];
  listRawAttendance(options: ReadFilter): RawAttendanceRow[];
  lastSync(): SyncLogRow | null;
  counts(): ReadCounts;
  snapshot(options: ReadFilter): ReadSnapshot;
}

export type Awaitable<T> = T | Promise<T>;

// Data needed by the web/API adapters. The SQLite implementation is synchronous;
// the viewer implementation is HTTP-backed and therefore awaitable.
export interface AppStore {
  lastSync(): Awaitable<SyncLogRow | null>;
  listEmployees(): Awaitable<EmployeeRow[]>;
  listEmployeeProfiles(): Awaitable<EmployeeProfileRow[]>;
  getEmployeeProfile(idNumber: string): Awaitable<EmployeeProfileRow | null>;
  listAttendancePage(options: AttendancePageOptions): Awaitable<AttendancePage>;
  listPunches(options: { from: string; to: string; idNumber?: string }): Awaitable<PunchRow[]>;
  listWorkExceptionsPage(options: WorkExceptionPageOptions): Awaitable<WorkExceptionPage>;
  listWorkExceptionSpans(idNumber: string): Awaitable<WorkExceptionSpan[]>;
  listWorkExceptionSpansInRange(
    from: string,
    to: string,
    idNumber?: string,
  ): Awaitable<WorkExceptionSpan[]>;
  getWorkException(id: number): Awaitable<WorkExceptionRow | null>;
  insertWorkException(input: WorkExceptionInput, createdAt: string): Awaitable<number>;
  deleteWorkException(id: number): Awaitable<boolean>;
  countEmployees(): Awaitable<number>;
  countAttendance(): Awaitable<number>;
  countEmployeeProfiles(): Awaitable<number>;
  countActiveProfiles(): Awaitable<number>;
  getAdminPasswordHash(): Awaitable<string | null>;
  getAppUserByUsername(username: string): Awaitable<AppUserCredential | null>;
  listAppUsers(): Awaitable<AppUserRow[]>;
  saveAppUser(input: AppUserInput): Awaitable<void>;
  deleteAppUser(username: string): Awaitable<boolean>;
  saveEmployeeProfile(profile: EmployeeProfileInput): Awaitable<void>;
  saveAdminPasswordHash(passwordHash: string, updatedAt: string): Awaitable<void>;
  insertShareLink(link: ShareLinkInput): Awaitable<void>;
  getShareLink(token: string): Awaitable<ShareLinkRow | null>;
  deleteExpiredShareLinks(nowMs: number): Awaitable<number>;
  listSyncSchedules(): Awaitable<SyncScheduleRow[]>;
  insertSyncSchedule(input: SyncScheduleInput, createdAt: string): Awaitable<number>;
  deleteSyncSchedule(id: number): Awaitable<boolean>;
  setSyncScheduleEnabled(id: number, enabled: boolean): Awaitable<boolean>;
  // Hooks are collector-only. A viewer has no events and no webhook targets.
  listEvents(options: { since: number; limit: number }): Awaitable<EventRow[]>;
  listWebhooks(): Awaitable<WebhookRow[]>;
  insertWebhook(input: {
    url: string;
    secret: string;
    events: string;
    enabled: boolean;
    createdAt: string;
  }): Awaitable<number>;
  updateWebhook(
    id: number,
    patch: { url?: string; events?: string; enabled?: boolean },
  ): Awaitable<boolean>;
  deleteWebhook(id: number): Awaitable<boolean>;
  recordWebhookAttempt(
    id: number,
    status: number | null,
    at: string,
    error: string | null,
  ): Awaitable<void>;
  backupTo(path: string): Awaitable<void>;
}

export class SqliteReadStore implements ReadStore {
  constructor(private readonly db: Db) {}

  get schemaVersion(): number {
    return this.db.schemaVersion;
  }

  listEmployees(): EmployeeRow[] {
    return this.db.listEmployees();
  }

  listEmployeeProfiles(): EmployeeProfileRow[] {
    return this.db.listEmployeeProfiles();
  }

  listRawAttendance(options: ReadFilter): RawAttendanceRow[] {
    return this.db.listRawAttendance(options);
  }

  lastSync(): SyncLogRow | null {
    return this.db.lastSync();
  }

  counts(): ReadCounts {
    return {
      employees: this.db.countEmployees(),
      attendance: this.db.countAttendance(),
    };
  }

  snapshot(options: ReadFilter): ReadSnapshot {
    // One SQLite transaction keeps a snapshot page from mixing collector states.
    return this.db.transaction(() => ({
      schemaVersion: this.db.schemaVersion,
      lastSync: this.db.lastSync(),
      counts: this.counts(),
      employees: this.db.listEmployees(),
      profiles: this.db.listEmployeeProfiles(),
      attendance: this.db.listRawAttendance(options),
    }));
  }
}
