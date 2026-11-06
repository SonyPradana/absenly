// Auto-sync schedules: many "window + interval" rows, union semantics.
// Rules are pure; the ticker at the bottom is the only side effect.
//
// A row means: on these weekdays, between start_time (inclusive) and end_time
// (exclusive), run a sync at most once every `every_minutes`.

import { DAY_KEYS, type DayKey } from "./schedule.ts";
import { NOOP_LOGGER, type AppLogger } from "./log.ts";
import type { SyncLogRow } from "./db.ts";
import type { Awaitable } from "./store.ts";
import { clockMinutes, minutesOfDay, wibDayIndex } from "./time.ts";

export const SCHEDULE_DAYS_ANY = "*";

export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 1440;

export type SyncScheduleErrorCode = "INVALID";

export class SyncScheduleError extends Error {
  constructor(
    readonly code: SyncScheduleErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SyncScheduleError";
  }
}

export interface SyncScheduleInput {
  days: string;
  startTime: string;
  endTime: string;
  everyMinutes: number;
  enabled: boolean;
}

export interface SyncScheduleRow extends SyncScheduleInput {
  id: number;
  createdAt: string;
}

/** A row reduced to the fields `isDue` needs; lets tests skip DB rows. */
export type SyncScheduleRule = Pick<
  SyncScheduleInput,
  "days" | "startTime" | "endTime" | "everyMinutes" | "enabled"
>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `*` or a comma list of `DAY_KEYS` names. Order and duplicates are ignored. */
export function parseDays(value: unknown): DayKey[] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === "") return null;
  if (trimmed === SCHEDULE_DAYS_ANY) return [...DAY_KEYS];

  const seen = new Set<DayKey>();
  for (const part of trimmed.split(",")) {
    const day = part.trim();
    if (day === "") return null;
    if (!(DAY_KEYS as readonly string[]).includes(day)) return null;
    seen.add(day as DayKey);
  }
  return DAY_KEYS.filter((day) => seen.has(day));
}

export function formatDays(days: readonly DayKey[]): string {
  return days.length === DAY_KEYS.length ? SCHEDULE_DAYS_ANY : days.join(",");
}

export function parseSyncSchedule(value: unknown): SyncScheduleInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncScheduleError("INVALID", "Jadwal harus objek.", "body");
  }
  const body = value as Record<string, unknown>;

  const days = parseDays(body.days ?? SCHEDULE_DAYS_ANY);
  if (days === null) {
    throw new SyncScheduleError(
      "INVALID",
      "days harus '*' atau daftar hari (MONDAY,SATURDAY,...).",
      "days",
    );
  }

  const startTime = body.start_time;
  const endTime = body.end_time;
  if (typeof startTime !== "string" || !TIME_RE.test(startTime)) {
    throw new SyncScheduleError("INVALID", "start_time harus HH:MM.", "start_time");
  }
  if (typeof endTime !== "string" || !TIME_RE.test(endTime)) {
    throw new SyncScheduleError("INVALID", "end_time harus HH:MM.", "end_time");
  }

  const start = minutesOfDay(startTime)!;
  const end = minutesOfDay(endTime)!;
  if (end <= start) {
    // A window crossing midnight is rejected instead of guessed: the day list
    // would then describe two different days.
    throw new SyncScheduleError("INVALID", "end_time harus setelah start_time.", "range");
  }

  const everyMinutes = body.every_minutes;
  if (
    typeof everyMinutes !== "number" ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < MIN_EVERY_MINUTES ||
    everyMinutes > MAX_EVERY_MINUTES
  ) {
    throw new SyncScheduleError(
      "INVALID",
      `every_minutes harus bilangan bulat ${MIN_EVERY_MINUTES}-${MAX_EVERY_MINUTES}.`,
      "every_minutes",
    );
  }
  if (everyMinutes > end - start) {
    throw new SyncScheduleError(
      "INVALID",
      "every_minutes lebih besar dari panjang window.",
      "every_minutes",
    );
  }

  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") {
    throw new SyncScheduleError("INVALID", "enabled harus boolean.", "enabled");
  }

  return { days: formatDays(days), startTime, endTime, everyMinutes, enabled };
}

export interface DueResult {
  due: boolean;
  /** Next moment a sync may start, or null when no row matches in the next 7 days. */
  nextAt: Date | null;
  /** True when the only reason for `due: false` is a recent attempt. */
  waitingForInterval: boolean;
}

