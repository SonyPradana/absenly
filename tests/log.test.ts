import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLogger, NOOP_LOGGER } from "../src/log.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rekap-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("file logger", () => {
  test("appends timestamped lines to one file per WIB day", () => {
    const dir = join(tempDir(), "logs");
    const logger = createFileLogger({
      dir,
      now: () => new Date("2026-10-29T07:44:49+07:00"),
    });

    logger.info("sync start");
    logger.info("sync done: 56 users");
    logger.info("line one\nline two");

    const lines = readFileSync(join(dir, "2026-10-29.log"), "utf8").trim().split("\n");
    expect(lines).toEqual([
      "2026-10-29T07:44:49+07:00 sync start",
      "2026-10-29T07:44:49+07:00 sync done: 56 users",
      "2026-10-29T07:44:49+07:00 line one line two",
    ]);
  });

  test("never throws when the log directory cannot be created", () => {
    const file = join(tempDir(), "file");
    writeFileSync(file, "x", "utf8");
    const logger = createFileLogger({ dir: join(file, "logs") });

    expect(() => logger.info("still fine")).not.toThrow();
  });

  test("the no-op logger accepts messages", () => {
    expect(() => NOOP_LOGGER.info("ignored")).not.toThrow();
  });
});
