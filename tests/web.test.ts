import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, type Db } from "../src/db.ts";
import { DEFAULT_EMPLOYEE_PASSWORD } from "../src/auth.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
import { startServer } from "../src/web/server.ts";

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

interface Running {
  base: string;
  db: Db;
  store: ScheduleStore;
  path: string;
  stop: () => void;
}

const cleanups: Running[] = [];

function start(options: { readOnly?: boolean } = {}): Running {
  const dir = mkdtempSync(join(tmpdir(), "rekap-web-"));
  const path = join(dir, "schedule.json");
  writeFileSync(path, JSON.stringify(CALENDAR), "utf8");

  const db = openMemoryDb();
  db.upsertEmployees(
    [
      { uid: 1, idNumber: "992", name: "Dummy Siti", privilege: 0, card: 0, groupId: "" },
      { uid: 2, idNumber: "993", name: "Dummy Budi", privilege: 0, card: 0, groupId: "" },
    ],
    "2026-10-22T07:00:00+07:00",
  );

  const store = new ScheduleStore({ calendar: CALENDAR, source: "file", filePath: path });
  const running = startServer({
    db,
    storage: { dbPath: ":memory:", mode: "test" },
    device: { host: "192.0.2.10", port: 4370, timeoutMs: 1000 },
    schedule: store,
    web: { username: "admin", password: "secret", port: 0, hostname: "127.0.0.1" },
    sync: async () => {
      throw new Error("sync is not configured");
    },
    probe: async () => ({ users: 56, records: 2795, usersCap: 3000, recordsCap: 100_000 }),
    now: () => NOW,
    readOnly: options.readOnly === true,
  });

  const item: Running = {
    base: `http://127.0.0.1:${running.port}`,
    db,
    store,
    path,
    stop: () => {
      running.stop();
      db.close();
      // Windows can keep the SQLite handle for a moment after close(); a leaked
      // temp dir is harmless, but a throw here would fail the following test.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort only.
      }
    },
  };
  cleanups.push(item);
  return item;
}

afterEach(() => {
  for (const item of cleanups.splice(0)) item.stop();
});

async function login(base: string, password = "secret"): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password }),
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

