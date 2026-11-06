import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "xlsx";
import { HELP_TEXT, runCli, VERSION } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { seedDb } from "./support/seed.ts";

function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return runCli(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }).then((code) => ({ code, out, err }));
}

describe("cli scaffold", () => {
  test("no command and help print usage", async () => {
    for (const argv of [[], ["help"]]) {
      const { code, out, err } = await capture(argv);
      expect(code).toBe(0);
      expect(out).toEqual([HELP_TEXT]);
      expect(HELP_TEXT).toContain("app relay status");
      expect(err).toEqual([]);
    }
  });

  test("--version matches package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const { code, out, err } = await capture(["--version"]);
    expect(code).toBe(0);
    expect(out).toEqual([VERSION]);
    expect(VERSION).toBe(pkg.version);
    expect(err).toEqual([]);
  });

  test("relay and unknown commands report usage errors", async () => {
    const { code, out, err } = await capture(["relay"]);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: usage: app relay status [--json]", 'run "app help" for usage']);

    const unknown = await capture(["nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toEqual([]);
    expect(unknown.err).toEqual(["error: unknown command: nope", 'run "app help" for usage']);
  });

  test("serve rejects bad flags before starting a server", async () => {
    for (const argv of [
      ["serve", "--bad"],
      ["serve", "--port"],
      ["serve", "--port", "0"],
      ["serve", "--port", "abc"],
      ["serve", "--hostname"],
      ["serve", "--hostname", "http://local"],
      ["serve", "--hostname", "a b"],
    ]) {
      const { code, out, err } = await capture(argv);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err[0]).toContain("error:");
    }
  });

  test("device requires the probe subcommand", async () => {
    const missing = await capture(["device"]);
    expect(missing.code).toBe(2);
    expect(missing.out).toEqual([]);
    expect(missing.err[0]).toContain("usage: app device probe");

    const unknown = await capture(["device", "counts"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toEqual([
      "error: unknown device command: counts",
      'run "app help" for usage',
    ]);
  });

  test("bad flags are usage errors, including JSON errors on stderr", async () => {
    const human = await capture(["sync", "--bad"]);
    expect(human.code).toBe(2);
    expect(human.out).toEqual([]);
    expect(human.err).toEqual(["error: unexpected argument: --bad", 'run "app help" for usage']);

    const json = await capture(["sync", "--json", "--bad"]);
    expect(json.code).toBe(2);
    expect(json.out).toEqual([]);
    expect(json.err).toEqual([
      JSON.stringify({
        error: { code: "INVALID_ARGS", message: "unexpected argument: --bad" },
      }),
    ]);
  });
});

const SEED_EMPLOYEES = [{ idNumber: "00123", name: "Dummy Budi" }];
const SEED_PUNCHES = [
  { idNumber: "00123", date: "2026-10-05", time: "07:00:00" },
  { idNumber: "00123", date: "2026-10-05", time: "16:00:00" },
  { idNumber: "00123", date: "2026-10-06", time: "07:05:00" },
  { idNumber: "00123", date: "2026-10-06", time: "15:00:00" },
];

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const VIEWER_TOKEN = "cli-viewer-token";
const VIEWER_CALENDAR = {
  version: 1,
  base: {
    MONDAY: { in: "07:00", out: "16:00" },
    TUESDAY: { in: "07:00", out: "16:00" },
    WEDNESDAY: { in: "07:00", out: "16:00" },
    THURSDAY: { in: "07:00", out: "16:00" },
    FRIDAY: { in: "07:00", out: "16:00" },
    SATURDAY: { in: "07:00", out: "12:00" },
    SUNDAY: null,
  },
  overrides: [],
};

function startFakeRelay() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${VIEWER_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      const data =
        url.pathname === "/relay/v1/employees"
          ? [
              {
                id_number: "00123",
                name: "Dummy Budi",
                card: 0,
                group_id: "",
                privilege: 0,
                device_uid: 1,
              },
            ]
          : url.pathname === "/relay/v1/attendance"
            ? [
                {
                  id_number: "00123",
                  date: "2026-10-05",
                  time: "07:00:00",
                  punch: 0,
                  verify: 1,
                },
                {
                  id_number: "00123",
                  date: "2026-10-05",
                  time: "16:00:00",
                  punch: 1,
                  verify: 1,
                },
                {
                  id_number: "00123",
                  date: "2026-10-06",
                  time: "07:05:00",
                  punch: 0,
                  verify: 1,
                },
                {
                  id_number: "00123",
                  date: "2026-10-06",
                  time: "15:00:00",
                  punch: 1,
                  verify: 1,
                },
              ]
            : url.pathname === "/relay/v1/schedule"
              ? VIEWER_CALENDAR
              : url.pathname === "/relay/v1/meta"
                ? {
                    app_version: "9.9.9",
                    schema_version: 5,
                    last_sync: {
                      at: "2026-10-22T09:01:00+07:00",
                      ok: true,
                      users: 1,
                      records: 4,
                      duration_ms: 60000,
                      first_date: "2026-10-05",
                      last_date: "2026-10-06",
                      error: null,
                    },
                    counts: { employees: 1, attendance: 4 },
                  }
                : null;
      if (data === null) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

function tempDbPath(name: string): string {
  return join(tmpdir(), `rekap-cli-${process.pid}-${name}.sqlite`);
}

function removeDb(path: string): void {
  // Windows keeps the SQLite files locked until the closed handle is collected, so a
  // failed removal is ignored; the files live in the OS temp directory.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("cli export", () => {
  // Creating a SQLite file costs 1-4 s on this machine, so the tests share one file
  // and get a generous timeout. The empty case reuses the same file with an empty month.
  const dbPath = tempDbPath("shared");
  const excelPath = join(tmpdir(), `rekap-cli-${process.pid}.xlsx`);
  const allPath = join(tmpdir(), `rekap-cli-all-${process.pid}.xlsx`);
  const emptyPath = join(tmpdir(), `rekap-cli-empty-${process.pid}.xlsx`);

  const env = {
    ABSEN_DB: dbPath,
    ABSEN_ENV: "test",
    ABSEN_SCHEDULE_FILE: join(tmpdir(), `rekap-cli-missing-${process.pid}.json`),
    ABSEN_SCHEDULE_IN: "07:00",
    ABSEN_SCHEDULE_OUT: "16:00",
  };

  test("--json writes only the envelope to stdout", async () => {
    seedDb(dbPath, SEED_EMPLOYEES, SEED_PUNCHES);

    const { code, out, err } = await withEnv(env, () =>
      capture(["export", "--for-month", "2026-10", "--json"]),
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.length).toBe(1);

    const envelope = JSON.parse(out[0]!) as { data: unknown[]; meta: Record<string, unknown> };
    expect(envelope.meta).toEqual({
      month: "2026-10",
      from: "2026-10-01",
      to: "2026-10-31",
      total: 2,
      page: 1,
      per_page: 2,
      total_pages: 1,
    });
    expect(envelope.data).toEqual([
      {
        date: "2026-10-05",
        id_number: "00123",
        name: "Dummy Budi",
        in_time: "07:00:00",
        out_time: "16:00:00",
        late_minutes: 0,
        early_minutes: 0,
        status: "lengkap",
        punches: 2,
      },
      {
        date: "2026-10-06",
        id_number: "00123",
        name: "Dummy Budi",
        in_time: "07:05:00",
        out_time: "15:00:00",
        late_minutes: 5,
        early_minutes: 60,
        status: "telat",
        punches: 2,
      },
    ]);
  }, 30_000);

  test("--excel writes the recap package by default", async () => {
    const { code, out, err } = await withEnv(env, () =>
      capture(["export", "--for-month", "2026-10", "--excel", "--out", excelPath]),
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toContain("export ok:");
    expect(existsSync(excelPath)).toBe(true);
    expect(readFile(excelPath).SheetNames).toEqual(["Masuk", "Pulang"]);
  }, 30_000);

  test("--excel --mode raw,recap,user,poin combines the four modes", async () => {
    const { code, out, err } = await withEnv(env, () =>
      capture([
        "export",
        "--for-month",
        "2026-10",
        "--excel",
        "--mode",
        "raw,recap,user,poin",
        "--out",
        allPath,
      ]),
    );

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toContain("(5 sheets)");
    expect(readFile(allPath).SheetNames).toEqual([
      "Raw",
      "Masuk",
      "Pulang",
      "00123 - Dummy Budi",
      "00123 - Dummy Budi (poin)",
    ]);
  }, 30_000);

  test("--excel without rows is NO_DATA and writes no file", async () => {
    const { code, out, err } = await withEnv(env, () =>
      capture(["export", "--for-month", "2026-09", "--excel", "--out", emptyPath]),
    );

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("NO_DATA");
    expect(existsSync(emptyPath)).toBe(false);
  }, 30_000);

  test("usage errors are exit 2 and never touch the database", async () => {
    const noFormat = await capture(["export", "--for-month", "2026-10"]);
    expect(noFormat.code).toBe(2);
    expect(noFormat.out).toEqual([]);
    expect(noFormat.err[0]).toContain("one of --json or --excel is required");

    const bothFormats = await capture(["export", "--for-month", "2026-10", "--json", "--excel"]);
    expect(bothFormats.code).toBe(2);
    expect(bothFormats.err[0]).toContain("--json cannot be combined with --excel");

    const noPeriod = await capture(["export", "--json"]);
    expect(noPeriod.code).toBe(2);
    expect(noPeriod.err[0]).toContain("exactly one of --for-month or --from/--to is required");

    const modeWithJson = await capture([
      "export",
      "--for-month",
      "2026-10",
      "--json",
      "--mode",
      "raw",
    ]);
    expect(modeWithJson.code).toBe(2);
    expect(modeWithJson.err[0]).toContain("--mode can only be used with --excel");

    const badMode = await capture(["export", "--for-month", "2026-10", "--excel", "--mode", "pdf"]);
    expect(badMode.code).toBe(2);
    expect(badMode.err[0]).toContain("--mode must be a comma list of raw|recap|user|poin: pdf");

    const userWithoutMode = await capture([
      "export",
      "--for-month",
      "2026-10",
      "--excel",
      "--user",
      "00123",
    ]);
    expect(userWithoutMode.code).toBe(2);
    expect(userWithoutMode.err[0]).toContain("--user with --excel requires --mode user or poin");

    const jsonError = await capture(["export", "--json", "--for-month", "2026-13"]);
    expect(jsonError.code).toBe(2);
    expect(jsonError.out).toEqual([]);
    expect(JSON.parse(jsonError.err[0]!)).toEqual({
      error: { code: "INVALID_ARGS", message: "--for-month must be YYYY-MM: 2026-13" },
    });

    const yearZero = await capture(["export", "--json", "--for-month", "0000-02"]);
    expect(yearZero.code).toBe(2);
    expect(yearZero.out).toEqual([]);
    expect(JSON.parse(yearZero.err[0]!)).toEqual({
      error: { code: "INVALID_ARGS", message: "--for-month must be YYYY-MM: 0000-02" },
    });
  });

  afterAll(() => {
    removeDb(dbPath);
    rmSync(excelPath, { force: true });
    rmSync(allPath, { force: true });
    rmSync(emptyPath, { force: true });
  });
});

describe("cli employees", () => {
  const dbPath = tempDbPath("employees");
  const env = {
    ABSEN_DB: dbPath,
    ABSEN_ENV: "test",
    ABSEN_SCHEDULE_FILE: join(tmpdir(), `rekap-cli-missing-${process.pid}.json`),
    ABSEN_SCHEDULE_IN: "07:00",
    ABSEN_SCHEDULE_OUT: "16:00",
  };

  test("list shows defaults and a partial update persists", async () => {
    seedDb(dbPath, SEED_EMPLOYEES, SEED_PUNCHES);

    const list = await withEnv(env, () => capture(["employees", "list", "--json"]));
    expect(list.code).toBe(0);
    expect(list.err).toEqual([]);
    const before = JSON.parse(list.out[0]!) as {
      data: Array<Record<string, unknown>>;
      meta: { total: number };
    };
    expect(before.meta.total).toBe(1);
    expect(before.data[0]).toMatchObject({
      id_number: "00123",
      device_name: "Dummy Budi",
      display_name: null,
      name: "Dummy Budi",
      active: true,
    });

    const update = await withEnv(env, () =>
      capture([
        "employees",
        "update",
        "--json",
        "--id",
        "00123",
        "--display-name",
        "Budi Santoso",
        "--prefix-title",
        "H.",
        "--suffix-title",
        ", S.Kom",
        "--active",
        "false",
      ]),
    );
    expect(update.code).toBe(0);
    expect(update.err).toEqual([]);
    expect(JSON.parse(update.out[0]!)).toMatchObject({
      data: {
        id_number: "00123",
        device_name: "Dummy Budi",
        display_name: "Budi Santoso",
        prefix_title: "H.",
        suffix_title: ", S.Kom",
        name: "H. Budi Santoso, S.Kom",
        active: false,
      },
    });

    const partial = await withEnv(env, () =>
      capture(["employees", "update", "--json", "--id", "00123", "--prefix-title", "Dr."]),
    );
    expect(partial.code).toBe(0);
    const saved = JSON.parse(partial.out[0]!) as { data: Record<string, unknown> };
    expect(saved.data).toMatchObject({
      display_name: "Budi Santoso",
      name: "Dr. Budi Santoso, S.Kom",
      active: false,
    });
  }, 30_000);

  test("inactive employees leave the recap unless named explicitly", async () => {
    const json = await withEnv(env, () => capture(["export", "--for-month", "2026-10", "--json"]));
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.out[0]!) as { data: unknown[]; meta: { total: number } };
    expect(envelope.data).toEqual([]);
    expect(envelope.meta.total).toBe(0);

    const explicit = await withEnv(env, () =>
      capture(["export", "--for-month", "2026-10", "--json", "--user", "00123"]),
    );
    expect(explicit.code).toBe(0);
    const included = JSON.parse(explicit.out[0]!) as {
      data: Array<{ name: string }>;
      meta: { total: number };
    };
    expect(included.meta.total).toBe(2);
    expect(included.data[0]?.name).toBe("Dr. Budi Santoso, S.Kom");
  }, 30_000);

  test("argument errors exit 2 and unknown IDs exit 1", async () => {
    const noId = await withEnv(env, () => capture(["employees", "update", "--active", "false"]));
    expect(noId.code).toBe(2);
    expect(noId.err[0]).toContain("--id is required");

    const noChange = await withEnv(env, () => capture(["employees", "update", "--id", "00123"]));
    expect(noChange.code).toBe(2);
    expect(noChange.err[0]).toContain("no changes");

    const badActive = await withEnv(env, () =>
      capture(["employees", "update", "--id", "00123", "--active", "yes"]),
    );
    expect(badActive.code).toBe(2);
    expect(badActive.err[0]).toContain("--active must be true|false");

    const missing = await withEnv(env, () =>
      capture(["employees", "update", "--id", "404", "--active", "false"]),
    );
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toContain("employee not found: 404");

    const unknown = await withEnv(env, () => capture(["employees", "nope"]));
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toContain("unknown employees command: nope");
  }, 30_000);

  afterAll(() => removeDb(dbPath));
});

describe("cli users", () => {
  const dbPath = tempDbPath("users");
  const env = {
    ABSEN_DB: dbPath,
    ABSEN_ENV: "test",
    ABSEN_SCHEDULE_FILE: join(tmpdir(), `rekap-cli-missing-${process.pid}.json`),
    ABSEN_SCHEDULE_IN: "07:00",
    ABSEN_SCHEDULE_OUT: "16:00",
  };

  test("creates, lists, rotates, and deletes an employee account", async () => {
    seedDb(dbPath, SEED_EMPLOYEES, SEED_PUNCHES);

    const empty = await withEnv(env, () => capture(["users", "list", "--json"]));
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out[0]!)).toEqual({ data: [] });

    const created = await withEnv(env, () =>
      capture([
        "users",
        "set-password",
        "--json",
        "--username",
        "budi",
        "--employee-id",
        "00123",
        "--password",
        "karyawan-1",
      ]),
    );
    expect(created.code).toBe(0);
    expect(created.err).toEqual([]);
    expect(JSON.parse(created.out[0]!)).toEqual({
      data: { username: "budi", role: "employee", employee_id_number: "00123" },
    });

    const list = await withEnv(env, () => capture(["users", "list", "--json"]));
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.out[0]!) as {
      data: Array<{ username: string; role: string; employee_id_number: string }>;
    };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      username: "budi",
      role: "employee",
      employee_id_number: "00123",
    });

    const db = openDb(dbPath, "test");
    try {
      const user = db.getAppUserByUsername("budi");
      expect(user === null).toBe(false);
      expect(await Bun.password.verify("karyawan-1", user!.passwordHash)).toBe(true);
    } finally {
      db.close();
    }

    const rotated = await withEnv(env, () =>
      capture([
        "users",
        "set-password",
        "--json",
        "--username",
        "budi",
        "--employee-id",
        "00123",
        "--password",
        "karyawan-2",
      ]),
    );
    expect(rotated.code).toBe(0);

    const deleted = await withEnv(env, () =>
      capture(["users", "delete", "--json", "--username", "budi"]),
    );
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.out[0]!)).toEqual({ data: { ok: true, username: "budi" } });

    const gone = await withEnv(env, () => capture(["users", "delete", "--username", "budi"]));
    expect(gone.code).toBe(1);
    expect(gone.err[0]).toContain("user not found: budi");
  }, 60_000);

  test("defaults the username to the PIN and keeps it on reset", async () => {
    const path = tempDbPath("users-default");
    seedDb(path, SEED_EMPLOYEES, SEED_PUNCHES);
    const local = { ...env, ABSEN_DB: path };
    try {
      const created = await withEnv(local, () =>
        capture([
          "users",
          "set-password",
          "--json",
          "--employee-id",
          "00123",
          "--password",
          "karyawan-1",
        ]),
      );
      expect(created.code).toBe(0);
      expect(JSON.parse(created.out[0]!)).toEqual({
        data: { username: "00123", role: "employee", employee_id_number: "00123" },
      });

      // A reset without --username reuses it instead of adding a second row.
      const reset = await withEnv(local, () =>
        capture([
          "users",
          "set-password",
          "--json",
          "--employee-id",
          "00123",
          "--password",
          "karyawan-2",
        ]),
      );
      expect(reset.code).toBe(0);
      expect((JSON.parse(reset.out[0]!) as { data: { username: string } }).data.username).toBe(
        "00123",
      );

      const db = openDb(path, "test");
      try {
        expect(db.listAppUsers()).toHaveLength(1);
        const user = db.getAppUserByUsername("00123");
        expect(await Bun.password.verify("karyawan-2", user!.passwordHash)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      removeDb(path);
    }
  }, 60_000);

  test("argument and lookup errors use exit 2 and exit 1", async () => {
    const noId = await withEnv(env, () =>
      capture(["users", "set-password", "--username", "x", "--password", "karyawan-1"]),
    );
    expect(noId.code).toBe(2);
    expect(noId.err[0]).toContain("--employee-id is required");

    const noPassword = await withEnv(env, () =>
      capture(["users", "set-password", "--username", "x", "--employee-id", "00123"]),
    );
    expect(noPassword.code).toBe(2);
    expect(noPassword.err[0]).toContain("--password is required");

    const short = await withEnv(env, () =>
      capture([
        "users",
        "set-password",
        "--username",
        "x",
        "--employee-id",
        "00123",
        "--password",
        "short",
      ]),
    );
    expect(short.code).toBe(2);
    expect(short.err[0]).toContain("at least 8 characters");

    const missing = await withEnv(env, () =>
      capture([
        "users",
        "set-password",
        "--username",
        "x",
        "--employee-id",
        "404",
        "--password",
        "karyawan-1",
      ]),
    );
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toContain("employee not found: 404");

    const unknown = await withEnv(env, () => capture(["users", "nope"]));
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toContain("unknown users command: nope");
  }, 60_000);

  afterAll(() => removeDb(dbPath));
});

