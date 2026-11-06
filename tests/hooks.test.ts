// Hooks are pure rules plus one fire-and-forget dispatcher. Every test here
// uses an in-memory DB and a fake fetch: no network, no device.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { openMemoryDb, type Db } from "../src/db.ts";
import type { DeviceGateway } from "../src/device.ts";
import {
  dispatchEvents,
  HookError,
  parseWebhookInput,
  sendTestEvent,
  signPayload,
  webhookSubscribes,
  type FetchLike,
} from "../src/hooks.ts";
import { syncNow } from "../src/sync.ts";
import { FakeDevice, type DeviceAttendance, type DeviceUser } from "./support/fake-device.ts";

const SYNCED_AT = "2026-11-05T07:00:00+07:00";

const USERS: DeviceUser[] = [
  { uid: 1, idNumber: "992", name: "Dummy Siti", privilege: 0, card: 0, groupId: "1" },
];

const BASE: DeviceAttendance[] = [
  {
    uid: 1,
    idNumber: "992",
    name: "Dummy Siti",
    date: "2026-11-05",
    time: "07:15:00",
    punch: 0,
    verify: 15,
  },
];

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(result: { ok?: boolean; status?: number; throws?: Error } = {}): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      if (result.throws !== undefined) throw result.throws;
      return { ok: result.ok ?? true, status: result.status ?? 200 };
    },
  };
}

let db: Db;

beforeEach(() => {
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
});

describe("webhook input", () => {
  test("accepts http and https and defaults to every event", () => {
    const draft = parseWebhookInput({ url: "https://bot.example.com/hook" });
    expect(draft).toEqual({
      url: "https://bot.example.com/hook",
      events: "attendance.changed,sync.done,sync.failed",
      enabled: true,
    });
  });

  test("accepts a LAN or ZeroTier address", () => {
    expect(parseWebhookInput({ url: "http://10.147.17.5:8080/hook" }).url).toContain("10.147.17.5");
    expect(parseWebhookInput({ url: "http://192.168.1.20/hook" }).url).toContain("192.168.1.20");
  });

  test("rejects loopback, link-local, and non-http schemes", () => {
    for (const url of [
      "http://127.0.0.1/hook",
      "http://127.5.5.5/hook",
      "http://localhost/hook",
      "http://app.localhost/hook",
      "http://169.254.169.254/latest",
      "http://[::1]/hook",
      "http://0.0.0.0/hook",
      "ftp://bot.example.com/hook",
    ]) {
      expect(() => parseWebhookInput({ url })).toThrow(HookError);
    }
  });

  test("rejects credentials in the URL and unknown events", () => {
    expect(() => parseWebhookInput({ url: "https://user:pw@bot.example.com/hook" })).toThrow(
      HookError,
    );
    expect(() =>
      parseWebhookInput({ url: "https://bot.example.com/hook", events: ["sync.done", "nope"] }),
    ).toThrow(HookError);
    expect(() => parseWebhookInput({ url: "https://bot.example.com/hook", events: [] })).toThrow(
      HookError,
    );
  });

  test("dedupes events and reads a subscription list", () => {
    const draft = parseWebhookInput({
      url: "https://bot.example.com/hook",
      events: ["sync.done", "sync.done", "sync.failed"],
    });
    expect(draft.events).toBe("sync.done,sync.failed");
    expect(webhookSubscribes(draft.events, "sync.done")).toBe(true);
    expect(webhookSubscribes(draft.events, "attendance.changed")).toBe(false);
  });
});