describe("web shell and auth", () => {
  test("serves login, assets, and the authenticated shell without secrets", async () => {
    const server = start();

    const loginPage = await fetch(`${server.base}/login`);
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain('name="password"');
    expect(loginHtml).not.toContain("ABSEN_WEB_PASSWORD_VALUE");

    const unauthenticated = await fetch(`${server.base}/`, { redirect: "manual" });
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe("/login");

    const asset = await fetch(`${server.base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("const TABS");

    expect((await fetch(`${server.base}/assets/missing.js`)).status).toBe(404);

    const cookie = await login(server.base);
    const shell = await fetch(`${server.base}/`, { headers: { cookie } });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain("data-bootstrap=");
    expect(html).toContain("Absenly");
    expect(html).not.toContain("ABSEN_ZK_COMM_KEY");
    expect(html).not.toContain("secret");

    // Vertical sidebar shell: a drawer toggle plus one link per admin tab.
    expect(html).toContain('id="nav-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="nav-drawer"');
    expect(html).toContain('id="nav-drawer"');
    expect(html).toContain('class="sidebar"');
    expect(html.match(/<a href="\/[a-z]*" data-link/g)?.length).toBe(8);
    expect(html).toContain(">Beranda<");
    expect(html).toContain(">Hooks");
    expect(html).toContain(">Settings<");

    const csp = shell.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
  });

  test("throttles failed logins after five attempts", async () => {
    const server = start();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${server.base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "admin", password: "wrong" }),
        redirect: "manual",
      });
      expect(response.status).toBe(401);
    }

    const blocked = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "secret" }),
      redirect: "manual",
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("web actions", () => {
  test("updates an employee profile and returns the additive API fields", async () => {
    const server = start();
    const cookie = await login(server.base);

    const response = await fetch(`${server.base}/employees/992/profile`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({
        display_name: "Siti Aminah",
        prefix_title: "H.",
        suffix_title: ", S.Kom",
        active: false,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string; active: boolean } };
    expect(body.data.name).toBe("H. Siti Aminah, S.Kom");
    expect(body.data.active).toBe(false);
    expect(server.db.getEmployeeProfile("992")).toMatchObject({
      displayName: "Siti Aminah",
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: false,
    });

    const employees = await fetch(`${server.base}/api/v1/employees`, { headers: { cookie } });
    const employeesBody = (await employees.json()) as {
      data: Array<{ id_number: string; device_name: string; display_name: string }>;
    };
    expect(employeesBody.data.find((item) => item.id_number === "992")).toMatchObject({
      device_name: "Dummy Siti",
      display_name: "Siti Aminah",
    });

    const invalid = await fetch(`${server.base}/employees/992/profile`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ active: "false" }),
    });
    expect(invalid.status).toBe(400);
  });

  test("creates, resets, and deletes an employee account", async () => {
    const server = start();
    const cookie = await login(server.base);

    const created = await fetch(`${server.base}/employees/992/account`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      data: { username: string; employee_id_number: string; reset: boolean };
    };
    expect(createdBody.data).toEqual({
      username: "992",
      employee_id_number: "992",
      reset: false,
    });

    const user = server.db.getAppUserByUsername("992");
    expect(user === null).toBe(false);
    expect(await Bun.password.verify(DEFAULT_EMPLOYEE_PASSWORD, user!.passwordHash)).toBe(true);

    const loginResponse = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "992", password: DEFAULT_EMPLOYEE_PASSWORD }),
      redirect: "manual",
    });
    expect(loginResponse.status).toBe(303);
    expect(loginResponse.headers.get("location")).toBe("/me");
    const employeeSession = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // Reset keeps the username, restores the default password, and drops sessions.
    const reset = await fetch(`${server.base}/employees/992/account`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { data: { reset: boolean } }).data.reset).toBe(true);
    expect(server.db.listAppUsers()).toHaveLength(1);
    const revoked = await fetch(`${server.base}/api/v1/me`, {
      headers: { cookie: employeeSession },
    });
    expect(revoked.status).toBe(401);

    const users = await fetch(`${server.base}/api/v1/users`, { headers: { cookie } });
    expect(users.status).toBe(200);
    const usersText = await users.text();
    expect(usersText).not.toContain("password");
    expect(usersText).not.toContain("$argon2");
    expect((JSON.parse(usersText) as { data: unknown[] }).data).toEqual([
      expect.objectContaining({ username: "992", employee_id_number: "992" }),
    ]);

    // Cross-origin writes never reach the DB.
    const crossSite = await fetch(`${server.base}/employees/993/account`, {
      method: "POST",
      headers: { ...actionHeaders(cookie, server.base), origin: "http://evil.example" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect(server.db.getAppUserByUsername("993")).toBeNull();

    const unknown = await fetch(`${server.base}/employees/404/account`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(unknown.status).toBe(404);

    const deleted = await fetch(`${server.base}/employees/992/account/delete`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(deleted.status).toBe(200);
    expect(server.db.getAppUserByUsername("992")).toBeNull();
    expect(server.db.listEmployees()).toHaveLength(2);

    const again = await fetch(`${server.base}/employees/992/account/delete`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(again.status).toBe(404);
  });

  test("saves a valid schedule, rejects invalid data, and hot-reloads an external edit", async () => {
    const server = start();
    const cookie = await login(server.base);

    const next = structuredClone(CALENDAR);
    next.base.SUNDAY = { in: "09:00", out: "12:00" };
    const saved = await fetch(`${server.base}/schedule`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ calendar: next }),
    });
    expect(saved.status).toBe(200);
    expect(server.store.calendar.base.SUNDAY).toEqual({ in: "09:00", out: "12:00" });
    expect(JSON.parse(readFileSync(server.path, "utf8")).base.SUNDAY).toEqual({
      in: "09:00",
      out: "12:00",
    });

    const invalid = structuredClone(CALENDAR);
    invalid.base.SUNDAY = null;
    invalid.base.MONDAY = null;
    invalid.base.TUESDAY = null;
    invalid.base.WEDNESDAY = null;
    invalid.base.THURSDAY = null;
    invalid.base.FRIDAY = null;
    invalid.base.SATURDAY = null;
    const rejected = await fetch(`${server.base}/schedule`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ calendar: invalid }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      "SCHEDULE_EMPTY",
    );

    const external = structuredClone(CALENDAR);
    external.base.SATURDAY = { in: "07:00", out: "11:00" };
    writeFileSync(server.path, JSON.stringify(external), "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(server.path, future, future);

    const shell = await fetch(`${server.base}/`, { headers: { cookie } });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("07:00");
    expect(server.store.calendar.base.SATURDAY).toEqual({ in: "07:00", out: "11:00" });
  });

  test("changes the password, invalidates sessions, and supports backup and probe", async () => {
    const server = start();
    const cookie = await login(server.base);

    const wrongOld = await fetch(`${server.base}/settings/password`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({
        old_password: "wrong",
        new_password: "new-secret",
        confirm_password: "new-secret",
      }),
    });
    expect(wrongOld.status).toBe(400);

    const changed = await fetch(`${server.base}/settings/password`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({
        old_password: "secret",
        new_password: "new-secret",
        confirm_password: "new-secret",
      }),
    });
    expect(changed.status).toBe(200);
    expect(server.db.getAdminPasswordHash()).not.toBeNull();

    const oldSession = await fetch(`${server.base}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(oldSession.status).toBe(303);

    const oldPassword = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "secret" }),
      redirect: "manual",
    });
    expect(oldPassword.status).toBe(401);

    const newCookie = await login(server.base, "new-secret");
    const backup = await fetch(`${server.base}/settings/backup`, {
      headers: { cookie: newCookie },
    });
    expect(backup.status).toBe(200);
    expect(backup.headers.get("content-type")).toBe("application/vnd.sqlite3");
    const bytes = new Uint8Array(await backup.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");

    const probe = await fetch(`${server.base}/about/probe`, {
      method: "POST",
      headers: actionHeaders(newCookie, server.base),
      body: "{}",
    });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { data: { records: number } }).data.records).toBe(2795);

    const loggedOut = await fetch(`${server.base}/settings/logout-all`, {
      method: "POST",
      headers: actionHeaders(newCookie, server.base),
      body: "{}",
    });
    expect(loggedOut.status).toBe(200);
    const afterLogout = await fetch(`${server.base}/`, {
      headers: { cookie: newCookie },
      redirect: "manual",
    });
    expect(afterLogout.status).toBe(303);
  });

  test("saves, toggles, and deletes sync schedules over the web routes", async () => {
    const server = start();
    const cookie = await login(server.base);
    const post = (path: string, body: unknown) =>
      fetch(`${server.base}${path}`, {
        method: "POST",
        headers: actionHeaders(cookie, server.base),
        body: JSON.stringify(body),
      });

    const created = await post("/settings/sync-schedules", {
      days: "monday",
      start_time: "07:00",
      end_time: "09:00",
      every_minutes: 10,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: number; days: string } };
    expect(body.data.days).toBe("MONDAY");
    expect(server.db.listSyncSchedules()).toHaveLength(1);

    // The bootstrap carried by the shell shows the new schedule.
    const shell = await fetch(`${server.base}/settings`, { headers: { cookie } });
    expect(await shell.text()).toContain("MONDAY");

    const off = await post("/settings/sync-schedules/update", {
      id: body.data.id,
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(server.db.listSyncSchedules()[0]!.enabled).toBe(false);

    const removed = await post("/settings/sync-schedules/delete", { id: body.data.id });
    expect(removed.status).toBe(200);
    expect(server.db.listSyncSchedules()).toEqual([]);

    // Bad input is a 400, a missing row is a 404.
    expect(
      (
        await post("/settings/sync-schedules", {
          start_time: "07:00",
          end_time: "07:00",
          every_minutes: 5,
        })
      ).status,
    ).toBe(400);
    expect((await post("/settings/sync-schedules/delete", { id: 99 })).status).toBe(404);

    // CSRF: a foreign origin is rejected before the body is touched.
    const crossSite = await fetch(`${server.base}/settings/sync-schedules`, {
      method: "POST",
      headers: { ...actionHeaders(cookie, server.base), origin: "http://evil.example" },
      body: JSON.stringify({
        start_time: "07:00",
        end_time: "09:00",
        every_minutes: 5,
      }),
    });
    expect(crossSite.status).toBe(403);
    expect(server.db.listSyncSchedules()).toEqual([]);
  });

  test("a viewer cannot touch sync schedules", async () => {
    const server = start({ readOnly: true });
    const cookie = await login(server.base);
    const response = await fetch(`${server.base}/settings/sync-schedules`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ start_time: "07:00", end_time: "09:00", every_minutes: 5 }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "READ_ONLY_VIEWER",
    );
  });
});

