import { describe, expect, test } from "bun:test";
import { RelayClientError, RelayReadStore, RelayScheduleStore } from "../src/relay/client.ts";
import type { ScheduleCalendar } from "../src/schedule.ts";

const TOKEN = "viewer-token";
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

const META = {
  app_version: "9.9.9",
  schema_version: 5,
  last_sync: {
    at: "2026-10-22T09:01:00+07:00",
    ok: true,
    users: 2,
    records: 3,
    duration_ms: 60000,
    first_date: "2026-10-20",
    last_date: "2026-10-21",
    error: null,
  },
  counts: { employees: 2, attendance: 3 },
};

const EMPLOYEES = [
  {
    id_number: "992",
    name: "Dummy Siti",
    card: 0,
    group_id: "1",
    privilege: 0,
    device_uid: 1,
  },
  {
    id_number: "993",
    name: "Dummy Budi",
    card: 0,
    group_id: "1",
    privilege: 0,
    device_uid: 2,
  },
];

const ATTENDANCE = [
  { id_number: "992", date: "2026-10-20", time: "07:28:34", punch: 0, verify: 15 },
  { id_number: "992", date: "2026-10-20", time: "16:05:00", punch: 1, verify: 15 },
];

function client(fetchImpl: typeof fetch, token = TOKEN): RelayReadStore {
  return new RelayReadStore({
    baseUrl: "http://collector.test",
    token,
    timeoutMs: 1000,
    fetch: fetchImpl,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: RelayClientError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("expected a RelayClientError");
  } catch (error) {
    expect(error).toBeInstanceOf(RelayClientError);
    expect((error as RelayClientError).code).toBe(code);
  }
}

describe("viewer relay client", () => {
  test("reads meta, employees, raw attendance, and schedule with the token", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (url.endsWith("/relay/v1/meta")) return jsonResponse(META);
      if (url.endsWith("/relay/v1/employees")) return jsonResponse(EMPLOYEES);
      if (url.includes("/relay/v1/attendance")) return jsonResponse(ATTENDANCE);
      if (url.endsWith("/relay/v1/schedule")) return jsonResponse(CALENDAR);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const relay = client(fetchImpl);
    expect(await relay.meta()).toEqual(META);
    expect((await relay.listEmployees()).map((row) => row.idNumber)).toEqual(["992", "993"]);
    expect(await relay.listRawAttendance({ from: "2026-10-20", to: "2026-10-20" })).toEqual([
      { idNumber: "992", date: "2026-10-20", time: "07:28:34", punch: 0, verify: 15 },
      { idNumber: "992", date: "2026-10-20", time: "16:05:00", punch: 1, verify: 15 },
    ]);
    expect(await relay.getSchedule()).toEqual(CALENDAR);

    const page = await relay.listAttendancePage({
      from: "2026-10-20",
      to: "2026-10-20",
      page: 1,
      perPage: 1,
    });
    expect(page.total).toBe(2);
    expect(page.rows[0]).toMatchObject({
      idNumber: "992",
      name: "Dummy Siti",
      status: "IN",
      rawPunch: 0,
    });

    const profiles = await relay.listEmployeeProfiles();
    expect(profiles.every((profile) => profile.active)).toBe(true);
    expect(await relay.counts()).toEqual({ employees: 2, attendance: 3 });
    expect(seen.length).toBeGreaterThan(0);
  });

  test("rejects writes and never caches rows", async () => {
    const relay = client((async () => jsonResponse(EMPLOYEES)) as unknown as typeof fetch);

    await expectCode(
      relay.insertWorkException(
        { idNumber: "992", kind: "overtime", date: "2026-10-20", endDate: "2026-10-20" } as never,
        "2026-10-22T09:00:00+07:00",
      ),
      "RELAY_READ_ONLY",
    );
    await expectCode(relay.deleteWorkException(1), "RELAY_READ_ONLY");
    await expectCode(relay.saveEmployeeProfile({} as never), "RELAY_READ_ONLY");
    await expectCode(relay.backupTo("x"), "RELAY_READ_ONLY");
    expect(await relay.getAdminPasswordHash()).toBeNull();
    expect(await relay.getShareLink("x")).toBeNull();
  });

  test("fails closed on auth, timeout, transport, malformed, and non-OK responses", async () => {
    const auth = client(
      (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    );
    await expectCode(auth.listEmployees(), "RELAY_AUTH");

    const timeout = client((async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch);
    await expectCode(timeout.listEmployees(), "RELAY_TIMEOUT");

    const down = client((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    await expectCode(down.listEmployees(), "RELAY_UNAVAILABLE");

    const malformed = client((async () => new Response("not json")) as unknown as typeof fetch);
    await expectCode(malformed.listEmployees(), "RELAY_BAD_RESPONSE");

    const badShape = client((async () => jsonResponse({ rows: [] })) as unknown as typeof fetch);
    await expectCode(badShape.listEmployees(), "RELAY_BAD_RESPONSE");

    const failed = client((async () => jsonResponse({}, 500)) as unknown as typeof fetch);
    await expectCode(failed.listEmployees(), "RELAY_UNAVAILABLE");
  });

  test("relay schedule store refreshes and is read-only", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/relay/v1/schedule")) return jsonResponse(CALENDAR);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const store = new RelayScheduleStore(client(fetchImpl));

    expect(() => store.calendar).toThrow();
    await store.refresh();
    expect(store.calendar).toEqual(CALENDAR);
    expect(store.reloadIfChanged()).toBe(false);
    expect(() => store.save()).toThrow();
  });
});
