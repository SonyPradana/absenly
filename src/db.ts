// SQLite schema, migrations, and the queries sync/recap need.

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { SPLIT_TIME, stamp } from "./time.ts";
import type { SyncScheduleInput, SyncScheduleRow } from "./auto-sync.ts";
import type {
  WorkExceptionInput,
  WorkExceptionKind,
  WorkExceptionSpan,
} from "./work-exceptions.ts";

export const DEFAULT_DB_FILE = "absen.sqlite";

export type DbMode = "production" | "test" | "staging";

export class DbError extends Error {
  constructor(
    readonly code: "DB_GUARD",
    message: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

export interface EmployeeInput {
  uid: number;
  idNumber: string;
  name: string;
  privilege: number;
  card: number;
  groupId: string;
}

export interface AttendanceInput {
  idNumber: string;
  date: string;
  time: string;
  punch: 0 | 1;
  verify: number;
}

export interface SyncLogInput {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  users: number;
  records: number;
  firstDate: string | null;
  lastDate: string | null;
  ok: boolean;
  error?: string | null;
}

export interface EmployeeRow {
  idNumber: string;
  name: string;
  card: number;
  groupId: string;
  privilege: number;
  deviceUid: number | null;
  syncedAt: string;
}

// Device employee + optional display mapping. No profile row = device name, active.
export interface EmployeeProfileRow {
  idNumber: string;
  deviceName: string;
  displayName: string | null;
  prefixTitle: string;
  suffixTitle: string;
  active: boolean;
  updatedAt: string | null;
}

export interface EmployeeProfileInput {
  idNumber: string;
  displayName: string | null;
  prefixTitle: string;
  suffixTitle: string;
  active: boolean;
  updatedAt: string;
}

type EmployeeProfileDbRow = Omit<EmployeeProfileRow, "active"> & { active: number };

export interface AttendanceRow {
  id: number;
  date: string;
  idNumber: string;
  time: string;
  status: "IN" | "OUT";
  rawPunch: number;
  verify: number;
  syncedAt: string;
}

export interface AttendanceWithNameRow extends AttendanceRow {
  name: string;
}

// Raw punches for the recap: id_number, name, date, time, verify. No derived status.
export interface PunchRow {
  idNumber: string;
  name: string;
  date: string;
  time: string;
  verify: number;
}

// Raw relay rows: the device values only, never a derived IN/OUT status.
export interface RawAttendanceRow {
  idNumber: string;
  date: string;
  time: string;
  punch: number;
  verify: number;
}

export interface AttendancePage {
  rows: AttendanceWithNameRow[];
  total: number;
}

export interface AttendancePageOptions {
  from: string;
  to: string;
  idNumber?: string;
  page: number;
  perPage: number;
}

export interface SyncLogRow {
  id: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  users: number;
  records: number;
  firstDate: string | null;
  lastDate: string | null;
  ok: boolean;
  error: string | null;
}

export interface WorkExceptionRow extends WorkExceptionInput {
  id: number;
  name: string;
  createdAt: string;
}

export interface WorkExceptionPageOptions {
  from: string;
  to: string;
  idNumber?: string;
  kind?: WorkExceptionKind;
  page: number;
  perPage: number;
}

export interface WorkExceptionPage {
  rows: WorkExceptionRow[];
  total: number;
}

export interface EventInput {
  event: string;
  at: string;
  payload: string;
}

export interface EventRow {
  id: number;
  event: string;
  at: string;
  payload: string;
  deliveredAt: string | null;
  attempts: number;
  lastError: string | null;
}

export interface WebhookRow {
  id: number;
  url: string;
  secret: string;
  events: string;
  enabled: boolean;
  createdAt: string;
  lastStatus: number | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface ShareLinkInput {
  token: string;
  idNumber: string;
  month: string;
  createdAt: string;
  expiresAt: number;
}

export type ShareLinkRow = ShareLinkInput;

export interface AppUserRow {
  id: number;
  username: string;
  role: "admin" | "employee";
  employeeIdNumber: string | null;
  createdAt: string;
}

export interface AppUserCredential extends AppUserRow {
  passwordHash: string;
}

export interface AppUserInput {
  username: string;
  passwordHash: string;
  employeeIdNumber: string;
  createdAt: string;
}

const MIGRATIONS = [
  `
  CREATE TABLE employees (
    id_number  TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    card       INTEGER NOT NULL DEFAULT 0,
    group_id   TEXT NOT NULL DEFAULT '',
    privilege  INTEGER NOT NULL DEFAULT 0,
    device_uid INTEGER,
    synced_at  TEXT NOT NULL
  );

  CREATE TABLE attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    id_number  TEXT NOT NULL REFERENCES employees(id_number),
    time       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('IN', 'OUT')),
    raw_punch  INTEGER NOT NULL,
    verify     INTEGER NOT NULL,
    synced_at  TEXT NOT NULL,
    UNIQUE (id_number, date, time)
  );

  CREATE INDEX idx_attendance_date ON attendance(date);
  CREATE INDEX idx_attendance_person_date ON attendance(id_number, date);

  CREATE TABLE sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    users       INTEGER NOT NULL DEFAULT 0,
    records     INTEGER NOT NULL DEFAULT 0,
    first_date  TEXT,
    last_date   TEXT,
    ok          INTEGER NOT NULL,
    error       TEXT
  );

  CREATE TABLE work_exceptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    id_number   TEXT NOT NULL REFERENCES employees(id_number),
    kind        TEXT NOT NULL CHECK (kind IN ('overtime', 'night_shift', 'holiday_work', 'other')),
    start_date  TEXT NOT NULL,
    start_time  TEXT NOT NULL,
    end_date    TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL,
    CHECK (end_date > start_date OR (end_date = start_date AND end_time > start_time)),
    UNIQUE (id_number, start_date, start_time, kind)
  );

  CREATE INDEX idx_work_exceptions_person_date ON work_exceptions(id_number, start_date);
  `,
  `
  CREATE TABLE sync_lock (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    owner       TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE employee_profiles (
    id_number    TEXT PRIMARY KEY REFERENCES employees(id_number) ON DELETE CASCADE,
    display_name TEXT,
    prefix_title TEXT NOT NULL DEFAULT '',
    suffix_title TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    updated_at   TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE admin_credentials (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE share_links (
    token      TEXT PRIMARY KEY,
    id_number  TEXT NOT NULL REFERENCES employees(id_number) ON DELETE CASCADE,
    month      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX idx_share_links_expires ON share_links(expires_at);
  `,
  `
  CREATE TABLE app_users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT NOT NULL UNIQUE,
    password_hash      TEXT NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
    employee_id_number TEXT REFERENCES employees(id_number) ON DELETE CASCADE,
    created_at         TEXT NOT NULL
  );

  CREATE UNIQUE INDEX idx_app_users_employee
    ON app_users(employee_id_number) WHERE employee_id_number IS NOT NULL;
  `,
  `
  CREATE TABLE sync_schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    days          TEXT NOT NULL,
    start_time    TEXT NOT NULL,
    end_time      TEXT NOT NULL,
    every_minutes INTEGER NOT NULL CHECK (every_minutes BETWEEN 1 AND 1440),
    enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at    TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event        TEXT NOT NULL,
    at           TEXT NOT NULL,
    payload      TEXT NOT NULL,
    delivered_at TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
  );

  CREATE INDEX idx_events_undelivered ON events(id) WHERE delivered_at IS NULL;

  CREATE TABLE webhooks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,
    events          TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at      TEXT NOT NULL,
    last_status     INTEGER,
    last_attempt_at TEXT,
    last_error      TEXT
  );
  `,
] as const;

export function assertSafeDbPath(path: string, mode: DbMode): void {
  if (mode === "production" || path === ":memory:") return;
  if (resolve(path) === resolve(DEFAULT_DB_FILE)) {
    throw new DbError(
      "DB_GUARD",
      `test/staging tidak boleh memakai DB default ${DEFAULT_DB_FILE}; set ABSEN_DB ke file terpisah`,
    );
  }
}

export class Db {
  constructor(private readonly sqlite: Database) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.ensureEmployeeProfiles(stamp());
  }

  get schemaVersion(): number {
    const row = this.sqlite.query("PRAGMA user_version").get() as { user_version: number } | null;
    return row?.user_version ?? 0;
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  tryAcquireSyncLock(owner: string, nowMs: number, ttlMs: number): boolean {
    const result = this.sqlite
      .prepare(
        `
        INSERT INTO sync_lock (id, owner, acquired_at, expires_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE sync_lock.expires_at <= ?
      `,
      )
      .run(owner, nowMs, nowMs + ttlMs, nowMs);
    return result.changes === 1;
  }

  releaseSyncLock(owner: string): void {
    this.sqlite.prepare("DELETE FROM sync_lock WHERE id = 1 AND owner = ?").run(owner);
  }

  upsertEmployees(employees: EmployeeInput[], syncedAt: string): void {
    const stmt = this.sqlite.prepare(`
      INSERT INTO employees (id_number, name, card, group_id, privilege, device_uid, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_number) DO UPDATE SET
        name = excluded.name,
        card = excluded.card,
        group_id = excluded.group_id,
        privilege = excluded.privilege,
        device_uid = excluded.device_uid,
        synced_at = excluded.synced_at
    `);

    for (const employee of employees) {
      stmt.run(
        employee.idNumber,
        employee.name,
        employee.card,
        employee.groupId,
        employee.privilege,
        employee.uid,
        syncedAt,
      );
    }

    this.ensureEmployeeProfiles(syncedAt);
  }

  ensureEmployees(idNumbers: Iterable<string>, syncedAt: string): void {
    const stmt = this.sqlite.prepare(`
      INSERT OR IGNORE INTO employees
        (id_number, name, card, group_id, privilege, device_uid, synced_at)
      VALUES (?, ?, 0, '', 0, NULL, ?)
    `);

    for (const idNumber of idNumbers) {
      stmt.run(idNumber, idNumber, syncedAt);
    }

    this.ensureEmployeeProfiles(syncedAt);
  }

  // Every employee gets a default-active profile. Existing profiles are never overwritten.
  ensureEmployeeProfiles(updatedAt: string): number {
    const result = this.sqlite
      .prepare(
        `
        INSERT OR IGNORE INTO employee_profiles
          (id_number, display_name, prefix_title, suffix_title, active, updated_at)
        SELECT id_number, NULL, '', '', 1, ?
        FROM employees
      `,
      )
      .run(updatedAt);
    return result.changes;
  }

  upsertAttendance(rows: AttendanceInput[], syncedAt: string): void {
    this.ensureEmployees(new Set(rows.map((row) => row.idNumber)), syncedAt);

    const stmt = this.sqlite.prepare(`
      INSERT INTO attendance
        (date, id_number, time, status, raw_punch, verify, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_number, date, time) DO UPDATE SET
        status = excluded.status,
        raw_punch = excluded.raw_punch,
        verify = excluded.verify,
        synced_at = excluded.synced_at
    `);

    for (const row of rows) {
      stmt.run(
        row.date,
        row.idNumber,
        row.time,
        row.time < SPLIT_TIME ? "IN" : "OUT",
        row.punch,
        row.verify,
        syncedAt,
      );
    }
  }

  recordSync(log: SyncLogInput): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO sync_log
          (started_at, finished_at, duration_ms, users, records, first_date, last_date, ok, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        log.startedAt,
        log.finishedAt,
        log.durationMs,
        log.users,
        log.records,
        log.firstDate,
        log.lastDate,
        log.ok ? 1 : 0,
        log.error ?? null,
      );
  }

  listEmployees(): EmployeeRow[] {
    return this.sqlite
      .query(
        `
        SELECT id_number AS idNumber, name, card, group_id AS groupId,
               privilege, device_uid AS deviceUid, synced_at AS syncedAt
        FROM employees
        ORDER BY id_number
      `,
      )
      .all() as EmployeeRow[];
  }

  listEmployeeProfiles(): EmployeeProfileRow[] {
    const rows = this.sqlite
      .query(
        `
        SELECT e.id_number AS idNumber, e.name AS deviceName,
               p.display_name AS displayName,
               COALESCE(p.prefix_title, '') AS prefixTitle,
               COALESCE(p.suffix_title, '') AS suffixTitle,
               COALESCE(p.active, 1) AS active,
               p.updated_at AS updatedAt
        FROM employees e
        LEFT JOIN employee_profiles p ON p.id_number = e.id_number
        ORDER BY e.id_number
      `,
      )
      .all() as EmployeeProfileDbRow[];
    return rows.map((row) => ({ ...row, active: row.active === 1 }));
  }

  getEmployeeProfile(idNumber: string): EmployeeProfileRow | null {
    const row = this.sqlite
      .query(
        `
        SELECT e.id_number AS idNumber, e.name AS deviceName,
               p.display_name AS displayName,
               COALESCE(p.prefix_title, '') AS prefixTitle,
               COALESCE(p.suffix_title, '') AS suffixTitle,
               COALESCE(p.active, 1) AS active,
               p.updated_at AS updatedAt
        FROM employees e
        LEFT JOIN employee_profiles p ON p.id_number = e.id_number
        WHERE e.id_number = ?
      `,
      )
      .get(idNumber) as EmployeeProfileDbRow | null;
    return row === null ? null : { ...row, active: row.active === 1 };
  }

  saveEmployeeProfile(profile: EmployeeProfileInput): void {
    this.sqlite
      .query(
        `
        INSERT INTO employee_profiles
          (id_number, display_name, prefix_title, suffix_title, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id_number) DO UPDATE SET
          display_name = excluded.display_name,
          prefix_title = excluded.prefix_title,
          suffix_title = excluded.suffix_title,
          active = excluded.active,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        profile.idNumber,
        profile.displayName,
        profile.prefixTitle,
        profile.suffixTitle,
        profile.active ? 1 : 0,
        profile.updatedAt,
      );
  }

  getAdminPasswordHash(): string | null {
    const row = this.sqlite
      .query("SELECT password_hash AS passwordHash FROM admin_credentials WHERE id = 1")
      .get() as { passwordHash: string } | null;
    return row?.passwordHash ?? null;
  }

  saveAdminPasswordHash(passwordHash: string, updatedAt: string): void {
    this.sqlite
      .query(
        `
        INSERT INTO admin_credentials (id, password_hash, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          password_hash = excluded.password_hash,
          updated_at = excluded.updated_at
      `,
      )
      .run(passwordHash, updatedAt);
  }

  clearAdminPasswordHash(): boolean {
    return this.sqlite.prepare("DELETE FROM admin_credentials WHERE id = 1").run().changes > 0;
  }

  listAppUsers(): AppUserRow[] {
    return this.sqlite
      .query(
        `
        SELECT id, username, role, employee_id_number AS employeeIdNumber, created_at AS createdAt
        FROM app_users
        ORDER BY username ASC
      `,
      )
      .all() as AppUserRow[];
  }

  getAppUserByUsername(username: string): AppUserCredential | null {
    return this.sqlite
      .query(
        `
        SELECT id, username, role, employee_id_number AS employeeIdNumber,
               created_at AS createdAt, password_hash AS passwordHash
        FROM app_users
        WHERE username = ?
      `,
      )
      .get(username) as AppUserCredential | null;
  }

  // One account per employee: re-saving a username keeps the row id.
  saveAppUser(input: AppUserInput): void {
    this.sqlite
      .query(
        `
        INSERT INTO app_users (username, password_hash, role, employee_id_number, created_at)
        VALUES (?, ?, 'employee', ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          password_hash = excluded.password_hash,
          employee_id_number = excluded.employee_id_number
      `,
      )
      .run(input.username, input.passwordHash, input.employeeIdNumber, input.createdAt);
  }

  deleteAppUser(username: string): boolean {
    return (
      this.sqlite.prepare("DELETE FROM app_users WHERE username = ?").run(username).changes > 0
    );
  }

  insertShareLink(link: ShareLinkInput): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO share_links (token, id_number, month, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(link.token, link.idNumber, link.month, link.createdAt, link.expiresAt);
  }

  getShareLink(token: string): ShareLinkRow | null {
    return this.sqlite
      .query(
        `
        SELECT token, id_number AS idNumber, month, created_at AS createdAt,
               expires_at AS expiresAt
        FROM share_links
        WHERE token = ?
      `,
      )
      .get(token) as ShareLinkRow | null;
  }

  deleteExpiredShareLinks(nowMs: number): number {
    return this.sqlite.prepare("DELETE FROM share_links WHERE expires_at <= ?").run(nowMs).changes;
  }

  listSyncSchedules(): SyncScheduleRow[] {
    const rows = this.sqlite
      .query(
        `
        SELECT id, days, start_time AS startTime, end_time AS endTime,
               every_minutes AS everyMinutes, enabled, created_at AS createdAt
        FROM sync_schedules
        ORDER BY start_time, id
      `,
      )
      .all() as Array<Omit<SyncScheduleRow, "enabled"> & { enabled: number }>;
    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  insertSyncSchedule(input: SyncScheduleInput, createdAt: string): number {
    const result = this.sqlite
      .prepare(
        `
        INSERT INTO sync_schedules (days, start_time, end_time, every_minutes, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.days,
        input.startTime,
        input.endTime,
        input.everyMinutes,
        input.enabled ? 1 : 0,
        createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  deleteSyncSchedule(id: number): boolean {
    return this.sqlite.prepare("DELETE FROM sync_schedules WHERE id = ?").run(id).changes > 0;
  }

  setSyncScheduleEnabled(id: number, enabled: boolean): boolean {
    return (
      this.sqlite
        .prepare("UPDATE sync_schedules SET enabled = ? WHERE id = ?")
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  // --- Hooks: outbound event log + webhook targets ---

  insertEvent(input: EventInput): number {
    const result = this.sqlite
      .prepare("INSERT INTO events (event, at, payload) VALUES (?, ?, ?)")
      .run(input.event, input.at, input.payload);
    return Number(result.lastInsertRowid);
  }

  listEvents(options: { since: number; limit: number }): EventRow[] {
    const rows = this.sqlite
      .query(
        `
        SELECT id, event, at, payload, delivered_at AS deliveredAt,
               attempts, last_error AS lastError
        FROM events
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `,
      )
      .all(options.since, options.limit) as EventRow[];
    return rows;
  }

  listUndeliveredEvents(limit: number): EventRow[] {
    // Exactly one attempt per event: a failure is recorded and never retried,
    // so a dead receiver cannot turn every later sync into a slow one.
    return this.sqlite
      .query(
        `
        SELECT id, event, at, payload, delivered_at AS deliveredAt,
               attempts, last_error AS lastError
        FROM events
        WHERE delivered_at IS NULL AND attempts = 0
        ORDER BY id
        LIMIT ?
      `,
      )
      .all(limit) as EventRow[];
  }

  markEventDelivered(id: number, at: string): void {
    this.sqlite
      .prepare("UPDATE events SET delivered_at = ?, last_error = NULL WHERE id = ?")
      .run(at, id);
  }

  markEventFailed(id: number, error: string): void {
    this.sqlite
      .prepare("UPDATE events SET attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run(error, id);
  }

  listWebhooks(): WebhookRow[] {
    const rows = this.sqlite
      .query(
        `
        SELECT id, url, secret, events, enabled, created_at AS createdAt,
               last_status AS lastStatus, last_attempt_at AS lastAttemptAt,
               last_error AS lastError
        FROM webhooks
        ORDER BY id
      `,
      )
      .all() as Array<Omit<WebhookRow, "enabled"> & { enabled: number }>;
    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  getWebhook(id: number): WebhookRow | null {
    return this.listWebhooks().find((row) => row.id === id) ?? null;
  }

  insertWebhook(input: {
    url: string;
    secret: string;
    events: string;
    enabled: boolean;
    createdAt: string;
  }): number {
    const result = this.sqlite
      .prepare(
        "INSERT INTO webhooks (url, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.url, input.secret, input.events, input.enabled ? 1 : 0, input.createdAt);
    return Number(result.lastInsertRowid);
  }

  updateWebhook(id: number, patch: { url?: string; events?: string; enabled?: boolean }): boolean {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.url !== undefined) {
      sets.push("url = ?");
      params.push(patch.url);
    }
    if (patch.events !== undefined) {
      sets.push("events = ?");
      params.push(patch.events);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(patch.enabled ? 1 : 0);
    }
    if (sets.length === 0) return this.getWebhook(id) !== null;
    params.push(id);
    return (
      this.sqlite.prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?`).run(...params)
        .changes > 0
    );
  }

  deleteWebhook(id: number): boolean {
    return this.sqlite.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  recordWebhookAttempt(id: number, status: number | null, at: string, error: string | null): void {
    this.sqlite
      .prepare(
        `
        UPDATE webhooks
        SET last_status = ?, last_attempt_at = ?, last_error = ?
        WHERE id = ?
      `,
      )
      .run(status, at, error, id);
  }

  // Consistent snapshot while WAL is active. The destination must not exist.
  backupTo(path: string): void {
    const escaped = path.replaceAll("'", "''");
    this.sqlite.exec(`VACUUM INTO '${escaped}'`);
  }

  countEmployeeProfiles(): number {
    return (this.sqlite.query("SELECT COUNT(*) AS n FROM employee_profiles").get() as { n: number })
      .n;
  }

  countActiveProfiles(): number {
    return (
      this.sqlite.query("SELECT COUNT(*) AS n FROM employee_profiles WHERE active = 1").get() as {
        n: number;
      }
    ).n;
  }

  listAttendance(from?: string, to?: string): AttendanceRow[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (from !== undefined) {
      conditions.push("date >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      conditions.push("date <= ?");
      params.push(to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.sqlite
      .query(
        `
        SELECT id, date, id_number AS idNumber, time, status,
               raw_punch AS rawPunch, verify, synced_at AS syncedAt
        FROM attendance
        ${where}
        ORDER BY date, time, id_number
      `,
      )
      .all(...params) as AttendanceRow[];
  }

  listAttendancePage(options: AttendancePageOptions): AttendancePage {
    const conditions = ["a.date >= ?", "a.date <= ?"];
    const params: Array<string | number> = [options.from, options.to];

    if (options.idNumber !== undefined) {
      conditions.push("a.id_number = ?");
      params.push(options.idNumber);
    }

    const where = conditions.join(" AND ");
    const total = (
      this.sqlite.query(`SELECT COUNT(*) AS n FROM attendance a WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;

    const offset = (options.page - 1) * options.perPage;
    const rows = this.sqlite
      .query(
        `
        SELECT a.id, a.date, a.id_number AS idNumber, e.name, a.time, a.status,
               a.raw_punch AS rawPunch, a.verify, a.synced_at AS syncedAt
        FROM attendance a
        JOIN employees e ON e.id_number = a.id_number
        WHERE ${where}
        ORDER BY a.date, a.time, a.id_number
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, options.perPage, offset) as AttendanceWithNameRow[];

    return { rows, total };
  }

  listPunches(options: { from: string; to: string; idNumber?: string }): PunchRow[] {
    const conditions = ["a.date >= ?", "a.date <= ?"];
    const params: string[] = [options.from, options.to];

    if (options.idNumber !== undefined) {
      conditions.push("a.id_number = ?");
      params.push(options.idNumber);
    }

    return this.sqlite
      .query(
        `
        SELECT a.id_number AS idNumber, e.name, a.date, a.time, a.verify
        FROM attendance a
        JOIN employees e ON e.id_number = a.id_number
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.date, a.id_number, a.time
      `,
      )
      .all(...params) as PunchRow[];
  }

  listRawAttendance(options: { from: string; to: string; idNumber?: string }): RawAttendanceRow[] {
    const conditions = ["date >= ?", "date <= ?"];
    const params: string[] = [options.from, options.to];

    if (options.idNumber !== undefined) {
      conditions.push("id_number = ?");
      params.push(options.idNumber);
    }

    return this.sqlite
      .query(
        `
        SELECT id_number AS idNumber, date, time, raw_punch AS punch, verify
        FROM attendance
        WHERE ${conditions.join(" AND ")}
        ORDER BY date, time, id_number
      `,
      )
      .all(...params) as RawAttendanceRow[];
  }

  countEmployees(): number {
    return (this.sqlite.query("SELECT COUNT(*) AS n FROM employees").get() as { n: number }).n;
  }
  countAttendance(): number {
    return (this.sqlite.query("SELECT COUNT(*) AS n FROM attendance").get() as { n: number }).n;
  }

  lastSync(): SyncLogRow | null {
    const row = this.sqlite
      .query(
        `
        SELECT id, started_at AS startedAt, finished_at AS finishedAt,
               duration_ms AS durationMs, users, records,
               first_date AS firstDate, last_date AS lastDate, ok, error
        FROM sync_log
        ORDER BY id DESC
        LIMIT 1
      `,
      )
      .get() as (Omit<SyncLogRow, "ok"> & { ok: number }) | null;

    return row === null ? null : { ...row, ok: row.ok === 1 };
  }

  listWorkExceptionsPage(options: WorkExceptionPageOptions): WorkExceptionPage {
    const conditions = ["w.start_date >= ?", "w.start_date <= ?"];
    const params: Array<string | number> = [options.from, options.to];

    if (options.idNumber !== undefined) {
      conditions.push("w.id_number = ?");
      params.push(options.idNumber);
    }
    if (options.kind !== undefined) {
      conditions.push("w.kind = ?");
      params.push(options.kind);
    }

    const where = conditions.join(" AND ");
    const total = (
      this.sqlite
        .query(`SELECT COUNT(*) AS n FROM work_exceptions w WHERE ${where}`)
        .get(...params) as {
        n: number;
      }
    ).n;

    const offset = (options.page - 1) * options.perPage;
    const rows = this.sqlite
      .query(
        `
        SELECT w.id, w.id_number AS idNumber, e.name, w.kind,
               w.start_date AS startDate, w.start_time AS startTime,
               w.end_date AS endDate, w.end_time AS endTime,
               w.note, w.created_at AS createdAt
        FROM work_exceptions w
        JOIN employees e ON e.id_number = w.id_number
        WHERE ${where}
        ORDER BY w.start_date DESC, w.start_time DESC, w.id DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, options.perPage, offset) as WorkExceptionRow[];

    return { rows, total };
  }

  listWorkExceptionSpans(idNumber: string): WorkExceptionSpan[] {
    return this.sqlite
      .query(
        `
        SELECT id_number AS idNumber, start_date AS startDate, start_time AS startTime,
               end_date AS endDate, end_time AS endTime
        FROM work_exceptions
        WHERE id_number = ?
      `,
      )
      .all(idNumber) as WorkExceptionSpan[];
  }

  // Spans that touch [from, to] at all, so a piket starting the night before
  // still waives the morning after.
  listWorkExceptionSpansInRange(from: string, to: string, idNumber?: string): WorkExceptionSpan[] {
    const conditions = ["start_date <= ?", "end_date >= ?"];
    const params: string[] = [to, from];
    if (idNumber !== undefined) {
      conditions.push("id_number = ?");
      params.push(idNumber);
    }
    return this.sqlite
      .query(
        `
        SELECT id_number AS idNumber, start_date AS startDate, start_time AS startTime,
               end_date AS endDate, end_time AS endTime
        FROM work_exceptions
        WHERE ${conditions.join(" AND ")}
        ORDER BY start_date, start_time
      `,
      )
      .all(...params) as WorkExceptionSpan[];
  }

  getWorkException(id: number): WorkExceptionRow | null {
    return this.sqlite
      .query(
        `
        SELECT w.id, w.id_number AS idNumber, e.name, w.kind,
               w.start_date AS startDate, w.start_time AS startTime,
               w.end_date AS endDate, w.end_time AS endTime,
               w.note, w.created_at AS createdAt
        FROM work_exceptions w
        JOIN employees e ON e.id_number = w.id_number
        WHERE w.id = ?
      `,
      )
      .get(id) as WorkExceptionRow | null;
  }

  insertWorkException(input: WorkExceptionInput, createdAt: string): number {
    const result = this.sqlite
      .prepare(
        `
        INSERT INTO work_exceptions
          (id_number, kind, start_date, start_time, end_date, end_time, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.idNumber,
        input.kind,
        input.startDate,
        input.startTime,
        input.endDate,
        input.endTime,
        input.note,
        createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  deleteWorkException(id: number): boolean {
    return this.sqlite.prepare("DELETE FROM work_exceptions WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) {
      throw new Error(`DB schema version ${current} lebih baru dari aplikasi`);
    }

    for (let version = current; version < MIGRATIONS.length; version++) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(MIGRATIONS[version]!);
        this.sqlite.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    }
  }
}

export function openDb(path: string, mode: DbMode = "production"): Db {
  assertSafeDbPath(path, mode);

  const sqlite = new Database(path, { create: true });
  try {
    if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
    return new Db(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function openMemoryDb(): Db {
  return openDb(":memory:", "test");
}
