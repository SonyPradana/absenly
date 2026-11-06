// /api/v1 handlers. Auth and HTTP details stay here; data rules stay in services.

import {
  clearSessionCookie,
  requestToken,
  sessionCookie,
  type Auth,
  type Session,
} from "../auth.ts";
import type { AppStore } from "../store.ts";
import { DeviceError } from "../device.ts";
import type { LoginThrottle } from "../login-throttle.ts";
import { composeDisplayName, toEmployeeViews } from "../employees.ts";
import {
  buildWorkbook,
  EXPORT_MODES,
  ExportError,
  type ExportMode,
  type ExportOptions,
} from "../export.ts";
import { dateRange, monthRange, PeriodError } from "../period.ts";
import {
  PRESENCE_FILTERS,
  PUNCTUALITY_FILTERS,
  summarizeDaily,
  type DailyRow,
  type PresenceFilter,
  type PunctualityFilter,
} from "../recap.ts";
import { buildReportRows, composeDailyRows } from "../reports.ts";
import type { ScheduleCalendar } from "../schedule.ts";
import { SyncError, type SyncRunner } from "../sync.ts";
import { HookError, newWebhookSecret, parseWebhookInput, sendTestEvent } from "../hooks.ts";
import {
  isDue,
  parseSyncSchedule,
  SyncScheduleError,
  type SyncScheduleInput,
} from "../auto-sync.ts";
import { stamp, today } from "../time.ts";
import {
  isWorkExceptionKind,
  validateWorkException,
  WORK_EXCEPTION_KINDS,
  WorkExceptionError,
  type WorkExceptionInput,
  type WorkExceptionKind,
} from "../work-exceptions.ts";
import {
  toAttendanceDto,
  toEmployeeDto,
  toEventDto,
  toRecapDto,
  toSummaryDto,
  toSyncResultDto,
  toSyncScheduleDto,
  toSyncStatusDto,
  toWebhookDto,
  toWorkExceptionDto,
  type ListMeta,
} from "./dto.ts";

export interface ApiContext {
  db: AppStore;
  auth: Auth;
  getCalendar: () => ScheduleCalendar;
  sync: SyncRunner;
  readOnly?: boolean;
  now?: () => Date;
  throttle?: LoginThrottle;
  clientIp?: (request: Request) => string;
}

interface PeriodQuery {
  from: string;
  to: string;
  idNumber?: string;
}

interface AttendanceQuery extends PeriodQuery {
  page: number;
  perPage: number;
}

interface FilterQuery extends PeriodQuery {
  presence: PresenceFilter;
  punctuality: PunctualityFilter;
}

interface RecapQuery extends FilterQuery {
  page: number;
  perPage: number;
}

type SummaryQuery = FilterQuery;

interface WorkExceptionQuery extends PeriodQuery {
  kind?: WorkExceptionKind;
  page: number;
  perPage: number;
}

interface ExportQuery {
  from: string;
  to: string;
  idNumbers: string[];
  month: string | null;
  modes: ExportMode[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly allow?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function jsonResponse(
  data: unknown,
  options: { meta?: unknown; status?: number; cookie?: string } = {},
): Response {
  const body = options.meta === undefined ? { data } : { data, meta: options.meta };
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (options.cookie !== undefined) headers.set("set-cookie", options.cookie);
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers });
}

export function errorResponse(error: ApiError): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (error.allow !== undefined) headers.set("allow", error.allow);
  if (error.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(error.retryAfterSeconds));
  }
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

function invalidQuery(field: string, message: string): never {
  throw new ApiError(400, "INVALID_QUERY", message, { field });
}

function invalidBody(field: string, message: string): never {
  throw new ApiError(400, "INVALID_BODY", message, { field });
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_BODY", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "Invalid JSON body");
  }
  return body as Record<string, unknown>;
}

function requireSession(request: Request, ctx: ApiContext): { session: Session; token: string } {
  const token = requestToken(request);
  const session = token === null ? null : ctx.auth.get(token);
  if (token === null || session === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
  }
  return { session, token };
}

function requireAdmin(request: Request, ctx: ApiContext): { session: Session; token: string } {
  const auth = requireSession(request, ctx);
  if (auth.session.role !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "Forbidden");
  }
  return auth;
}

