// Local relay E2E: two real `app serve` processes on loopback (collector + viewer).
// It covers the CLI/env wiring and read-only parity without the device or a
// ZeroTier tunnel. Run with `bun run e2e:local`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../src/db.ts";

const PASSWORD = "e2e-password";
const RELAY_TOKEN = "e2e-relay-token";
const MONTH = "2026-10";
const SYNCED_AT = "2026-10-22T09:01:00+07:00";
const ROOT = resolve(import.meta.dir, "..");

const CALENDAR = {
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

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
}

function seed(dbPath: string): void {
  const db = openDb(dbPath, "test");
  try {
    db.upsertEmployees(
      [
        { uid: 1, idNumber: "992", name: "Siti", privilege: 0, card: 0, groupId: "1" },
        { uid: 2, idNumber: "993", name: "Budi", privilege: 0, card: 0, groupId: "1" },
        { uid: 3, idNumber: "994", name: "Joko", privilege: 0, card: 0, groupId: "1" },
      ],
      SYNCED_AT,
    );
    db.upsertAttendance(
      [
        { idNumber: "992", date: "2026-10-19", time: "07:28:34", punch: 0, verify: 15 },
        { idNumber: "992", date: "2026-10-19", time: "16:05:00", punch: 1, verify: 15 },
        { idNumber: "992", date: "2026-10-20", time: "08:15:00", punch: 0, verify: 15 },
        { idNumber: "992", date: "2026-10-20", time: "15:50:00", punch: 1, verify: 15 },
        { idNumber: "993", date: "2026-10-20", time: "07:58:00", punch: 0, verify: 1 },
        { idNumber: "993", date: "2026-10-20", time: "16:30:00", punch: 1, verify: 1 },
        { idNumber: "994", date: "2026-10-21", time: "07:45:00", punch: 0, verify: 15 },
      ],
      SYNCED_AT,
    );
    db.saveEmployeeProfile({
      idNumber: "992",
      displayName: null,
      prefixTitle: "H.",
      suffixTitle: ", S.Kom",
      active: true,
      updatedAt: SYNCED_AT,
    });
    db.saveEmployeeProfile({
      idNumber: "993",
      displayName: "Budi Viewer",
      prefixTitle: "",
      suffixTitle: "",
      active: false,
      updatedAt: SYNCED_AT,
    });
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
      SYNCED_AT,
    );
    db.recordSync({
      startedAt: "2026-10-22T09:00:00+07:00",
      finishedAt: SYNCED_AT,
      durationMs: 60_000,
      users: 3,
      records: 7,
      firstDate: "2026-10-19",
      lastDate: "2026-10-21",
      ok: true,
    });
  } finally {
    db.close();
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("could not allocate a free port");
  return port;
}

function stderrText(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  return child.stderr instanceof ReadableStream
    ? new Response(child.stderr).text()
    : Promise.resolve("");
}

interface Serve {
  label: string;
  port: number;
  child: ReturnType<typeof Bun.spawn>;
  stop: () => Promise<void>;
}

function spawnServe(label: string, port: number, env: Record<string, string>, cwd: string): Serve {
  const child = Bun.spawn(["bun", "run", join(ROOT, "src", "app.ts"), "serve"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (child.exitCode === null) child.kill();
      // Windows keeps the SQLite file locked until the process has exited.
      await Promise.race([child.exited, Bun.sleep(5000)]);
    })();
    return stopping;
  };
  return { label, port, child, stop };
}

