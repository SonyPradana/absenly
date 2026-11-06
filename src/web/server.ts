// HTTP server: /api/v1 plus the admin web shell and its small write routes.

import { handleApi } from "../api/router.ts";
import { Auth } from "../auth.ts";
import type { WebConfig } from "../config.ts";
import { LoginThrottle } from "../login-throttle.ts";
import { RelayClientError } from "../relay/client.ts";
import type { ScheduleSource } from "../schedule-store.ts";
import type { AppStore } from "../store.ts";
import type { SyncRunner } from "../sync.ts";
import { VERSION } from "../version.ts";
import {
  handleWeb,
  renderErrorPage,
  renderNotFound,
  renderServerError,
  type ProbeResult,
  type WebContext,
  type WebStorageInfo,
} from "./routes.ts";

export interface ServeDevice {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface ServerOptions {
  web: WebConfig;
  db: AppStore;
  storage: WebStorageInfo;
  device: ServeDevice | null;
  schedule: ScheduleSource;
  sync: SyncRunner;
  probe: (() => Promise<ProbeResult>) | null;
  readOnly?: boolean;
  /** Viewer-only: refresh the remote schedule before data requests. */
  refresh?: () => Promise<void>;
  now?: () => Date;
}

function needsRefresh(path: string): boolean {
  if (path.startsWith("/assets/") || path === "/login" || path === "/logout") return false;
  if (path.startsWith("/api/v1/auth/")) return false;
  if (path === "/api/v1/health") return false;
  return true;
}

function relayErrorResponse(error: RelayClientError, api: boolean): Response {
  if (api) {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
      status: error.status,
      headers,
    });
  }
  return renderErrorPage(error.status, error.message);
}

export function startServer({
  web,
  db,
  storage,
  device,
  schedule,
  sync,
  probe,
  readOnly = false,
  refresh,
  now = () => new Date(),
}: ServerOptions) {
  const auth = new Auth({
    username: web.username,
    password: web.password,
    passwordHash: () => db.getAdminPasswordHash(),
    findUser: (username) => db.getAppUserByUsername(username),
  });
  const throttle = new LoginThrottle();

  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname: web.hostname,
    port: web.port,
    idleTimeout: 30,
    async fetch(request) {
      // Read an externally edited schedule before handling any request.
      schedule.reloadIfChanged();
      const url = new URL(request.url);
      const clientIp = server.requestIP(request)?.address ?? "unknown";
      const isApi = url.pathname.startsWith("/api/v1");

      try {
        if (refresh !== undefined && needsRefresh(url.pathname)) {
          try {
            await refresh();
          } catch (error) {
            if (error instanceof RelayClientError) return relayErrorResponse(error, isApi);
            throw error;
          }
        }

        const api = await handleApi(request, url, {
          db,
          auth,
          getCalendar: () => schedule.calendar,
          sync,
          readOnly,
          now,
          throttle,
          clientIp: () => clientIp,
        });
        if (api !== null) return api;

        const webContext: WebContext = {
          db,
          auth,
          schedule,
          web,
          storage,
          device,
          probe,
          readOnly,
          throttle,
          clientIp: () => clientIp,
          now,
          version: VERSION,
        };
        return (await handleWeb(request, url, webContext)) ?? renderNotFound();
      } catch (error) {
        if (error instanceof RelayClientError) return relayErrorResponse(error, isApi);
        console.error("server error:", error instanceof Error ? error.message : error);
        return renderServerError();
      }
    },
  });

  return {
    server,
    port: server.port,
    stop: () => server.stop(true),
  };
}
