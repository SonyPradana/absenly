import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { API_ROUTES, type ApiContext } from "../src/api/handlers.ts";
import { handleApi } from "../src/api/router.ts";
import { Auth } from "../src/auth.ts";
import { openMemoryDb, type Db } from "../src/db.ts";
import { DeviceError, type DeviceGateway } from "../src/device.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
import { syncNow } from "../src/sync.ts";
import { startServer } from "../src/web/server.ts";
import { read } from "xlsx";
import { FakeDevice, type DeviceAttendance, type DeviceUser } from "./support/fake-device.ts";

const NOW = new Date("2026-10-21T08:00:00+07:00");
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

const SYNC_USERS: DeviceUser[] = [
  { uid: 501, idNumber: "9001", name: "Dummy Sync", privilege: 0, card: 0, groupId: "" },
];

const SYNC_ATTENDANCE: DeviceAttendance[] = [
  {
    uid: 1,
    idNumber: "9001",
    name: "Dummy Sync",
    date: "2026-10-20",
    time: "07:15:00",
    punch: 0,
    verify: 15,
  },
];

let db: Db;
let ctx: ApiContext;

beforeEach(() => {
  db = openMemoryDb();
  db.upsertEmployees(
    [
      {
        uid: 1,
        idNumber: "992",
        name: "Dummy Siti",
        privilege: 0,
        card: 0,
        groupId: "1",
      },
      {
        uid: 2,
        idNumber: "00123",
        name: "Dummy Budi",
        privilege: 0,
        card: 0,
        groupId: "1",
      },
    ],
    SYNCED_AT,
  );
  db.upsertAttendance(
    [
      { idNumber: "992", date: "2026-10-20", time: "07:28:34", punch: 0, verify: 15 },
      { idNumber: "992", date: "2026-10-20", time: "16:30:15", punch: 1, verify: 15 },
      { idNumber: "00123", date: "2026-10-21", time: "09:59:59", punch: 0, verify: 15 },
      { idNumber: "00123", date: "2026-10-21", time: "10:00:00", punch: 1, verify: 15 },
    ],
    SYNCED_AT,
  );

  ctx = {
    db,
    auth: new Auth({
      username: "admin",
      password: "secret",
      now: () => NOW.getTime(),
    }),
    getCalendar: () => CALENDAR,
    sync: async () => {
      throw new Error("sync is not configured for this test");
    },
    now: () => NOW,
  };
});

afterEach(() => {
  db.close();
});

async function api(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`http://local${path}`, init);
  const response = await handleApi(request, new URL(request.url), ctx);
  if (response === null) throw new Error("not an API route");
  return response;
}

async function login(): Promise<{ token: string; cookie: string }> {
  const response = await api("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { token: string } };
  return { token: body.data.token, cookie: response.headers.get("set-cookie") ?? "" };
}

function bearer(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function adminGet(path: string): Promise<Response> {
  const { token } = await login();
  return api(path, bearer(token));
}

async function adminRequest(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<Response> {
  const { token } = await login();
  return api(path, {
    ...bearer(token),
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function fakeGateway(device: FakeDevice): DeviceGateway {
  return device as unknown as DeviceGateway;
}

async function listBody(
  response: Response,
): Promise<{ data: Array<Record<string, unknown>>; meta: Record<string, unknown> }> {
  return (await response.json()) as {
    data: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  };
}

describe("api auth", () => {
  test("health is public and reports no sync yet", async () => {
    const response = await api("/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ok: true, last_sync: null },
    });
  });

  test("wrong credentials return a generic 401", async () => {
    const response = await api("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_CREDENTIALS", message: "Username atau password salah." },
    });
  });

  test("login sets a cookie, me works, and logout revokes the token", async () => {
    const { token, cookie } = await login();
    expect(token).not.toBe("");
    expect(cookie).toContain("absen_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const me = await api("/api/v1/auth/me", bearer(token));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      data: { role: "admin", username: "admin" },
    });

    const logout = await api("/api/v1/auth/logout", { ...bearer(token), method: "POST" });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ data: { ok: true } });

    const after = await api("/api/v1/attendance", bearer(token));
    expect(after.status).toBe(401);
  });

  test("cookie auth works for data routes", async () => {
    const { cookie } = await login();
    const response = await api("/api/v1/attendance", { headers: { cookie } });
    expect(response.status).toBe(200);
  });
});

