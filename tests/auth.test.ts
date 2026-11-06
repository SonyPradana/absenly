import { describe, expect, test } from "bun:test";
import { Auth } from "../src/auth.ts";
import { LoginThrottle } from "../src/login-throttle.ts";

const NOW = 1_000_000;

describe("auth", () => {
  test("env password logs in when no DB hash exists", async () => {
    const auth = new Auth({ username: "admin", password: "secret", now: () => NOW });
    expect(await auth.login("admin", "secret")).not.toBeNull();
    expect(await auth.login("admin", "wrong")).toBeNull();
    expect(await auth.login("other", "secret")).toBeNull();
  });

  test("DB hash replaces the env password and sessions expire", async () => {
    const hash = await Bun.password.hash("db-secret");
    let now = NOW;
    const auth = new Auth({
      username: "admin",
      password: "env-secret",
      passwordHash: () => hash,
      ttlMs: 1000,
      now: () => now,
    });

    expect(await auth.login("admin", "env-secret")).toBeNull();
    const session = await auth.login("admin", "db-secret");
    expect(session).not.toBeNull();
    expect(auth.get(session!.token)?.username).toBe("admin");

    now += 1001;
    expect(auth.get(session!.token)).toBeNull();
  });

  test("employee accounts log in with their own scope only", async () => {
    const hash = await Bun.password.hash("karyawan-1");
    const auth = new Auth({
      username: "admin",
      password: "secret",
      now: () => NOW,
      findUser: (username) =>
        username === "siti"
          ? {
              username: "siti",
              passwordHash: hash,
              role: "employee" as const,
              employeeIdNumber: "992",
            }
          : null,
    });

    const session = await auth.login("siti", "karyawan-1");
    expect(session).toMatchObject({ role: "employee", username: "siti", employeeIdNumber: "992" });
    expect(await auth.login("siti", "secret")).toBeNull();
    expect(await auth.login("siti", "wrong")).toBeNull();
    expect(await auth.login("unknown", "karyawan-1")).toBeNull();
    // The admin env password still works.
    expect((await auth.login("admin", "secret"))?.role).toBe("admin");
  });

  test("verifyPassword and logoutAll cover every session", async () => {
    const auth = new Auth({ username: "admin", password: "secret", now: () => NOW });
    expect(await auth.verifyPassword("secret")).toBe(true);
    expect(await auth.verifyPassword("nope")).toBe(false);

    await auth.login("admin", "secret");
    await auth.login("admin", "secret");
    expect(auth.sessionCount()).toBe(2);
    expect(auth.logoutAll()).toBe(2);
    expect(auth.sessionCount()).toBe(0);
  });

  test("revokeUser drops one account's sessions and can spare one token", async () => {
    const auth = new Auth({
      username: "admin",
      password: "secret",
      findUser: (username) =>
        username === "siti"
          ? {
              username: "siti",
              passwordHash: "unused",
              role: "employee",
              employeeIdNumber: "992",
            }
          : null,
      now: () => NOW,
    });
    const first = await auth.login("admin", "secret");
    const second = await auth.login("admin", "secret");
    expect(first === null || second === null).toBe(false);

    expect(auth.revokeUser("admin", first!.token)).toBe(1);
    expect(auth.get(first!.token) === null).toBe(false);
    expect(auth.get(second!.token)).toBeNull();

    expect(auth.revokeUser("admin")).toBe(1);
    expect(auth.get(first!.token)).toBeNull();
    expect(auth.revokeUser("nobody")).toBe(0);
  });
});

describe("login throttle", () => {
  test("blocks after five failures and resets after the window", () => {
    let now = NOW;
    const throttle = new LoginThrottle({ now: () => now, maxAttempts: 5, windowMs: 1000 });

    expect(throttle.check("ip").allowed).toBe(true);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(throttle.check("ip").allowed).toBe(true);
      throttle.fail("ip");
    }

    const blocked = throttle.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);

    now += 1000;
    expect(throttle.check("ip").allowed).toBe(true);
  });

  test("success clears the counter and keys are independent", () => {
    const throttle = new LoginThrottle({ now: () => NOW, maxAttempts: 2, windowMs: 1000 });
    throttle.fail("a");
    throttle.fail("a");
    expect(throttle.check("a").allowed).toBe(false);
    expect(throttle.check("b").allowed).toBe(true);

    throttle.success("a");
    expect(throttle.check("a").allowed).toBe(true);
    expect(throttle.check("a").remaining).toBe(2);
  });
});