describe("signature", () => {
  test("is a deterministic sha256 HMAC of the raw body", () => {
    const body = JSON.stringify({ a: 1 });
    expect(signPayload("secret", body)).toBe(
      "sha256=" + createHmac("sha256", "secret").update(body).digest("hex"),
    );
    expect(signPayload("secret", body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("secret", body)).not.toBe(signPayload("other", body));
  });
});

describe("dispatchEvents", () => {
  function insertEvent(event: string, data: Record<string, unknown>): number {
    return db.insertEvent({ event, at: SYNCED_AT, payload: JSON.stringify(data) });
  }

  function addHook(events: string, url = "https://bot.example.com/hook"): number {
    return db.insertWebhook({
      url,
      secret: "secret",
      events,
      enabled: true,
      createdAt: SYNCED_AT,
    });
  }

  test("posts to a subscribed webhook and marks the event delivered", async () => {
    addHook("sync.done");
    const id = insertEvent("sync.done", { records: 5 });
    const fake = fakeFetch();

    await dispatchEvents({ db, fetch: fake.fetch });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.headers["x-rekap-event"]).toBe("sync.done");
    expect(call.headers["x-rekap-signature"]).toBe(signPayload("secret", call.body));
    expect(JSON.parse(call.body)).toMatchObject({ id, event: "sync.done", data: { records: 5 } });

    const [row] = db.listEvents({ since: 0, limit: 10 });
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.attempts).toBe(0);
  });

  test("skips a webhook that is not subscribed", async () => {
    addHook("sync.failed");
    insertEvent("sync.done", { records: 5 });
    const fake = fakeFetch();

    await dispatchEvents({ db, fetch: fake.fetch });

    expect(fake.calls).toHaveLength(0);
    // No subscriber means nothing to deliver, so the backlog stays empty.
    expect(db.listEvents({ since: 0, limit: 10 })[0]?.deliveredAt).not.toBeNull();
  });

  test("skips a disabled webhook", async () => {
    const id = addHook("sync.done");
    db.updateWebhook(id, { enabled: false });
    insertEvent("sync.done", { records: 5 });
    const fake = fakeFetch();

    await dispatchEvents({ db, fetch: fake.fetch });

    expect(fake.calls).toHaveLength(0);
  });

  test("records a failure once and never retries it", async () => {
    addHook("sync.done");
    insertEvent("sync.done", { records: 5 });
    const fake = fakeFetch({ ok: false, status: 500 });

    await dispatchEvents({ db, fetch: fake.fetch });
    await dispatchEvents({ db, fetch: fake.fetch });

    // Exactly one attempt across two dispatches.
    expect(fake.calls).toHaveLength(1);
    const [row] = db.listEvents({ since: 0, limit: 10 });
    expect(row?.deliveredAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("HTTP 500");
  });

  test("a throwing fetch is captured, not propagated", async () => {
    addHook("sync.done");
    insertEvent("sync.done", { records: 5 });
    const fake = fakeFetch({ throws: new Error("ECONNREFUSED") });

    await expect(dispatchEvents({ db, fetch: fake.fetch })).resolves.toBeUndefined();

    expect(db.listEvents({ since: 0, limit: 10 })[0]?.lastError).toBe("ECONNREFUSED");
  });

  test("never throws when the store itself fails", async () => {
    const broken = {
      ...db,
      listUndeliveredEvents: () => {
        throw new Error("db gone");
      },
    } as unknown as Db;
    await expect(dispatchEvents({ db: broken, fetch: fakeFetch().fetch })).resolves.toBeUndefined();
  });

  test("a batch larger than the page is drained across calls", async () => {
    addHook("sync.done");
    for (let index = 0; index < 60; index++) insertEvent("sync.done", { n: index });
    const fake = fakeFetch();

    await dispatchEvents({ db, fetch: fake.fetch });
    expect(fake.calls).toHaveLength(50);
    await dispatchEvents({ db, fetch: fake.fetch });
    expect(fake.calls).toHaveLength(60);
  });

  test("sendTestEvent posts once and reports the receiver status", async () => {
    const fake = fakeFetch({ ok: false, status: 404 });
    const result = await sendTestEvent({
      webhook: { url: "https://bot.example.com/hook", secret: "secret" },
      fetch: fake.fetch,
    });

    expect(result).toEqual({ ok: false, status: 404, error: "HTTP 404" });
    expect(fake.calls[0]?.headers["x-rekap-event"]).toBe("test.ping");
  });
});

describe("sync events", () => {
  test("a first sync writes attendance.changed and sync.done", async () => {
    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    await syncNow({ device: fake as unknown as DeviceGateway, db });

    const events = db.listEvents({ since: 0, limit: 10 });
    expect(events.map((row) => row.event)).toEqual(["attendance.changed", "sync.done"]);

    const changed = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(changed).toMatchObject({ inserted: 1, records: 1, users: 1, from: "2026-11-05" });
    // Thin payload: no names, no PINs, no comm key.
    expect(events[0]!.payload).not.toContain("Dummy Siti");
    expect(events[0]!.payload).not.toContain("992");
  });

  test("a second identical sync writes sync.done only", async () => {
    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    const gateway = fake as unknown as DeviceGateway;
    await syncNow({ device: gateway, db });
    await syncNow({ device: gateway, db });

    const events = db.listEvents({ since: 0, limit: 10 });
    expect(events.map((row) => row.event)).toEqual([
      "attendance.changed",
      "sync.done",
      "sync.done",
    ]);
    expect(JSON.parse(events[2]!.payload)).toMatchObject({ inserted: 0 });
  });

  test("a failed sync writes sync.failed and still rethrows", async () => {
    const fake = new FakeDevice({
      users: USERS,
      attendance: BASE,
      failConnect: new Error("device offline"),
    });

    await expect(syncNow({ device: fake as unknown as DeviceGateway, db })).rejects.toThrow(
      "device offline",
    );

    const events = db.listEvents({ since: 0, limit: 10 });
    expect(events.map((row) => row.event)).toEqual(["sync.failed"]);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ error: "device offline" });
  });

  test("sync still succeeds when the event write fails", async () => {
    const broken = Object.create(db) as Db;
    broken.insertEvent = () => {
      throw new Error("events table gone");
    };

    const fake = new FakeDevice({ users: USERS, attendance: BASE });
    const result = await syncNow({ device: fake as unknown as DeviceGateway, db: broken });

    expect(result.ok).toBe(true);
    expect(db.lastSync()).toMatchObject({ ok: true });
  });
});