interface Candidate {
  at: Date;
  everyMinutes: number;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/** The WIB midnight that starts the day containing `now`, truncated to the minute. */
function wibDayStart(now: Date): Date {
  const floored = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return addMinutes(floored, -clockMinutes(floored));
}

/**
 * Earliest start of a `startTime` window at or after `from`, in WIB.
 * Searches 8 days ahead so the next occurrence resolves from any weekday.
 */
function nextWindowStart(day: DayKey, startMinutes: number, from: Date): Date {
  const dayStart = wibDayStart(from);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = addMinutes(dayStart, offset * 1440 + startMinutes);
    if (candidate.getTime() >= from.getTime() && DAY_KEYS[wibDayIndex(candidate)] === day) {
      return candidate;
    }
  }
  return addMinutes(dayStart, 7 * 1440 + startMinutes);
}

function inWindow(rule: SyncScheduleRule, day: DayKey, clock: number): boolean {
  const days = parseDays(rule.days);
  if (days === null || !days.includes(day)) return false;
  const start = minutesOfDay(rule.startTime);
  const end = minutesOfDay(rule.endTime);
  if (start === null || end === null) return false;
  return clock >= start && clock < end;
}

/**
 * Pure decision for one tick.
 *
 * `lastAttemptAt` is the last sync start (success or failure). Using the last
 * attempt, not the last success, keeps a dead device from retrying every tick.
 */
export function isDue(
  rules: readonly SyncScheduleRule[],
  lastAttemptAt: Date | null,
  now: Date,
): DueResult {
  const active = rules.filter((rule) => rule.enabled);
  if (active.length === 0) return { due: false, nextAt: null, waitingForInterval: false };

  const dayIndex = wibDayIndex(now);
  const day = DAY_KEYS[dayIndex]!;
  const clock = clockMinutes(now);

  const open = active.filter((rule) => inWindow(rule, day, clock));
  if (open.length > 0) {
    const waited = (rule: SyncScheduleRule): boolean =>
      lastAttemptAt === null ||
      now.getTime() - lastAttemptAt.getTime() >= rule.everyMinutes * 60_000;

    if (open.some(waited)) return { due: true, nextAt: now, waitingForInterval: false };

    const soonest = Math.min(...open.map((rule) => rule.everyMinutes));
    const nextAt = addMinutes(lastAttemptAt!, soonest);
    return { due: false, nextAt, waitingForInterval: true };
  }

  // No window is open: report when the earliest future window starts.
  const candidates: Candidate[] = [];
  for (const rule of active) {
    const days = parseDays(rule.days);
    if (days === null) continue;
    const start = minutesOfDay(rule.startTime);
    if (start === null) continue;
    for (const candidateDay of days) {
      const at = nextWindowStart(candidateDay, start, now);
      if (at.getTime() > now.getTime()) {
        candidates.push({ at, everyMinutes: rule.everyMinutes });
      }
    }
  }
  if (candidates.length === 0) return { due: false, nextAt: null, waitingForInterval: false };
  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { due: false, nextAt: candidates[0]!.at, waitingForInterval: false };
}

export const TICK_INTERVAL_MS = 30_000;

export interface AutoSyncDeps {
  db: {
    listSyncSchedules(): Awaitable<SyncScheduleRow[]>;
    lastSync(): Awaitable<SyncLogRow | null>;
  };
  sync: () => Promise<unknown>;
  logger?: AppLogger;
  now?: () => Date;
}

// Tick reads the schedules and the last attempt from the DB every time, so a
// Settings change applies without a restart, and a missed tick self-heals.
export function createAutoSync(deps: AutoSyncDeps) {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? NOOP_LOGGER;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const schedules = await deps.db.listSyncSchedules();
      const last = await deps.db.lastSync();
      const lastAttemptAt = last === null ? null : new Date(last.startedAt);
      const decision = isDue(schedules, lastAttemptAt, now());
      if (!decision.due) return;

      logger.info("auto sync start");
      try {
        await deps.sync();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A manual sync holding the lock is normal, not an error.
        const busy = /SYNC_IN_PROGRESS/.test(message);
        logger.info(`auto sync ${busy ? "skipped (busy)" : "error"}: ${message}`);
      }
    } catch (error) {
      logger.info(`auto sync error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick();
      }, TICK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    get started(): boolean {
      return timer !== null;
    },
  };
}
