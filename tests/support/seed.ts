// Test-only DB seeding. Uses a throwaway file so the CLI can open it too.

import { openDb } from "../../src/db.ts";

export interface SeedEmployee {
  idNumber: string;
  name: string;
}

export interface SeedPunch {
  idNumber: string;
  date: string;
  time: string;
  punch?: 0 | 1;
  verify?: number;
}

const SYNCED_AT = "2026-10-21T14:43:22+07:00";

export function seedDb(path: string, employees: SeedEmployee[], punches: SeedPunch[]): void {
  const db = openDb(path, "test");
  try {
    db.upsertEmployees(
      employees.map((employee, index) => ({
        uid: index + 1,
        idNumber: employee.idNumber,
        name: employee.name,
        privilege: 0,
        card: 0,
        groupId: "1",
      })),
      SYNCED_AT,
    );
    db.upsertAttendance(
      punches.map((punch) => ({
        idNumber: punch.idNumber,
        date: punch.date,
        time: punch.time,
        punch: punch.punch ?? 0,
        verify: punch.verify ?? 15,
      })),
      SYNCED_AT,
    );
  } finally {
    db.close();
  }
}