describe("raw attendance", () => {
  test("requires auth", async () => {
    const response = await api("/api/v1/attendance");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
  });

  test("returns date, name, time, status, and verification", async () => {
    const { token } = await login();
    const response = await api("/api/v1/attendance", bearer(token));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };

    expect(body.data).toHaveLength(4);
    expect(body.data[0]).toEqual({
      id: 1,
      date: "2026-10-20",
      name: "Dummy Siti",
      time: "07:28:34",
      status: "IN",
      verify: 15,
      id_number: "992",
      raw_punch: 0,
    });
    expect(body.data[1]).toMatchObject({
      date: "2026-10-20",
      time: "16:30:15",
      status: "OUT",
      verify: 15,
    });
    expect(body.meta).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      total: 4,
      page: 1,
      per_page: 50,
      total_pages: 1,
    });
  });

  test("filters by employee and inclusive date range", async () => {
    const { token } = await login();
    const body = (await (
      await api("/api/v1/attendance?employee_id=00123&from=2026-10-21&to=2026-10-21", bearer(token))
    ).json()) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };

    expect(body.data).toHaveLength(2);
    expect(body.data.map((row) => row.status)).toEqual(["IN", "OUT"]);
    expect(body.meta).toMatchObject({ from: "2026-10-21", to: "2026-10-21", total: 2 });
  });

  test("keeps raw punches for inactive employees", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: null,
      prefixTitle: "",
      suffixTitle: "",
      active: false,
      updatedAt: SYNCED_AT,
    });

    const body = await listBody(await adminGet("/api/v1/attendance"));
    expect(body.meta.total).toBe(4);
  });

  test("paginates and reports the full total", async () => {
    const { token } = await login();
    const body = (await (
      await api("/api/v1/attendance?per_page=1&page=2", bearer(token))
    ).json()) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ date: "2026-10-20", time: "16:30:15" });
    expect(body.meta).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      total: 4,
      page: 2,
      per_page: 1,
      total_pages: 4,
    });
  });

  test("rejects invalid periods and pagination", async () => {
    const { token } = await login();
    const cases = [
      "/api/v1/attendance?month=0000-01",
      "/api/v1/attendance?month=2026-13",
      "/api/v1/attendance?month=2026-10&from=2026-10-01",
      "/api/v1/attendance?from=2026-10-21",
      "/api/v1/attendance?from=0000-01-01&to=2026-10-21",
      "/api/v1/attendance?from=2026-13-01&to=2026-10-21",
      "/api/v1/attendance?from=2026-02-31&to=2026-10-21",
      "/api/v1/attendance?from=2026-10-21&to=2026-10-20",
      "/api/v1/attendance?from=2024-01-01&to=2025-01-01",
      "/api/v1/attendance?page=0",
      "/api/v1/attendance?per_page=201",
      "/api/v1/attendance?employee_id=",
    ];

    for (const path of cases) {
      const response = await api(path, bearer(token));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_QUERY");
    }
  });

  test("wrong methods and unknown routes use the error envelope", async () => {
    const { token } = await login();
    const method = await api("/api/v1/attendance", { ...bearer(token), method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");

    const missing = await api("/api/v1/nope", bearer(token));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });
});

