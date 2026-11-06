// Small in-memory login throttle. One process, one map; restart clears it.

export interface LoginThrottleOptions {
  maxAttempts?: number;
  windowMs?: number;
  now?: () => number;
}

export interface ThrottleCheck {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

interface Entry {
  count: number;
  firstAt: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  check(key: string): ThrottleCheck {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return { allowed: true, retryAfterMs: 0, remaining: this.maxAttempts };
    }

    const expiresAt = entry.firstAt + this.windowMs;
    if (now >= expiresAt) {
      this.entries.delete(key);
      return { allowed: true, retryAfterMs: 0, remaining: this.maxAttempts };
    }
    if (entry.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: expiresAt - now, remaining: 0 };
    }
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: this.maxAttempts - entry.count,
    };
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry === undefined || now >= entry.firstAt + this.windowMs) {
      this.entries.set(key, { count: 1, firstAt: now });
      return;
    }
    entry.count += 1;
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }
}
