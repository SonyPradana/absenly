import { describe, expect, test } from "bun:test";
import { SPLIT_TIME, TIME_ZONE, stamp, today } from "../src/time.ts";

describe("WIB time", () => {
  test("uses Asia/Jakarta and the 10:00 split", () => {
    expect(TIME_ZONE).toBe("Asia/Jakarta");
    expect(SPLIT_TIME).toBe("10:00:00");
  });

  test("today follows WIB across the UTC day boundary", () => {
    expect(today(new Date("2026-10-20T16:30:00Z"))).toBe("2026-10-20");
    expect(today(new Date("2026-10-20T17:30:00Z"))).toBe("2026-10-21");
  });

  test("stamp is an ISO timestamp with a +07:00 offset", () => {
    expect(stamp(new Date("2026-10-20T16:30:00Z"))).toBe("2026-10-20T23:30:00+07:00");
    expect(stamp(new Date("2026-10-20T17:30:00Z"))).toBe("2026-10-21T00:30:00+07:00");
  });
});