describe("route auth table", () => {
  test("every non-public route rejects an anonymous request", async () => {
    const protectedRoutes = API_ROUTES.filter((route) => route.auth !== "public");
    expect(protectedRoutes.length).toBeGreaterThan(0);

    for (const route of protectedRoutes) {
      const response = await api(route.path, { method: route.method });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }
  });

  test("the route table has no duplicate method/path pairs", () => {
    const keys = API_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("employees", () => {
  test("returns report names ordered by name, with active defaulting to true", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: true,
      updatedAt: SYNCED_AT,
    });

    const response = await adminGet("/api/v1/employees");
    expect(response.status).toBe(200);
    const body = await listBody(response);

    expect(body.data).toEqual([
      {
        id_number: "00123",
        name: "Dummy Budi",
        card: 0,
        group_id: "1",
        privilege: 0,
        active: true,
        device_name: "Dummy Budi",
        display_name: null,
        prefix_title: "",
        suffix_title: "",
      },
      {
        id_number: "992",
        name: "H. Siti Aminah, S.Kom",
        card: 0,
        group_id: "1",
        privilege: 0,
        active: true,
        device_name: "Dummy Siti",
        display_name: "Siti Aminah",
        prefix_title: "H.",
        suffix_title: ", S.Kom",
      },
    ]);
    expect(body.meta).toEqual({ total: 2 });
  });

  test("includes inactive employees with active false", async () => {
    db.saveEmployeeProfile({
      idNumber: "00123",
      displayName: null,
      prefixTitle: "",
      suffixTitle: "",
      active: false,
      updatedAt: SYNCED_AT,
    });

    const body = await listBody(await adminGet("/api/v1/employees"));
    expect(body.data.map((row) => [row.id_number, row.active])).toEqual([
      ["00123", false],
      ["992", true],
    ]);
  });
});

describe("recap", () => {
  test("returns daily rows with schedule minutes and display names", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: "Siti Aminah",
      prefixTitle: "",
      suffixTitle: "",
      active: true,
      updatedAt: SYNCED_AT,
    });

    const body = await listBody(await adminGet("/api/v1/recap"));
    expect(body.data).toEqual([
      {
        date: "2026-10-20",
        id_number: "992",
        name: "Siti Aminah",
        in_time: "07:28:34",
        out_time: "16:30:15",
        late_minutes: 28,
        early_minutes: 0,
        status: "telat",
        punches: 2,
      },
      {
        date: "2026-10-21",
        id_number: "00123",
        name: "Dummy Budi",
        in_time: "09:59:59",
        out_time: "10:00:00",
        late_minutes: 179,
        early_minutes: 360,
        status: "telat",
        punches: 2,
      },
    ]);
    expect(body.meta).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      total: 2,
      page: 1,
      per_page: 50,
      total_pages: 1,
    });
  });

  test("filters presence, punctuality, and employee, then paginates", async () => {
    db.upsertAttendance(
      [{ idNumber: "00123", date: "2026-10-22", time: "06:59:00", punch: 0, verify: 15 }],
      SYNCED_AT,
    );

    const missingOut = await listBody(
      await adminGet("/api/v1/recap?month=2026-10&presence=missing_out"),
    );
    expect(missingOut.data).toHaveLength(1);
    expect(missingOut.data[0]).toMatchObject({
      date: "2026-10-22",
      in_time: "06:59:00",
      out_time: null,
      late_minutes: 0,
      early_minutes: null,
      status: "belum_pulang",
      punches: 1,
    });

    const ontime = await listBody(await adminGet("/api/v1/recap?punctuality=ontime"));
    expect(ontime.data.map((row) => row.date)).toEqual(["2026-10-22"]);

    const completeLate = await listBody(
      await adminGet("/api/v1/recap?presence=complete&punctuality=late"),
    );
    expect(completeLate.meta.total).toBe(2);

    const oneEmployee = await listBody(
      await adminGet("/api/v1/recap?employee_id=00123&month=2026-10"),
    );
    expect(oneEmployee.meta.total).toBe(2);
    expect(oneEmployee.data.map((row) => row.date)).toEqual(["2026-10-21", "2026-10-22"]);

    const page2 = await listBody(await adminGet("/api/v1/recap?per_page=1&page=2"));
    expect(page2.meta).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      total: 3,
      page: 2,
      per_page: 1,
      total_pages: 3,
    });
    expect(page2.data[0]).toMatchObject({ date: "2026-10-21", id_number: "00123" });
  });

  test("hides inactive employees unless employee_id is explicit", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: null,
      prefixTitle: "",
      suffixTitle: "",
      active: false,
      updatedAt: SYNCED_AT,
    });

    const all = await listBody(await adminGet("/api/v1/recap"));
    expect(all.meta.total).toBe(1);
    expect(all.data[0]).toMatchObject({ id_number: "00123" });

    const explicit = await listBody(await adminGet("/api/v1/recap?employee_id=992"));
    expect(explicit.meta.total).toBe(1);
    expect(explicit.data[0]).toMatchObject({ id_number: "992" });
  });

  test("rejects invalid filters", async () => {
    for (const path of [
      "/api/v1/recap?presence=maybe",
      "/api/v1/recap?punctuality=maybe",
      "/api/v1/summary?presence=maybe",
    ]) {
      const response = await adminGet(path);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: { field?: string } };
      };
      expect(body.error.code).toBe("INVALID_QUERY");
      expect(body.error.details?.field).toBeDefined();
    }
  });
});

