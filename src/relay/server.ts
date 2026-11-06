// Collector relay: GET-only raw data on its own ZeroTier-bound listener.

import type { ScheduleCalendar } from "../schedule.ts";
import { dateRange, PeriodError } from "../period.ts";
import type { ReadFilter, ReadStore } from "../store.ts";
import { VERSION } from "../version.ts";
import { digestRelayToken, isRelayAuthorized } from "./auth.ts";
import {
  toRelayAttendanceDto,
  toRelayEmployeeDto,
  toRelayMetaDto,
  toRelaySnapshotDto,
} from "./dto.ts";

export interface RelayListener {
  host: string;
  port: number;
  token: string;
}

export interface RelayServerOptions {
  relay: RelayListener;
  store: ReadStore;
  getCalendar: () => ScheduleCalendar;
  version?: string;
}

function jsonResponse(data: unknown, status = 200, allow?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(JSON.stringify({ data }), { status, headers });
}

function errorResponse(status: number, code: string, message: string, allow?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function parseFilter(url: URL): ReadFilter {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const range = dateRange(from, to);
  const employee = url.searchParams.get("employee_id")?.trim();
  return employee === undefined || employee === "" ? range : { ...range, idNumber: employee };
}

export function startRelayServer({
  relay,
  store,
  getCalendar,
  version = VERSION,
}: RelayServerOptions) {
  if (relay.host === "0.0.0.0" || relay.host === "::") {
    throw new Error("relay host must be a specific tunnel address");
  }
  const expectedDigest = digestRelayToken(relay.token);

  const server = Bun.serve({
    hostname: relay.host,
    port: relay.port,
    idleTimeout: 30,
    fetch(request) {
      const url = new URL(request.url);

      if (!isRelayAuthorized(request.headers.get("authorization"), expectedDigest)) {
        return errorResponse(401, "UNAUTHORIZED", "Missing or invalid relay token.");
      }
      if (request.method !== "GET") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Relay is read-only.", "GET");
      }

      try {
        switch (url.pathname) {
          case "/relay/v1/meta": {
            return jsonResponse(
              toRelayMetaDto(store.lastSync(), store.schemaVersion, store.counts(), version),
            );
          }
          case "/relay/v1/employees": {
            const profiles = new Map(
              store.listEmployeeProfiles().map((profile) => [profile.idNumber, profile]),
            );
            return jsonResponse(
              store
                .listEmployees()
                .map((row) => toRelayEmployeeDto(row, profiles.get(row.idNumber))),
            );
          }
          case "/relay/v1/schedule": {
            return jsonResponse(getCalendar());
          }
          case "/relay/v1/attendance": {
            const filter = parseFilter(url);
            return jsonResponse(store.listRawAttendance(filter).map(toRelayAttendanceDto));
          }
          case "/relay/v1/snapshot": {
            const filter = parseFilter(url);
            return jsonResponse(toRelaySnapshotDto(store.snapshot(filter), getCalendar(), version));
          }
          default:
            return errorResponse(404, "NOT_FOUND", "Relay route not found.");
        }
      } catch (error) {
        if (error instanceof PeriodError) {
          return errorResponse(400, "INVALID_QUERY", error.message);
        }
        console.error("relay error:", error instanceof Error ? error.message : error);
        return errorResponse(500, "INTERNAL_ERROR", "Internal relay error.");
      }
    },
  });

  return {
    server,
    port: server.port,
    stop: () => server.stop(true),
  };
}
