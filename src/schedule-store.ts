// Mutable schedule holder for `app serve`: hot reload by mtime + atomic save.
// The pure schedule rules stay in schedule.ts.

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import {
  parseScheduleCalendar,
  parseScheduleJson,
  ScheduleError,
  type ScheduleCalendar,
} from "./schedule.ts";

export type ScheduleSourceName = "file" | "env" | "relay";

export interface ScheduleSource {
  readonly calendar: ScheduleCalendar;
  readonly source: ScheduleSourceName;
  readonly filePath: string | null;
  readonly lastError: ScheduleError | null;
  reloadIfChanged(): boolean;
  save(input: ScheduleCalendar): ScheduleCalendar | Promise<ScheduleCalendar>;
}

export interface ScheduleStoreOptions {
  calendar: ScheduleCalendar;
  source: "file" | "env";
  filePath: string | null;
  readFile?: (path: string) => string;
  statMtime?: (path: string) => number;
  writeFile?: (path: string, text: string) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ScheduleStore implements ScheduleSource {
  private current: ScheduleCalendar;
  private mtimeMs: number | null;
  private error: ScheduleError | null = null;
  private readonly readFile: (path: string) => string;
  private readonly statMtime: (path: string) => number;
  private readonly writeFile: (path: string, text: string) => void;
  private readonly rename: (from: string, to: string) => void;
  private readonly remove: (path: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: ScheduleStoreOptions) {
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.statMtime = options.statMtime ?? ((path) => statSync(path).mtimeMs);
    this.writeFile = options.writeFile ?? ((path, text) => writeFileSync(path, text, "utf8"));
    this.rename = options.rename ?? ((from, to) => renameSync(from, to));
    this.remove = options.remove ?? ((path) => unlinkSync(path));
    this.now = options.now ?? Date.now;
    this.current = options.calendar;
    this.mtimeMs = this.readMtime(options.filePath);
  }

  get calendar(): ScheduleCalendar {
    return this.current;
  }

  get source(): "file" | "env" {
    return this.options.source;
  }

  get filePath(): string | null {
    return this.options.filePath;
  }

  get lastError(): ScheduleError | null {
    return this.error;
  }

  // Called before HTTP work. A bad external edit keeps the last valid calendar.
  reloadIfChanged(): boolean {
    const path = this.options.filePath;
    if (this.options.source !== "file" || path === null) return false;

    let mtime: number | null;
    try {
      mtime = this.statMtime(path);
    } catch (error) {
      this.error = new ScheduleError(
        "SCHEDULE_READ",
        `tidak bisa membaca ${path}: ${messageOf(error)}`,
      );
      return false;
    }

    if (this.mtimeMs !== null && mtime === this.mtimeMs) return false;
    this.mtimeMs = mtime;

    try {
      const next = parseScheduleJson(this.readFile(path));
      this.current = next;
      this.error = null;
      return true;
    } catch (error) {
      this.error =
        error instanceof ScheduleError
          ? new ScheduleError(error.code, `${path}: ${error.message}`)
          : new ScheduleError("SCHEDULE_READ", `${path}: ${messageOf(error)}`);
      return false;
    }
  }

  save(input: ScheduleCalendar): ScheduleCalendar {
    const path = this.options.filePath;
    if (this.options.source !== "file" || path === null) {
      throw new ScheduleError(
        "SCHEDULE_READONLY",
        "jadwal berasal dari env dan tidak bisa diedit dari web",
      );
    }

    let next: ScheduleCalendar;
    try {
      next = parseScheduleCalendar(input);
    } catch (error) {
      if (error instanceof ScheduleError) throw error;
      throw new ScheduleError("SCHEDULE_SHAPE", messageOf(error));
    }

    const text = `${JSON.stringify(next, null, 2)}\n`;
    const temp = `${path}.${process.pid}.${this.now()}.tmp`;
    try {
      this.writeFile(temp, text);
      this.rename(temp, path);
    } catch (error) {
      try {
        this.remove(temp);
      } catch {
        // The temp file may not exist; do not mask the write error.
      }
      throw new ScheduleError("SCHEDULE_WRITE", `gagal menulis ${path}: ${messageOf(error)}`);
    }

    this.current = next;
    this.mtimeMs = this.readMtime(path);
    this.error = null;
    return next;
  }

  private readMtime(path: string | null): number | null {
    if (path === null) return null;
    try {
      return this.statMtime(path);
    } catch {
      return null;
    }
  }
}