describe("summary", () => {
  test("summarizes the entire filtered set", async () => {
    const response = await adminGet("/api/v1/summary");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        rows: 2,
        present: 2,
        late: 2,
        early: 1,
        incomplete: 0,
        late_minutes: 207,
        early_minutes: 360,
      },
    });
  });

  test("counts every filtered row and ignores pagination", async () => {
    db.upsertAttendance(
      [{ idNumber: "00123", date: "2026-10-22", time: "06:59:00", punch: 0, verify: 15 }],
      SYNCED_AT,
    );

    const all = (await (await adminGet("/api/v1/summary?per_page=1")).json()) as {
      data: Record<string, number>;
    };
    expect(all.data).toEqual({
      rows: 3,
      present: 3,
      late: 2,
      early: 1,
      incomplete: 1,
      late_minutes: 207,
      early_minutes: 360,
    });

    const missingOut = (await (await adminGet("/api/v1/summary?presence=missing_out")).json()) as {
      data: Record<string, number>;
    };
    expect(missingOut.data).toEqual({
      rows: 1,
      present: 1,
      late: 0,
      early: 0,
      incomplete: 1,
      late_minutes: 0,
      early_minutes: 0,
    });
  });

  test("hides inactive employees unless employee_id is explicit", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: null,
      prefixTitle: "",
      suffixTitle: "",
      active: false,
      updatedAt: SYNCED_AT,
    });

    const all = (await (await adminGet("/api/v1/summary")).json()) as {
      data: Record<string, number>;
    };
    expect(all.data).toMatchObject({ rows: 1, late: 1, late_minutes: 179 });

    const explicit = (await (await adminGet("/api/v1/summary?employee_id=992")).json()) as {
      data: Record<string, number>;
    };
    expect(explicit.data).toMatchObject({ rows: 1, late: 1, late_minutes: 28 });
  });
});

