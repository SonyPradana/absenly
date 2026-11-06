import { afterEach, describe, expect, test } from "bun:test";
import { openMemoryDb, type Db } from "../src/db.ts";
import { RelayClientError, RelayReadStore, RelayScheduleStore } from "../src/relay/client.ts";
import { startRelayServer } from "../src/relay/server.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import { SqliteReadStore } from "../src/store.ts";
import { startServer } from "../src/web/server.ts";

const TOKEN = "viewer-token";
const SYNCED_AT = "2026-10-22T09:01:00+07:00";
const NOW = new Date("2026-10-22T10:00:00+07:00");

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

interface RunningCollector {
  base: string;
  db: Db;
  stop: () => void;
}

interface RunningViewer {
  base: string;
  stop: () => void;
}

const cleanups: Array<() => void> = [];

function startCollector(): RunningCollector {
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
  db.saveEmployeeProfile({
    idNumber: "993",
    displayName: "Budi Viewer",
    prefixTitle: "",
    suffixTitle: "",
    active: false,
    updatedAt: SYNCED_AT,
  });
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

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    running.stop();
    db.close();
  };
  cleanups.push(stop);
  return { base: `http://127.0.0.1:${running.port}`, db, stop };
}

function startViewer(collectorBase: string, token = TOKEN): RunningViewer {
  const relay = new RelayReadStore({
    baseUrl: collectorBase,
    token,
    timeoutMs: 2000,
  });
  const schedule = new RelayScheduleStore(relay);
  const running = startServer({
    web: { username: "admin", password: "secret", port: 0, hostname: "127.0.0.1" },
    db: relay,
    storage: { dbPath: "(relay)", mode: "viewer" },
    device: null,
    schedule,
    sync: async () => {
      throw new RelayClientError("RELAY_READ_ONLY", "read only", 403);
    },
    probe: null,
    readOnly: true,
    refresh: () => schedule.refresh(),
    now: () => NOW,
  });

  const stop = () => running.stop();
  cleanups.push(stop);
  return { base: `http://127.0.0.1:${running.port}`, stop };
}

afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "secret" }),
    redirect: "manual",
  });
  if (response.status !== 303) throw new Error(`login failed: ${response.status}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function actionHeaders(cookie: string, base: string): Record<string, string> {
  return {
    cookie,
    origin: base,
    "content-type": "application/json",
  };
}

describe("viewer web", () => {
  test("serves collector data read-only and hides collector-only pages", async () => {
    const collector = startCollector();
    const viewer = startViewer(collector.base);
    const cookie = await login(viewer.base);

    const shell = await fetch(`${viewer.base}/`, { headers: { cookie } });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain("&quot;read_only&quot;:true");
    expect(html).toContain("&quot;role&quot;:&quot;viewer&quot;");
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain('href="/hooks"');

    const settings = await fetch(`${viewer.base}/settings`, { headers: { cookie } });
    expect(settings.status).toBe(404);
    const hooks = await fetch(`${viewer.base}/hooks`, { headers: { cookie } });
    expect(hooks.status).toBe(404);

    const employees = await fetch(`${viewer.base}/api/v1/employees`, { headers: { cookie } });
    expect(employees.status).toBe(200);
    const employeeBody = (await employees.json()) as {
      data: Array<{ id_number: string; name: string; active: boolean }>;
    };
    expect(employeeBody.data).toHaveLength(2);
    expect(employeeBody.data.find((row) => row.id_number === "992")).toMatchObject({
      id_number: "992",
      name: "Dummy Siti",
    });
    expect(employeeBody.data.find((row) => row.id_number === "993")).toMatchObject({
      id_number: "993",
      name: "Budi Viewer",
      active: false,
    });

    const attendance = await fetch(
      `${viewer.base}/api/v1/attendance?from=2026-10-21&to=2026-10-21`,
      { headers: { cookie } },
    );
    expect(attendance.status).toBe(200);
    const attendanceBody = (await attendance.json()) as {
      data: Array<{ id_number: string; name: string }>;
    };
    // Raw rows keep the device name; the display overlay only applies to reports.
    expect(attendanceBody.data).toHaveLength(1);
    expect(attendanceBody.data[0]).toMatchObject({ id_number: "993", name: "Dummy Budi" });

    const recap = await fetch(`${viewer.base}/api/v1/recap?from=2026-10-20&to=2026-10-20`, {
      headers: { cookie },
    });
    expect(recap.status).toBe(200);
    const recapBody = (await recap.json()) as {
      data: Array<{ id_number: string; in_time: string | null; out_time: string | null }>;
    };
    expect(recapBody.data[0]).toMatchObject({
      id_number: "992",
      in_time: "07:28:34",
      out_time: "16:05:00",
    });

    const inactiveRecap = await fetch(`${viewer.base}/api/v1/recap?from=2026-10-21&to=2026-10-21`, {
      headers: { cookie },
    });
    expect(((await inactiveRecap.json()) as { data: unknown[] }).data).toEqual([]);

    const syncStatus = await fetch(`${viewer.base}/api/v1/sync/status`, { headers: { cookie } });
    expect(
      ((await syncStatus.json()) as { data: { last_sync: { records: number } } }).data.last_sync,
    ).toMatchObject({ records: 3 });

    const sync = await fetch(`${viewer.base}/api/v1/sync`, {
      method: "POST",
      headers: actionHeaders(cookie, viewer.base),
      body: "{}",
    });
    expect(sync.status).toBe(403);
    expect(((await sync.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );

    const account = await fetch(`${viewer.base}/employees/992/account`, {
      method: "POST",
      headers: actionHeaders(cookie, viewer.base),
      body: "{}",
    });
    expect(account.status).toBe(403);
    expect(((await account.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );

    const password = await fetch(`${viewer.base}/settings/password`, {
      method: "POST",
      headers: actionHeaders(cookie, viewer.base),
      body: JSON.stringify({ old_password: "secret", new_password: "new-secret" }),
    });
    expect(password.status).toBe(403);
    expect(((await password.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );

    const schedule = await fetch(`${viewer.base}/schedule`, {
      method: "POST",
      headers: actionHeaders(cookie, viewer.base),
      body: JSON.stringify({ calendar: CALENDAR }),
    });
    expect(schedule.status).toBe(403);
    expect(((await schedule.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );

    const probe = await fetch(`${viewer.base}/about/probe`, {
      method: "POST",
      headers: actionHeaders(cookie, viewer.base),
      body: "{}",
    });
    expect(probe.status).toBe(403);
    expect(((await probe.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );

    const chainedRelay = await fetch(`${viewer.base}/relay/v1/meta`);
    expect(chainedRelay.status).toBe(404);
  });

  test("fails closed when the collector is unreachable", async () => {
    const collector = startCollector();
    const viewer = startViewer(collector.base);
    const cookie = await login(viewer.base);
    collector.stop();

    const employees = await fetch(`${viewer.base}/api/v1/employees`, { headers: { cookie } });
    expect(employees.status).toBe(502);
    const body = (await employees.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RELAY_UNAVAILABLE");

    const shell = await fetch(`${viewer.base}/`, { headers: { cookie } });
    expect(shell.status).toBe(502);
    expect(await shell.text()).toContain("Collector tidak dapat dihubungi");
  });

  test("fails closed on a rejected relay token", async () => {
    const collector = startCollector();
    const viewer = startViewer(collector.base, "wrong-token");
    const cookie = await login(viewer.base);

    const employees = await fetch(`${viewer.base}/api/v1/employees`, { headers: { cookie } });
    expect(employees.status).toBe(502);
    const body = (await employees.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RELAY_AUTH");
  });
});
