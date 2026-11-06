// Config boundary: env/file -> validated per-capability config.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DbMode } from "./db.ts";
import {
  parseScheduleJson,
  scheduleFromEnv,
  ScheduleError,
  type ScheduleCalendar,
} from "./schedule.ts";

export const DEFAULT_SCHEDULE_FILE = "schedule.json";
export const DEFAULT_DB_PATH = "absen.sqlite";
export const DEFAULT_ZK_PORT = 4370;
export const DEFAULT_ZK_TIMEOUT_MS = 10_000;
export const DEFAULT_RELAY_PORT = 3100;
export const DEFAULT_RELAY_TIMEOUT_MS = 5_000;

export interface EnvConfigOptions {
  env?: Record<string, string | undefined>;
}

export interface LoadedScheduleConfig {
  calendar: ScheduleCalendar;
  source: "file" | "env";
  filePath: string | null;
}

export interface ScheduleConfigOptions extends EnvConfigOptions {
  cwd?: string;
  readFile?: (path: string) => string;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function loadScheduleConfig(options: ScheduleConfigOptions = {}): LoadedScheduleConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const configured = (env.ABSEN_SCHEDULE_FILE ?? "").trim(); // empty/whitespace = default
  const filePath = isAbsolute(configured || DEFAULT_SCHEDULE_FILE)
    ? configured || DEFAULT_SCHEDULE_FILE
    : resolve(cwd, configured || DEFAULT_SCHEDULE_FILE);

