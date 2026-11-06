import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  DEFAULT_DB_PATH,
  DEFAULT_RELAY_PORT,
  DEFAULT_RELAY_TIMEOUT_MS,
  DEFAULT_ZK_PORT,
  DEFAULT_ZK_TIMEOUT_MS,
  loadDeviceConfig,
  loadRelayConfig,
  loadRoleConfig,
  loadScheduleConfig,
  loadStorageConfig,
  loadViewerRelayConfig,
  loadWebConfig,
} from "../src/config.ts";
import type { WeeklySchedule } from "../src/schedule.ts";

const BASE: WeeklySchedule = {
  SUNDAY: null,
  MONDAY: { in: "07:00", out: "16:00" },
  TUESDAY: { in: "07:00", out: "16:00" },
  WEDNESDAY: { in: "07:00", out: "16:00" },
  THURSDAY: { in: "07:00", out: "16:00" },
  FRIDAY: { in: "07:00", out: "16:00" },
  SATURDAY: { in: "07:00", out: "12:00" },
};

function deviceEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ABSEN_ZK_HOST: "192.0.2.10",
    ...overrides,
  };
}

function loadDevice(overrides: Record<string, string | undefined> = {}) {
  return loadDeviceConfig({ env: deviceEnv(overrides) });
}

function loadStorage(overrides: Record<string, string | undefined> = {}) {
  return loadStorageConfig({ env: overrides });
}

function loadWeb(overrides: Record<string, string | undefined> = {}) {
  return loadWebConfig({
    env: { ABSEN_WEB_USER: "admin", ABSEN_WEB_PASSWORD: "secret", ...overrides },
  });
}

function loadSchedule() {
  return loadScheduleConfig({
    env: {},
    cwd: "C:/work",
    readFile: () => JSON.stringify({ version: 1, base: BASE }),
  });
}

function configCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConfigError ? error.code : "OTHER";
  }
  return undefined;
}

describe("device config", () => {
  test("uses device defaults and needs only the host", () => {
    expect(loadDevice()).toEqual({
      host: "192.0.2.10",
      port: DEFAULT_ZK_PORT,
      commKey: 0,
      timeoutMs: DEFAULT_ZK_TIMEOUT_MS,
    });
  });

  test("parses custom device values", () => {
    expect(
      loadDevice({
        ABSEN_ZK_HOST: "  device.local  ",
        ABSEN_ZK_PORT: "1234",
        ABSEN_ZK_COMM_KEY: "123456",
        ABSEN_ZK_TIMEOUT_MS: "500",
      }),
    ).toEqual({
      host: "device.local",
      port: 1234,
      commKey: 123456,
      timeoutMs: 500,
    });
  });

  test("rejects a missing, schemed, or whitespace host", () => {
    expect(configCode(() => loadDevice({ ABSEN_ZK_HOST: "" }))).toBe("CONFIG_HOST");
    expect(configCode(() => loadDevice({ ABSEN_ZK_HOST: "http://device" }))).toBe("CONFIG_HOST");
    expect(configCode(() => loadDevice({ ABSEN_ZK_HOST: "a b" }))).toBe("CONFIG_HOST");
  });

  test("rejects invalid ports, comm keys, and timeouts", () => {
    for (const value of ["0", "65536", "abc", "1.5"]) {
      expect(configCode(() => loadDevice({ ABSEN_ZK_PORT: value }))).toBe("CONFIG_PORT");
    }
    for (const value of ["-1", "1000000", "abc"]) {
      expect(configCode(() => loadDevice({ ABSEN_ZK_COMM_KEY: value }))).toBe("CONFIG_COMM_KEY");
    }
    for (const value of ["0", "abc", "-5"]) {
      expect(configCode(() => loadDevice({ ABSEN_ZK_TIMEOUT_MS: value }))).toBe("CONFIG_TIMEOUT");
    }
  });
});

