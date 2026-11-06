// Full-snapshot sync: device -> validated rows -> one DB transaction.

import { randomUUID } from "node:crypto";
import {
  DeviceError,
  type DeviceAttendance,
  type DeviceGateway,
  type DeviceSnapshot,
} from "./device.ts";
import type { Db } from "./db.ts";
import type { AppLogger } from "./log.ts";
import { NOOP_LOGGER } from "./log.ts";
import { stamp } from "./time.ts";

const SYNC_LOCK_TTL_MS = 5 * 60_000;

export type SyncErrorCode = "SYNC_IN_PROGRESS";

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncResult {
  ok: true;
  users: number;
  records: number;
  firstDate: string | null;
  lastDate: string | null;
  durationMs: number;
  syncedAt: string;
  attempts: number;
}

export type SyncRunner = () => Promise<SyncResult>;

type SyncDb = Db & {
  insertEvent?: Db["insertEvent"];
};

// Events are written *after* the sync transaction commits, in their own
// transaction, and a failure to write one is swallowed: an audit trail must
// never turn a good sync into a failed one. `pendingDispatch` is handed back so
// a short-lived caller (`app sync`) can flush before closing the DB.
function recordEvent(
  db: SyncDb,
  logger: AppLogger,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (db.insertEvent === undefined) return;
  try {
    db.insertEvent({ event, at: stamp(), payload: JSON.stringify(payload) });
  } catch (error) {
    logger.info(
      `sync event skipped (${event}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRetryableCountMismatch(error: unknown): boolean {
  return error instanceof DeviceError && error.code === "ZK_COUNT_MISMATCH" && error.retryable;
}

function dateRange(rows: DeviceAttendance[]): {
  firstDate: string | null;
  lastDate: string | null;
} {
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const row of rows) {
    if (firstDate === null || row.date < firstDate) firstDate = row.date;
    if (lastDate === null || row.date > lastDate) lastDate = row.date;
  }

  return { firstDate, lastDate };
}

function errorMessage(error: unknown): string {
  if (error instanceof DeviceError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function readDevice(device: DeviceGateway): Promise<DeviceSnapshot> {
  let connected = false;
  try {
    await device.connect();
    connected = true;

    const snapshot = await device.readSnapshot();
    if (
      snapshot.users.length !== snapshot.counts.users ||
      snapshot.attendance.length !== snapshot.counts.records
    ) {
      throw new DeviceError(
        "ZK_COUNT_MISMATCH",
        `device reports ${snapshot.counts.users} users / ${snapshot.counts.records} records, ` +
          `parsed ${snapshot.users.length} / ${snapshot.attendance.length}`,
        true,
      );
    }

    return snapshot;
  } finally {
    if (connected) await device.disconnect();
  }
}

export async function syncNow(deps: {
  device: DeviceGateway;
  db: Db;
  logger?: AppLogger;
}): Promise<SyncResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const lockOwner = randomUUID();
  if (!deps.db.tryAcquireSyncLock(lockOwner, Date.now(), SYNC_LOCK_TTL_MS)) {
    throw new SyncError("SYNC_IN_PROGRESS", "another sync is already running");
  }

  const startedAt = stamp();
  const started = performance.now();
  logger.info("sync start");
  let lastError: unknown = null;
  let attempts = 0;

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      attempts = attempt;
      try {
        const snapshot = await readDevice(deps.device);
        const { firstDate, lastDate } = dateRange(snapshot.attendance);
        const syncedAt = stamp();
        const durationMs = Math.max(0, Math.round(performance.now() - started));

        const inserted = deps.db.transaction(() => {
          const before = deps.db.countAttendance();
          deps.db.upsertEmployees(snapshot.users, syncedAt);
          deps.db.upsertAttendance(snapshot.attendance, syncedAt);
          deps.db.recordSync({
            startedAt,
            finishedAt: syncedAt,
            durationMs,
            users: snapshot.users.length,
            records: snapshot.attendance.length,
            firstDate,
            lastDate,
            ok: true,
          });
          return deps.db.countAttendance() - before;
        });

        logger.info(
          `sync done: ${snapshot.users.length} users, ${snapshot.attendance.length} records, ` +
            `${firstDate ?? "-"}..${lastDate ?? "-"}, ${durationMs} ms, attempt ${attempts}`,
        );

        // Only genuinely new punches are an "attendance changed" event: a
        // re-read of the same rows rewrites synced_at but changes nothing a
        // consumer can act on.
        if (inserted > 0) {
          recordEvent(deps.db, logger, "attendance.changed", {
            from: firstDate,
            to: lastDate,
            inserted,
            records: snapshot.attendance.length,
            users: snapshot.users.length,
          });
        }
        recordEvent(deps.db, logger, "sync.done", {
          users: snapshot.users.length,
          records: snapshot.attendance.length,
          inserted,
          first_date: firstDate,
          last_date: lastDate,
          duration_ms: durationMs,
          attempts,
        });

        return {
          ok: true,
          users: snapshot.users.length,
          records: snapshot.attendance.length,
          firstDate,
          lastDate,
          durationMs,
          syncedAt,
          attempts,
        };
      } catch (error) {
        lastError = error;
        if (!isRetryableCountMismatch(error) || attempt === 3) break;
        logger.info(`sync retry after count mismatch: attempt ${attempt}`);
      }
    }

    const finishedAt = stamp();
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    try {
      deps.db.recordSync({
        startedAt,
        finishedAt,
        durationMs,
        users: 0,
        records: 0,
        firstDate: null,
        lastDate: null,
        ok: false,
        error: errorMessage(lastError),
      });
    } catch {
      // Do not mask the sync error if writing the failure log also fails.
    }

    logger.info(`sync error: ${errorMessage(lastError)}, ${durationMs} ms`);
    recordEvent(deps.db, logger, "sync.failed", {
      error: errorMessage(lastError),
      duration_ms: durationMs,
      attempts,
    });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    deps.db.releaseSyncLock(lockOwner);
  }
}