  let text: string;
  try {
    text = readFile(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        calendar: { version: 1, base: scheduleFromEnv(env), overrides: [] },
        source: "env",
        filePath: null,
      };
    }
    throw new ScheduleError(
      "SCHEDULE_READ",
      `tidak bisa membaca ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return { calendar: parseScheduleJson(text), source: "file", filePath };
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw new ScheduleError(error.code, `${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export type ConfigErrorCode =
  | "CONFIG_HOST"
  | "CONFIG_PORT"
  | "CONFIG_COMM_KEY"
  | "CONFIG_TIMEOUT"
  | "CONFIG_ENV"
  | "CONFIG_DB"
  | "CONFIG_WEB_USER"
  | "CONFIG_WEB_PASSWORD"
  | "CONFIG_WEB_PORT"
  | "CONFIG_HOSTNAME"
  | "CONFIG_ROLE"
  | "CONFIG_RELAY_ENABLED"
  | "CONFIG_RELAY_HOST"
  | "CONFIG_RELAY_PORT"
  | "CONFIG_RELAY_TOKEN"
  | "CONFIG_RELAY_URL"
  | "CONFIG_RELAY_TIMEOUT"
  | "CONFIG_RELAY_CHAIN"
  | "CONFIG_VIEWER_DEVICE";

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface DeviceConfig {
  host: string;
  port: number;
  commKey: number;
  timeoutMs: number;
}

export interface StorageConfig {
  dbPath: string;
  mode: DbMode;
}

export interface WebConfig {
  username: string;
  password: string;
  port: number;
  hostname: string;
}

export interface RelayConfig {
  enabled: boolean;
  host: string | null;
  port: number;
  token: string | null;
}

export type AppRole = "collector" | "viewer";

export interface ViewerRelayConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

function integerEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  code: ConfigErrorCode,
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(code, `${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(code, `${key} must be between ${min} and ${max}`);
  }
  return value;
}

export function loadStorageConfig(options: EnvConfigOptions = {}): StorageConfig {
  const env = options.env ?? process.env;

  const modeRaw = (env.ABSEN_ENV ?? "").trim() || "production";
  if (modeRaw !== "production" && modeRaw !== "staging" && modeRaw !== "test") {
    throw new ConfigError("CONFIG_ENV", "ABSEN_ENV must be production, staging, or test");
  }

  return {
    dbPath: (env.ABSEN_DB ?? "").trim() || DEFAULT_DB_PATH,
    mode: modeRaw,
  };
}

export function loadRoleConfig(options: EnvConfigOptions = {}): AppRole {
  const env = options.env ?? process.env;
  const raw = (env.ABSEN_ROLE ?? "").trim().toLowerCase() || "collector";
  if (raw !== "collector" && raw !== "viewer") {
    throw new ConfigError("CONFIG_ROLE", "ABSEN_ROLE must be collector or viewer");
  }
  return raw;
}

export function loadDeviceConfig(options: EnvConfigOptions = {}): DeviceConfig {
  const env = options.env ?? process.env;

  const host = (env.ABSEN_ZK_HOST ?? "").trim();
  if (host === "") {
    throw new ConfigError("CONFIG_HOST", "ABSEN_ZK_HOST is required");
  }
  if (host.includes("://")) {
    throw new ConfigError("CONFIG_HOST", "ABSEN_ZK_HOST must not contain a scheme");
  }
  if (/\s/.test(host)) {
    throw new ConfigError("CONFIG_HOST", "ABSEN_ZK_HOST must not contain whitespace");
  }

  return {
    host,
    port: integerEnv(env, "ABSEN_ZK_PORT", DEFAULT_ZK_PORT, 1, 65535, "CONFIG_PORT"),
    commKey: integerEnv(env, "ABSEN_ZK_COMM_KEY", 0, 0, 999_999, "CONFIG_COMM_KEY"),
    timeoutMs: integerEnv(
      env,
      "ABSEN_ZK_TIMEOUT_MS",
      DEFAULT_ZK_TIMEOUT_MS,
      1,
      2_147_483_647,
      "CONFIG_TIMEOUT",
    ),
  };
}

export function loadWebConfig(options: EnvConfigOptions = {}): WebConfig {
  const env = options.env ?? process.env;

  const username = (env.ABSEN_WEB_USER ?? "").trim();
  if (username === "") {
    throw new ConfigError("CONFIG_WEB_USER", "ABSEN_WEB_USER is required");
  }

  const password = env.ABSEN_WEB_PASSWORD ?? "";
  if (password.trim() === "") {
    throw new ConfigError("CONFIG_WEB_PASSWORD", "ABSEN_WEB_PASSWORD is required");
  }

  const port = integerEnv(env, "ABSEN_PORT", 3000, 1, 65535, "CONFIG_WEB_PORT");
  const hostname = (env.ABSEN_HOSTNAME ?? "").trim() || "0.0.0.0";
  if (hostname.includes("://") || /\s/.test(hostname)) {
    throw new ConfigError("CONFIG_HOSTNAME", "ABSEN_HOSTNAME must be a hostname or IP address");
  }

  return { username, password, port, hostname };
}

export function loadRelayConfig(options: EnvConfigOptions = {}): RelayConfig {
  const env = options.env ?? process.env;

  if ((env.ABSEN_RELAY_URL ?? "").trim() !== "") {
    throw new ConfigError(
      "CONFIG_RELAY_CHAIN",
      "a collector must not read from another relay (ABSEN_RELAY_URL)",
    );
  }

  const enabledRaw = (env.ABSEN_RELAY_ENABLED ?? "").trim().toLowerCase() || "false";
  if (enabledRaw !== "true" && enabledRaw !== "false") {
    throw new ConfigError("CONFIG_RELAY_ENABLED", "ABSEN_RELAY_ENABLED must be true or false");
  }
  const enabled = enabledRaw === "true";

  const host = (env.ABSEN_RELAY_HOST ?? "").trim();
  if (host.includes("://") || /\s/.test(host)) {
    throw new ConfigError("CONFIG_RELAY_HOST", "ABSEN_RELAY_HOST must be a hostname or IP address");
  }
  if (host === "0.0.0.0" || host === "::") {
    throw new ConfigError(
      "CONFIG_RELAY_HOST",
      "ABSEN_RELAY_HOST must bind a specific tunnel address, not a wildcard",
    );
  }
  if (enabled && host === "") {
    throw new ConfigError(
      "CONFIG_RELAY_HOST",
      "ABSEN_RELAY_HOST is required when relay is enabled",
    );
  }

  const token = (env.ABSEN_RELAY_TOKEN ?? "").trim();
  if (enabled && token === "") {
    throw new ConfigError(
      "CONFIG_RELAY_TOKEN",
      "ABSEN_RELAY_TOKEN is required when relay is enabled",
    );
  }

  return {
    enabled,
    host: host === "" ? null : host,
    port: integerEnv(env, "ABSEN_RELAY_PORT", DEFAULT_RELAY_PORT, 1, 65535, "CONFIG_RELAY_PORT"),
    token: token === "" ? null : token,
  };
}

export function loadViewerRelayConfig(options: EnvConfigOptions = {}): ViewerRelayConfig {
  const env = options.env ?? process.env;

  if ((env.ABSEN_ZK_HOST ?? "").trim() !== "") {
    throw new ConfigError(
      "CONFIG_VIEWER_DEVICE",
      "a viewer must not configure ABSEN_ZK_HOST; it has no device access",
    );
  }

  const enabled = (env.ABSEN_RELAY_ENABLED ?? "").trim().toLowerCase();
  if (enabled === "true") {
    throw new ConfigError(
      "CONFIG_RELAY_CHAIN",
      "a viewer must not serve a relay (ABSEN_RELAY_ENABLED=true)",
    );
  }

  const urlRaw = (env.ABSEN_RELAY_URL ?? "").trim();
  if (urlRaw === "") {
    throw new ConfigError("CONFIG_RELAY_URL", "ABSEN_RELAY_URL is required for a viewer");
  }

  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    throw new ConfigError("CONFIG_RELAY_URL", "ABSEN_RELAY_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("CONFIG_RELAY_URL", "ABSEN_RELAY_URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("CONFIG_RELAY_URL", "ABSEN_RELAY_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      "CONFIG_RELAY_URL",
      "ABSEN_RELAY_URL must not contain a query or fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError("CONFIG_RELAY_URL", "ABSEN_RELAY_URL must be a base URL without a path");
  }

  const token = (env.ABSEN_RELAY_TOKEN ?? "").trim();
  if (token === "") {
    throw new ConfigError("CONFIG_RELAY_TOKEN", "ABSEN_RELAY_TOKEN is required for a viewer");
  }

  return {
    url: url.origin,
    token,
    timeoutMs: integerEnv(
      env,
      "ABSEN_RELAY_TIMEOUT_MS",
      DEFAULT_RELAY_TIMEOUT_MS,
      1,
      120_000,
      "CONFIG_RELAY_TIMEOUT",
    ),
  };
}
