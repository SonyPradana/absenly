import { describe, expect, test } from "bun:test";
import type { EmployeeProfileRow } from "../src/db.ts";
import { composeDisplayName, toEmployeeViews } from "../src/employees.ts";

function profile(overrides: Partial<EmployeeProfileRow> = {}): EmployeeProfileRow {
  return {
    idNumber: "001",
    deviceName: "Budi",
    displayName: null,
    prefixTitle: "",
    suffixTitle: "",
    active: true,
    updatedAt: null,
    ...overrides,
  };
}

describe("composeDisplayName", () => {
  test("falls back to the device name", () => {
    expect(composeDisplayName(profile())).toBe("Budi");
  });

  test("display name override wins", () => {
    expect(composeDisplayName(profile({ displayName: "Budi Santoso" }))).toBe("Budi Santoso");
  });

  test("prefix and suffix are joined", () => {
    expect(composeDisplayName(profile({ prefixTitle: "H.", suffixTitle: "S.Kom" }))).toBe(
      "H. Budi S.Kom",
    );
  });

  test("a suffix starting with punctuation attaches directly", () => {
    expect(composeDisplayName(profile({ suffixTitle: ", S.Kom" }))).toBe("Budi, S.Kom");
  });

  test("blank strings fall back", () => {
    expect(
      composeDisplayName(profile({ displayName: "  ", prefixTitle: " ", suffixTitle: " " })),
    ).toBe("Budi");
  });
});

describe("toEmployeeViews", () => {
  test("keeps id, composed name, and active flag", () => {
    expect(
      toEmployeeViews([
        profile(),
        profile({ idNumber: "002", deviceName: "Sari", displayName: "Sari W", active: false }),
      ]),
    ).toEqual([
      { idNumber: "001", name: "Budi", active: true },
      { idNumber: "002", name: "Sari W", active: false },
    ]);
  });
});
