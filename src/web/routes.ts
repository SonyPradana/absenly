// Web adapter: login, app shell, and small admin write routes.
// These routes are not /api/v1; the dashboard still reads data from the API.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionCookie,
  DEFAULT_EMPLOYEE_PASSWORD,
  requestToken,
  sessionCookie,
  type Auth,
  type Session,
} from "../auth.ts";
import type { EmployeeProfileInput } from "../db.ts";
import type { AppStore } from "../store.ts";
import { DeviceError } from "../device.ts";
import { composeDisplayName, toEmployeeViews } from "../employees.ts";
import type { LoginThrottle } from "../login-throttle.ts";
import { monthRange } from "../period.ts";
import type { DailyRow } from "../recap.ts";
import { buildReportRows } from "../reports.ts";
import { ScheduleError, resolveSchedule, type ScheduleCalendar } from "../schedule.ts";
import type { ScheduleSource } from "../schedule-store.ts";
import {
  elapsedWorkdays,
  previousMonth,
  shareMonthMetrics,
  workdayCutoff,
  type ShareMonthMetrics,
} from "../share-report.ts";
import { isShareLinkActive, newShareLink, SHARE_TOKEN_RE } from "../share-links.ts";
import { stamp, today } from "../time.ts";
import { isDue, parseSyncSchedule, SyncScheduleError } from "../auto-sync.ts";
import { toSyncScheduleDto } from "../api/dto.ts";
import type { WebConfig } from "../config.ts";
import { CLIENT_ASSETS, contentTypeFor } from "./assets.ts";
import { renderMeError, renderMePage, renderMePasswordPage } from "./me.ts";
import { renderError, renderLogin, renderShell, type Bootstrap } from "./shell.ts";
import { renderShareError, renderSharePage, type ShareToday } from "./share.ts";

const APP_PATHS = new Set([
  "/",
  "/generate",
  "/log",
  "/employees",
  "/schedule",
  "/hooks",
  "/settings",
  "/about",
]);

const SESSION_TTL_HOURS = 8;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_FORM_BYTES = 16 * 1024;

export interface DeviceInfo {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface ProbeResult {
  users: number;
  records: number;
  usersCap: number;
  recordsCap: number;
}

export interface WebStorageInfo {
  dbPath: string;
  mode: string;
}

export interface WebContext {
  db: AppStore;
  auth: Auth;
  schedule: ScheduleSource;
  web: WebConfig;
  storage: WebStorageInfo;
  device: DeviceInfo | null;
  probe: (() => Promise<ProbeResult>) | null;
  readOnly?: boolean;
  throttle: LoginThrottle;
  clientIp: (request: Request) => string;
  now: () => Date;
  version: string;
}

class WebError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WebError";
  }
}

function securityHeaders(headers = new Headers()): Headers {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return headers;
}