describe("work exceptions", () => {
  const valid = {
    id_number: "992",
    kind: "night_shift",
    start_date: "2026-10-20",
    start_time: "21:00:00",
    end_date: "2026-10-21",
    end_time: "07:00:00",
    note: "Piket",
  };

  test("creates, lists with report names, filters, and deletes a ledger row", async () => {
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: true,
      updatedAt: SYNCED_AT,
    });

    const empty = await listBody(await adminGet("/api/v1/work-exceptions"));
    expect(empty.data).toEqual([]);
    expect(empty.meta).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      total: 0,
      page: 1,
      per_page: 50,
      total_pages: 0,
    });

    const created = await adminRequest("/api/v1/work-exceptions", "POST", valid);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: {
        id: 1,
        id_number: "992",
        name: "H. Siti Aminah, S.Kom",
        kind: "night_shift",
        start_date: "2026-10-20",
        start_time: "21:00:00",
        end_date: "2026-10-21",
        end_time: "07:00:00",
        note: "Piket",
        created_at: "2026-10-21T08:00:00+07:00",
      },
    });

    const listed = await listBody(
      await adminGet("/api/v1/work-exceptions?month=2026-10&kind=night_shift"),
    );
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      id_number: "992",
      name: "H. Siti Aminah, S.Kom",
      start_date: "2026-10-20",
    });
    expect(listed.meta).toMatchObject({ total: 1, total_pages: 1 });

    const deleted = await adminRequest("/api/v1/work-exceptions/1", "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ data: { ok: true } });

    const missing = await adminRequest("/api/v1/work-exceptions/1", "DELETE");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });

  test("rejects invalid fields, durations, and employees with INVALID_BODY", async () => {
    const cases = [
      { ...valid, kind: "sick_leave" },
      { ...valid, id_number: "NOPE" },
      { ...valid, end_time: "20:00:00", end_date: "2026-10-20" },
      { ...valid, start_time: "24:00:00" },
      {
        ...valid,
        start_date: "2026-10-20",
        start_time: "00:00:00",
        end_date: "2026-10-22",
        end_time: "01:00:00",
      },
    ];

    for (const body of cases) {
      const response = await adminRequest("/api/v1/work-exceptions", "POST", body);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; details?: unknown } };
      expect(payload.error.code).toBe("INVALID_BODY");
      expect(payload.error.details).toBeDefined();
    }
  });

  test("rejects overlaps and allows adjacent half-open ranges", async () => {
    expect((await adminRequest("/api/v1/work-exceptions", "POST", valid)).status).toBe(201);

    const overlap = await adminRequest("/api/v1/work-exceptions", "POST", {
      ...valid,
      start_date: "2026-10-21",
      start_time: "06:00:00",
      end_date: "2026-10-21",
      end_time: "08:00:00",
    });
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toEqual({
      error: {
        code: "WORK_EXCEPTION_OVERLAP",
        message: "overlap dengan 992 2026-10-20 21:00:00 - 2026-10-21 07:00:00",
      },
    });

    const adjacent = await adminRequest("/api/v1/work-exceptions", "POST", {
      ...valid,
      start_date: "2026-10-21",
      start_time: "07:00:00",
      end_date: "2026-10-21",
      end_time: "08:00:00",
    });
    expect(adjacent.status).toBe(201);
  });

  test("filters and paginates with stable ordering", async () => {
    for (const [kind, date, time, endTime] of [
      ["overtime", "2026-10-20", "16:00:00", "18:00:00"],
      ["other", "2026-10-21", "09:00:00", "10:00:00"],
    ] as const) {
      const response = await adminRequest("/api/v1/work-exceptions", "POST", {
        ...valid,
        kind,
        start_date: date,
        start_time: time,
        end_date: date,
        end_time: endTime,
      });
      expect(response.status).toBe(201);
    }

    const first = await listBody(
      await adminGet("/api/v1/work-exceptions?month=2026-10&per_page=1"),
    );
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({ start_date: "2026-10-21", kind: "other" });
    expect(first.meta).toMatchObject({ total: 2, page: 1, per_page: 1, total_pages: 2 });

    const second = await listBody(
      await adminGet("/api/v1/work-exceptions?month=2026-10&per_page=1&page=2"),
    );
    expect(second.data[0]).toMatchObject({ start_date: "2026-10-20", kind: "overtime" });

    const filtered = await listBody(await adminGet("/api/v1/work-exceptions?kind=overtime"));
    expect(filtered.meta.total).toBe(1);

    const invalid = await adminGet("/api/v1/work-exceptions?kind=sick_leave");
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_QUERY",
    );
  });

  test("DELETE rejects malformed ids as 404", async () => {
    for (const id of ["0", "abc", "1.5"]) {
      const response = await adminRequest(`/api/v1/work-exceptions/${id}`, "DELETE");
      expect(response.status).toBe(404);
    }
  });
});

describe("sync endpoints", () => {
  test("status is null before the first sync", async () => {
    const response = await adminGet("/api/v1/sync/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { last_sync: null } });
  });

  test("POST /sync runs the service and status reports the full log", async () => {
    const fake = new FakeDevice({ users: SYNC_USERS, attendance: SYNC_ATTENDANCE });
    ctx = { ...ctx, sync: () => syncNow({ device: fakeGateway(fake), db }) };

    const response = await adminRequest("/api/v1/sync", "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        ok: boolean;
        users: number;
        records: number;
        first_date: string | null;
        last_date: string | null;
        duration_ms: number;
        synced_at: string;
      };
    };
    expect(body.data).toMatchObject({
      ok: true,
      users: 1,
      records: 1,
      first_date: "2026-10-20",
      last_date: "2026-10-20",
    });
    expect(body.data.duration_ms).toBeGreaterThanOrEqual(0);
    expect(body.data.synced_at).toContain("+07:00");
    expect(body.data).not.toHaveProperty("attempts");
    expect(db.countEmployees()).toBe(3);
    expect(db.countAttendance()).toBe(5);
    expect(fake.calls).toEqual(["connect", "readSnapshot", "disconnect"]);

    const status = (await (await adminGet("/api/v1/sync/status")).json()) as {
      data: { last_sync: Record<string, unknown> };
    };
    expect(status.data.last_sync).toMatchObject({
      users: 1,
      records: 1,
      first_date: "2026-10-20",
      last_date: "2026-10-20",
      ok: true,
      error: null,
    });
    expect(status.data.last_sync).toHaveProperty("started_at");
    expect(status.data.last_sync).toHaveProperty("duration_ms");
  });

  test("a held sync lock returns 409 SYNC_IN_PROGRESS", async () => {
    expect(db.tryAcquireSyncLock("other-process", Date.now(), 60_000)).toBe(true);
    const fake = new FakeDevice({ users: SYNC_USERS, attendance: SYNC_ATTENDANCE });
    ctx = { ...ctx, sync: () => syncNow({ device: fakeGateway(fake), db }) };

    const response = await adminRequest("/api/v1/sync", "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "SYNC_IN_PROGRESS", message: "another sync is already running" },
    });
    expect(fake.calls).toEqual([]);
    expect(db.lastSync()).toBeNull();

    db.releaseSyncLock("other-process");
  });

  test("device failures return 502 with the device code", async () => {
    const fake = new FakeDevice({
      users: [],
      attendance: [],
      failConnect: new DeviceError("ZK_NETWORK", "offline"),
    });
    ctx = { ...ctx, sync: () => syncNow({ device: fakeGateway(fake), db }) };

    const response = await adminRequest("/api/v1/sync", "POST");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "DEVICE_UNAVAILABLE",
        message: "Device unavailable",
        details: { device_code: "ZK_NETWORK" },
      },
    });
    expect(db.lastSync()).toMatchObject({ ok: false, error: "ZK_NETWORK: offline" });
  });
});