describe("storage config", () => {
  test("uses storage defaults without a device host", () => {
    expect(loadStorage()).toEqual({
      dbPath: DEFAULT_DB_PATH,
      mode: "production",
    });
  });

  test("parses custom DB and mode values", () => {
    expect(
      loadStorage({
        ABSEN_DB: "C:/data/staging.sqlite",
        ABSEN_ENV: "staging",
      }),
    ).toEqual({
      dbPath: "C:/data/staging.sqlite",
      mode: "staging",
    });
  });

  test("an empty DB path uses the default", () => {
    expect(loadStorage({ ABSEN_DB: "   " }).dbPath).toBe(DEFAULT_DB_PATH);
  });

  test("rejects an unknown environment", () => {
    expect(configCode(() => loadStorage({ ABSEN_ENV: "development" }))).toBe("CONFIG_ENV");
  });
});

describe("schedule config", () => {
  test("loads the JSON calendar independently", () => {
    const schedule = loadSchedule();
    expect(schedule.source).toBe("file");
    expect(schedule.calendar.base).toEqual(BASE);
  });
});

describe("web config", () => {
  test("uses admin and listener defaults without a device host", () => {
    expect(loadWeb()).toEqual({
      username: "admin",
      password: "secret",
      port: 3000,
      hostname: "0.0.0.0",
    });
  });

  test("parses custom listener values and trims the username", () => {
    expect(
      loadWeb({
        ABSEN_WEB_USER: "  operator  ",
        ABSEN_PORT: "8080",
        ABSEN_HOSTNAME: "127.0.0.1",
      }),
    ).toEqual({
      username: "operator",
      password: "secret",
      port: 8080,
      hostname: "127.0.0.1",
    });
  });

  test("requires web credentials", () => {
    expect(configCode(() => loadWebConfig({ env: {} }))).toBe("CONFIG_WEB_USER");
    expect(configCode(() => loadWebConfig({ env: { ABSEN_WEB_USER: "admin" } }))).toBe(
      "CONFIG_WEB_PASSWORD",
    );
    expect(
      configCode(() =>
        loadWebConfig({ env: { ABSEN_WEB_USER: "admin", ABSEN_WEB_PASSWORD: "  " } }),
      ),
    ).toBe("CONFIG_WEB_PASSWORD");
  });

  test("rejects invalid ports and hostnames", () => {
    expect(configCode(() => loadWeb({ ABSEN_PORT: "0" }))).toBe("CONFIG_WEB_PORT");
    expect(configCode(() => loadWeb({ ABSEN_PORT: "65536" }))).toBe("CONFIG_WEB_PORT");
    expect(configCode(() => loadWeb({ ABSEN_HOSTNAME: "http://local" }))).toBe("CONFIG_HOSTNAME");
    expect(configCode(() => loadWeb({ ABSEN_HOSTNAME: "a b" }))).toBe("CONFIG_HOSTNAME");
  });
});