describe("web employees tab", () => {
  test("the account column reports presence only; actions live in the editor", async () => {
    const server = start();
    const asset = await fetch(`${server.base}/assets/tabs/employees.js`);
    expect(asset.status).toBe(200);
    const js = await asset.text();

    // The table cell must not print the default password next to the username.
    expect(js).not.toContain("${account.username} · ${DEFAULT_PASSWORD}");
    // Reset/delete are rendered from the editor section, not the table row.
    expect(js).toContain("Akun login");
    expect(js).toContain("Reset password");
    expect(js).toContain("Hapus akun");
  });

  test("the share topbar wraps instead of overlapping on narrow screens", async () => {
    const server = start();
    const css = await fetch(`${server.base}/assets/app.css`);
    expect(css.status).toBe(200);
    const text = await css.text();
    expect(text).toContain(".share-topbar {");
    expect(text).toContain("flex-wrap: wrap;");
  });
});

describe("web layout", () => {
  test("the content column stays narrow on large monitors", async () => {
    const server = start();
    const css = await (await fetch(`${server.base}/assets/app.css`)).text();
    expect(css).toContain("width: min(1200px, 100%)");
    expect(css).not.toContain("1400px");
  });
});

describe("web hooks tab", () => {
  test("serves the hooks page and its assets to an admin", async () => {
    const server = start();
    const cookie = await login(server.base);

    const page = await fetch(`${server.base}/hooks`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hooks");

    const asset = await fetch(`${server.base}/assets/tabs/hooks.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("/api/v1/webhooks");
  });

  test("a viewer gets 404 on /hooks", async () => {
    const server = start({ readOnly: true });
    const cookie = await login(server.base);
    expect((await fetch(`${server.base}/hooks`, { headers: { cookie } })).status).toBe(404);
  });

  test("webhook create, toggle and delete round-trip through the API", async () => {
    const server = start();
    const cookie = await login(server.base);

    const created = await fetch(`${server.base}/api/v1/webhooks`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ url: "https://bot.example.com/rekap", events: ["sync.done"] }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: number; secret: string } };

    const off = await fetch(`${server.base}/api/v1/webhooks/${createdBody.data.id}`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);

    const removed = await fetch(`${server.base}/api/v1/webhooks/${createdBody.data.id}`, {
      method: "DELETE",
      headers: actionHeaders(cookie, server.base),
    });
    expect(removed.status).toBe(200);
    expect(server.db.listWebhooks()).toEqual([]);
  });

  test("hooks are behind the admin session", async () => {
    const server = start();
    expect((await fetch(`${server.base}/api/v1/events`)).status).toBe(401);
    const anonymous = await fetch(`${server.base}/api/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://bot.example.com/rekap" }),
    });
    expect(anonymous.status).toBe(401);
    expect(server.db.listWebhooks()).toEqual([]);
  });
});

