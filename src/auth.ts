// In-memory admin sessions shared by the API and the web UI.
//
// The env password is the bootstrap credential. Once a DB hash exists, web/API
// login accepts only the DB password; the env password is no longer a login
// credential. Reset the DB hash from the local CLI to fall back to env again.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type Role = "admin" | "employee";

export interface Session {
  token: string;
  role: Role;
  username: string;
  employeeIdNumber?: string;
  expiresAt: number;
}

export interface AuthOptions {
  username: string;
  password: string;
  /** Lazy DB lookup. null/undefined means no DB password has been set. */
  passwordHash?: () => string | null | Promise<string | null>;
  /** Employee accounts (`app_users`). Absent/undefined disables employee login. */
  findUser?: (username: string) => AuthUser | null | Promise<AuthUser | null>;
  ttlMs?: number;
  now?: () => number;
}

export interface AuthUser {
  username: string;
  passwordHash: string;
  role: Role;
  employeeIdNumber: string | null;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = "absen_session";
// Password handed to a freshly created employee account. Reused on reset.
// The web UI tells the admin this value; it is never echoed by an API response.
export const DEFAULT_EMPLOYEE_PASSWORD = "satutekad";

function secureEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export class Auth {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AuthOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async hasDbPassword(): Promise<boolean> {
    return (await this.options.passwordHash?.()) != null;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = (await this.options.passwordHash?.()) ?? null;
    if (hash !== null) {
      try {
        return await Bun.password.verify(password, hash);
      } catch {
        return false;
      }
    }
    return secureEqual(password, this.options.password);
  }

  async login(username: string, password: string): Promise<Session | null> {
    const name = username.trim();
    // Admin first: the admin username is fixed, employee usernames come from app_users.
    if (secureEqual(name, this.options.username)) {
      if (!(await this.verifyPassword(password))) return null;
      return this.createSession({ role: "admin", username: this.options.username });
    }

    const user = (await this.options.findUser?.(name)) ?? null;
    if (user === null || user.role !== "employee" || user.employeeIdNumber === null) return null;

    let passwordOk = false;
    try {
      passwordOk = await Bun.password.verify(password, user.passwordHash);
    } catch {
      return null;
    }
    if (!passwordOk) return null;

    return this.createSession({
      role: "employee",
      username: user.username,
      employeeIdNumber: user.employeeIdNumber,
    });
  }

  private createSession(input: {
    role: Role;
    username: string;
    employeeIdNumber?: string;
  }): Session {
    const session: Session = {
      token: randomBytes(32).toString("base64url"),
      role: input.role,
      username: input.username,
      ...(input.employeeIdNumber === undefined ? {} : { employeeIdNumber: input.employeeIdNumber }),
      expiresAt: this.now() + this.ttlMs,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  logoutAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  // Drop every session for one username (account reset/delete). `exceptToken`
  // keeps the caller's own session alive, e.g. after a self-service password change.
  revokeUser(username: string, exceptToken?: string): number {
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (session.username === username && token !== exceptToken) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  sessionCount(): number {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    return this.sessions.size;
  }
}

export function requestToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const [scheme, token] = authorization.trim().split(/\s+/, 2);
    return scheme?.toLowerCase() === "bearer" && token ? token : null;
  }

  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: number, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