function requireWritable(ctx: ApiContext): void {
  if (ctx.readOnly === true) {
    throw new ApiError(
      403,
      "READ_ONLY_VIEWER",
      "Viewer hanya membaca data collector; perubahan tidak diizinkan.",
    );
  }
}

// Hooks live on the collector only: a viewer has no event log and no targets.
function requireCollector(ctx: ApiContext): void {
  if (ctx.readOnly === true) {
    throw new ApiError(
      403,
      "READ_ONLY_VIEWER",
      "Hooks hanya tersedia di collector; viewer tidak menyimpan event.",
    );
  }
}

// /me/* is employee-only and always scoped to the session's own id_number.
function requireEmployee(
  request: Request,
  ctx: ApiContext,
): { session: Session; idNumber: string } {
  const { session } = requireSession(request, ctx);
  if (session.role !== "employee" || session.employeeIdNumber === undefined) {
    throw new ApiError(403, "FORBIDDEN", "Forbidden");
  }
  return { session, idNumber: session.employeeIdNumber };
}

function rejectEmployeeFilter(params: URLSearchParams): void {
  if (params.has("employee_id") || params.has("employee_ids")) {
    invalidQuery("employee_id", "employee_id is not allowed on /me; scope comes from the session");
  }
}

function methodNotAllowed(methods: string[]): never {
  throw new ApiError(
    405,
    "METHOD_NOT_ALLOWED",
    "Method not allowed",
    undefined,
    methods.join(", "),
  );
}

