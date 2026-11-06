import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDb, type Db } from "../src/db.ts";
import { startRelayServer } from "../src/relay/server.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import { SqliteReadStore } from "../src/store.ts";

const TOKEN = "test-relay-token";
const SYNCED_AT = "2026-10-22T09:01:00+07:00";

const CALENDAR: ScheduleCalendar = {
  version: 1,
  base: {
    MONDAY: { in: "08:00", out: "16:00" },
    TUESDAY: { in: "08:00", out: "16:00" },
    WEDNESDAY: { in: "08:00", out: "16:00" },
    THURSDAY: { in: "08:00", out: "16:00" },
    FRIDAY: { in: "08:00", out: "16:00" },
    SATURDAY: { in: "08:00", out: "12:00" },
    SUNDAY: null,
  },
  overrides: [],
};

interface RunningRelay {
  base: string;
  db: Db;
  stop: () => void;
}

const cleanups: RunningRelay[] = [];

function start(): RunningRelay {
  const db = openMemoryDb();
  db.upsertEmployees(
    [
      { uid: 1, idNumber: "992", name: "Dummy Siti", privilege: 0, card: 0, groupId: "1" },
      { uid: 2, idNumber: "993", name: "Dummy Budi", privilege: 0, card: 0, groupId: "1" },
    ],
    SYNCED_AT,
  );
  db.upsertAttendance(
    [
      { idNumber: "992", date: "2026-10-20", time: "07:28:34", punch: 0, verify: 15 },
      { idNumber: "992", date: "2026-10-20", time: "16:05:00", punch: 1, verify: 15 },
      { idNumber: "993", date: "2026-10-21", time: "07:58:00", punch: 0, verify: 1 },
    ],
    SYNCED_AT,
  );
  db.recordSync({
    startedAt: "2026-10-22T09:00:00+07:00",
    finishedAt: SYNCED_AT,
    durationMs: 60_000,
    users: 2,
    records: 3,
    firstDate: "2026-10-20",
    lastDate: "2026-10-21",
    ok: true,
  });

  const running = startRelayServer({
    relay: { host: "127.0.0.1", port: 0, token: TOKEN },
    store: new SqliteReadStore(db),
    getCalendar: () => CALENDAR,
    version: "9.9.9",
  });

  const item: RunningRelay = {
    base: `http://127.0.0.1:${running.port}`,
    db,
    stop: () => {
      running.stop();
      db.close();
    },
  };
  cleanups.push(item);
  return item;
}

afterEach(() => {
  for (const item of cleanups.splice(0)) item.stop();
});

function auth(server: RunningRelay, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return fetch(`${server.base}${path}`, { ...init, headers });
}