describe("web share links", () => {
  test("creates a public one-employee page and hides invalid links", async () => {
    const server = start();
    const cookie = await login(server.base);
    server.db.upsertAttendance(
      [
        { idNumber: "992", date: "2026-10-22", time: "07:58:00", punch: 0, verify: 15 },
        { idNumber: "992", date: "2026-10-22", time: "16:05:00", punch: 1, verify: 15 },
      ],
      "2026-10-22T10:00:00+07:00",
    );

    const unauthenticated = await fetch(`${server.base}/generate/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_number: "992", month: "2026-10" }),
    });
    expect(unauthenticated.status).toBe(401);

    const badMonth = await fetch(`${server.base}/generate/share`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ id_number: "992", month: "2026-13" }),
    });
    expect(badMonth.status).toBe(400);

    const created = await fetch(`${server.base}/generate/share`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ id_number: "992", month: "2026-10" }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      data: { path: string; month: string; expires_at: string };
    };
    expect(body.data.path).toMatch(
      /^\/share\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.data.month).toBe("2026-10");
    expect(new Date(body.data.expires_at).getTime() - NOW.getTime()).toBe(86_400_000);

    const page = await fetch(`${server.base}${body.data.path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain("Dummy Siti");
    expect(html).toContain("Total absen");
    expect(html).toContain("Persentase ketepatan");
    expect(html).not.toContain("Persentase telat");
    expect(html.match(/class="share-stat"/g)).toHaveLength(8);
    expect(html).toContain("Absen hari ini");
    expect(html).toContain("07:58:00 → 16:05:00");
    expect(html).toContain("Lengkap");
    expect(html).toContain("Dibuat pada");
    expect(html).toContain("Sync terakhir: belum ada");
    expect(html).not.toContain("Dummy Budi");
    expect(html).not.toContain("data-bootstrap");
    expect(html).not.toContain("Keluar");

    server.db.recordSync({
      startedAt: "2026-10-22T09:00:00+07:00",
      finishedAt: "2026-10-22T09:01:00+07:00",
      durationMs: 60_000,
      users: 2,
      records: 10,
      firstDate: "2026-10-01",
      lastDate: "2026-10-22",
      ok: true,
    });
    const withSync = await (await fetch(`${server.base}${body.data.path}`)).text();
    expect(withSync).toContain("Sync terakhir: 22 Okt 2026");
    expect(withSync).toContain("09.01 WIB");

    const profile = server.db.getEmployeeProfile("992");
    if (profile === null) throw new Error("profile fixture missing");
    server.db.saveEmployeeProfile({
      idNumber: profile.idNumber,
      displayName: profile.displayName,
      prefixTitle: profile.prefixTitle,
      suffixTitle: profile.suffixTitle,
      active: false,
      updatedAt: "2026-10-22T10:00:00+07:00",
    });
    const inactive = await fetch(`${server.base}/generate/share`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ id_number: "992", month: "2026-10" }),
    });
    expect(inactive.status).toBe(400);
    expect(((await inactive.json()) as { error: { code: string } }).error.code).toBe(
      "INACTIVE_EMPLOYEE",
    );
    expect((await fetch(`${server.base}${body.data.path}`)).status).toBe(200);

    server.db.insertShareLink({
      token: "11111111-1111-4111-8111-111111111111",
      idNumber: "992",
      month: "2026-10",
      createdAt: "2026-10-22T10:00:00+07:00",
      expiresAt: NOW.getTime() - 1,
    });
    expect((await fetch(`${server.base}/share/11111111-1111-4111-8111-111111111111`)).status).toBe(
      404,
    );
    expect((await fetch(`${server.base}/share/not-a-uuid`)).status).toBe(404);
    expect(
      (await fetch(`${server.base}/share/${body.data.path.slice(7)}`, { method: "POST" })).status,
    ).toBe(405);
  });
});