describe("sync schedule endpoints", () => {
  test("creates, lists, toggles, and deletes schedules", async () => {
    expect(await (await adminGet("/api/v1/sync-schedules")).json()).toEqual({
      data: [],
      meta: { next_at: null },
    });

    const created = await adminRequest("/api/v1/sync-schedules", "POST", {
      days: "monday,saturday",
      start_time: "07:00",
      end_time: "09:00",
      every_minutes: 15,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: 1,
      days: "MONDAY,SATURDAY",
      start_time: "07:00",
      end_time: "09:00",
      every_minutes: 15,
      enabled: true,
    });

    const listed = (await (await adminGet("/api/v1/sync-schedules")).json()) as {
      data: Array<Record<string, unknown>>;
      meta: { next_at: string | null };
    };
    expect(listed.data).toHaveLength(1);
    // 2026-10-22 is a Thursday, so the next Monday window is in the future.
    expect(typeof listed.meta.next_at).toBe("string");

    const toggled = await adminRequest("/api/v1/sync-schedules/1", "POST", { enabled: false });
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);

    const deleted = await adminRequest("/api/v1/sync-schedules/1", "DELETE");
    expect(deleted.status).toBe(200);
    expect(db.listSyncSchedules()).toEqual([]);

    expect((await adminRequest("/api/v1/sync-schedules/1", "DELETE")).status).toBe(404);
    expect((await adminRequest("/api/v1/sync-schedules/1", "POST", { enabled: true })).status).toBe(
      404,
    );
  });

  test("validates the body and rejects bad windows", async () => {
    const cases: Array<Record<string, unknown>> = [
      { start_time: "07:00", end_time: "09:00", every_minutes: 0 },
      { start_time: "7:00", end_time: "09:00", every_minutes: 5 },
      { start_time: "22:00", end_time: "02:00", every_minutes: 5 },
      { days: "SENIN", start_time: "07:00", end_time: "09:00", every_minutes: 5 },
      { start_time: "07:00", end_time: "07:04", every_minutes: 5 },
    ];
    for (const body of cases) {
      const response = await adminRequest("/api/v1/sync-schedules", "POST", body);
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error: { code: string } };
      expect(error.error.code).toBe("INVALID");
    }
    expect(db.listSyncSchedules()).toEqual([]);
  });

  test("needs an admin token", async () => {
    expect((await api("/api/v1/sync-schedules")).status).toBe(401);
    expect((await api("/api/v1/sync-schedules", { method: "POST" })).status).toBe(401);
  });

  test("a viewer cannot write schedules", async () => {
    ctx = { ...ctx, readOnly: true };
    const response = await adminRequest("/api/v1/sync-schedules", "POST", {
      start_time: "07:00",
      end_time: "09:00",
      every_minutes: 5,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );
  });
});