describe("cli viewer", () => {
  const viewerEnv = (base: string) => ({
    ABSEN_ROLE: "viewer",
    ABSEN_RELAY_URL: base,
    ABSEN_RELAY_TOKEN: VIEWER_TOKEN,
    ABSEN_DB: tempDbPath("viewer-should-not-open"),
    ABSEN_ENV: "test",
    ABSEN_ZK_HOST: undefined,
    ABSEN_RELAY_ENABLED: undefined,
  });

  test("blocks collector-only commands before touching a DB or device", async () => {
    const relay = startFakeRelay();
    try {
      for (const argv of [
        ["sync", "--json"],
        ["device", "probe", "--json"],
        ["employees", "list", "--json"],
        ["admin", "reset-password", "--json"],
      ]) {
        const { code, out, err } = await withEnv(viewerEnv(relay.base), () => capture(argv));
        expect(code).toBe(2);
        expect(out).toEqual([]);
        expect(JSON.parse(err[0]!).error.code).toBe("READ_ONLY_VIEWER");
      }
    } finally {
      relay.stop();
    }
  });

  test("exports the collector data without a local DB", async () => {
    const relay = startFakeRelay();
    try {
      const { code, out, err } = await withEnv(viewerEnv(relay.base), () =>
        capture(["export", "--for-month", "2026-10", "--json"]),
      );
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const envelope = JSON.parse(out[0]!) as {
        data: Array<{ date: string; id_number: string; status: string }>;
        meta: { total: number };
      };
      expect(envelope.meta.total).toBe(2);
      expect(envelope.data).toEqual([
        expect.objectContaining({ date: "2026-10-05", id_number: "00123", status: "lengkap" }),
        expect.objectContaining({ date: "2026-10-06", id_number: "00123", status: "telat" }),
      ]);
    } finally {
      relay.stop();
    }
  });

  test("relay status reports viewer and collector modes without the token", async () => {
    const relay = startFakeRelay();
    try {
      const viewer = await withEnv(viewerEnv(relay.base), () =>
        capture(["relay", "status", "--json"]),
      );
      expect(viewer.code).toBe(0);
      expect(viewer.err).toEqual([]);
      expect(JSON.parse(viewer.out[0]!)).toMatchObject({
        data: {
          role: "viewer",
          relay_url: relay.base,
          reachable: true,
          schema_version: 5,
          counts: { employees: 1, attendance: 4 },
        },
      });
      expect(viewer.out[0]).not.toContain(VIEWER_TOKEN);

      const disabled = await withEnv(
        {
          ABSEN_ROLE: "collector",
          ABSEN_RELAY_ENABLED: undefined,
          ABSEN_RELAY_URL: undefined,
        },
        () => capture(["relay", "status", "--json"]),
      );
      expect(disabled.code).toBe(0);
      expect(JSON.parse(disabled.out[0]!)).toEqual({
        data: {
          role: "collector",
          relay_enabled: false,
          relay_url: null,
          reachable: null,
        },
      });

      const collector = await withEnv(
        {
          ABSEN_ROLE: "collector",
          ABSEN_RELAY_ENABLED: "true",
          ABSEN_RELAY_HOST: "127.0.0.1",
          ABSEN_RELAY_PORT: String(relay.port),
          ABSEN_RELAY_TOKEN: VIEWER_TOKEN,
          ABSEN_RELAY_URL: undefined,
        },
        () => capture(["relay", "status", "--json"]),
      );
      expect(collector.code).toBe(0);
      expect(JSON.parse(collector.out[0]!)).toMatchObject({
        data: {
          role: "collector",
          relay_enabled: true,
          reachable: true,
          counts: { employees: 1, attendance: 4 },
        },
      });
      expect(collector.out[0]).not.toContain(VIEWER_TOKEN);
    } finally {
      relay.stop();
    }
  });

  test("relay status exits 1 when the collector is unreachable", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("down", { status: 500 }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    server.stop(true);
    const { code, out, err } = await withEnv(viewerEnv(base), () =>
      capture(["relay", "status", "--json"]),
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0]!).error.code).toBe("RELAY_UNAVAILABLE");
  });
});

describe("cli admin", () => {
  test("reset-password clears the DB hash with JSON output", async () => {
    const dbPath = tempDbPath("admin-reset");
    removeDb(dbPath);
    const db = openDb(dbPath, "test");
    db.saveAdminPasswordHash("hash", "2026-10-22T07:00:00+07:00");
    db.close();

    const env = { ABSEN_DB: dbPath, ABSEN_ENV: "test" };
    const { code, out, err } = await withEnv(env, () =>
      capture(["admin", "reset-password", "--json"]),
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toEqual({ data: { ok: true, cleared: true } });

    const reopened = openDb(dbPath, "test");
    expect(reopened.getAdminPasswordHash()).toBeNull();
    reopened.close();
    removeDb(dbPath);
  }, 30_000);
});