describe("employee /me page", () => {
  async function employeeCookie(
    server: Running,
    username: string,
    password: string,
  ): Promise<string> {
    const hash = await Bun.password.hash(password);
    server.db.saveAppUser({
      username,
      passwordHash: hash,
      employeeIdNumber: username === "siti" ? "992" : "993",
      createdAt: "2026-10-22T07:00:00+07:00",
    });
    const response = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/me");
    return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  test("serves only the caller's recap on /me", async () => {
    const server = start();
    const cookie = await employeeCookie(server, "siti", "karyawan-1");

    const page = await fetch(`${server.base}/me`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Dummy Siti");
    expect(html).toContain("ID 992");
    expect(html).not.toContain("Dummy Budi");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const month = await fetch(`${server.base}/me?month=2026-09`, { headers: { cookie } });
    expect(month.status).toBe(200);
    const september = await month.text();
    expect(september).toContain("September 2026");
    // The month picker submits a plain GET form. An inline onchange would be
    // blocked by the page CSP (script-src 'self') and silently do nothing.
    expect(september).not.toContain("onchange=");
    expect(september).toContain('<button type="submit" class="button">Tampilkan</button>');
    expect(september).toContain('value="2026-09" selected');

    // The mobile account menu is a burger + popup wired by an external module.
    expect(september).toContain('id="topbar-burger"');
    expect(september).toContain('aria-expanded="false"');
    expect(september).toContain('id="topbar-menu"');
    expect(september).toContain('<script type="module" src="/assets/me-menu.js">');
    expect(september).not.toContain("onclick=");

    const menuAsset = await fetch(`${server.base}/assets/me-menu.js`);
    expect(menuAsset.status).toBe(200);
    expect(await menuAsset.text()).toContain("aria-expanded");

    // Hooks shipped; the admin nav must not label it "segera" anymore.
    const adminCookie = await login(server.base);
    const home = await fetch(`${server.base}/`, { headers: { cookie: adminCookie } });
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/hooks"');
    expect(homeHtml).not.toContain(">segera<");

    expect((await fetch(`${server.base}/me?month=2026-13`, { headers: { cookie } })).status).toBe(
      400,
    );
    expect((await fetch(`${server.base}/me?month=2027-01`, { headers: { cookie } })).status).toBe(
      400,
    );
    expect((await fetch(`${server.base}/me`, { redirect: "manual" })).status).toBe(303);
  });

  test("lets an employee change their own password and keeps this session", async () => {
    const server = start();
    const cookie = await employeeCookie(server, "siti", "karyawan-1");

    const form = await fetch(`${server.base}/me/password`, { headers: { cookie } });
    expect(form.status).toBe(200);
    const formHtml = await form.text();
    expect(formHtml).toContain('action="/me/password"');
    expect(formHtml).toContain("Dummy Siti");
    expect(formHtml).not.toContain("Dummy Budi");
    expect(form.headers.get("cache-control")).toBe("no-store");

    const otherSession = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "siti", password: "karyawan-1" }),
      redirect: "manual",
    });
    const otherCookie = (otherSession.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(otherCookie).not.toBe("");

    const change = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`${server.base}/me/password`, {
        method: "POST",
        headers: {
          cookie,
          origin: server.base,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(body),
        redirect: "manual",
      });

    expect(
      (
        await change({
          old_password: "karyawan-1",
          new_password: "short",
          confirm_password: "short",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await change({
          old_password: "karyawan-1",
          new_password: "karyawan-2",
          confirm_password: "karyawan-3",
        })
      ).status,
    ).toBe(400);

    const wrong = await change({
      old_password: "salah",
      new_password: "karyawan-2",
      confirm_password: "karyawan-2",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Password lama salah.");

    const crossSite = await change(
      { old_password: "karyawan-1", new_password: "karyawan-2", confirm_password: "karyawan-2" },
      { origin: "http://evil.example" },
    );
    expect(crossSite.status).toBe(403);
    // A rejected origin still renders the employee HTML page, never the JSON
    // envelope the admin SPA uses.
    expect(crossSite.headers.get("content-type")).toContain("text/html");
    expect(await crossSite.text()).toContain("Origin tidak cocok");

    // An opaque origin (`Origin: null`) is what a proxied/saved page sends; it
    // must not be mistaken for a cross-site form post. A wrong old password
    // proves the request reached the form logic instead of the origin gate.
    const opaque = await change(
      { old_password: "salah", new_password: "karyawan-2", confirm_password: "karyawan-2" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    );
    expect(opaque.status).toBe(400);
    expect(await opaque.text()).toContain("Password lama salah.");

    // Sec-Fetch-Site is the real gate: a cross-site post is refused even with
    // no Origin header at all, and the password does not change.
    const noOriginCrossSite = await change(
      { old_password: "karyawan-1", new_password: "karyawan-3", confirm_password: "karyawan-3" },
      { "sec-fetch-site": "cross-site" },
    );
    expect(noOriginCrossSite.status).toBe(403);
    expect(noOriginCrossSite.headers.get("content-type")).toContain("text/html");
    expect(
      await Bun.password.verify("karyawan-1", server.db.getAppUserByUsername("siti")!.passwordHash),
    ).toBe(true);

    const saved = await change({
      old_password: "karyawan-1",
      new_password: "karyawan-2",
      confirm_password: "karyawan-2",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/me?changed=1");

    // This browser stays logged in, the other session is gone.
    expect((await fetch(`${server.base}/me`, { headers: { cookie } })).status).toBe(200);
    expect(
      (await fetch(`${server.base}/me`, { headers: { cookie: otherCookie }, redirect: "manual" }))
        .status,
    ).toBe(303);
    const banner = await fetch(`${server.base}/me?changed=1`, { headers: { cookie } });
    expect(await banner.text()).toContain("Password diganti");

    const credential = server.db.getAppUserByUsername("siti");
    expect(await Bun.password.verify("karyawan-2", credential!.passwordHash)).toBe(true);
    expect(await Bun.password.verify("karyawan-1", credential!.passwordHash)).toBe(false);

    const oldLogin = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "siti", password: "karyawan-1" }),
      redirect: "manual",
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "siti", password: "karyawan-2" }),
      redirect: "manual",
    });
    expect(newLogin.status).toBe(303);
    expect(newLogin.headers.get("location")).toBe("/me");
    // Seven argon2 hash/verify calls cost ~2.8s on a slow disk, so the default
    // 5s budget is too tight once the rest of the suite competes for the CPU.
  }, 20_000);

  test("throttles repeated wrong old passwords on /me/password", async () => {
    const server = start();
    const cookie = await employeeCookie(server, "siti", "karyawan-1");

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${server.base}/me/password`, {
        method: "POST",
        headers: {
          cookie,
          origin: server.base,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          old_password: "salah",
          new_password: "karyawan-2",
          confirm_password: "karyawan-2",
        }),
        redirect: "manual",
      });
      expect(response.status).toBe(400);
    }

    const blocked = await fetch(`${server.base}/me/password`, {
      method: "POST",
      headers: {
        cookie,
        origin: server.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        old_password: "karyawan-1",
        new_password: "karyawan-2",
        confirm_password: "karyawan-2",
      }),
      redirect: "manual",
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("an employee session cannot reach admin pages or actions", async () => {
    const server = start();
    const cookie = await employeeCookie(server, "siti", "karyawan-1");

    const home = await fetch(`${server.base}/`, { headers: { cookie }, redirect: "manual" });
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/me");

    const employeesPage = await fetch(`${server.base}/employees`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(employeesPage.status).toBe(303);
    expect(employeesPage.headers.get("location")).toBe("/me");

    const action = await fetch(`${server.base}/employees/992/profile`, {
      method: "POST",
      headers: { ...actionHeaders(cookie, server.base) },
      body: JSON.stringify({ display_name: "Hacked" }),
    });
    expect(action.status).toBe(403);

    const account = await fetch(`${server.base}/employees/993/account`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: "{}",
    });
    expect(account.status).toBe(403);
    expect(server.db.listAppUsers()).toHaveLength(1);

    const share = await fetch(`${server.base}/generate/share`, {
      method: "POST",
      headers: actionHeaders(cookie, server.base),
      body: JSON.stringify({ id_number: "993", month: "2026-10" }),
    });
    expect(share.status).toBe(403);
  });

  test("an admin session is redirected away from /me", async () => {
    const server = start();
    const cookie = await login(server.base);
    const response = await fetch(`${server.base}/me`, { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");

    const passwordPage = await fetch(`${server.base}/me/password`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(passwordPage.status).toBe(303);
    expect(passwordPage.headers.get("location")).toBe("/");
  });
});
