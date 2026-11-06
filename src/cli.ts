// CLI boundary: argv -> command dispatch. Commands call services directly, never HTTP.

import {
  loadDeviceConfig,
  loadRelayConfig,
  loadRoleConfig,
  loadScheduleConfig,
  loadStorageConfig,
  loadViewerRelayConfig,
  loadWebConfig,
  type AppRole,
  type DeviceConfig,
  type LoadedScheduleConfig,
  type RelayConfig,
  type StorageConfig,
  type ViewerRelayConfig,
  type WebConfig,
} from "./config.ts";
import { openDb, type Db, type EmployeeProfileInput, type EmployeeProfileRow } from "./db.ts";
import {
  composeDisplayName,
  EmployeeError,
  toEmployeeViews,
  type EmployeeView,
} from "./employees.ts";
import {
  defaultExportPath,
  ExportError,
  parseExportOptions,
  toExportJson,
  writeWorkbook,
  type ExportOptions,
} from "./export.ts";
import { RelayClientError, RelayReadStore, RelayScheduleStore } from "./relay/client.ts";
import { startRelayServer } from "./relay/server.ts";
import { createFileLogger } from "./log.ts";
import type { Punch } from "./recap.ts";
import { composeDailyRows, selectReportRows } from "./reports.ts";
import type { WorkExceptionSpan } from "./work-exceptions.ts";
import type { ScheduleCalendar } from "./schedule.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { SqliteReadStore } from "./store.ts";
import { stamp } from "./time.ts";
import { VERSION } from "./version.ts";
import { startServer } from "./web/server.ts";
import { ZkClient } from "./zk.ts";
import { syncNow } from "./sync.ts";
import { createAutoSync } from "./auto-sync.ts";
import { dispatchEvents } from "./hooks.ts";

export { VERSION };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const KNOWN_COMMANDS = new Set(["serve", "sync", "device", "relay"]);
export const HELP_TEXT = `absenly app

Usage:
  app serve [--port N] [--hostname H]   (admin web + API)
  app sync [--json]
  app device probe [--json]
  app export --for-month YYYY-MM [--user ID[,ID]] [--presence P] [--punctuality P] (--json | --excel [--mode raw,recap,user,poin] [--out PATH])
  app export --from YYYY-MM-DD --to YYYY-MM-DD [--user ID[,ID]] [--presence P] [--punctuality P] (--json | --excel [--mode raw,recap,user,poin] [--out PATH])
  app employees list [--json]
  app employees update --id ID [--display-name NAME] [--prefix-title T] [--suffix-title T] [--active true|false] [--json]
  app users list [--json]
  app users set-password [--username U] --employee-id ID --password P [--json]
  app users delete --username U [--json]
  app admin reset-password [--json]
  app relay status [--json]
  app help
  app --version

Implemented: help, --version, serve (admin web + API), sync, device probe, export, employees, users, admin reset-password, relay status.
Viewer role: serve and export read the collector; sync, device, employees, users, and admin are collector-only.
Contract: docs/CLI.md`;

function extractJson(args: string[]): { json: boolean; rest: string[] } {
  return {
    json: args.includes("--json"),
    rest: args.filter((arg) => arg !== "--json"),
  };
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "RUNTIME";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(io: CliIo, json: boolean, error: unknown): number {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (json) {
    io.err(JSON.stringify({ error: { code, message } }));
  } else {
    io.err(`error: ${message}`);
  }
  return 1;
}

function usage(io: CliIo, json: boolean, message: string): number {
  if (json) {
    io.err(JSON.stringify({ error: { code: "INVALID_ARGS", message } }));
  } else {
    io.err(`error: ${message}`);
    io.err('run "app help" for usage');
  }
  return 2;
}

function notImplemented(command: string, io: CliIo): number {
  io.err(`error: "${command}" is not implemented yet`);
  return 2;
}

function readOnlyCommand(io: CliIo, json: boolean, command: string): number {
  const message = `${command} is not available in viewer mode; run it on the collector`;
  if (json) {
    io.err(JSON.stringify({ error: { code: "READ_ONLY_VIEWER", message } }));
  } else {
    io.err(`error: ${message}`);
  }
  return 2;
}

function collectorOnly(io: CliIo, json: boolean, command: string): number | null {
  let role: AppRole;
  try {
    role = loadRoleConfig();
  } catch (error) {
    return fail(io, json, error);
  }
  return role === "viewer" ? readOnlyCommand(io, json, command) : null;
}

interface ServeOptions {
  port?: number;
  hostname?: string;
}

function parseServeArgs(args: string[], io: CliIo): ServeOptions | number {
  const options: ServeOptions = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--port" || arg === "--hostname") {
      const value = args[++index];
      if (value === undefined || value === "") {
        return usage(io, false, `${arg} requires a value`);
      }
      if (arg === "--port") {
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
          return usage(io, false, "--port must be between 1 and 65535");
        }
        options.port = port;
      } else {
        if (value.includes("://") || /\s/.test(value)) {
          return usage(io, false, "--hostname must be a hostname or IP address");
        }
        options.hostname = value;
      }
      continue;
    }
    return usage(io, false, `unexpected argument: ${arg}`);
  }

  return options;
}

