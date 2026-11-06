// Hooks: a thin outbound event log plus webhook push.
//
// Sync only *writes* events to the DB. Dispatch is a separate, fire-and-forget
// step so a dead receiver can never stall a sync. There is no retry: a failed
// push stays visible as `last_error` on the event and the webhook, and any
// consumer can catch up with GET /api/v1/events?since=<id>. Payloads stay thin
// on purpose (counts and dates only) so a misconfigured receiver cannot leak
// employee data.

import { createHmac, randomBytes } from "node:crypto";
import type { EventRow, WebhookRow } from "./db.ts";
import { NOOP_LOGGER, type AppLogger } from "./log.ts";
import type { Awaitable } from "./store.ts";
import { stamp } from "./time.ts";

export const EVENT_NAMES = ["attendance.changed", "sync.done", "sync.failed"] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Synthetic event used by the "Kirim tes" button; never stored in `events`. */
export const TEST_EVENT = "test.ping";

export const WEBHOOK_TIMEOUT_MS = 5_000;
const DISPATCH_BATCH = 50;

export type HookErrorCode = "INVALID_URL" | "BLOCKED_URL" | "INVALID_EVENTS";

export class HookError extends Error {
  constructor(
    readonly code: HookErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "HookError";
  }
}

export interface WebhookDraft {
  url: string;
  events: string;
  enabled: boolean;
}

export interface DispatchStore {
  listUndeliveredEvents(limit: number): Awaitable<EventRow[]>;
  listWebhooks(): Awaitable<WebhookRow[]>;
  markEventDelivered(id: number, at: string): Awaitable<void>;
  markEventFailed(id: number, error: string): Awaitable<void>;
  recordWebhookAttempt(
    id: number,
    status: number | null,
    at: string,
    error: string | null,
  ): Awaitable<void>;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

// The admin already holds full access, but a webhook URL is still an
// attacker-influenced outbound request. Loopback and link-local targets are
// refused; LAN, ZeroTier, and public hosts stay allowed.
const BLOCKED_EXACT = new Set(["localhost", "0.0.0.0", "::", "::1", "[::1]", "[::]"]);

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_EXACT.has(host) || host.endsWith(".localhost")) return true;
  if (host.startsWith("127.") || host.startsWith("[::ffff:7f")) return true;
  if (host.startsWith("169.254.")) return true;
  return false;
}

function parseEvents(value: unknown): string {
  if (value === undefined || value === null) return EVENT_NAMES.join(",");

  const list = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !(EVENT_NAMES as readonly string[]).includes(entry)) {
      throw new HookError(
        "INVALID_EVENTS",
        `events must be a subset of ${EVENT_NAMES.join("|")}`,
        "events",
      );
    }
    if (!names.includes(entry)) names.push(entry);
  }
  if (names.length === 0) {
    throw new HookError("INVALID_EVENTS", "events must not be empty", "events");
  }
  return names.join(",");
}

export function parseWebhookInput(body: Record<string, unknown>): WebhookDraft {
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (rawUrl === "" || rawUrl.length > 2048) {
    throw new HookError("INVALID_URL", "url wajib diisi (maks 2048 karakter).", "url");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HookError("INVALID_URL", "url tidak valid.", "url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HookError("INVALID_URL", "url harus http atau https.", "url");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new HookError("INVALID_URL", "url tidak boleh memuat kredensial.", "url");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new HookError("BLOCKED_URL", "url mengarah ke alamat loopback/link-local.", "url");
  }

  return {
    url: parsed.toString(),
    events: parseEvents(body.events),
    enabled: body.enabled === undefined ? true : body.enabled === true,
  };
}

export function newWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

export function webhookEvents(events: string): string[] {
  return events
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

export function webhookSubscribes(events: string, name: string): boolean {
  return webhookEvents(events).includes(name);
}

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postOnce(
  fetchImpl: FetchLike,
  hook: { url: string; secret: string },
  event: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "absenly-hooks",
        "x-rekap-event": event,
        "x-rekap-signature": signPayload(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { ok: true, status: response.status, error: null }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: null, error: errorText(error) };
  }
}

/**
 * Push undelivered events to every subscribed, enabled webhook.
 *
 * Never throws and never retries. Outcome per event:
 * - delivered: every subscribed webhook accepted it;
 * - failed: `attempts` grows and `last_error` is set, so a consumer can catch
 *   up with `?since=`.
 * An event with no subscriber is marked delivered immediately, so the backlog
 * cannot grow while no webhook is configured.
 */
export async function dispatchEvents(deps: {
  db: DispatchStore;
  fetch?: FetchLike;
  logger?: AppLogger;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<void> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  try {
    const events = await deps.db.listUndeliveredEvents(DISPATCH_BATCH);
    if (events.length === 0) return;
    const hooks = (await deps.db.listWebhooks()).filter((hook) => hook.enabled);

    for (const event of events) {
      const at = stamp(now());
      const subscribed = hooks.filter((hook) => webhookSubscribes(hook.events, event.event));
      if (subscribed.length === 0) {
        await deps.db.markEventDelivered(event.id, at);
        continue;
      }

      const body = JSON.stringify({
        id: event.id,
        event: event.event,
        at: event.at,
        data: JSON.parse(event.payload) as unknown,
      });

      let failure: string | null = null;
      for (const hook of subscribed) {
        const result = await postOnce(fetchImpl, hook, event.event, body, timeoutMs);
        await deps.db.recordWebhookAttempt(hook.id, result.status, at, result.error);
        if (!result.ok) failure = result.error ?? "unknown error";
      }

      if (failure === null) await deps.db.markEventDelivered(event.id, at);
      else await deps.db.markEventFailed(event.id, failure);
    }
  } catch (error) {
    // Hooks must never break a sync or a request.
    logger.info(`hooks error: ${errorText(error)}`);
  }
}

/** One-off delivery for the "Kirim tes" button. Returns the receiver's status. */
export async function sendTestEvent(deps: {
  webhook: { url: string; secret: string };
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const body = JSON.stringify({
    id: 0,
    event: TEST_EVENT,
    at: stamp((deps.now ?? (() => new Date()))()),
    data: { message: "absenly webhook test" },
  });
  return postOnce(fetchImpl, deps.webhook, TEST_EVENT, body, deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
}