describe("export", () => {
  test("returns a workbook with the recap sheets and filename", async () => {
    const response = await adminGet("/api/v1/export.xlsx?month=2026-10");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="absen-recap-2026-10-01_2026-10-31.xlsx"',
    );

    const book = read(await response.arrayBuffer(), { type: "array" });
    expect(book.SheetNames).toEqual(["Masuk", "Pulang"]);
  });

  test("supports mode lists and selects one employee", async () => {
    const response = await adminGet(
      "/api/v1/export.xlsx?month=2026-10&mode=raw,user&employee_id=992",
    );
    expect(response.status).toBe(200);
    const book = read(await response.arrayBuffer(), { type: "array" });
    expect(book.SheetNames).toEqual(["Raw", "992 - Dummy Siti"]);

    const raw = book.Sheets.Raw!;
    expect(raw.A2?.v).toBe(1);
    expect(raw.B2?.v).toBe("992");
    expect(raw.B3?.v).toBe("992");
    expect(raw.B4?.v).toBe("00123");
    expect(raw.B5?.v).toBe("00123");
    expect(raw.A6).toBeUndefined();

    const recap = await adminGet("/api/v1/export.xlsx?month=2026-10&mode=recap&employee_id=992");
    const recapBook = read(await recap.arrayBuffer(), { type: "array" });
    expect(recapBook.Sheets.Masuk?.A3?.v).toBe("Dummy Siti");
    expect(recapBook.Sheets.Masuk?.A4).toBeUndefined();
  });

  test("returns 404 NO_DATA and rejects daily-only filters or bad modes", async () => {
    const empty = await adminGet("/api/v1/export.xlsx?from=2025-01-01&to=2025-01-02");
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({
      error: { code: "NO_DATA", message: "tidak ada baris untuk diekspor (NO_DATA)" },
    });

    for (const idNumber of ["00123", "992"]) {
      db.saveEmployeeProfile({
        idNumber,
        displayName: null,
        prefixTitle: "",
        suffixTitle: "",
        active: false,
        updatedAt: SYNCED_AT,
      });
    }
    const noActive = await adminGet("/api/v1/export.xlsx?month=2026-10&mode=user");
    expect(noActive.status).toBe(404);
    expect(await noActive.json()).toEqual({
      error: {
        code: "NO_DATA",
        message: "tidak ada karyawan aktif untuk diekspor (NO_DATA)",
      },
    });

    for (const path of [
      "/api/v1/export.xlsx?month=2026-10&presence=complete",
      "/api/v1/export.xlsx?month=2026-10&punctuality=late",
      "/api/v1/export.xlsx?month=2026-10&mode=pdf",
    ]) {
      const response = await adminGet(path);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "INVALID_QUERY",
      );
    }
  });
});