function positiveInt(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) {
    invalidQuery(name, `${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    invalidQuery(name, `${name} must be between 1 and ${max}`);
  }
  return value;
}

function parsePeriod(params: URLSearchParams, now: Date): { from: string; to: string } {
  const hasMonth = params.has("month");
  const hasFrom = params.has("from");
  const hasTo = params.has("to");

  if (hasMonth && (hasFrom || hasTo)) {
    invalidQuery("month", "month cannot be combined with from/to");
  }

  try {
    if (hasMonth) {
      return monthRange(params.get("month") ?? "");
    }

    if (hasFrom || hasTo) {
      if (!hasFrom || !hasTo) {
        invalidQuery(hasFrom ? "to" : "from", "from and to must be paired");
      }
      return dateRange(params.get("from") ?? "", params.get("to") ?? "");
    }

    return monthRange(today(now).slice(0, 7));
  } catch (error) {
    if (error instanceof PeriodError) invalidQuery(error.field, error.message);
    throw error;
  }
}

function parseEmployeeId(params: URLSearchParams): string | undefined {
  const rawId = params.get("employee_id");
  const idNumber = rawId === null ? undefined : rawId.trim();
  if (idNumber !== undefined && (idNumber === "" || idNumber.length > 32)) {
    invalidQuery("employee_id", "employee_id must be 1-32 characters");
  }
  return idNumber;
}

function parseEmployeeIds(params: URLSearchParams): string[] {
  const raw = params.get("employee_ids");
  if (raw === null) return [];

  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "" || id.length > 32) {
      invalidQuery("employee_ids", "each employee_ids entry must be 1-32 characters");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) invalidQuery("employee_ids", "employee_ids must not be empty");
  if (ids.length > 200)
    invalidQuery("employee_ids", "employee_ids must contain at most 200 entries");
  return ids;
}

function enumParam<T extends string>(
  params: URLSearchParams,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!(values as readonly string[]).includes(raw)) {
    invalidQuery(name, `${name} must be one of ${values.join("|")}`);
  }
  return raw as T;
}

function parseAttendanceQuery(params: URLSearchParams, now: Date): AttendanceQuery {
  const period = parsePeriod(params, now);
  const idNumber = parseEmployeeId(params);
  return {
    ...period,
    ...(idNumber === undefined ? {} : { idNumber }),
    page: positiveInt(params, "page", 1, Number.MAX_SAFE_INTEGER),
    perPage: positiveInt(params, "per_page", 50, 200),
  };
}

function parseFilters(params: URLSearchParams, now: Date): FilterQuery {
  const period = parsePeriod(params, now);
  const idNumber = parseEmployeeId(params);
  return {
    ...period,
    ...(idNumber === undefined ? {} : { idNumber }),
    presence: enumParam(params, "presence", PRESENCE_FILTERS, "all"),
    punctuality: enumParam(params, "punctuality", PUNCTUALITY_FILTERS, "all"),
  };
}

function parseRecapQuery(params: URLSearchParams, now: Date): RecapQuery {
  return {
    ...parseFilters(params, now),
    page: positiveInt(params, "page", 1, Number.MAX_SAFE_INTEGER),
    perPage: positiveInt(params, "per_page", 50, 200),
  };
}

function parseSummaryQuery(params: URLSearchParams, now: Date): SummaryQuery {
  return parseFilters(params, now);
}

function parseWorkExceptionQuery(params: URLSearchParams, now: Date): WorkExceptionQuery {
  const period = parsePeriod(params, now);
  const idNumber = parseEmployeeId(params);
  const rawKind = params.get("kind");
  let kind: WorkExceptionKind | undefined;
  if (rawKind !== null) {
    if (!isWorkExceptionKind(rawKind)) {
      invalidQuery("kind", `kind must be one of ${WORK_EXCEPTION_KINDS.join("|")}`);
    }
    kind = rawKind;
  }
  return {
    ...period,
    ...(idNumber === undefined ? {} : { idNumber }),
    ...(kind === undefined ? {} : { kind }),
    page: positiveInt(params, "page", 1, Number.MAX_SAFE_INTEGER),
    perPage: positiveInt(params, "per_page", 50, 200),
  };
}

function parseExportModes(params: URLSearchParams): ExportMode[] {
  const raw = params.get("mode");
  if (raw === null) return ["recap"];

  const modes: ExportMode[] = [];
  for (const part of raw.split(",")) {
    const mode = part.trim();
    if (!(EXPORT_MODES as readonly string[]).includes(mode)) {
      invalidQuery("mode", `mode must be a comma list of ${EXPORT_MODES.join("|")}`);
    }
    const typed = mode as ExportMode;
    if (!modes.includes(typed)) modes.push(typed);
  }
  return modes.length === 0 ? ["recap"] : modes;
}

function parseExportQuery(params: URLSearchParams, now: Date): ExportQuery {
  const period = parsePeriod(params, now);
  const single = parseEmployeeId(params);
  const many = parseEmployeeIds(params);
  if (single !== undefined && many.length > 0) {
    invalidQuery("employee_ids", "employee_id and employee_ids cannot be combined");
  }
  // Presence/punctuality are daily-row filters; a recap grid cannot represent them.
  for (const name of ["presence", "punctuality"]) {
    if (params.has(name)) {
      invalidQuery(name, `${name} only applies to /recap`);
    }
  }
  const month = params.has("month") ? (params.get("month") ?? "") : null;
  return {
    ...period,
    idNumbers: single === undefined ? many : [single],
    month,
    modes: parseExportModes(params),
  };
}

function parseWorkExceptionBody(body: Record<string, unknown>): WorkExceptionInput {
  const idRaw = body.id_number;
  if (typeof idRaw !== "string") invalidBody("id_number", "id_number wajib diisi");
  const idNumber = idRaw.trim();

  const kindRaw = body.kind;
  if (typeof kindRaw !== "string") invalidBody("kind", "kind wajib diisi");

  const required = (name: string): string => {
    const value = body[name];
    if (typeof value !== "string") invalidBody(name, `${name} wajib diisi`);
    return value;
  };

  const noteRaw = body.note;
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string") {
    invalidBody("note", "note must be a string or null");
  }

  return {
    idNumber,
    kind: kindRaw as WorkExceptionKind,
    startDate: required("start_date"),
    startTime: required("start_time"),
    endDate: required("end_date"),
    endTime: required("end_time"),
    note: typeof noteRaw === "string" ? noteRaw : null,
  };
}

async function login(request: Request, ctx: ApiContext): Promise<Response> {
  const clientIp = ctx.clientIp?.(request) ?? "unknown";
  const check = ctx.throttle?.check(clientIp);
  if (check !== undefined && !check.allowed) {
    const seconds = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
    throw new ApiError(
      429,
      "TOO_MANY_ATTEMPTS",
      "Terlalu banyak percobaan login. Coba lagi nanti.",
      { retry_after_seconds: seconds },
      undefined,
      seconds,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_BODY", "Invalid JSON body");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "Invalid JSON body");
  }
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new ApiError(400, "INVALID_BODY", "username and password are required");
  }

  const session = await ctx.auth.login(username, password);
  if (session === null) {
    ctx.throttle?.fail(clientIp);
    throw new ApiError(401, "INVALID_CREDENTIALS", "Username atau password salah.");
  }
  ctx.throttle?.success(clientIp);

  const now = ctx.now?.() ?? new Date();
  return jsonResponse(
    {
      token: session.token,
      expires_at: stamp(new Date(session.expiresAt)),
      user: {
        role: session.role,
        username: session.username,
        ...(session.employeeIdNumber === undefined
          ? {}
          : { employee_id_number: session.employeeIdNumber }),
      },
    },
    { cookie: sessionCookie(session.token, session.expiresAt, now.getTime()) },
  );
}

function logout(request: Request, ctx: ApiContext): Response {
  const { token } = requireSession(request, ctx);
  ctx.auth.logout(token);
  return jsonResponse({ ok: true }, { cookie: clearSessionCookie() });
}

function me(request: Request, ctx: ApiContext): Response {
  const { session } = requireSession(request, ctx);
  return jsonResponse({
    role: session.role,
    username: session.username,
    ...(session.employeeIdNumber === undefined
      ? {}
      : { employee_id_number: session.employeeIdNumber }),
  });
}

async function health(ctx: ApiContext): Promise<Response> {
  const last = await ctx.db.lastSync();
  return jsonResponse({
    ok: true,
    last_sync:
      last === null
        ? null
        : { at: last.finishedAt, ok: last.ok, users: last.users, records: last.records },
  });
}

async function attendance(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const query = parseAttendanceQuery(url.searchParams, ctx.now?.() ?? new Date());
  const result = await ctx.db.listAttendancePage(query);
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: result.total,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(result.total / query.perPage),
  };
  return jsonResponse(result.rows.map(toAttendanceDto), { meta });
}

async function employees(ctx: ApiContext): Promise<Response> {
  const profiles = new Map(
    (await ctx.db.listEmployeeProfiles()).map((profile) => [profile.idNumber, profile]),
  );
  const rows = await ctx.db.listEmployees();
  const data = rows
    .map((row) => toEmployeeDto(row, profiles.get(row.idNumber)))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id_number < b.id_number ? -1 : a.id_number > b.id_number ? 1 : 0;
    });
  return jsonResponse(data, { meta: { total: data.length } });
}

// Login accounts only: no password hash ever leaves the DB. The web joins this
// with /api/v1/employees on employee_id_number to show who still needs an account.
async function users(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.listAppUsers();
  return jsonResponse(
    rows.map((row) => ({
      username: row.username,
      role: row.role,
      employee_id_number: row.employeeIdNumber,
      created_at: row.createdAt,
    })),
    { meta: { total: rows.length } },
  );
}

// Recap and summary share the schedule, display-name mapping, and filters.
async function filteredDailyRows(ctx: ApiContext, query: FilterQuery): Promise<DailyRow[]> {
  const [punches, profiles, workExceptions] = await Promise.all([
    ctx.db.listPunches({
      from: query.from,
      to: query.to,
      ...(query.idNumber === undefined ? {} : { idNumber: query.idNumber }),
    }),
    ctx.db.listEmployeeProfiles(),
    ctx.db.listWorkExceptionSpansInRange(query.from, query.to, query.idNumber),
  ]);
  return buildReportRows({
    punches,
    employees: toEmployeeViews(profiles),
    calendar: ctx.getCalendar(),
    workExceptions,
    options: {
      idNumbers: query.idNumber === undefined ? undefined : [query.idNumber],
      presence: query.presence,
      punctuality: query.punctuality,
    },
  });
}

async function recap(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const query = parseRecapQuery(url.searchParams, ctx.now?.() ?? new Date());
  const rows = await filteredDailyRows(ctx, query);
  const offset = (query.page - 1) * query.perPage;
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: rows.length,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(rows.length / query.perPage),
  };
  return jsonResponse(rows.slice(offset, offset + query.perPage).map(toRecapDto), { meta });
}

async function summary(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const query = parseSummaryQuery(url.searchParams, ctx.now?.() ?? new Date());
  return jsonResponse(toSummaryDto(summarizeDaily(await filteredDailyRows(ctx, query))));
}

// ---- /me/* : employee-only, always scoped to the session's id_number ----

async function meProfile(request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  const { session, idNumber } = requireEmployee(request, ctx);
  const profiles = await ctx.db.listEmployeeProfiles();
  const profile = profiles.find((item) => item.idNumber === idNumber) ?? null;
  return jsonResponse({
    role: "employee",
    username: session.username,
    id_number: idNumber,
    name: profile === null ? idNumber : composeDisplayName(profile),
    display_name: profile?.displayName ?? null,
    prefix_title: profile?.prefixTitle ?? "",
    suffix_title: profile?.suffixTitle ?? "",
    device_name: profile?.deviceName ?? null,
    active: profile?.active ?? true,
  });
}

async function meAttendance(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { idNumber } = requireEmployee(request, ctx);
  rejectEmployeeFilter(url.searchParams);
  const query = parseAttendanceQuery(url.searchParams, ctx.now?.() ?? new Date());
  const result = await ctx.db.listAttendancePage({ ...query, idNumber });
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: result.total,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(result.total / query.perPage),
  };
  return jsonResponse(result.rows.map(toAttendanceDto), { meta });
}

async function meRecap(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { idNumber } = requireEmployee(request, ctx);
  rejectEmployeeFilter(url.searchParams);
  const query = parseRecapQuery(url.searchParams, ctx.now?.() ?? new Date());
  const rows = await filteredDailyRows(ctx, { ...query, idNumber });
  const offset = (query.page - 1) * query.perPage;
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: rows.length,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(rows.length / query.perPage),
  };
  return jsonResponse(rows.slice(offset, offset + query.perPage).map(toRecapDto), { meta });
}

async function meSummary(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { idNumber } = requireEmployee(request, ctx);
  rejectEmployeeFilter(url.searchParams);
  const query = parseSummaryQuery(url.searchParams, ctx.now?.() ?? new Date());
  return jsonResponse(
    toSummaryDto(summarizeDaily(await filteredDailyRows(ctx, { ...query, idNumber }))),
  );
}

async function meWorkExceptions(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { idNumber } = requireEmployee(request, ctx);
  rejectEmployeeFilter(url.searchParams);
  const query = parseWorkExceptionQuery(url.searchParams, ctx.now?.() ?? new Date());
  const result = await ctx.db.listWorkExceptionsPage({ ...query, idNumber });
  const profile = await ctx.db.getEmployeeProfile(idNumber);
  const name = profile === null ? idNumber : composeDisplayName(profile);
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: result.total,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(result.total / query.perPage),
  };
  return jsonResponse(
    result.rows.map((row) => toWorkExceptionDto(row, name)),
    { meta },
  );
}

function workExceptionError(error: unknown): never {
  if (error instanceof WorkExceptionError) {
    if (error.code === "OVERLAP") {
      throw new ApiError(409, "WORK_EXCEPTION_OVERLAP", error.message);
    }
    throw new ApiError(
      400,
      "INVALID_BODY",
      error.message,
      error.field ? { field: error.field } : undefined,
    );
  }
  throw error;
}

async function workExceptions(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const query = parseWorkExceptionQuery(url.searchParams, ctx.now?.() ?? new Date());
  const result = await ctx.db.listWorkExceptionsPage(query);
  const names = new Map(
    toEmployeeViews(await ctx.db.listEmployeeProfiles()).map((view) => [view.idNumber, view.name]),
  );
  const meta: ListMeta = {
    from: query.from,
    to: query.to,
    total: result.total,
    page: query.page,
    per_page: query.perPage,
    total_pages: Math.ceil(result.total / query.perPage),
  };
  return jsonResponse(
    result.rows.map((row) => toWorkExceptionDto(row, names.get(row.idNumber))),
    { meta },
  );
}

async function createWorkException(
  request: Request,
  _url: URL,
  ctx: ApiContext,
): Promise<Response> {
  requireWritable(ctx);
  const input = parseWorkExceptionBody(await jsonObject(request));
  try {
    validateWorkException(
      input,
      await ctx.db.listWorkExceptionSpans(input.idNumber),
      (await ctx.db.getEmployeeProfile(input.idNumber)) !== null,
    );
  } catch (error) {
    workExceptionError(error);
  }

  const id = await ctx.db.insertWorkException(input, stamp(ctx.now?.() ?? new Date()));
  const row = await ctx.db.getWorkException(id);
  if (row === null) throw new Error("created work exception not found");
  const view = toEmployeeViews(await ctx.db.listEmployeeProfiles()).find(
    (candidate) => candidate.idNumber === row.idNumber,
  );
  return jsonResponse(toWorkExceptionDto(row, view?.name), { status: 201 });
}

async function deleteWorkException(
  _request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireWritable(ctx);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !(await ctx.db.deleteWorkException(id))) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  return jsonResponse({ ok: true });
}

async function syncStatus(_request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  const last = await ctx.db.lastSync();
  return jsonResponse({ last_sync: last === null ? null : toSyncStatusDto(last) });
}

async function listSyncSchedules(_request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.listSyncSchedules();
  const last = await ctx.db.lastSync();
  const decision = isDue(
    rows,
    last === null ? null : new Date(last.startedAt),
    ctx.now?.() ?? new Date(),
  );
  return jsonResponse(rows.map(toSyncScheduleDto), {
    meta: { next_at: decision.nextAt === null ? null : decision.nextAt.toISOString() },
  });
}

async function createSyncSchedule(request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  requireWritable(ctx);
  let input: SyncScheduleInput;
  try {
    input = parseSyncSchedule(await jsonObject(request));
  } catch (error) {
    if (error instanceof SyncScheduleError) {
      throw new ApiError(400, error.code, error.message);
    }
    throw error;
  }

  const createdAt = stamp(ctx.now?.() ?? new Date());
  const id = await ctx.db.insertSyncSchedule(input, createdAt);
  return jsonResponse(toSyncScheduleDto({ id, createdAt, ...input }), { status: 201 });
}

async function deleteSyncSchedule(
  _request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireWritable(ctx);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !(await ctx.db.deleteSyncSchedule(id))) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  return jsonResponse({ ok: true });
}

async function updateSyncSchedule(
  request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireWritable(ctx);
  const id = Number(params.id);
  const body = await jsonObject(request);
  if (typeof body.enabled !== "boolean") {
    throw new ApiError(400, "INVALID", "enabled harus boolean.");
  }
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !(await ctx.db.setSyncScheduleEnabled(id, body.enabled))
  ) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  const rows = await ctx.db.listSyncSchedules();
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Not found");
  return jsonResponse(toSyncScheduleDto(row));
}

async function listEvents(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  requireCollector(ctx);
  const rawSince = url.searchParams.get("since") ?? "0";
  if (!/^\d+$/.test(rawSince)) {
    invalidQuery("since", "since must be a non-negative integer");
  }
  const since = Number(rawSince);
  if (!Number.isSafeInteger(since)) {
    invalidQuery("since", "since must be a non-negative integer");
  }
  const limit = positiveInt(url.searchParams, "limit", 100, 500);
  const rows = await ctx.db.listEvents({ since, limit });
  return jsonResponse(rows.map(toEventDto), {
    meta: {
      since,
      limit,
      // The id to pass as `since` on the next poll: only advance past rows the
      // caller actually received, so a short page does not lose events.
      next_since: rows.length === 0 ? since : rows[rows.length - 1]!.id,
    },
  });
}

async function listWebhooks(_request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  requireCollector(ctx);
  return jsonResponse((await ctx.db.listWebhooks()).map(toWebhookDto));
}

async function createWebhook(request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  requireCollector(ctx);
  let draft: ReturnType<typeof parseWebhookInput>;
  try {
    draft = parseWebhookInput(await jsonObject(request));
  } catch (error) {
    if (error instanceof HookError) throw new ApiError(400, error.code, error.message);
    throw error;
  }
  const createdAt = stamp(ctx.now?.() ?? new Date());
  const secret = newWebhookSecret();
  const id = await ctx.db.insertWebhook({ ...draft, secret, createdAt });
  const row = (await ctx.db.listWebhooks()).find((candidate) => candidate.id === id);
  if (row === undefined) throw new ApiError(500, "INTERNAL_ERROR", "Webhook tidak tersimpan.");
  // The secret is returned once, on creation, and never again.
  return jsonResponse({ ...toWebhookDto(row), secret }, { status: 201 });
}

async function updateWebhook(
  request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireCollector(ctx);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, "NOT_FOUND", "Not found");
  const body = await jsonObject(request);
  const row = (await ctx.db.listWebhooks()).find((candidate) => candidate.id === id);
  if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Not found");

  // Validate a merged draft so a partial update never has to resend every field.
  let draft: ReturnType<typeof parseWebhookInput>;
  try {
    draft = parseWebhookInput({
      url: body.url ?? row.url,
      events: body.events ?? row.events.split(","),
      enabled: body.enabled ?? row.enabled,
    });
  } catch (error) {
    if (error instanceof HookError) throw new ApiError(400, error.code, error.message);
    throw error;
  }

  if (!(await ctx.db.updateWebhook(id, draft))) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  const saved = (await ctx.db.listWebhooks()).find((candidate) => candidate.id === id);
  if (saved === undefined) throw new ApiError(404, "NOT_FOUND", "Not found");
  return jsonResponse(toWebhookDto(saved));
}

async function deleteWebhook(
  _request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireCollector(ctx);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !(await ctx.db.deleteWebhook(id))) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  return jsonResponse({ ok: true });
}

async function testWebhook(
  _request: Request,
  _url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  requireCollector(ctx);
  const id = Number(params.id);
  const row =
    Number.isSafeInteger(id) && id > 0
      ? (await ctx.db.listWebhooks()).find((c) => c.id === id)
      : undefined;
  if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Not found");

  const at = stamp(ctx.now?.() ?? new Date());
  const result = await sendTestEvent({ webhook: { url: row.url, secret: row.secret } });
  await ctx.db.recordWebhookAttempt(row.id, result.status, at, result.error);
  return jsonResponse({
    ok: result.ok,
    status: result.status,
    error: result.error,
  });
}

async function sync(_request: Request, _url: URL, ctx: ApiContext): Promise<Response> {
  requireWritable(ctx);
  try {
    return jsonResponse(toSyncResultDto(await ctx.sync()));
  } catch (error) {
    if (error instanceof SyncError) {
      throw new ApiError(409, error.code, error.message);
    }
    if (error instanceof DeviceError) {
      throw new ApiError(502, "DEVICE_UNAVAILABLE", "Device unavailable", {
        device_code: error.code,
      });
    }
    throw error;
  }
}

async function exportXlsx(_request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const now = ctx.now?.() ?? new Date();
  const query = parseExportQuery(url.searchParams, now);
  // Raw keeps every punch; the workbook narrows only recap/user sheets.
  const [punches, profiles, workExceptions] = await Promise.all([
    ctx.db.listPunches({ from: query.from, to: query.to }),
    ctx.db.listEmployeeProfiles(),
    ctx.db.listWorkExceptionSpansInRange(query.from, query.to),
  ]);
  const employees = toEmployeeViews(profiles);
  const calendar = ctx.getCalendar();
  const daily = composeDailyRows(punches, employees, calendar, workExceptions);
  const options: ExportOptions = {
    from: query.from,
    to: query.to,
    month: query.month,
    users: query.idNumbers,
    presence: "all",
    punctuality: "all",
    format: "excel",
    modes: query.modes,
    out: null,
  };

  try {
    const workbook = buildWorkbook({
      options,
      punches,
      daily,
      employees,
      calendar,
      today: today(now),
    });
    const mode = query.modes.join("-");
    const headers = new Headers({
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="absen-${mode}-${query.from}_${query.to}.xlsx"`,
      "content-length": String(workbook.buffer.byteLength),
      "cache-control": "no-store",
    });
    return new Response(workbook.buffer, { headers });
  } catch (error) {
    if (error instanceof ExportError && error.code === "NO_DATA") {
      throw new ApiError(404, "NO_DATA", error.message);
    }
    throw error;
  }
}