function htmlResponse(html: string, status = 200, extra?: Headers): Response {
  const headers = securityHeaders(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(html, { status, headers });
}

function shareResponse(html: string, status = 200, extra?: Headers): Response {
  const headers = securityHeaders();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow");
  if (extra !== undefined) {
    for (const [key, value] of extra) headers.set(key, value);
  }
  return new Response(html, { status, headers });
}

// /me is a private page for one employee: same hardening as a share link.
const meResponse = shareResponse;

function redirect(location: string, status = 303, cookie?: string): Response {
  const headers = securityHeaders();
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  if (cookie !== undefined) headers.set("set-cookie", cookie);
  return new Response(null, { status, headers });
}

function jsonResponse(data: unknown, status = 200, extra?: Headers): Response {
  const headers = securityHeaders(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(error: WebError): Response {
  const headers = new Headers();
  if (error.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(error.retryAfterSeconds));
  }
  return jsonResponse(
    { error: { code: error.code, message: error.message } },
    error.status,
    headers,
  );
}

function actionError(error: unknown): Response {
  if (error instanceof WebError) return errorResponse(error);
  if (error instanceof ScheduleError) {
    const status = error.code === "SCHEDULE_READONLY" ? 409 : 400;
    return errorResponse(new WebError(status, error.code, error.message));
  }
  if (error instanceof SyncScheduleError) {
    return errorResponse(new WebError(400, error.code, error.message));
  }
  if (error instanceof DeviceError) {
    return errorResponse(
      new WebError(502, "DEVICE_UNAVAILABLE", `Device tidak tersedia (${error.code}).`),
    );
  }
  console.error("web action error:", error instanceof Error ? error.message : error);
  return errorResponse(new WebError(500, "INTERNAL_ERROR", "Internal server error"));
}

function methodNotAllowed(allow: string): Response {
  const headers = securityHeaders(new Headers({ allow }));
  return new Response("Method not allowed", { status: 405, headers });
}

function getAuth(request: Request, ctx: WebContext): { session: Session; token: string } | null {
  const token = requestToken(request);
  if (token === null) return null;
  const session = ctx.auth.get(token);
  return session === null ? null : { session, token };
}

function requireAuth(request: Request, ctx: WebContext): { session: Session; token: string } {
  const auth = getAuth(request, ctx);
  if (auth === null) throw new WebError(401, "UNAUTHORIZED", "Unauthorized");
  // Every route below requireAuth is an admin action; employees are read-only.
  if (auth.session.role !== "admin") throw new WebError(403, "FORBIDDEN", "Forbidden");
  return auth;
}

function requireWritable(ctx: WebContext): void {
  if (ctx.readOnly === true) {
    throw new WebError(
      403,
      "READ_ONLY_VIEWER",
      "Viewer hanya membaca data collector; perubahan tidak diizinkan.",
    );
  }
}

function requireSameOrigin(request: Request): void {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  // Browsers send `Origin: null` for an opaque origin (a saved page, a proxy
  // rewrite, a sandboxed frame). That is not a cross-site request: keep the
  // Sec-Fetch-Site check below as the real gate instead of failing the form.
  if (origin !== null && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new WebError(403, "FORBIDDEN", "Origin tidak valid.");
    }
    if (host === null || originHost !== host) {
      throw new WebError(403, "FORBIDDEN", "Origin tidak cocok.");
    }
  }

  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw new WebError(403, "FORBIDDEN", "Permintaan lintas situs ditolak.");
  }
}

async function readText(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    throw new WebError(413, "BODY_TOO_LARGE", "Body terlalu besar.");
  }
  const text = await request.text();
  if (text.length > max) throw new WebError(413, "BODY_TOO_LARGE", "Body terlalu besar.");
  return text;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request, MAX_JSON_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WebError(400, "INVALID_BODY", "JSON tidak valid.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebError(400, "INVALID_BODY", "Body harus objek JSON.");
  }
  return value as Record<string, unknown>;
}

async function readCredentials(request: Request): Promise<{ username: string; password: string }> {
  const text = await readText(request, MAX_FORM_BYTES);
  const form = new URLSearchParams(text);
  return {
    username: form.get("username") ?? "",
    password: form.get("password") ?? "",
  };
}

function monthResolved(
  calendar: ScheduleCalendar,
  day: string,
): Record<string, { in: string; out: string } | null> {
  const [yearRaw, monthRaw] = day.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const result: Record<string, { in: string; out: string } | null> = {};
  for (let date = 1; date <= days; date++) {
    const key = `${yearRaw}-${monthRaw}-${String(date).padStart(2, "0")}`;
    const schedule = resolveSchedule(calendar, key);
    result[key] = schedule === null ? null : { in: schedule.in, out: schedule.out };
  }
  return result;
}

async function bootstrapFor(ctx: WebContext, page: string): Promise<Bootstrap> {
  const now = ctx.now();
  const day = today(now);
  const calendar = ctx.schedule.calendar;
  const [employees, attendance, profiles, active, passwordHash, schedules, lastSync] =
    await Promise.all([
      ctx.db.countEmployees(),
      ctx.db.countAttendance(),
      ctx.db.countEmployeeProfiles(),
      ctx.db.countActiveProfiles(),
      ctx.db.getAdminPasswordHash(),
      ctx.db.listSyncSchedules(),
      ctx.db.lastSync(),
    ]);
  const nowDate = ctx.now();
  const decision = isDue(
    schedules,
    lastSync === null ? null : new Date(lastSync.startedAt),
    nowDate,
  );
  return {
    version: ctx.version,
    page,
    today: day,
    now: now.toISOString(),
    role: ctx.readOnly === true ? "viewer" : "collector",
    read_only: ctx.readOnly === true,
    web: {
      hostname: ctx.web.hostname,
      port: ctx.web.port,
      username: ctx.web.username,
    },
    storage: { db_path: ctx.storage.dbPath, mode: ctx.storage.mode },
    device:
      ctx.device === null
        ? null
        : {
            host: ctx.device.host,
            port: ctx.device.port,
            timeout_ms: ctx.device.timeoutMs,
          },
    schedule: {
      source: ctx.schedule.source,
      file_path: ctx.schedule.filePath,
      calendar,
      month: monthResolved(calendar, day),
      error: ctx.schedule.lastError?.message ?? null,
    },
    counts: {
      employees,
      attendance,
      profiles,
      active,
    },
    password_source: passwordHash === null ? "env" : "db",
    session_ttl_hours: SESSION_TTL_HOURS,
    auto_sync: {
      schedules: schedules.map(toSyncScheduleDto),
      next_at: decision.nextAt === null ? null : decision.nextAt.toISOString(),
    },
  };
}