describe("relay config", () => {
  function loadRelay(overrides: Record<string, string | undefined> = {}) {
    return loadRelayConfig({ env: overrides });
  }

  test("is disabled by default", () => {
    expect(loadRelay()).toEqual({
      enabled: false,
      host: null,
      port: DEFAULT_RELAY_PORT,
      token: null,
    });
  });

  test("parses the collector listener settings", () => {
    expect(
      loadRelay({
        ABSEN_RELAY_ENABLED: "true",
        ABSEN_RELAY_HOST: "  10.147.17.5 ",
        ABSEN_RELAY_PORT: "3200",
        ABSEN_RELAY_TOKEN: "  relay-secret  ",
      }),
    ).toEqual({
      enabled: true,
      host: "10.147.17.5",
      port: 3200,
      token: "relay-secret",
    });
  });

  test("requires a tunnel host and token when enabled", () => {
    expect(configCode(() => loadRelay({ ABSEN_RELAY_ENABLED: "true" }))).toBe("CONFIG_RELAY_HOST");
    expect(
      configCode(() => loadRelay({ ABSEN_RELAY_ENABLED: "true", ABSEN_RELAY_HOST: "10.147.17.5" })),
    ).toBe("CONFIG_RELAY_TOKEN");
  });

  test("rejects invalid flags, ports, and wildcard binds", () => {
    expect(configCode(() => loadRelay({ ABSEN_RELAY_ENABLED: "yes" }))).toBe(
      "CONFIG_RELAY_ENABLED",
    );
    for (const value of ["0", "65536", "abc"]) {
      expect(configCode(() => loadRelay({ ABSEN_RELAY_PORT: value }))).toBe("CONFIG_RELAY_PORT");
    }
    for (const host of ["0.0.0.0", "::", "http://tunnel", "a b"]) {
      expect(configCode(() => loadRelay({ ABSEN_RELAY_HOST: host }))).toBe("CONFIG_RELAY_HOST");
    }
  });

  test("a collector cannot chain to another relay", () => {
    expect(configCode(() => loadRelay({ ABSEN_RELAY_URL: "http://10.147.17.5:3100" }))).toBe(
      "CONFIG_RELAY_CHAIN",
    );
  });
});

describe("role and viewer config", () => {
  test("defaults to collector and accepts viewer", () => {
    expect(loadRoleConfig({ env: {} })).toBe("collector");
    expect(loadRoleConfig({ env: { ABSEN_ROLE: " Viewer " } })).toBe("viewer");
    expect(configCode(() => loadRoleConfig({ env: { ABSEN_ROLE: "server" } }))).toBe("CONFIG_ROLE");
  });

  test("parses the viewer relay settings", () => {
    expect(
      loadViewerRelayConfig({
        env: {
          ABSEN_RELAY_URL: "http://10.147.17.5:3100/",
          ABSEN_RELAY_TOKEN: "  viewer-secret ",
          ABSEN_RELAY_TIMEOUT_MS: "2500",
        },
      }),
    ).toEqual({
      url: "http://10.147.17.5:3100",
      token: "viewer-secret",
      timeoutMs: 2500,
    });
  });

  test("viewer requires a base URL and token and has no device or relay listener", () => {
    const base = { ABSEN_RELAY_URL: "http://10.147.17.5:3100", ABSEN_RELAY_TOKEN: "secret" };
    expect(loadViewerRelayConfig({ env: base })).toMatchObject({
      timeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
    });

    expect(configCode(() => loadViewerRelayConfig({ env: {} }))).toBe("CONFIG_RELAY_URL");
    expect(
      configCode(() => loadViewerRelayConfig({ env: { ABSEN_RELAY_URL: base.ABSEN_RELAY_URL } })),
    ).toBe("CONFIG_RELAY_TOKEN");

    for (const url of [
      "not a url",
      "ftp://10.147.17.5:3100",
      "http://user:pass@10.147.17.5:3100",
      "http://10.147.17.5:3100/path",
      "http://10.147.17.5:3100?x=1",
    ]) {
      expect(
        configCode(() => loadViewerRelayConfig({ env: { ...base, ABSEN_RELAY_URL: url } })),
      ).toBe("CONFIG_RELAY_URL");
    }

    expect(
      configCode(() => loadViewerRelayConfig({ env: { ...base, ABSEN_ZK_HOST: "1.2.3.4" } })),
    ).toBe("CONFIG_VIEWER_DEVICE");
    expect(
      configCode(() => loadViewerRelayConfig({ env: { ...base, ABSEN_RELAY_ENABLED: "true" } })),
    ).toBe("CONFIG_RELAY_CHAIN");
    expect(
      configCode(() => loadViewerRelayConfig({ env: { ...base, ABSEN_RELAY_TIMEOUT_MS: "0" } })),
    ).toBe("CONFIG_RELAY_TIMEOUT");
  });
});