type RouteHandler = (
  request: Request,
  url: URL,
  ctx: ApiContext,
  params: Record<string, string>,
) => Response | Promise<Response>;

export type RouteAuth = "public" | "session" | "admin";

export interface ApiRoute {
  method: "GET" | "POST" | "DELETE";
  path: string;
  auth: RouteAuth;
  handle: RouteHandler;
}

export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/health",
    auth: "public",
    handle: (_request, _url, ctx) => health(ctx),
  },
  {
    method: "POST",
    path: "/api/v1/auth/login",
    auth: "public",
    handle: (request, _url, ctx) => login(request, ctx),
  },
  {
    method: "POST",
    path: "/api/v1/auth/logout",
    auth: "session",
    handle: (request, _url, ctx) => logout(request, ctx),
  },
  {
    method: "GET",
    path: "/api/v1/auth/me",
    auth: "session",
    handle: (request, _url, ctx) => me(request, ctx),
  },
  {
    method: "GET",
    path: "/api/v1/attendance",
    auth: "admin",
    handle: attendance,
  },
  {
    method: "GET",
    path: "/api/v1/employees",
    auth: "admin",
    handle: (_request, _url, ctx) => employees(ctx),
  },
  {
    method: "GET",
    path: "/api/v1/users",
    auth: "admin",
    handle: (_request, _url, ctx) => users(ctx),
  },
  {
    method: "GET",
    path: "/api/v1/work-exceptions",
    auth: "admin",
    handle: workExceptions,
  },
  {
    method: "POST",
    path: "/api/v1/work-exceptions",
    auth: "admin",
    handle: createWorkException,
  },
  {
    method: "DELETE",
    path: "/api/v1/work-exceptions/:id",
    auth: "admin",
    handle: deleteWorkException,
  },
  {
    method: "GET",
    path: "/api/v1/recap",
    auth: "admin",
    handle: recap,
  },
  {
    method: "GET",
    path: "/api/v1/summary",
    auth: "admin",
    handle: summary,
  },
  {
    method: "GET",
    path: "/api/v1/sync/status",
    auth: "admin",
    handle: syncStatus,
  },
  {
    method: "GET",
    path: "/api/v1/sync-schedules",
    auth: "admin",
    handle: listSyncSchedules,
  },
  {
    method: "POST",
    path: "/api/v1/sync-schedules",
    auth: "admin",
    handle: createSyncSchedule,
  },
  {
    method: "POST",
    path: "/api/v1/sync-schedules/:id",
    auth: "admin",
    handle: updateSyncSchedule,
  },
  {
    method: "DELETE",
    path: "/api/v1/sync-schedules/:id",
    auth: "admin",
    handle: deleteSyncSchedule,
  },
  {
    method: "POST",
    path: "/api/v1/sync",
    auth: "admin",
    handle: sync,
  },
  {
    method: "GET",
    path: "/api/v1/events",
    auth: "admin",
    handle: listEvents,
  },
  {
    method: "GET",
    path: "/api/v1/webhooks",
    auth: "admin",
    handle: listWebhooks,
  },
  {
    method: "POST",
    path: "/api/v1/webhooks",
    auth: "admin",
    handle: createWebhook,
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/:id",
    auth: "admin",
    handle: updateWebhook,
  },
  {
    method: "DELETE",
    path: "/api/v1/webhooks/:id",
    auth: "admin",
    handle: deleteWebhook,
  },
  {
    method: "POST",
    path: "/api/v1/webhooks/:id/test",
    auth: "admin",
    handle: testWebhook,
  },
  {
    method: "GET",
    path: "/api/v1/export.xlsx",
    auth: "admin",
    handle: exportXlsx,
  },
  {
    method: "GET",
    path: "/api/v1/me",
    auth: "session",
    handle: meProfile,
  },
  {
    method: "GET",
    path: "/api/v1/me/attendance",
    auth: "session",
    handle: meAttendance,
  },
  {
    method: "GET",
    path: "/api/v1/me/recap",
    auth: "session",
    handle: meRecap,
  },
  {
    method: "GET",
    path: "/api/v1/me/summary",
    auth: "session",
    handle: meSummary,
  },
  {
    method: "GET",
    path: "/api/v1/me/work-exceptions",
    auth: "session",
    handle: meWorkExceptions,
  },
];

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  if (!pattern.includes(":")) return pattern === pathname ? {} : null;

  const expectedParts = pattern.split("/");
  const actualParts = pathname.split("/");
  if (expectedParts.length !== actualParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < expectedParts.length; index++) {
    const expected = expectedParts[index]!;
    const actual = actualParts[index]!;
    if (expected.startsWith(":")) {
      if (actual === "") return null;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export async function route(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const candidates = API_ROUTES.flatMap((candidate) => {
    const params = matchPath(candidate.path, url.pathname);
    return params === null ? [] : [{ route: candidate, params }];
  });
  if (candidates.length === 0) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }

  const matched = candidates.find((candidate) => candidate.route.method === request.method);
  if (matched === undefined) {
    methodNotAllowed(candidates.map((candidate) => candidate.route.method));
  }
  const selected = matched.route;
  if (selected.auth === "session") requireSession(request, ctx);
  else if (selected.auth === "admin") requireAdmin(request, ctx);
  return selected.handle(request, url, ctx, matched.params);
}
