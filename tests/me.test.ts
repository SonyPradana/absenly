import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { API_ROUTES, type ApiContext } from "../src/api/handlers.ts";
import { handleApi } from "../src/api/router.ts";
import { Auth } from "../src/auth.ts";
import { openMemoryDb, type Db } from "../src/db.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import { stamp } from "../src/time.ts";

const NOW = new Date("2026-10-21T10:00:00+07:00");
const SYNCED_AT = "2026-10-21T07:00:00+07:00";
const WORKDAY = { in: "07:00", out: "16:00" };

const CALENDAR: ScheduleCalendar = {
  version: 1,
  base: {
    MONDAY: WORKDAY,
    TUESDAY: WORKDAY,
    WEDNESDAY: WORKDAY,
    THURSDAY: WORKDAY,
    FRIDAY: WORKDAY,
    SATURDAY: WORKDAY,
    SUNDAY: null,
  },
  overrides: [],
};

const EMPLOYEE_HASH = await Bun.password.hash("karyawan-1");
const OTHER_HASH = await Bun.password.hash("karyawan-2");

let db: Db;
let ctx: ApiContext;

beforeEach(() => {
  db = openMemoryDb();
  db.upsertEmployees(
    [
      { uid: 1, idNumber: "992", name: "Dummy Siti", privilege: 0, card: 0, groupId: "" },
      { uid: 2, idNumber: "993", name: "Dummy Budi", privilege: 0, card: 0, groupId: "" },
    ],
    SYNCED_AT,
  );
  db.upsertAttendance(
    [
      { idNumber: "992", date: "2026-10-20", time: "07:28:34", punch: 0, verify: 15 },
      { idNumber: "992", date: "2026-10-20", time: "16:30:15", punch: 1, verify: 15 },
      { idNumber: "993", date: "2026-10-20", time: "08:00:00", punch: 0, verify: 15 },
      { idNumber: "993", date: "2026-10-20", time: "17:00:00", punch: 1, verify: 15 },
    ],
    SYNCED_AT,
  );
  db.insertWorkException(
    {
      idNumber: "992",
      kind: "night_shift",
      startDate: "2026-10-20",
      startTime: "21:00",
      endDate: "2026-10-21",
      endTime: "07:00",
      note: "piket",
    },
    stamp(NOW),
  );
  db.insertWorkException(
    {
      idNumber: "993",
      kind: "overtime",
      startDate: "2026-10-20",
      startTime: "17:00",
      endDate: "2026-10-20",
      endTime: "20:00",
      note: null,
    },
    stamp(NOW),
  );

  ctx = {
    db,
    auth: new Auth({
      username: "admin",
      password: "secret",
      now: () => NOW.getTime(),
      findUser: async (username) => {
        if (username === "siti") {
          return {
            username: "siti",
            passwordHash: EMPLOYEE_HASH,
            role: "employee" as const,
            employeeIdNumber: "992",
          };
        }
        if (username === "budi") {
          return {
            username: "budi",
            passwordHash: OTHER_HASH,
            role: "employee" as const,
            employeeIdNumber: "993",
          };
        }
        return null;
      },
    }),
    getCalendar: () => CALENDAR,
    sync: async () => {
      throw new Error("sync is not configured");
    },
    now: () => NOW,
  };
});

afterEach(() => {
  db.close();
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`http://local${path}`, init);
  const response = await handleApi(request, new URL(request.url), ctx);
  if (response === null) throw new Error("not an API route");
  return response;
}

