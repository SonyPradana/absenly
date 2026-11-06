import { describe, expect, test } from "bun:test";
import { dateRange, isValidDate, monthRange, PeriodError } from "../src/period.ts";

function thrown(fn: () => unknown): PeriodError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PeriodError);
    return error as PeriodError;
  }
  throw new Error("expected PeriodError");
}

describe("period validation", () => {
  test("month ranges use the real month length", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2024-02").to).toBe("2024-02-29");
    expect(monthRange("2023-02").to).toBe("2023-02-28");
    expect(monthRange("2000-02").to).toBe("2000-02-29");
    expect(monthRange("1900-02").to).toBe("1900-02-28");
  });

  test("invalid months, including year zero, are rejected", () => {
    for (const month of ["0000-01", "2026-00", "2026-13", "2026-1", "2026-10-01"]) {
      const error = thrown(() => monthRange(month));
      expect(error.code).toBe("MONTH");
      expect(error.field).toBe("month");
    }
  });

  test("valid dates include leap days but not impossible days or year zero", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2026-10-21")).toBe(true);
    expect(isValidDate("2023-02-29")).toBe(false);
    expect(isValidDate("2026-04-31")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("0000-01-01")).toBe(false);
    expect(isValidDate("2026-1-01")).toBe(false);
  });

  test("date ranges are inclusive, ordered, and at most 366 days", () => {
    expect(dateRange("2026-10-01", "2026-10-31")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(dateRange("2024-01-01", "2024-12-31")).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
    });

    expect(thrown(() => dateRange("2026-10-20", "2026-10-01")).code).toBe("ORDER");
    expect(thrown(() => dateRange("2024-01-01", "2025-01-01")).code).toBe("RANGE");
    expect(thrown(() => dateRange("0000-01-01", "0000-01-02")).field).toBe("from");
    expect(thrown(() => dateRange("2026-10-01", "2026-02-31")).field).toBe("to");
  });
});