async function waitReady(server: Serve, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      const text = await stderrText(server.child);
      throw new Error(`${server.label} exited (${server.child.exitCode}): ${text.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(`${server.label} did not become ready in ${timeoutMs} ms`);
}

async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  const body = (await response.json()) as { data?: { token?: string }; error?: { code: string } };
  if (response.status !== 200 || body.data?.token === undefined) {
    throw new Error(`login failed: ${response.status} ${body.error?.code ?? ""}`.trim());
  }
  return body.data.token;
}

async function get(base: string, token: string, path: string) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ABSEN_") && value !== undefined) env[key] = value;
  }
  return env;
}

// Always identical: these routes read only relayed data.
const COMPARED_PATHS = ["/api/v1/health", "/api/v1/employees"];

// Equal only while the collector has no work exceptions. The relay is raw-only,
// so a piket waiver exists on the collector and cannot exist on the viewer.
const WAIVED_PATHS = [
  `/api/v1/recap?month=${MONTH}&per_page=200`,
  `/api/v1/summary?month=${MONTH}`,
];

// The viewer synthesizes row ids, so compare attendance without them.
function stripIds(body: unknown): unknown {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return body;
  return {
    ...(body as Record<string, unknown>),
    data: data.map((row) => {
      const copy = { ...(row as Record<string, unknown>) };
      delete copy.id;
      return copy;
    }),
  };
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "rekap-e2e-"));
  const dbPath = join(dir, "data.db");
  const schedulePath = join(dir, "schedule.json");
  writeFileSync(schedulePath, JSON.stringify(CALENDAR), "utf8");
  seed(dbPath);

  const webPort = await freePort();
  const relayPort = await freePort();
  const viewerPort = await freePort();

  const shared = baseEnv();
  const collector = spawnServe(
    "collector",
    webPort,
    {
      ...shared,
      ABSEN_ENV: "test",
      ABSEN_ROLE: "collector",
      ABSEN_DB: dbPath,
      ABSEN_SCHEDULE_FILE: schedulePath,
      ABSEN_WEB_USER: "admin",
      ABSEN_WEB_PASSWORD: PASSWORD,
      ABSEN_PORT: String(webPort),
      ABSEN_HOSTNAME: "127.0.0.1",
      ABSEN_ZK_HOST: "192.0.2.10",
      ABSEN_RELAY_ENABLED: "true",
      ABSEN_RELAY_HOST: "127.0.0.1",
      ABSEN_RELAY_PORT: String(relayPort),
      ABSEN_RELAY_TOKEN: RELAY_TOKEN,
      ABSEN_RELAY_URL: "",
    },
    dir,
  );
  const viewer = spawnServe(
    "viewer",
    viewerPort,
    {
      ...shared,
      ABSEN_ENV: "test",
      ABSEN_ROLE: "viewer",
      ABSEN_WEB_USER: "admin",
      ABSEN_WEB_PASSWORD: PASSWORD,
      ABSEN_PORT: String(viewerPort),
      ABSEN_HOSTNAME: "127.0.0.1",
      ABSEN_RELAY_URL: `http://127.0.0.1:${relayPort}`,
      ABSEN_RELAY_TOKEN: RELAY_TOKEN,
      ABSEN_RELAY_ENABLED: "false",
      ABSEN_ZK_HOST: "",
    },
    dir,
  );

  try {
    await waitReady(collector);
    await waitReady(viewer);
    const collectorBase = `http://127.0.0.1:${webPort}`;
    const viewerBase = `http://127.0.0.1:${viewerPort}`;

    const collectorToken = await login(collectorBase);
    const viewerToken = await login(viewerBase);

    for (const path of COMPARED_PATHS) {
      const mine = await get(collectorBase, collectorToken, path);
      const relayed = await get(viewerBase, viewerToken, path);
      const same = JSON.stringify(mine.body) === JSON.stringify(relayed.body);
      check(
        `viewer matches collector: ${path}`,
        mine.status === 200 && relayed.status === 200 && same,
        same ? `status ${relayed.status}` : "body differs",
      );
    }

    const attendancePath = `/api/v1/attendance?month=${MONTH}&per_page=200`;
    const attendanceMine = await get(collectorBase, collectorToken, attendancePath);
    const attendanceRelayed = await get(viewerBase, viewerToken, attendancePath);
    check(
      "viewer matches collector: raw attendance (ignoring row ids)",
      JSON.stringify(stripIds(attendanceMine.body)) ===
        JSON.stringify(stripIds(attendanceRelayed.body)),
      "body differs",
    );

    // Documented gap: the relay is raw-only, so a viewer has no ledger rows.
    const exceptionsMine = await get(
      collectorBase,
      collectorToken,
      `/api/v1/work-exceptions?month=${MONTH}`,
    );
    const exceptionsRelayed = await get(
      viewerBase,
      viewerToken,
      `/api/v1/work-exceptions?month=${MONTH}`,
    );
    const collectorRows = (exceptionsMine.body as { data: unknown[] }).data.length;
    const viewerRows = (exceptionsRelayed.body as { data: unknown[] }).data.length;
    check(
      "viewer has no work-exception ledger (relay is raw-only)",
      collectorRows === 1 && viewerRows === 0,
      `collector ${collectorRows}, viewer ${viewerRows}`,
    );

    // With no ledger the collector is unwaived too, so the bodies must match.
    // The seed always has one piket, so this branch guards against a future seed
    // change silently turning the check below into a tautology.
    if (collectorRows === 0) {
      for (const path of WAIVED_PATHS) {
        const mine = await get(collectorBase, collectorToken, path);
        const relayed = await get(viewerBase, viewerToken, path);
        const same = JSON.stringify(mine.body) === JSON.stringify(relayed.body);
        check(
          `viewer matches collector without a ledger: ${path}`,
          mine.status === 200 && relayed.status === 200 && same,
          same ? `status ${relayed.status}` : "body differs",
        );
      }
    } else {
      // The one difference that matters: the collector waives the piket day and
      // the viewer cannot, so the viewer reports the raw sanction.
      const collectorRecap = await get(
        collectorBase,
        collectorToken,
        `/api/v1/recap?month=${MONTH}&per_page=200`,
      );
      const viewerRecap = await get(
        viewerBase,
        viewerToken,
        `/api/v1/recap?month=${MONTH}&per_page=200`,
      );
      const rowOf = (body: unknown) =>
        (
          body as { data?: Array<{ date: string; status: string; late_minutes: number }> }
        ).data?.find((row) => row.date === "2026-10-20");
      const collectorDay = rowOf(collectorRecap.body);
      const viewerDay = rowOf(viewerRecap.body);
      check(
        "viewer recap is unwaived when the collector has a piket",
        collectorDay?.status === "piket" &&
          collectorDay.late_minutes === 0 &&
          viewerDay?.status === "telat" &&
          (viewerDay.late_minutes ?? 0) > 0,
        `collector ${collectorDay?.status}/${collectorDay?.late_minutes}, viewer ${viewerDay?.status}/${viewerDay?.late_minutes}`,
      );

      // Same cause on the summary: the waived late minutes differ.
      const collectorSummary = await get(
        collectorBase,
        collectorToken,
        `/api/v1/summary?month=${MONTH}`,
      );
      const viewerSummary = await get(viewerBase, viewerToken, `/api/v1/summary?month=${MONTH}`);
      const lateOf = (body: unknown) =>
        (body as { data?: { late_minutes?: number } }).data?.late_minutes ?? -1;
      check(
        "viewer summary keeps the late minutes the collector waived",
        collectorSummary.status === 200 &&
          viewerSummary.status === 200 &&
          lateOf(viewerSummary.body) > lateOf(collectorSummary.body),
        `collector ${lateOf(collectorSummary.body)}, viewer ${lateOf(viewerSummary.body)}`,
      );
    }

    const raw = await get(viewerBase, viewerToken, `/api/v1/recap?month=${MONTH}`);
    const rawBody = raw.body as { data?: Array<{ name: string }> };
    const names = rawBody.data?.map((row) => row.name) ?? [];
    check(
      "viewer applies collector display names and hides inactive employees",
      names.includes("H. Siti, S.Kom") && !names.some((name) => name.includes("Budi")),
      JSON.stringify(names),
    );

    const write = await fetch(`${viewerBase}/api/v1/work-exceptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const writeBody = (await write.json()) as { error?: { code: string } };
    check(
      "viewer rejects writes with READ_ONLY_VIEWER",
      write.status === 403 && writeBody.error?.code === "READ_ONLY_VIEWER",
      `${write.status} ${writeBody.error?.code ?? ""}`.trim(),
    );

    const badToken = await fetch(`http://127.0.0.1:${relayPort}/relay/v1/meta`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    check(
      "relay rejects a wrong token",
      badToken.status === 401 || badToken.status === 403,
      `status ${badToken.status}`,
    );

    await collector.stop();
    await Bun.sleep(300);
    const offline = await get(viewerBase, viewerToken, `/api/v1/recap?month=${MONTH}`);
    const offlineBody = offline.body as { error?: { code: string } };
    check(
      "viewer fails closed when the collector is down",
      offline.status === 502 && offlineBody.error?.code === "RELAY_UNAVAILABLE",
      `${offline.status} ${offlineBody.error?.code ?? ""}`.trim(),
    );
  } finally {
    await viewer.stop();
    await collector.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const failed = checks.filter((item) => !item.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

const code = await main().catch((error: unknown) => {
  console.error(`e2e failed: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
process.exit(code);