async function serveViewer(env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  let web: WebConfig;
  let relayConfig: ViewerRelayConfig;
  try {
    web = loadWebConfig({ env });
    relayConfig = loadViewerRelayConfig({ env });
  } catch (error) {
    return fail(io, false, error);
  }

  const relay = new RelayReadStore({
    baseUrl: relayConfig.url,
    token: relayConfig.token,
    timeoutMs: relayConfig.timeoutMs,
  });
  const scheduleStore = new RelayScheduleStore(relay);

  let running: ReturnType<typeof startServer>;
  try {
    running = startServer({
      web,
      db: relay,
      storage: { dbPath: "(relay)", mode: "viewer" },
      device: null,
      schedule: scheduleStore,
      sync: async () => {
        throw new RelayClientError(
          "RELAY_READ_ONLY",
          "Viewer hanya membaca data collector; sync dilakukan di collector.",
          403,
        );
      },
      probe: null,
      readOnly: true,
      refresh: () => scheduleStore.refresh(),
    });
  } catch (error) {
    return fail(io, false, error);
  }

  const displayHost = web.hostname === "0.0.0.0" ? "127.0.0.1" : web.hostname;
  io.out(
    `serving on http://${displayHost}:${running.port} (viewer, read-only via ${relayConfig.url})`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      running.stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

async function serveCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseServeArgs(args, io);
  if (typeof parsed === "number") return parsed;

  const env = { ...process.env };
  if (parsed.port !== undefined) env.ABSEN_PORT = String(parsed.port);
  if (parsed.hostname !== undefined) env.ABSEN_HOSTNAME = parsed.hostname;

  let role: AppRole;
  try {
    role = loadRoleConfig({ env });
  } catch (error) {
    return fail(io, false, error);
  }
  if (role === "viewer") return serveViewer(env, io);

  let storage: StorageConfig;
  let web: WebConfig;
  let schedule: LoadedScheduleConfig;
  let device: DeviceConfig;
  let relay: RelayConfig;
  try {
    storage = loadStorageConfig({ env });
    web = loadWebConfig({ env });
    schedule = loadScheduleConfig({ env });
    device = loadDeviceConfig({ env });
    relay = loadRelayConfig({ env });
  } catch (error) {
    return fail(io, false, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, false, error);
  }

  let running: ReturnType<typeof startServer>;
  let relayRunning: ReturnType<typeof startRelayServer> | null = null;
  let autoSync: ReturnType<typeof createAutoSync>;
  try {
    const scheduleStore = new ScheduleStore({
      calendar: schedule.calendar,
      source: schedule.source,
      filePath: schedule.filePath,
    });
    const logger = createFileLogger();
    const makeDevice = (): ZkClient =>
      new ZkClient(device.host, device.port, device.commKey, device.timeoutMs);
    // Sync never awaits a webhook. Dispatch runs afterwards, in the background,
    // so a dead receiver cannot slow down or fail a sync.
    const runSync = async (): Promise<Awaited<ReturnType<typeof syncNow>>> => {
      const result = await syncNow({ device: makeDevice(), db, logger });
      void dispatchEvents({ db, logger });
      return result;
    };
    running = startServer({
      web,
      db,
      storage,
      device: { host: device.host, port: device.port, timeoutMs: device.timeoutMs },
      schedule: scheduleStore,
      sync: runSync,
      probe: async () => {
        const client = makeDevice();
        try {
          await client.connect();
          return await client.getCounts();
        } finally {
          try {
            await client.disconnect();
          } catch {
            // Do not mask a probe error with a disconnect error.
          }
        }
      },
    });

    if (relay.enabled) {
      try {
        relayRunning = startRelayServer({
          relay: { host: relay.host!, port: relay.port, token: relay.token! },
          store: new SqliteReadStore(db),
          getCalendar: () => {
            scheduleStore.reloadIfChanged();
            return scheduleStore.calendar;
          },
        });
      } catch (error) {
        running.stop();
        db.close();
        return fail(io, false, error);
      }
    }

    // Auto-sync schedules live in the DB (Settings), not in env. The ticker
    // re-reads them every 30s, so an edit applies without a restart.
    autoSync = createAutoSync({
      db,
      sync: runSync,
      logger,
    });
    autoSync.start();
  } catch (error) {
    db.close();
    return fail(io, false, error);
  }

  const displayHost = web.hostname === "0.0.0.0" ? "127.0.0.1" : web.hostname;
  io.out(`serving on http://${displayHost}:${running.port} (admin web + API)`);
  if (relayRunning !== null) {
    io.out(`relay on http://${relay.host}:${relayRunning.port} (/relay/v1, read-only)`);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      autoSync.stop();
      relayRunning?.stop();
      running.stop();
      db.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

async function syncCommand(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) {
    return usage(io, json, `unexpected argument: ${rest[0]}`);
  }
  const denied = collectorOnly(io, json, "sync");
  if (denied !== null) return denied;

  let storage: StorageConfig;
  let deviceConfig: DeviceConfig;
  try {
    storage = loadStorageConfig();
    deviceConfig = loadDeviceConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const device = new ZkClient(
      deviceConfig.host,
      deviceConfig.port,
      deviceConfig.commKey,
      deviceConfig.timeoutMs,
    );
    const result = await syncNow({ device, db, logger: createFileLogger() });
    // Unlike `serve`, this process exits right after and closes SQLite, so the
    // pending webhook push is flushed here. It never throws and never prints,
    // so `--json` stays clean.
    await dispatchEvents({ db });

    if (json) {
      io.out(
        JSON.stringify({
          data: {
            ok: true,
            users: result.users,
            records: result.records,
            first_date: result.firstDate,
            last_date: result.lastDate,
            duration_ms: result.durationMs,
            synced_at: result.syncedAt,
          },
        }),
      );
    } else {
      const period =
        result.firstDate === null || result.lastDate === null
          ? "no records"
          : `${result.firstDate}..${result.lastDate}`;
      io.out(
        `sync ok: ${result.users} users, ${result.records} records, ${period}, ${result.durationMs} ms`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function probeCommand(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) {
    return usage(io, json, `unexpected argument: ${rest[0]}`);
  }
  const denied = collectorOnly(io, json, "device probe");
  if (denied !== null) return denied;

  let deviceConfig: DeviceConfig;
  try {
    deviceConfig = loadDeviceConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  const device = new ZkClient(
    deviceConfig.host,
    deviceConfig.port,
    deviceConfig.commKey,
    deviceConfig.timeoutMs,
  );

  try {
    await device.connect();
    const counts = await device.getCounts();
    if (json) {
      io.out(
        JSON.stringify({
          data: {
            host: deviceConfig.host,
            port: deviceConfig.port,
            users: counts.users,
            records: counts.records,
            users_cap: counts.usersCap,
            records_cap: counts.recordsCap,
          },
        }),
      );
    } else {
      io.out(
        `probe ok: ${deviceConfig.host}:${deviceConfig.port}, ${counts.users} users, ${counts.records} records`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    try {
      await device.disconnect();
    } catch {
      // Do not mask a probe error with a disconnect error.
    }
  }
}

async function deviceCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "probe") {
    const json = args.includes("--json");
    return usage(
      io,
      json,
      subcommand === undefined
        ? "usage: app device probe [--json]"
        : `unknown device command: ${subcommand}`,
    );
  }
  return probeCommand(rest, io);
}

function emitExport(
  options: ExportOptions,
  punches: Punch[],
  employees: EmployeeView[],
  calendar: ScheduleCalendar,
  io: CliIo,
  workExceptions: WorkExceptionSpan[] = [],
): number {
  try {
    const daily = composeDailyRows(punches, employees, calendar, workExceptions);

    if (options.format === "json") {
      const rows = selectReportRows(daily, employees, {
        idNumbers: options.users,
        presence: options.presence,
        punctuality: options.punctuality,
      });
      io.out(toExportJson(rows, options));
      return 0;
    }

    const path = options.out ?? defaultExportPath(options);
    const result = writeWorkbook({ options, punches, daily, employees, calendar }, path);
    io.out(`export ok: ${result.path} (${result.sheets.length} sheets)`);
    return 0;
  } catch (error) {
    return fail(io, options.format === "json", error);
  }
}

async function exportCommand(args: string[], io: CliIo): Promise<number> {
  // --json selects the output format here, so it cannot be stripped before parsing.
  const jsonMode = args.includes("--json");

  let options: ExportOptions;
  try {
    options = parseExportOptions(args);
  } catch (error) {
    if (error instanceof ExportError) return usage(io, jsonMode, error.message);
    return fail(io, jsonMode, error);
  }

  let role: AppRole;
  try {
    role = loadRoleConfig();
  } catch (error) {
    return fail(io, jsonMode, error);
  }

  if (role === "viewer") {
    let relayConfig: ViewerRelayConfig;
    try {
      relayConfig = loadViewerRelayConfig();
    } catch (error) {
      return fail(io, jsonMode, error);
    }
    const relay = new RelayReadStore({
      baseUrl: relayConfig.url,
      token: relayConfig.token,
      timeoutMs: relayConfig.timeoutMs,
    });
    try {
      const [punches, profiles, calendar] = await Promise.all([
        relay.listPunches({ from: options.from, to: options.to }),
        relay.listEmployeeProfiles(),
        relay.getSchedule(),
      ]);
      return emitExport(options, punches, toEmployeeViews(profiles), calendar, io);
    } catch (error) {
      return fail(io, jsonMode, error);
    }
  }

  let storage: StorageConfig;
  let schedule: LoadedScheduleConfig;
  try {
    storage = loadStorageConfig();
    schedule = loadScheduleConfig();
  } catch (error) {
    return fail(io, jsonMode, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, jsonMode, error);
  }

  try {
    const punches = db.listPunches({ from: options.from, to: options.to });
    const employees = toEmployeeViews(db.listEmployeeProfiles());
    const workExceptions = db.listWorkExceptionSpansInRange(options.from, options.to);
    return emitExport(options, punches, employees, schedule.calendar, io, workExceptions);
  } finally {
    db.close();
  }
}

function profileDto(profile: EmployeeProfileRow) {
  return {
    id_number: profile.idNumber,
    device_name: profile.deviceName,
    display_name: profile.displayName,
    prefix_title: profile.prefixTitle,
    suffix_title: profile.suffixTitle,
    name: composeDisplayName(profile),
    active: profile.active,
    updated_at: profile.updatedAt,
  };
}

async function employeesList(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) return usage(io, json, `unexpected argument: ${rest[0]}`);

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const rows = db.listEmployeeProfiles().map(profileDto);
    if (json) {
      io.out(JSON.stringify({ data: rows, meta: { total: rows.length } }));
      return 0;
    }
    if (rows.length === 0) {
      io.out("no employees");
      return 0;
    }

    const idWidth = Math.max(2, ...rows.map((row) => row.id_number.length));
    const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
    io.out(`${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}  ACTIVE  DEVICE NAME`);
    for (const row of rows) {
      const state = row.active ? "yes" : "no";
      io.out(
        `${row.id_number.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${state.padEnd(6)}  ${row.device_name}`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function employeesUpdate(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  let id: string | null = null;
  let displayName: string | null | undefined;
  let prefixTitle: string | undefined;
  let suffixTitle: string | undefined;
  let active: boolean | undefined;

  try {
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      const next = (): string => {
        const value = rest[++index];
        if (value === undefined) {
          throw new EmployeeError("INVALID_ARGS", `${arg} requires a value`);
        }
        return value;
      };

      switch (arg) {
        case "--id": {
          const value = next().trim();
          if (value === "") throw new EmployeeError("INVALID_ARGS", "--id must not be empty");
          id = value;
          break;
        }
        case "--display-name": {
          const value = next().trim();
          displayName = value === "" ? null : value;
          break;
        }
        case "--prefix-title":
          prefixTitle = next().trim();
          break;
        case "--suffix-title":
          suffixTitle = next().trim();
          break;
        case "--active": {
          const value = next();
          if (value !== "true" && value !== "false") {
            throw new EmployeeError("INVALID_ARGS", "--active must be true|false");
          }
          active = value === "true";
          break;
        }
        default:
          throw new EmployeeError("INVALID_ARGS", `unexpected argument: ${arg}`);
      }
    }
  } catch (error) {
    if (error instanceof EmployeeError && error.code === "INVALID_ARGS") {
      return usage(io, json, error.message);
    }
    return fail(io, json, error);
  }

  if (id === null) return usage(io, json, "--id is required");
  if (
    displayName === undefined &&
    prefixTitle === undefined &&
    suffixTitle === undefined &&
    active === undefined
  ) {
    return usage(
      io,
      json,
      "no changes: pass --display-name, --prefix-title, --suffix-title, or --active",
    );
  }

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const existing = db.getEmployeeProfile(id);
    if (existing === null) {
      return fail(io, json, new EmployeeError("NOT_FOUND", `employee not found: ${id}`));
    }

    const input: EmployeeProfileInput = {
      idNumber: id,
      displayName: displayName === undefined ? existing.displayName : displayName,
      prefixTitle: prefixTitle ?? existing.prefixTitle,
      suffixTitle: suffixTitle ?? existing.suffixTitle,
      active: active ?? existing.active,
      updatedAt: stamp(),
    };
    db.saveEmployeeProfile(input);

    const saved = db.getEmployeeProfile(id);
    if (saved === null) {
      return fail(io, json, new EmployeeError("NOT_FOUND", `employee not found: ${id}`));
    }
    const dto = profileDto(saved);
    if (json) {
      io.out(JSON.stringify({ data: dto }));
    } else {
      io.out(`employee ok: ${dto.id_number} | ${dto.name} | ${dto.active ? "active" : "inactive"}`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function employeesCommand(args: string[], io: CliIo): Promise<number> {
  const denied = collectorOnly(io, args.includes("--json"), "employees");
  if (denied !== null) return denied;
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return employeesList(rest, io);
  if (subcommand === "update") return employeesUpdate(rest, io);
  return usage(
    io,
    args.includes("--json"),
    subcommand === undefined
      ? "usage: app employees list|update"
      : `unknown employees command: ${subcommand}`,
  );
}

async function usersList(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) return usage(io, json, `unexpected argument: ${rest[0]}`);

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const rows = db.listAppUsers().map((row) => ({
      username: row.username,
      role: row.role,
      employee_id_number: row.employeeIdNumber,
      created_at: row.createdAt,
    }));
    if (json) {
      io.out(JSON.stringify({ data: rows }));
      return 0;
    }
    if (rows.length === 0) {
      io.out("no employee accounts");
      return 0;
    }
    const userWidth = Math.max(8, ...rows.map((row) => row.username.length));
    io.out(`${"USERNAME".padEnd(userWidth)}  ROLE      EMPLOYEE  CREATED`);
    for (const row of rows) {
      io.out(
        `${row.username.padEnd(userWidth)}  ${row.role.padEnd(8)}  ${(row.employee_id_number ?? "-").padEnd(8)}  ${row.created_at}`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function usersSetPassword(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  let username: string | null = null;
  let employeeId: string | null = null;
  let password: string | null = null;

  try {
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      const next = (): string => {
        const value = rest[++index];
        if (value === undefined) throw new EmployeeError("INVALID_ARGS", `${arg} requires a value`);
        return value;
      };
      switch (arg) {
        case "--username": {
          const value = next().trim();
          if (value === "") throw new EmployeeError("INVALID_ARGS", "--username must not be empty");
          username = value;
          break;
        }
        case "--employee-id": {
          const value = next().trim();
          if (value === "")
            throw new EmployeeError("INVALID_ARGS", "--employee-id must not be empty");
          employeeId = value;
          break;
        }
        case "--password": {
          password = next();
          break;
        }
        default:
          throw new EmployeeError("INVALID_ARGS", `unexpected argument: ${arg}`);
      }
    }
  } catch (error) {
    if (error instanceof EmployeeError && error.code === "INVALID_ARGS") {
      return usage(io, json, error.message);
    }
    return fail(io, json, error);
  }

  if (employeeId === null) return usage(io, json, "--employee-id is required");
  if (password === null) return usage(io, json, "--password is required");
  if (password.length < 8) return usage(io, json, "--password must be at least 8 characters");

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    if (db.getEmployeeProfile(employeeId) === null) {
      return fail(io, json, new EmployeeError("NOT_FOUND", `employee not found: ${employeeId}`));
    }
    // Username defaults to the employee's PIN. A reset keeps the existing
    // username instead of creating a second account for the same employee.
    const existing = db.listAppUsers().find((user) => user.employeeIdNumber === employeeId) ?? null;
    const finalUsername = username ?? existing?.username ?? employeeId;
    if (existing !== null && existing.username !== finalUsername) {
      return fail(
        io,
        json,
        new EmployeeError(
          "ACCOUNT_EXISTS",
          `employee ${employeeId} already has account: ${existing.username}`,
        ),
      );
    }
    const hash = await Bun.password.hash(password);
    db.saveAppUser({
      username: finalUsername,
      passwordHash: hash,
      employeeIdNumber: employeeId,
      createdAt: stamp(),
    });
    const saved = db.getAppUserByUsername(finalUsername);
    const data = {
      username: finalUsername,
      role: "employee" as const,
      employee_id_number: saved?.employeeIdNumber ?? employeeId,
    };
    if (json) {
      io.out(JSON.stringify({ data }));
    } else {
      io.out(`user ok: ${finalUsername} -> employee ${data.employee_id_number}`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function usersDelete(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  let username: string | null = null;
  try {
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg !== "--username") {
        throw new EmployeeError("INVALID_ARGS", `unexpected argument: ${arg}`);
      }
      const value = rest[++index];
      if (value === undefined)
        throw new EmployeeError("INVALID_ARGS", "--username requires a value");
      username = value.trim();
    }
  } catch (error) {
    if (error instanceof EmployeeError && error.code === "INVALID_ARGS") {
      return usage(io, json, error.message);
    }
    return fail(io, json, error);
  }
  if (username === null || username === "") return usage(io, json, "--username is required");

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const deleted = db.deleteAppUser(username);
    if (!deleted) {
      return fail(io, json, new EmployeeError("NOT_FOUND", `user not found: ${username}`));
    }
    if (json) {
      io.out(JSON.stringify({ data: { ok: true, username } }));
    } else {
      io.out(`user deleted: ${username}`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function usersCommand(args: string[], io: CliIo): Promise<number> {
  const denied = collectorOnly(io, args.includes("--json"), "users");
  if (denied !== null) return denied;
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return usersList(rest, io);
  if (subcommand === "set-password") return usersSetPassword(rest, io);
  if (subcommand === "delete") return usersDelete(rest, io);
  return usage(
    io,
    args.includes("--json"),
    subcommand === undefined
      ? "usage: app users list|set-password|delete"
      : `unknown users command: ${subcommand}`,
  );
}

async function adminResetPassword(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) return usage(io, json, `unexpected argument: ${rest[0]}`);

  let storage: StorageConfig;
  try {
    storage = loadStorageConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  let db: Db;
  try {
    db = openDb(storage.dbPath, storage.mode);
  } catch (error) {
    return fail(io, json, error);
  }

  try {
    const cleared = db.clearAdminPasswordHash();
    if (json) {
      io.out(JSON.stringify({ data: { ok: true, cleared } }));
    } else {
      io.out(
        cleared
          ? "admin password reset: DB hash removed; env bootstrap is active again"
          : "admin password reset: no DB hash; env bootstrap is already active",
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  } finally {
    db.close();
  }
}

async function adminCommand(args: string[], io: CliIo): Promise<number> {
  const denied = collectorOnly(io, args.includes("--json"), "admin");
  if (denied !== null) return denied;
  const [subcommand, ...rest] = args;
  if (subcommand === "reset-password") return adminResetPassword(rest, io);
  return usage(
    io,
    args.includes("--json"),
    subcommand === undefined
      ? "usage: app admin reset-password"
      : `unknown admin command: ${subcommand}`,
  );
}

function localRelayUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const bracketed = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  return `http://${bracketed}:${port}`;
}

async function relayStatus(args: string[], io: CliIo): Promise<number> {
  const { json, rest } = extractJson(args);
  if (rest.length > 0) return usage(io, json, `unexpected argument: ${rest[0]}`);

  let role: AppRole;
  try {
    role = loadRoleConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  if (role === "viewer") {
    let config: ViewerRelayConfig;
    try {
      config = loadViewerRelayConfig();
    } catch (error) {
      return fail(io, json, error);
    }
    const client = new RelayReadStore({
      baseUrl: config.url,
      token: config.token,
      timeoutMs: config.timeoutMs,
    });
    try {
      const meta = await client.meta();
      const data = {
        role: "viewer",
        relay_url: config.url,
        reachable: true,
        app_version: meta.app_version,
        schema_version: meta.schema_version,
        counts: meta.counts,
        last_sync: meta.last_sync,
      };
      if (json) {
        io.out(JSON.stringify({ data }));
      } else {
        io.out(
          `relay ok: viewer -> ${config.url}, schema ${meta.schema_version}, ${meta.counts.employees} employees, ${meta.counts.attendance} records`,
        );
      }
      return 0;
    } catch (error) {
      return fail(io, json, error);
    }
  }

  let config: RelayConfig;
  try {
    config = loadRelayConfig();
  } catch (error) {
    return fail(io, json, error);
  }

  if (!config.enabled) {
    const data = {
      role: "collector",
      relay_enabled: false,
      relay_url: null,
      reachable: null,
    };
    if (json) {
      io.out(JSON.stringify({ data }));
    } else {
      io.out("relay status: disabled (collector has no relay listener)");
    }
    return 0;
  }

  const url = localRelayUrl(config.host!, config.port);
  const client = new RelayReadStore({
    baseUrl: url,
    token: config.token!,
    timeoutMs: 5_000,
  });
  try {
    const meta = await client.meta();
    const data = {
      role: "collector",
      relay_enabled: true,
      relay_url: url,
      reachable: true,
      app_version: meta.app_version,
      schema_version: meta.schema_version,
      counts: meta.counts,
      last_sync: meta.last_sync,
    };
    if (json) {
      io.out(JSON.stringify({ data }));
    } else {
      io.out(
        `relay ok: collector -> ${url}, schema ${meta.schema_version}, ${meta.counts.employees} employees, ${meta.counts.attendance} records`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, error);
  }
}

async function relayCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return relayStatus(rest, io);
  return usage(
    io,
    args.includes("--json"),
    subcommand === undefined
      ? "usage: app relay status [--json]"
      : `unknown relay command: ${subcommand}`,
  );
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined || command === "help") {
    io.out(HELP_TEXT);
    return 0;
  }
  if (command === "--version") {
    io.out(VERSION);
    return 0;
  }
  if (command === "serve") return serveCommand(args, io);
  if (command === "sync") return syncCommand(args, io);
  if (command === "device") return deviceCommand(args, io);
  if (command === "export") return exportCommand(args, io);
  if (command === "employees") return employeesCommand(args, io);
  if (command === "users") return usersCommand(args, io);
  if (command === "admin") return adminCommand(args, io);
  if (command === "relay") return relayCommand(args, io);
  if (KNOWN_COMMANDS.has(command)) {
    return notImplemented(command, io);
  }

  io.err(`error: unknown command: ${command}`);
  io.err('run "app help" for usage');
  return 2;
}