describe("hooks api", () => {
  function seedEvent(event: string, data: Record<string, unknown>): number {
    return db.insertEvent({ event, at: SYNCED_AT, payload: JSON.stringify(data) });
  }

  test("lists events after a cursor with the next cursor in meta", async () => {
    const first = seedEvent("sync.done", { records: 5 });
    const second = seedEvent("attendance.changed", { inserted: 2 });

    const all = await listBody(await adminGet("/api/v1/events"));
    expect(all.data.map((row) => row.id)).toEqual([first, second]);
    expect(all.meta.next_since).toBe(second);

    const after = await listBody(await adminGet(`/api/v1/events?since=${first}`));
    expect(after.data.map((row) => row.id)).toEqual([second]);
    expect(after.data[0]).toMatchObject({
      event: "attendance.changed",
      data: { inserted: 2 },
      delivered_at: null,
      attempts: 0,
    });

    const empty = await listBody(await adminGet(`/api/v1/events?since=${second}`));
    expect(empty.data).toEqual([]);
    expect(empty.meta.next_since).toBe(second);
  });

  test("rejects a bad cursor or limit", async () => {
    for (const path of [
      "/api/v1/events?since=-1",
      "/api/v1/events?limit=0",
      "/api/v1/events?limit=9001",
    ]) {
      const response = await adminGet(path);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "INVALID_QUERY",
      );
    }
  });

  test("creates a webhook, returns the secret once, then never again", async () => {
    const created = await adminRequest("/api/v1/webhooks", "POST", {
      url: "https://bot.example.com/rekap",
      events: ["sync.done"],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: { id: number; url: string; events: string[]; secret: string; enabled: boolean };
    };
    expect(body.data.events).toEqual(["sync.done"]);
    expect(body.data.enabled).toBe(true);
    expect(body.data.secret).toMatch(/^[0-9a-f]{48}$/);

    const listed = await listBody(await adminGet("/api/v1/webhooks"));
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).not.toHaveProperty("secret");
  });

  test("rejects a loopback url and an unknown event", async () => {
    const loopback = await adminRequest("/api/v1/webhooks", "POST", {
      url: "http://127.0.0.1:9999/hook",
    });
    expect(loopback.status).toBe(400);
    expect(((await loopback.json()) as { error: { code: string } }).error.code).toBe("BLOCKED_URL");

    const badEvent = await adminRequest("/api/v1/webhooks", "POST", {
      url: "https://bot.example.com/rekap",
      events: ["nope"],
    });
    expect(badEvent.status).toBe(400);
    expect(((await badEvent.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_EVENTS",
    );
  });

  test("updates enabled, deletes, and 404s a missing id", async () => {
    const id = db.insertWebhook({
      url: "https://bot.example.com/rekap",
      secret: "s",
      events: "sync.done",
      enabled: true,
      createdAt: SYNCED_AT,
    });

    const off = await adminRequest(`/api/v1/webhooks/${id}`, "POST", { enabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);

    expect((await adminRequest(`/api/v1/webhooks/9999`, "POST", { enabled: true })).status).toBe(
      404,
    );
    expect((await adminRequest(`/api/v1/webhooks/${id}`, "DELETE")).status).toBe(200);
    expect((await adminRequest(`/api/v1/webhooks/${id}`, "DELETE")).status).toBe(404);
  });

  test("hooks are admin-only", async () => {
    for (const path of ["/api/v1/events", "/api/v1/webhooks"]) {
      const response = await api(path);
      expect(response.status).toBe(401);
    }
  });

  test("a viewer gets READ_ONLY_VIEWER on hooks", async () => {
    const previous = ctx.readOnly;
    ctx.readOnly = true;
    try {
      for (const path of ["/api/v1/events", "/api/v1/webhooks"]) {
        const response = await adminGet(path);
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "READ_ONLY_VIEWER",
        );
      }
    } finally {
      ctx.readOnly = previous;
    }
  });
});

describe("http server", () => {
  test("starts on a random local port and serves the raw API", async () => {
    const running = startServer({
      db,
      storage: { dbPath: ":memory:", mode: "test" },
      device: { host: "192.0.2.1", port: 4370, timeoutMs: 1000 },
      schedule: new ScheduleStore({ calendar: CALENDAR, source: "env", filePath: null }),
      sync: async () => {
        throw new Error("sync is not configured for this test");
      },
      probe: async () => ({ users: 0, records: 0, usersCap: 0, recordsCap: 0 }),
      web: { username: "admin", password: "secret", port: 0, hostname: "127.0.0.1" },
      now: () => NOW,
    });

    try {
      const loginResponse = await fetch(`http://127.0.0.1:${running.port}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      expect(loginResponse.status).toBe(200);
      const loginBody = (await loginResponse.json()) as { data: { token: string } };

      const response = await fetch(`http://127.0.0.1:${running.port}/api/v1/attendance`, {
        headers: { authorization: `Bearer ${loginBody.data.token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(4);
    } finally {
      running.stop();
    }
  });
});

describe("export multi-user", () => {
  test("accepts employee_ids for recap/user modes", async () => {
    const response = await adminGet(
      "/api/v1/export.xlsx?month=2026-10&mode=user&employee_ids=992,00123",
    );
    expect(response.status).toBe(200);
    const book = read(await response.arrayBuffer(), { type: "array" });
    expect(book.SheetNames).toContain("992 - Dummy Siti");
    expect(book.SheetNames).toContain("00123 - Dummy Budi");
  });

  test("rejects employee_id + employee_ids and empty lists", async () => {
    const both = await adminGet(
      "/api/v1/export.xlsx?month=2026-10&employee_id=992&employee_ids=00123",
    );
    expect(both.status).toBe(400);
    expect(((await both.json()) as { error: { code: string } }).error.code).toBe("INVALID_QUERY");

    const empty = await adminGet("/api/v1/export.xlsx?month=2026-10&employee_ids=");
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe("INVALID_QUERY");
  });
});