describe("relay auth and read-only boundary", () => {
  test("rejects missing or wrong tokens without leaking the token", async () => {
    const server = start();

    const missing = await fetch(`${server.base}/relay/v1/meta`);
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { error: { code: string; message: string } };
    expect(missingBody.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(missingBody)).not.toContain(TOKEN);

    const wrong = await fetch(`${server.base}/relay/v1/meta`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);

    const basic = await fetch(`${server.base}/relay/v1/meta`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(basic.status).toBe(401);

    const lower = await fetch(`${server.base}/relay/v1/meta`, {
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(lower.status).toBe(200);
  });

  test("allows GET only and never proxies admin routes", async () => {
    const server = start();

    const post = await auth(server, "/relay/v1/meta", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe(
      "METHOD_NOT_ALLOWED",
    );

    const admin = await auth(server, "/api/v1/health");
    expect(admin.status).toBe(404);

    const sync = await auth(server, "/relay/v1/sync");
    expect(sync.status).toBe(404);
  });
});

describe("collector relay data", () => {
  test("serves meta, employees, schedule, and raw attendance", async () => {
    const server = start();

    const meta = await auth(server, "/relay/v1/meta");
    expect(meta.status).toBe(200);
    expect(meta.headers.get("cache-control")).toBe("no-store");
    const metaBody = (await meta.json()) as {
      data: {
        app_version: string;
        schema_version: number;
        last_sync: {
          at: string;
          ok: boolean;
          users: number;
          records: number;
          duration_ms: number;
          first_date: string | null;
          last_date: string | null;
          error: string | null;
        };
        counts: { employees: number; attendance: number };
      };
    };
    expect(metaBody.data).toEqual({
      app_version: "9.9.9",
      schema_version: 8,
      last_sync: {
        at: SYNCED_AT,
        ok: true,
        users: 2,
        records: 3,
        duration_ms: 60000,
        first_date: "2026-10-20",
        last_date: "2026-10-21",
        error: null,
      },
      counts: { employees: 2, attendance: 3 },
    });

    const employees = await auth(server, "/relay/v1/employees");
    const employeeBody = (await employees.json()) as {
      data: Array<{ id_number: string; device_uid: number | null }>;
    };
    expect(employeeBody.data).toHaveLength(2);
    expect(employeeBody.data.find((row) => row.id_number === "992")?.device_uid).toBe(1);

    const schedule = await auth(server, "/relay/v1/schedule");
    expect(((await schedule.json()) as { data: ScheduleCalendar }).data).toEqual(CALENDAR);

    const attendance = await auth(server, "/relay/v1/attendance?from=2026-10-20&to=2026-10-21");
    const attendanceBody = (await attendance.json()) as {
      data: Array<{ id_number: string; date: string; time: string; punch: number; verify: number }>;
    };
    expect(attendanceBody.data).toHaveLength(3);
    expect(attendanceBody.data[0]).toEqual({
      id_number: "992",
      date: "2026-10-20",
      time: "07:28:34",
      punch: 0,
      verify: 15,
    });

    const filtered = await auth(
      server,
      "/relay/v1/attendance?from=2026-10-20&to=2026-10-21&employee_id=993",
    );
    const filteredBody = (await filtered.json()) as {
      data: Array<{ id_number: string; date: string; time: string; punch: number; verify: number }>;
    };
    expect(filteredBody.data).toEqual([
      { id_number: "993", date: "2026-10-21", time: "07:58:00", punch: 0, verify: 1 },
    ]);
  });

  test("serves a consistent snapshot with the same filters", async () => {
    const server = start();

    const response = await auth(
      server,
      "/relay/v1/snapshot?from=2026-10-20&to=2026-10-21&employee_id=992",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        meta: { schema_version: number };
        employees: unknown[];
        schedule: ScheduleCalendar;
        attendance: Array<{ id_number: string }>;
      };
    };
    expect(body.data.meta.schema_version).toBe(8);
    expect(body.data.employees).toHaveLength(2);
    expect(body.data.schedule).toEqual(CALENDAR);
    expect(body.data.attendance).toHaveLength(2);
    expect(body.data.attendance.every((row) => row.id_number === "992")).toBe(true);
  });

  test("rejects invalid date filters", async () => {
    const server = start();

    for (const path of [
      "/relay/v1/attendance",
      "/relay/v1/attendance?from=2026-10-01",
      "/relay/v1/attendance?from=2026-02-30&to=2026-03-01",
      "/relay/v1/attendance?from=2025-01-01&to=2026-10-21",
    ]) {
      const response = await auth(server, path);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_QUERY");
    }
  });
});

describe("relay module boundary", () => {
  test("rejects a wildcard bind at runtime", () => {
    const db = openMemoryDb();
    try {
      expect(() =>
        startRelayServer({
          relay: { host: "0.0.0.0", port: 0, token: TOKEN },
          store: new SqliteReadStore(db),
          getCalendar: () => CALENDAR,
        }),
      ).toThrow("specific tunnel address");
    } finally {
      db.close();
    }
  });

  test("never imports the device, sync, or web layers", () => {
    for (const file of ["auth.ts", "dto.ts", "server.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", "relay", file), "utf8");
      expect(source).not.toContain("../zk.ts");
      expect(source).not.toContain("../device.ts");
      expect(source).not.toContain("../sync.ts");
      expect(source).not.toContain("../web/");
      expect(source).not.toContain("../api/");
    }
  });
});
