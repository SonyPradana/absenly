// Append-only daily log. Keep sync lifecycle events, never secrets or personal data.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stamp, today } from "./time.ts";

export interface AppLogger {
  info(message: string): void;
}

export const NOOP_LOGGER: AppLogger = { info() {} };

function oneLine(message: string): string {
  return message.replace(/[\r\n]+/g, " ");
}

export function createFileLogger(options: { dir?: string; now?: () => Date } = {}): AppLogger {
  const dir = options.dir ?? "logs";
  const now = options.now ?? (() => new Date());
  return {
    info(message) {
      try {
        const at = now();
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${today(at)}.log`), `${stamp(at)} ${oneLine(message)}\n`, "utf8");
      } catch {
        // Logging must never break a sync or a request.
      }
    },
  };
}