function serveAsset(path: string, version: string): Response {
  const asset = CLIENT_ASSETS[path];
  if (asset === undefined) {
    return new Response("Not found", {
      status: 404,
      headers: securityHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }
  const headers = securityHeaders();
  headers.set("content-type", contentTypeFor(path));
  headers.set("cache-control", "public, max-age=3600");
  headers.set("etag", `"${version}-${path}"`);
  return new Response(asset, { headers });
}

async function loginPage(request: Request, ctx: WebContext): Promise<Response> {
  const auth = getAuth(request, ctx);
  if (auth !== null) return redirect(auth.session.role === "employee" ? "/me" : "/");
  const url = new URL(request.url);
  return htmlResponse(renderLogin({ changed: url.searchParams.get("changed") === "1" }));
}

async function loginAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  const clientIp = ctx.clientIp(request);
  const check = ctx.throttle.check(clientIp);
  if (!check.allowed) {
    const seconds = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
    const headers = new Headers({ "retry-after": String(seconds) });
    return htmlResponse(
      renderLogin({
        error: "Terlalu banyak percobaan login.",
        retryAfterSeconds: seconds,
      }),
      429,
      headers,
    );
  }

  let credentials: Awaited<ReturnType<typeof readCredentials>>;
  try {
    credentials = await readCredentials(request);
  } catch (error) {
    if (error instanceof WebError) {
      return htmlResponse(renderLogin({ error: error.message }), error.status);
    }
    throw error;
  }

  const { username, password } = credentials;
  const session = await ctx.auth.login(username, password);
  if (session === null) {
    ctx.throttle.fail(clientIp);
    return htmlResponse(
      renderLogin({
        error: "Username atau password salah.",
        username,
      }),
      401,
    );
  }

  ctx.throttle.success(clientIp);
  const now = ctx.now();
  const target = session.role === "employee" ? "/me" : "/";
  return redirect(target, 303, sessionCookie(session.token, session.expiresAt, now.getTime()));
}

function logoutAction(request: Request, ctx: WebContext): Response {
  const auth = getAuth(request, ctx);
  if (auth !== null) ctx.auth.logout(auth.token);
  return redirect("/login", 303, clearSessionCookie());
}

async function page(request: Request, ctx: WebContext, path: string): Promise<Response> {
  const auth = getAuth(request, ctx);
  if (auth === null) return redirect("/login");
  if (auth.session.role !== "admin") return redirect("/me");
  return htmlResponse(renderShell(await bootstrapFor(ctx, path)));
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
  max: number,
  options: { nullable?: boolean } = {},
): string | null {
  const value = body[key];
  if (value === undefined && options.nullable === true) return null;
  if (value === null && options.nullable === true) return null;
  if (typeof value !== "string") {
    throw new WebError(400, "INVALID_BODY", `${key} harus string.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new WebError(400, "INVALID_BODY", `${key} maksimal ${max} karakter.`);
  }
  return text === "" && options.nullable === true ? null : text;
}

async function employeeAction(
  request: Request,
  ctx: WebContext,
  params: Record<string, string>,
): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const idNumber = params.id ?? "";
  const existing = await ctx.db.getEmployeeProfile(idNumber);
  if (existing === null) throw new WebError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");

  const body = await readJson(request);
  const displayName = readOptionalString(body, "display_name", 100, { nullable: true });
  const prefixTitle = readOptionalString(body, "prefix_title", 50) ?? "";
  const suffixTitle = readOptionalString(body, "suffix_title", 50) ?? "";
  if (typeof body.active !== "boolean") {
    throw new WebError(400, "INVALID_BODY", "active harus boolean.");
  }

  const input: EmployeeProfileInput = {
    idNumber,
    displayName,
    prefixTitle,
    suffixTitle,
    active: body.active,
    updatedAt: stamp(ctx.now()),
  };
  await ctx.db.saveEmployeeProfile(input);
  const saved = await ctx.db.getEmployeeProfile(idNumber);
  if (saved === null) throw new WebError(500, "INTERNAL_ERROR", "Profil gagal disimpan.");
  return jsonResponse({
    data: {
      id_number: saved.idNumber,
      device_name: saved.deviceName,
      display_name: saved.displayName,
      prefix_title: saved.prefixTitle,
      suffix_title: saved.suffixTitle,
      name: composeDisplayName(saved),
      active: saved.active,
      updated_at: saved.updatedAt,
    },
  });
}

// Create and reset share one path: the password is a constant, so the admin
// never types or receives a secret. Reset keeps the existing username.
async function employeeAccountAction(
  request: Request,
  ctx: WebContext,
  params: Record<string, string>,
): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const idNumber = params.id ?? "";
  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) throw new WebError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");

  const users = await ctx.db.listAppUsers();
  const existing = users.find((user) => user.employeeIdNumber === idNumber) ?? null;
  const username = existing?.username ?? idNumber;
  const claimed = users.find((user) => user.username === username) ?? null;
  if (claimed !== null && claimed.employeeIdNumber !== idNumber) {
    throw new WebError(409, "ACCOUNT_USERNAME_TAKEN", `Username ${username} sudah dipakai.`);
  }

  const passwordHash = await Bun.password.hash(DEFAULT_EMPLOYEE_PASSWORD);
  await ctx.db.saveAppUser({
    username,
    passwordHash,
    employeeIdNumber: idNumber,
    createdAt: existing?.createdAt ?? stamp(ctx.now()),
  });
  ctx.auth.revokeUser(username);
  return jsonResponse({
    data: { username, employee_id_number: idNumber, reset: existing !== null },
  });
}

async function employeeAccountDeleteAction(
  request: Request,
  ctx: WebContext,
  params: Record<string, string>,
): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const idNumber = params.id ?? "";
  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) throw new WebError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");

  const users = await ctx.db.listAppUsers();
  const existing = users.find((user) => user.employeeIdNumber === idNumber) ?? null;
  if (existing === null) throw new WebError(404, "NOT_FOUND", "Akun tidak ditemukan.");

  const deleted = await ctx.db.deleteAppUser(existing.username);
  if (deleted) ctx.auth.revokeUser(existing.username);
  return jsonResponse({ data: { deleted, username: existing.username } });
}

async function scheduleAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const calendar = body.calendar;
  if (typeof calendar !== "object" || calendar === null || Array.isArray(calendar)) {
    throw new WebError(400, "INVALID_BODY", "calendar harus objek.");
  }
  const saved = await ctx.schedule.save(calendar as ScheduleCalendar);
  return jsonResponse({ data: { ok: true, overrides: saved.overrides.length } });
}

// Auto-sync schedules are DB-backed. The running ticker re-reads them, so a
// save here takes effect without a restart (no schedule.json involvement).
async function syncScheduleCreateAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const input = parseSyncSchedule(body);
  const createdAt = stamp(ctx.now());
  const id = await ctx.db.insertSyncSchedule(input, createdAt);
  return jsonResponse({ data: toSyncScheduleDto({ id, createdAt, ...input }) }, 201);
}

async function syncScheduleUpdateAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const id = Number(body.id);
  if (typeof body.enabled !== "boolean") {
    throw new WebError(400, "INVALID_BODY", "enabled harus boolean.");
  }
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WebError(400, "INVALID_BODY", "id tidak valid.");
  }
  if (!(await ctx.db.setSyncScheduleEnabled(id, body.enabled))) {
    throw new WebError(404, "NOT_FOUND", "Jadwal tidak ditemukan.");
  }
  return jsonResponse({ data: { ok: true } });
}

async function syncScheduleDeleteAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WebError(400, "INVALID_BODY", "id tidak valid.");
  }
  if (!(await ctx.db.deleteSyncSchedule(id))) {
    throw new WebError(404, "NOT_FOUND", "Jadwal tidak ditemukan.");
  }
  return jsonResponse({ data: { ok: true } });
}

async function passwordAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const oldPassword = readOptionalString(body, "old_password", 1024) ?? "";
  const newPassword = readOptionalString(body, "new_password", 1024) ?? "";
  const confirmPassword = readOptionalString(body, "confirm_password", 1024) ?? "";

  if (newPassword.length < 8) {
    throw new WebError(400, "WEAK_PASSWORD", "Password baru minimal 8 karakter.");
  }
  if (newPassword !== confirmPassword) {
    throw new WebError(400, "PASSWORD_MISMATCH", "Konfirmasi password tidak sama.");
  }
  if (!(await ctx.auth.verifyPassword(oldPassword))) {
    throw new WebError(400, "INVALID_OLD_PASSWORD", "Password lama salah.");
  }

  const hash = await Bun.password.hash(newPassword);
  await ctx.db.saveAdminPasswordHash(hash, stamp(ctx.now()));
  ctx.auth.logoutAll();
  return jsonResponse(
    { data: { ok: true, requires_login: true } },
    200,
    new Headers({ "set-cookie": clearSessionCookie() }),
  );
}

function logoutAllAction(request: Request, ctx: WebContext): Response {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  const count = ctx.auth.logoutAll();
  return jsonResponse(
    { data: { ok: true, logged_out: count } },
    200,
    new Headers({ "set-cookie": clearSessionCookie() }),
  );
}

async function backupAction(ctx: WebContext): Promise<Response> {
  requireWritable(ctx);
  const dir = mkdtempSync(join(tmpdir(), "absenly-backup-"));
  const path = join(dir, "absen.sqlite");
  try {
    await ctx.db.backupTo(path);
    const bytes = readFileSync(path);
    const stampText = stamp(ctx.now())
      .replace(/[-:T+]/g, "")
      .slice(0, 14);
    const headers = securityHeaders();
    headers.set("content-type", "application/vnd.sqlite3");
    headers.set("content-disposition", `attachment; filename="absen-backup-${stampText}.sqlite"`);
    headers.set("cache-control", "no-store");
    return new Response(bytes, { headers });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function probeAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  if (ctx.probe === null || ctx.device === null) {
    throw new WebError(403, "READ_ONLY_VIEWER", "Viewer tidak memiliki akses device.");
  }
  try {
    const result = await ctx.probe();
    return jsonResponse({
      data: {
        host: ctx.device.host,
        port: ctx.device.port,
        users: result.users,
        records: result.records,
        users_cap: result.usersCap,
        records_cap: result.recordsCap,
      },
    });
  } catch (error) {
    return actionError(error);
  }
}

async function shareAction(request: Request, ctx: WebContext): Promise<Response> {
  requireSameOrigin(request);
  requireAuth(request, ctx);
  requireWritable(ctx);
  const body = await readJson(request);
  const idNumber = readOptionalString(body, "id_number", 50) ?? "";
  const month = readOptionalString(body, "month", 7) ?? "";
  if (idNumber === "") throw new WebError(400, "INVALID_BODY", "id_number wajib diisi.");

  try {
    monthRange(month);
  } catch {
    throw new WebError(400, "INVALID_MONTH", "Bulan harus dalam format YYYY-MM.");
  }

  const now = ctx.now();
  if (month > today(now).slice(0, 7)) {
    throw new WebError(400, "INVALID_MONTH", "Bulan tidak boleh di masa depan.");
  }
  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) {
    throw new WebError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  }
  if (!profile.active) {
    throw new WebError(400, "INACTIVE_EMPLOYEE", "Karyawan nonaktif tidak bisa dibagikan.");
  }

  const link = newShareLink({ idNumber, month, now });
  await ctx.db.deleteExpiredShareLinks(now.getTime());
  await ctx.db.insertShareLink(link);
  return jsonResponse({
    data: {
      path: `/share/${link.token}`,
      month: link.month,
      expires_at: new Date(link.expiresAt).toISOString(),
    },
  });
}

interface MonthlyReport {
  month: string;
  through: string;
  rows: DailyRow[];
  current: ShareMonthMetrics;
  previous: ShareMonthMetrics | null;
  compareNote: string;
  today: ShareToday | null;
}

// One employee, one month. Shared by the public share page and /me so the
// streak and month-compare rules exist in one place.
async function monthlyReport(
  ctx: WebContext,
  idNumber: string,
  month: string,
  now: Date,
): Promise<MonthlyReport | null> {
  let range: ReturnType<typeof monthRange>;
  try {
    range = monthRange(month);
  } catch {
    return null;
  }

  const day = today(now);
  const currentMonth = day.slice(0, 7);
  if (month > currentMonth) return null;

  const calendar = ctx.schedule.calendar;
  const through = month === currentMonth && day < range.to ? day : range.to;
  const [profiles, currentPunches, currentExceptions] = await Promise.all([
    ctx.db.listEmployeeProfiles(),
    ctx.db.listPunches({ from: range.from, to: through, idNumber }),
    ctx.db.listWorkExceptionSpansInRange(range.from, through, idNumber),
  ]);
  const employees = toEmployeeViews(profiles);
  const rows = buildReportRows({
    punches: currentPunches,
    employees,
    calendar,
    workExceptions: currentExceptions,
    options: { idNumbers: [idNumber] },
  });
  const current = shareMonthMetrics(rows, calendar, month, through);

  let previous: ShareMonthMetrics | null = null;
  let compareNote = "vs bulan lalu";
  if (month === currentMonth) {
    const elapsed = elapsedWorkdays(calendar, month, through);
    compareNote = "vs bulan lalu (hari kerja setara)";
    if (elapsed > 0) {
      const prevMonth = previousMonth(month);
      const prevRange = monthRange(prevMonth);
      const prevThrough = workdayCutoff(calendar, prevMonth, elapsed) ?? prevRange.to;
      const prevRows = buildReportRows({
        punches: await ctx.db.listPunches({ from: prevRange.from, to: prevThrough, idNumber }),
        employees,
        calendar,
        workExceptions: await ctx.db.listWorkExceptionSpansInRange(
          prevRange.from,
          prevThrough,
          idNumber,
        ),
        options: { idNumbers: [idNumber] },
      });
      const metrics = shareMonthMetrics(prevRows, calendar, prevMonth, prevThrough);
      if (metrics.presentDays > 0) previous = metrics;
    }
  } else {
    const prevMonth = previousMonth(month);
    const prevRange = monthRange(prevMonth);
    const prevRows = buildReportRows({
      punches: await ctx.db.listPunches({ from: prevRange.from, to: prevRange.to, idNumber }),
      employees,
      calendar,
      workExceptions: await ctx.db.listWorkExceptionSpansInRange(
        prevRange.from,
        prevRange.to,
        idNumber,
      ),
      options: { idNumbers: [idNumber] },
    });
    const metrics = shareMonthMetrics(prevRows, calendar, prevMonth, prevRange.to);
    if (metrics.presentDays > 0) previous = metrics;
  }

  let todayInfo: ShareToday | null = null;
  if (month === currentMonth) {
    const row = rows.find((item) => item.date === day);
    const holiday = resolveSchedule(calendar, day) === null && row === undefined;
    todayInfo = {
      holiday,
      inTime: row?.inTime ?? null,
      outTime: row?.outTime ?? null,
    };
  }

  return { month, through, rows, current, previous, compareNote, today: todayInfo };
}

async function lastSyncInfo(ctx: WebContext): Promise<{ at: number; ok: boolean } | null> {
  const last = await ctx.db.lastSync();
  if (last === null) return null;
  const at = Date.parse(last.finishedAt);
  return Number.isNaN(at) ? null : { at, ok: last.ok };
}

function shareNotFound(): Response {
  return shareResponse(renderShareError(), 404);
}

async function sharePage(ctx: WebContext, token: string): Promise<Response> {
  const link = SHARE_TOKEN_RE.test(token) ? await ctx.db.getShareLink(token) : null;
  if (link === null || !isShareLinkActive(link, ctx.now().getTime())) return shareNotFound();

  const profile = await ctx.db.getEmployeeProfile(link.idNumber);
  if (profile === null) return shareNotFound();

  const now = ctx.now();
  const report = await monthlyReport(ctx, link.idNumber, link.month, now);
  if (report === null) return shareNotFound();

  return shareResponse(
    renderSharePage({
      idNumber: link.idNumber,
      name: composeDisplayName(profile),
      month: link.month,
      through: report.through,
      generatedAt: now.getTime(),
      expiresAt: link.expiresAt,
      lastSync: await lastSyncInfo(ctx),
      rows: report.rows,
      current: report.current,
      previous: report.previous,
      compareNote: report.compareNote,
      today: report.today,
    }),
  );
}

async function mePage(request: Request, url: URL, ctx: WebContext): Promise<Response> {
  const auth = getAuth(request, ctx);
  if (auth === null) return redirect("/login");
  const idNumber = auth.session.employeeIdNumber;
  if (auth.session.role !== "employee" || idNumber === undefined) {
    // Admins use the dashboard; /me is employee-only.
    return redirect("/");
  }

  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) {
    return meResponse(renderMeError(404, "Data karyawan tidak ditemukan."), 404);
  }

  const now = ctx.now();
  const currentMonth = today(now).slice(0, 7);
  const requested = url.searchParams.get("month");
  const month = requested === null ? currentMonth : requested;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return meResponse(renderMeError(400, "Format bulan harus YYYY-MM."), 400);
  }

  const report = await monthlyReport(ctx, idNumber, month, now);
  if (report === null) {
    return meResponse(renderMeError(400, "Bulan tidak boleh di masa depan."), 400);
  }

  const months: string[] = [];
  for (let index = 0; index < 6; index++) {
    const date = new Date(
      Date.UTC(Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7)) - 1 - index, 1),
    );
    months.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  return meResponse(
    renderMePage({
      idNumber,
      name: composeDisplayName(profile),
      month,
      through: report.through,
      generatedAt: now.getTime(),
      lastSync: await lastSyncInfo(ctx),
      rows: report.rows,
      current: report.current,
      previous: report.previous,
      compareNote: report.compareNote,
      today: report.today,
      months,
      changed: url.searchParams.get("changed") === "1",
    }),
  );
}

// Self-service password change: employee-only, same hardening as /me.
async function mePasswordPage(request: Request, ctx: WebContext): Promise<Response> {
  const auth = getAuth(request, ctx);
  if (auth === null) return redirect("/login");
  if (auth.session.role !== "employee") return redirect("/");
  const idNumber = auth.session.employeeIdNumber;
  if (idNumber === undefined) return redirect("/login");

  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) {
    return meResponse(renderMeError(404, "Data karyawan tidak ditemukan."), 404);
  }
  return meResponse(renderMePasswordPage({ idNumber, name: composeDisplayName(profile) }));
}

async function mePasswordAction(request: Request, ctx: WebContext): Promise<Response> {
  const auth = getAuth(request, ctx);
  if (auth === null) return redirect("/login");
  if (auth.session.role !== "employee") return redirect("/");
  const idNumber = auth.session.employeeIdNumber;
  if (idNumber === undefined) return redirect("/login");
  requireWritable(ctx);

  const profile = await ctx.db.getEmployeeProfile(idNumber);
  if (profile === null) {
    return meResponse(renderMeError(404, "Data karyawan tidak ditemukan."), 404);
  }
  const name = composeDisplayName(profile);

  // This page is for employees, so a rejected origin must render HTML, never
  // the JSON envelope the admin SPA expects.
  try {
    requireSameOrigin(request);
  } catch (error) {
    if (error instanceof WebError) {
      return meResponse(
        renderMePasswordPage({ idNumber, name, error: error.message }),
        error.status,
      );
    }
    throw error;
  }

  const clientIp = ctx.clientIp(request);

  const check = ctx.throttle.check(clientIp);
  if (!check.allowed) {
    const seconds = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
    return meResponse(
      renderMePasswordPage({
        idNumber,
        name,
        error: "Terlalu banyak percobaan. Coba lagi nanti.",
        retryAfterSeconds: seconds,
      }),
      429,
      new Headers({ "retry-after": String(seconds) }),
    );
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readText(request, MAX_FORM_BYTES));
  } catch (error) {
    if (error instanceof WebError) {
      return meResponse(
        renderMePasswordPage({ idNumber, name, error: error.message }),
        error.status,
      );
    }
    throw error;
  }

  const oldPassword = form.get("old_password") ?? "";
  const newPassword = form.get("new_password") ?? "";
  const confirmPassword = form.get("confirm_password") ?? "";

  if (newPassword.length < 8) {
    return meResponse(
      renderMePasswordPage({ idNumber, name, error: "Password baru minimal 8 karakter." }),
      400,
    );
  }
  if (newPassword !== confirmPassword) {
    return meResponse(
      renderMePasswordPage({ idNumber, name, error: "Konfirmasi password tidak sama." }),
      400,
    );
  }

  const credential = await ctx.db.getAppUserByUsername(auth.session.username);
  let oldOk = false;
  if (credential !== null) {
    try {
      oldOk = await Bun.password.verify(oldPassword, credential.passwordHash);
    } catch {
      oldOk = false;
    }
  }
  if (!oldOk) {
    // Only a wrong password counts against the shared login throttle.
    ctx.throttle.fail(clientIp);
    return meResponse(renderMePasswordPage({ idNumber, name, error: "Password lama salah." }), 400);
  }

  const hash = await Bun.password.hash(newPassword);
  await ctx.db.saveAppUser({
    username: auth.session.username,
    passwordHash: hash,
    employeeIdNumber: idNumber,
    createdAt: credential?.createdAt ?? stamp(ctx.now()),
  });
  ctx.throttle.success(clientIp);
  // Keep this browser logged in; every other session for this account is dropped.
  ctx.auth.revokeUser(auth.session.username, auth.token);
  return redirect("/me?changed=1");
}

type EmployeeResource = "profile" | "account" | "account/delete";

function matchEmployeePath(path: string): { id: string; resource: EmployeeResource } | null {
  const prefix = "/employees/";
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const resources: EmployeeResource[] = ["account/delete", "account", "profile"];
  for (const resource of resources) {
    const suffix = `/${resource}`;
    if (!rest.endsWith(suffix)) continue;
    const raw = rest.slice(0, -suffix.length);
    if (raw === "" || raw.includes("/")) return null;
    try {
      return { id: decodeURIComponent(raw), resource };
    } catch {
      return null;
    }
  }
  return null;
}

export async function handleWeb(
  request: Request,
  url: URL,
  ctx: WebContext,
): Promise<Response | null> {
  const path = url.pathname;

  if (path.startsWith("/assets/")) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return serveAsset(path.slice("/assets/".length), ctx.version);
  }

  if (path === "/login") {
    if (request.method === "GET") return loginPage(request, ctx);
    if (request.method === "POST") {
      try {
        return await loginAction(request, ctx);
      } catch (error) {
        if (error instanceof WebError) {
          return htmlResponse(renderLogin({ error: error.message }), error.status);
        }
        throw error;
      }
    }
    return methodNotAllowed("GET, POST");
  }

  if (path === "/logout") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return logoutAction(request, ctx);
  }

  if (path === "/schedule" && request.method === "POST") {
    try {
      return await scheduleAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/sync-schedules" && request.method === "POST") {
    try {
      return await syncScheduleCreateAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/sync-schedules/update" && request.method === "POST") {
    try {
      return await syncScheduleUpdateAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/sync-schedules/delete" && request.method === "POST") {
    try {
      return await syncScheduleDeleteAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/generate/share") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      return await shareAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path.startsWith("/share/")) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return await sharePage(ctx, path.slice("/share/".length));
  }

  if (path === "/me") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return await mePage(request, url, ctx);
  }

  if (path === "/me/password") {
    if (request.method === "GET") return await mePasswordPage(request, ctx);
    if (request.method === "POST") {
      try {
        return await mePasswordAction(request, ctx);
      } catch (error) {
        return actionError(error);
      }
    }
    return methodNotAllowed("GET, POST");
  }

  if (APP_PATHS.has(path)) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (ctx.readOnly === true && (path === "/settings" || path === "/hooks")) {
      return renderNotFound();
    }
    return await page(request, ctx, path);
  }

  const employee = matchEmployeePath(path);
  if (employee !== null) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      if (employee.resource === "account") {
        return await employeeAccountAction(request, ctx, employee);
      }
      if (employee.resource === "account/delete") {
        return await employeeAccountDeleteAction(request, ctx, employee);
      }
      return await employeeAction(request, ctx, employee);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/password") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      return await passwordAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/logout-all") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      return logoutAllAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/settings/backup") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    try {
      requireAuth(request, ctx);
      return await backupAction(ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  if (path === "/about/probe") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    try {
      return await probeAction(request, ctx);
    } catch (error) {
      return actionError(error);
    }
  }

  return null;
}

export function renderErrorPage(status: number, message: string): Response {
  return htmlResponse(renderError(status, message), status);
}

export function renderNotFound(): Response {
  return renderErrorPage(404, "Halaman tidak ditemukan.");
}

export function renderServerError(): Response {
  return renderErrorPage(500, "Terjadi kesalahan pada server.");
}