async function token(username: string, password: string): Promise<string> {
  const response = await call("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  const body = (await response.json()) as { data: { token: string } };
  return body.data.token;
}

function bearer(value: string): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${value}` } };
}

describe("me endpoints", () => {
  test("login reports the employee role and id", async () => {
    const response = await call("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "siti", password: "karyawan-1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { user: { role: string; username: string; employee_id_number?: string } };
    };
    expect(body.data.user).toEqual({
      role: "employee",
      username: "siti",
      employee_id_number: "992",
    });
  });

  test("GET /api/v1/me returns only the caller's profile", async () => {
    const response = await call("/api/v1/me", bearer(await token("siti", "karyawan-1")));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      role: "employee",
      username: "siti",
      id_number: "992",
      name: "Dummy Siti",
      active: true,
    });
  });

  test("recap, attendance, and summary are scoped to the session", async () => {
    const siti = await token("siti", "karyawan-1");

    const recap = await call("/api/v1/me/recap?month=2026-10", bearer(siti));
    expect(recap.status).toBe(200);
    const recapBody = (await recap.json()) as { data: Array<{ id_number: string }> };
    expect(recapBody.data.length).toBeGreaterThan(0);
    expect(new Set(recapBody.data.map((row) => row.id_number))).toEqual(new Set(["992"]));

    const attendance = await call("/api/v1/me/attendance?month=2026-10", bearer(siti));
    expect(attendance.status).toBe(200);
    const attendanceBody = (await attendance.json()) as { data: Array<{ id_number: string }> };
    expect(attendanceBody.data).toHaveLength(2);
    expect(new Set(attendanceBody.data.map((row) => row.id_number))).toEqual(new Set(["992"]));

    const summary = await call("/api/v1/me/summary?month=2026-10", bearer(siti));
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as { data: { present: number } };
    expect(summaryBody.data.present).toBe(1);
  });

  test("work-exceptions are scoped and carry the employee's name", async () => {
    const response = await call(
      "/api/v1/me/work-exceptions?month=2026-10",
      bearer(await token("siti", "karyawan-1")),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id_number: string; name: string; kind: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id_number: "992",
      name: "Dummy Siti",
      kind: "night_shift",
    });
  });

  test("employee_id in a /me query is rejected", async () => {
    const siti = await token("siti", "karyawan-1");
    for (const path of [
      "/api/v1/me/recap?month=2026-10&employee_id=993",
      "/api/v1/me/summary?month=2026-10&employee_ids=993",
      "/api/v1/me/attendance?month=2026-10&employee_id=993",
      "/api/v1/me/work-exceptions?month=2026-10&employee_id=993",
    ]) {
      const response = await call(path, bearer(siti));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_QUERY");
    }
  });

  test("an admin session is forbidden on /me", async () => {
    const admin = await token("admin", "secret");
    for (const path of [
      "/api/v1/me",
      "/api/v1/me/recap",
      "/api/v1/me/attendance",
      "/api/v1/me/summary",
      "/api/v1/me/work-exceptions",
    ]) {
      const response = await call(path, bearer(admin));
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
    }
  });

  test("admin routes stay admin-only for employee sessions", async () => {
    const siti = await token("siti", "karyawan-1");
    for (const path of [
      "/api/v1/attendance",
      "/api/v1/employees",
      "/api/v1/recap",
      "/api/v1/summary",
      "/api/v1/work-exceptions",
      "/api/v1/sync/status",
      "/api/v1/export.xlsx",
    ]) {
      const response = await call(path, bearer(siti));
      expect(response.status).toBe(403);
    }
    const sync = await call("/api/v1/sync", { ...bearer(siti), method: "POST" });
    expect(sync.status).toBe(403);
  });

  test("an unauthenticated /me request is 401", async () => {
    const response = await call("/api/v1/me");
    expect(response.status).toBe(401);
  });

  test("/me routes are registered exactly once each", () => {
    const paths = API_ROUTES.map((route) => `${route.method} ${route.path}`);
    const me = paths.filter((path) => path.endsWith("/me") || path.includes("/me/"));
    expect(me).toEqual([
      "GET /api/v1/auth/me",
      "GET /api/v1/me",
      "GET /api/v1/me/attendance",
      "GET /api/v1/me/recap",
      "GET /api/v1/me/summary",
      "GET /api/v1/me/work-exceptions",
    ]);
  });
});
