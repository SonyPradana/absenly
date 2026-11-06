import { describe, expect, test } from "bun:test";
import { loadWorkExceptions } from "./support/fixtures.ts";
import { buildDaily } from "./support/recap-reference.ts";
import {
  addWorkException,
  overlaps,
  validateWorkException,
  WorkExceptionError,
  type WorkExceptionInput,
  type WorkExceptionRow,
} from "./support/work-exceptions.ts";

const fixture = loadWorkExceptions();
const employeeIds = new Set(fixture.employees);

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkExceptionError) return error.code;
    throw error;
  }
  throw new Error("expected WorkExceptionError");
}

function asInput(value: Record<string, unknown>): WorkExceptionInput {
  return value as unknown as WorkExceptionInput;
}

describe("work_exceptions ledger", () => {
  test("valid rows are accepted, including a cross-day piket", () => {
    let rows: WorkExceptionRow[] = [];
    for (const input of fixture.valid) {
      rows = addWorkException(rows, input, employeeIds);
    }
    expect(rows.length).toBe(fixture.valid.length);
    expect(rows.map((row) => row.kind)).toEqual([
      "night_shift",
      "overtime",
      "holiday_work",
      "other",
    ]);
    const piket = rows[0]!;
    expect(piket.id).toBe(1);
    expect(piket.start_date).toBe("2026-10-05");
    expect(piket.end_date).toBe("2026-10-06");
    expect(piket.note).toBe("Piket");
  });

  test("half-open overlap: adjacent endpoints are allowed", () => {
    const first = fixture.boundary_non_overlap[0]!;
    const second = fixture.boundary_non_overlap[1]!;
    expect(overlaps(first, second)).toBe(false);

    let rows: WorkExceptionInput[] = [...fixture.valid];
    rows = addWorkException(rows, first, employeeIds);
    rows = addWorkException(rows, second, employeeIds);
    expect(rows.length).toBe(fixture.valid.length + 2);

    const duplicateStart = { ...first };
    expect(() => validateWorkException(duplicateStart, rows, employeeIds)).toThrow(
      WorkExceptionError,
    );
  });

  test("invalid rows are rejected with stable codes", () => {
    for (const invalid of fixture.invalid) {
      const code = errorCode(() =>
        validateWorkException(asInput(invalid.input), fixture.valid, employeeIds),
      );
      expect(code).toBe(invalid.code);
    }
  });

  test("work_exceptions do not change the normal daily recap", () => {
    const daily = buildDaily(
      fixture.recap_unaffected.attendance.map((a) => ({
        idNumber: a.idNumber,
        name: a.name,
        date: a.date,
        time: a.time,
        punch: a.punch,
        verify: a.verify,
        uid: a.uid,
      })),
      fixture.recap_unaffected.schedule,
    );
    expect(daily).toEqual(fixture.recap_unaffected.expected_daily);

    const piketStart = daily.find((row) => row.id_number === "00123" && row.date === "2026-10-06");
    expect(piketStart?.in_time).toBeNull();
    expect(piketStart?.out_time).toBe("21:00:00");
    expect(piketStart?.status).toBe("tanpa_masuk");

    const piketEnd = daily.find((row) => row.id_number === "00123" && row.date === "2026-10-07");
    expect(piketEnd?.in_time).toBe("06:30:00");
    expect(piketEnd?.out_time).toBeNull();
    expect(piketEnd?.status).toBe("belum_pulang");

    const normal = daily.find((row) => row.id_number === "A-100" && row.date === "2026-10-06");
    expect(normal?.in_time).toBe("07:00:00");
    expect(normal?.out_time).toBe("16:30:00");
    expect(normal?.early_minutes).toBe(0);
    expect(normal?.status).toBe("lengkap");
  });
});
