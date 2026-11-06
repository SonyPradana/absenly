# App architecture and operations

Read `docs/ARCHITECTURE.md`, `docs/API.md`, and `docs/CLI.md` for the full contracts. This guide is the short, actionable version.

The docs above are authoritative if a guide note differs.

## Shape

One Bun app, one process, one SQLite DB, one entrypoint:

```
app.ts -> cli.ts
  serve  -> web/ (shell + lazy tabs + actions) + api/ (JSON /api/v1) -> db + recap + export
  sync   -> sync.ts -> device.ts (port) <- zk.ts -> TCP 4370 -> db
  export -> db + recap + export.ts / api/dto.ts
```

- `device.ts` is the device port; `zk.ts` is the adapter. `sync.ts` depends only on the port.
- `recap.ts` is pure: no DB, HTTP, or device.
- `api/` and `web/` are HTTP adapters; `auth.ts` is shared. Web mutations are POST routes under web paths; the SPA reads `/api/v1`.
- `schedule-store.ts` owns atomic schedule saves + mtime hot reload; `login-throttle.ts` owns failed-login throttling.
- `cli.ts` calls services directly, never HTTP.
- Dependency direction: `web/api/cli -> service -> db/device`. No imports back.
- No microservices, no framework, no ORM, no React, no frontend build.

## Config

All env keys use `ABSEN_` (Windows already sets `USERNAME`).

| Key                   | Default         | Needed by                 | Notes                                             |
| --------------------- | --------------- | ------------------------- | ------------------------------------------------- |
| `ABSEN_ZK_HOST`       | -               | `sync`, `probe`           |                                                   |
| `ABSEN_ZK_PORT`       | `4370`          | `sync`, `probe`           |                                                   |
| `ABSEN_ZK_COMM_KEY`   | `0`             | `sync`, `probe`           |                                                   |
| `ABSEN_ZK_TIMEOUT_MS` | `10000`         | `sync`, `probe`           |                                                   |
| `ABSEN_SCHEDULE_FILE` | `schedule.json` | `serve`, recap, export    | JSON calendar; path may be absolute               |
| `ABSEN_SCHEDULE_IN`   | -               | recap, export             | flat shift, used only if the JSON file is missing |
| `ABSEN_SCHEDULE_OUT`  | -               | recap, export             | flat shift, used only if the JSON file is missing |
| `ABSEN_WEB_USER`      | -               | `serve`                   | required                                          |
| `ABSEN_WEB_PASSWORD`  | -               | `serve`                   | required bootstrap; DB hash wins after change     |
| `ABSEN_PORT`          | `3000`          | `serve`                   |                                                   |
| `ABSEN_HOSTNAME`      | `0.0.0.0`       | `serve`                   |                                                   |
| `ABSEN_DB`            | `absen.sqlite`  | `serve`, `sync`, export   |                                                   |
| `ABSEN_ENV`           | `production`    | `serve`, `sync`, export   | `production`, `staging`, or `test`; guards DB     |
| `ABSEN_ROLE`          | `collector`     | all                       | `collector` (device owner) or `viewer`            |
| `ABSEN_RELAY_ENABLED` | `false`         | collector                 | opt-in read-only relay listener                   |
| `ABSEN_RELAY_HOST`    | -               | collector + relay         | ZeroTier address to bind                          |
| `ABSEN_RELAY_PORT`    | `3100`          | collector + relay         | separate from the admin API port                  |
| `ABSEN_RELAY_TOKEN`   | -               | collector + relay, viewer | collector accepts it; viewer sends it             |
| `ABSEN_RELAY_URL`     | -               | `viewer`                  | collector base URL over the tunnel                |

Each command loads only its capability: `serve` = storage + web + schedule + device (device only for `/sync` and probe); `sync` = storage + device; `probe` = device; `export` = storage + schedule.

- `schedule.json`: `version: 1`, full `base` week (`SUNDAY`..`SATURDAY`, `null` = off), and `overrides[]` with inclusive `from`/`to`, `priority`, full-week `schedule` or `null` (holiday). Highest matching priority wins; same-priority overlaps are invalid.
- Validate `HH:MM`, `IN < OUT`, at least one workday per weekly schedule, real dates, unique ids.
- If the file is missing, use flat `ABSEN_SCHEDULE_IN`/`ABSEN_SCHEDULE_OUT` for every day (including Sunday), no overrides. If the file exists but is invalid, fail startup; do not fall back to env.
- `ABSEN_JAM_MASUK`/`ABSEN_JAM_PULANG` and per-day `ABSEN_SCHEDULE_<DAY>_*` are removed. Daily schedule is one day shift only; overnight/piket uses `work_exceptions`.
- Validate ports, timeout.
- `ABSEN_ENV=test|staging` must not use the default `absen.sqlite`; tests use `:memory:`.
- Timezone is the constant `Asia/Jakarta`, not env. Use `Intl` for `today()`/`stamp()`.
- `.env` is gitignored; `.env.example` is committed. `app serve` hot-reloads a changed `schedule.json`; one-shot commands read it at startup, so restart those after editing. Saves from the web are atomic and do not restart the server.
- An empty/whitespace `ABSEN_SCHEDULE_FILE` uses the default `schedule.json`.
- No `User`/`Password` keys without the prefix.

## Database

Tables: `employees`, `employee_profiles`, `attendance`, `sync_log`, `work_exceptions`, `sync_lock`, `admin_credentials`, `share_links`. Future: `app_users`. Schema version 5.

- `employees.id_number` is the PK and the join key (PIN, not UID).
- `employee_profiles` is the display/active overlay keyed by `id_number`: `display_name` (NULL = device name), `prefix_title`, `suffix_title`, `active`. Sync never writes it. Every employee is seeded with a profile (active default 1) and existing rows are not overwritten. `active=0` hides the employee from recap/user sheets; raw punches stay. Report name = prefix + name + suffix (a suffix starting with `.`/`,` attaches without a space).
- `attendance` stores raw punches: `date`, `time`, `status`, `raw_punch`, `verify`, `synced_at`.
- `UNIQUE (id_number, date, time)`; upsert on sync.
- `sync_log` records every attempt: duration, counts, first/last date, `ok`, `error`. Serial/firmware/clock drift are optional when the adapter exposes identity/time; do not fake them.
- `work_exceptions` is a ledger for rare work: `id_number`, `kind` (`overtime|night_shift|holiday_work|other`), `start_date/time`, `end_date/time`, `note`, `created_at`. `night_shift` covers piket `21:00`-`07:00`; `end_date` may be the next day.
- `work_exceptions` is not attendance. Raw punches stay in `attendance`; normal recap/export does not consume exceptions yet. Reject overlapping spans for the same employee.
- `admin_credentials` stores one `Bun.password` (argon2id) hash, never plaintext. `ABSEN_WEB_PASSWORD` is bootstrap only; a DB hash overrides it. `app admin reset-password` clears the hash. Backups contain the hash; treat them as secrets.
- `share_links` maps a plaintext UUID v4 token to one `id_number` + `month` with a fixed 24-hour `expires_at` (epoch ms). The URL is the bearer secret. No revoke/list UI; expired rows are purged opportunistically when a new link is created.
- Device counts are live and change between reads. Never hardcode a record count.
- `status` is a cache derived from `time`; recap recomputes from `time`.
- WAL mode, foreign keys on, busy timeout.
- Migrations: `PRAGMA user_version` + array in `db.ts`. No migration framework.
- No daily recap table. Derive on read. Add a cache only if measured slow.

## Recap rules

- IN = earliest punch `< 10:00:00`; OUT = latest punch `>= 10:00:00` for normal day-shift recap.
- Real data has 1-9 punches per user-day, not always 2. Earliest/latest handles it.
- Late = workday and `inTime > resolved.in`; minutes difference, **no tolerance**.
- Early leave = workday and `outTime < resolved.out`; minutes difference.
- Workday = the resolved calendar day has a schedule. No hardcoded Monday-Saturday; Sunday is off only when the calendar says `null`.
- Global monthly/seasonal changes (Ramadan, holidays) are date-range overrides in `schedule.json`; highest matching priority wins.
- Daily schedule is one day shift (`IN < OUT`). Piket/overnight `21:00`-`07:00` is stored in `work_exceptions` as `night_shift`, not in the daily schedule.
- `work_exceptions` do not alter recap/export yet. Keep them a separate ledger until overtime/piket rules are confirmed.
- Piket punches remain in `attendance`; normal recap may show `tanpa_masuk`/`belum_pulang` for those dates. Read `work_exceptions` for context.
- Missing IN -> "Tanpa masuk"; missing OUT -> "Belum pulang".
- Both late and early can apply; show both badges.
- `lateMinutes`/`earlyMinutes` are `null` when the relevant punch is missing, `0` when on time. `lateSeconds`/`earlySeconds` are the exact source; minutes are derived for JSON.
- Never use raw `punch` for IN/OUT.
- Default view: first day of current month through today (WIB), max 366 days.

Pure functions: `buildDaily(punches, resolveSchedule, splitTime)`, `filterDaily`, `summarize`, `paginate`. The employee dashboard reuses them with a scoped `idNumber`.

## HTTP: web + API

Web routes:

- `GET /login`, `POST /login` public; `GET /assets/*` public.
- Admin shell: `GET /`, `/generate`, `/log`, `/employees`, `/schedule`, `/hooks`, `/settings`, `/about`; clean URLs, lazy tab modules, in-memory cache.
- Mutations: `POST /logout`, `POST /employees/:id/profile`, `POST /schedule`, `POST /settings/password`, `POST /settings/logout-all`, `POST /about/probe`, `POST /generate/share` (admin, creates a 24h UUID link).
- `GET /settings/backup` downloads a `VACUUM INTO` SQLite snapshot.
- `GET /share/<uuid>` public server-rendered individual recap; one employee/month, no login, generic 404 for invalid/expired, `no-store` + `no-referrer` + `noindex`.
- `GET /me` employee (future phase).
- `/api/v1/*` JSON API, see `docs/API.md`.

Dashboard tabs:

- Home: active/today/month metrics, rankings (including top-5 longest late streaks; holidays skipped, absence breaks), recent punches, month progress.
- Generate: one Excel file; raw, recap, user, or all (`raw,recap,user`) mode; plus the public individual share-link card.
- Log Absensi: date range/employee filter, 100 raw punches/page.
- Karyawan: display name, prefix/suffix, active; device name read-only.
- Jadwal: base week + overrides; env schedule is read-only.
- Hooks: placeholder.
- Settings: runtime info, backup, logout-all, password change; token/auto-sync not available.
- About: version, last sync, counts, on-demand read-only probe.

API v1 highlights:

- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
- `GET /api/v1/health` public; `GET /api/v1/employees`, `/attendance`, `/recap`, `/summary`, `/sync/status`, `/work-exceptions` admin.
- `POST /api/v1/sync`, `POST/DELETE /api/v1/work-exceptions`, `GET /api/v1/export.xlsx` admin.
- `work_exceptions`: `kind` enum, valid span max 48h, overlap -> `409 WORK_EXCEPTION_OVERLAP`; does not mutate attendance or recap.
- Export accepts `employee_id` or additive `employee_ids` (mutually exclusive); `raw` is always the full workbook. API filename `absen-{mode}-{from}_{to}.xlsx`.
- Future employee: `/api/v1/me`, `/me/attendance`, `/me/recap`, `/me/summary`, `/me/work-exceptions`.
- Wire format: snake_case; success `{ data, meta? }`; error `{ error: { code, message, details? } }`.
- Pagination: `page` (default 1), `per_page` (default 50, max 200).
- Period: `month=YYYY-MM` or `from`/`to`; max 366 days.
- Additive changes only in v1. No stack traces/SQL/credentials in responses.

Auth and security:

- Admin username from `ABSEN_WEB_USER`. `ABSEN_WEB_PASSWORD` is bootstrap only; once `admin_credentials` has a hash, only the DB password is accepted. Reset locally with `app admin reset-password`.
- In-memory session `Map`; cookie `absen_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`, 8h) or `Authorization: Bearer <token>` with the same token.
- Session has `{ role: "admin" | "employee", employeeIdNumber? }`. Phase 4 is admin only.
- Guard every data route; sync/export/work-exceptions/share creation admin-only; `/me/*` employee-only and scoped server-side.
- Public reads only: login/assets, `/api/v1/health`, `/api/v1/auth/login`, and `GET /share/<uuid>` (bearer, one employee/month, 24h). Invalid/expired links return the same 404; responses are `no-store`, `no-referrer`, `noindex, nofollow`.
- Failed logins are throttled in memory: 5 per IP per 15 minutes; `429 TOO_MANY_ATTEMPTS` + `Retry-After`.
- Web mutations require an admin session and Origin/Sec-Fetch-Site checks. HTML is escaped through `esc()`/`escAttr()`; bootstrap JSON is escaped as an attribute and contains no secrets.
- CSP (`script-src 'self'`), nosniff, DENY framing, no-store HTML/JSON, request body limits.
- Client assets are text imports in `src/web/assets/`, so compile is self-contained; no frontend build.
- `Bun.serve({ idleTimeout: 30 })` allows a ~1.2s sync plus overhead.
- Schedule saves validate + write temp/rename atomically; `reloadIfChanged()` watches mtime and keeps the last valid calendar on bad edits.
- Do not add a second API shape or camelCase JSON for the dashboard. Use `api/dto.ts`.

## Relay (future phase 7)

- Two roles: `collector` owns the device, SQLite, sync, and the admin API; `viewer` has no device, no sync, and no local attendance clone.
- Collector: `ABSEN_RELAY_ENABLED=true` + `ABSEN_RELAY_HOST` (ZeroTier address) + `ABSEN_RELAY_TOKEN` enable a read-only relay listener. Unset = disabled.
- Viewer: `ABSEN_ROLE=viewer` + `ABSEN_RELAY_URL` + `ABSEN_RELAY_TOKEN`; it pulls raw rows and computes recap/export/web itself.
- HTTP pull over the ZeroTier tunnel on its own port and path (`/relay/v1`); never proxy the admin `/api/v1` routes.
- Relay token is a read-only service principal, not a user role/session. Allowed GET: meta, employees, schedule, raw attendance, snapshot. Deny sync, device, work-exception writes, export.
- One hop: a viewer may never enable a relay, and a collector never reads from another relay.
- Viewer keeps its own admin login; the relay token stays server-side, never in the browser or logs.
- v1 is read-through live, no clone and no persistent cache. `app relay status [--json]` is planned and exits `2` until phase 7.
- Tests use a fake collector; no live device, no ZeroTier, no external network.
- See `relay.md` for the full design.

## Excel and JSON export

- `xlsx` is the only runtime dependency. The free writer gives column widths and a hidden helper row, not bold/freeze panes.
- Three modes, combinable with `--mode raw,recap,user` (default `recap`):
  - `raw`: `No | ID | Date | Name | Time | Status | Verification`. Every punch; `ID` = `id_number` as text; `verify=15` -> `Face`, else `Unverified`.
  - `recap`: two sheets, always together. `Masuk`/`Pulang` grids with dates as columns, employees as rows, cells in seconds (`0` on time, empty for missing punch or day off). Totals are Excel formulas (`SUM`, `COUNTIF`, `COUNTIFS`) over the row; a hidden workday row keeps holidays out of the absence totals.
  - `user`: one sheet per employee, `Date | Name | Time | Status | Verification | Keterangan Waktu`; earliest IN + latest OUT per day; `ok` / `Telat …` / `Pulang awal …` / `Libur`.
- Sheet names: `Raw`, `Masuk`, `Pulang`, then `<id_number> - <name>` (sanitized, max 31, deduped).
- `Nama` uses `employee_profiles`; inactive employees are skipped in `Masuk`/`Pulang`/user sheets, `Raw` keeps every punch, and explicit `--user` still selects an inactive employee.
- Current-month date columns stop at today (WIB); future dates are not counted as absence.
- Column widths are computed from content (dates uniform), plus the hidden workday row. No borders/bold/font/freeze with the free writer.
- Seconds are the recap source of truth; JSON still exposes minutes.
- Web Generate calls `/api/v1/export.xlsx`; API filename is `absen-{mode}-{from}_{to}.xlsx`. `employee_ids` narrows recap/user sheets; `raw` is full.
- CLI:
  - `app export --for-month 2026-10 --json` -> stdout, same `{ data, meta }` as `/api/v1/recap`.
  - `app export --for-month 2026-10 --excel [--mode raw,recap,user] [--out PATH]` -> file.
  - `app export --from 2026-10-01 --to 2026-10-31 --excel --mode user --user 992,993`.
- `--presence`/`--punctuality` are JSON-only; `--user` filters JSON and selects `user`-mode sheets.
- Default CLI Excel: `exports/rekap-2026-10.xlsx` or `exports/rekap-2026-10-01_2026-10-31.xlsx`.
- No rows: web/API 404 `NO_DATA`; CLI `--json` empty success; CLI `--excel` exit 1.
- `work_exceptions` are not in recap/export yet; expose them via the separate endpoint.
- Write dates as `dd/mm/yy` and times as `HH:MM:SS` strings to avoid timezone shifts.

## CLI and scripts

```bash
bun run start
bun run serve
bun run dev
bun run sync
bun run device -- probe --json
bun run export -- --for-month 2026-10 --json
bun run export -- --for-month 2026-10 --excel
bun run fmt
bun run lint
bun run typecheck
bun run test
bun run compile
bun run check
```

Compiled CLI:

```bash
app serve
app sync [--json]
app device probe [--json]
app export --for-month 2026-10 --json
app export --for-month 2026-10 --excel
app export --for-month 2026-10 --excel --mode raw,recap,user
app employees list [--json]
app employees update --id 992 --display-name "Budi" --active false [--json]
app admin reset-password [--json]
app relay status [--json]  # planned; exits 2 for now
```

Rules:

- `--for-month` is exclusive with `--from`/`--to`; one period form is required.
- Export requires exactly one of `--json` / `--excel`.
- `--json` writes only JSON to stdout; logs/errors go to stderr.
- Exit codes: `0` ok, `1` runtime/data/device error, `2` usage error.
- `app export` reads SQLite; it does not need the device or web server.
- Do not run two syncs at once. `syncNow` holds the SQLite `sync_lock` row across processes; schedule cron so it does not overlap manual sync.

## Ops

- Log daily to `logs/YYYY-MM-DD.log`: `sync_start`/`sync_done`/`sync_error`, duration, bytes, rows. Do not dump names/PIN, and never log the comm key.
- `GET /api/v1/health` returns last sync status; do not hit the device on every health check. Active probe = TCP + handshake + `GET_FREE_SIZES` (`app device probe`).
- Scheduler is external (Task Scheduler/cron `app sync` every 5 minutes). No internal scheduler in phase 1. Lock so syncs do not overlap; alert after 3 consecutive failures or count mismatch.
- Full sync is ~1.24 s at a few thousand records. At 100k it is ~50 s, near the 60 s budget. Plan archive/compaction before the device fills; never clear the device from the app.
- Device clock drift > 5 min is a warning. Never set the device clock.
- Device security: comm key 0, telnet 23 open, old web UI still uses the default password. Keep it on a LAN/VLAN; do not expose it, and do not use web/telnet for sync.
- SQLite backup: Settings downloads `VACUUM INTO`; the file contains the admin password hash and share-link tokens. For a manual copy, stop the app or checkpoint WAL.
- Share links are fixed at 24 hours and cannot be revoked. A leaked URL stays readable until expiry; expired rows purge on the next link creation.
- `app serve` hot-reloads `schedule.json`; saves from Jadwal are atomic and need no restart.
- Login throttle is in-memory: 5 failures/IP/15 minutes; restart clears it.
- Bind `0.0.0.0` only for LAN use. Do not expose to the internet without HTTPS and a strong password.
- Standalone build: `dist/app.exe`; run from the folder containing `.env`; DB/logs are relative to CWD.
- API tokens are in-memory; restart logs everyone out. Password change/logout-all revokes sessions; `app admin reset-password` does not, so restart `serve` to drop them.

## Employee dashboard seam

Future phase, same app:

1. Add `app_users` (`username`, `password_hash`, `role`, `employee_id_number`).
2. Login checks the DB admin hash (falling back to the env bootstrap only when no hash exists), then `app_users`; session sets role/employee id.
3. Add `GET /me` HTML and `/api/v1/me/*` JSON: profile, raw attendance, recap, summary, work-exceptions.
4. Enforce scope server-side: `WHERE id_number = session.employeeIdNumber`; reject `employee_id` on `/me/*`.
5. Use `Bun.password.hash/verify` for employee accounts.
6. Do not touch `device.ts`, `zk.ts`, `sync.ts`, `attendance`, or recap rules.

## Testing

- `bun test` must not touch the device.
- Cover 10:00 boundary, earliest/latest, 1-minute late, base vs override schedule (Monday vs Saturday), day off (Sunday), missing IN/OUT, upsert idempotency, export round-trip.
- Cover calendar validation: full week, `IN < OUT`, at least one workday, dates, priority/overlap, flat env fallback.
- Cover `work_exceptions` validation/overlap and confirm they do not change normal recap.
- Cover API envelope/error/pagination and CLI argument/exit behavior.
- Cover web auth/CSRF/headers, employee profile actions, schedule save/hot reload/read-only, password change, logout-all, backup, and probe.
- Cover auth bootstrap-vs-DB password, throttle, session expiry; schedule-store reload/atomic save/error retention; metrics helpers.
- Cover share creation auth/CSRF, fixed 24h expiry, one-employee isolation, public rendering without a session, invalid/expired 404, and security headers.
- Cover relay: relay token is read-only; viewer refuses sync/probe and cannot enable a relay; fake collector, no device.
- Manual integration: `app sync` twice; the full snapshot (live count grows), no duplicates. Counts may differ if a punch arrives between runs.
- Run `bun run check` (fmt, lint, typecheck, test, compile) before done.

## Common mistakes

- Loading every config block in every command (`serve` needing ZK/schedule, `probe` needing DB).
- Reading counts/users/attendance as separate calls for one sync snapshot; use `readSnapshot()`.
- `username`/`password` env keys without `ABSEN_`, or still using removed `ABSEN_JAM_MASUK`/`ABSEN_JAM_PULANG`.
- Storing name only in `attendance` (breaks the employee master/dropdown).
- Using raw `punch` or `uid`, or treating `verify=15` as IN/OUT.
- Auto-deleting rows when the device count drops.
- Hardcoding a record count; the device is live.
- Hardcoding Monday-Saturday or assuming Sunday is always off instead of resolving `schedule.json`.
- Falling back to env when the schedule file exists but is invalid; that hides a bad schedule.
- Putting a `21:00`-`07:00` piket into the daily schedule; use `work_exceptions.kind = night_shift`.
- Auto-merging `work_exceptions` into recap/export before the overtime/piket policy is confirmed.
- Assuming 2 punches per user-day (real data has 1-9).
- Treating `getAttendanceLogs({ since })` as a device filter; it is client-side.
- Porting pyzk `live_capture()`; it can enable/disable the device.
- Using the old web UI/telnet instead of native ZK, or exposing the device to the internet.
- Adding a scheduler/ORM "for later" before the core works.
- Forgetting auth on a web action, `/settings/backup`, `/about/probe`, `/api/v1/*`, or the schedule/profile routes.
- Letting `/me/*` read `employee_id` from the query instead of the session.
- Mixing CLI progress logs into stdout when `--json` is used.
- Giving a viewer device/sync/write access, exposing ZK TCP through the tunnel, or letting a viewer serve another relay.
- Treating the relay token as an admin session or sending it to the browser.
- Treating a share link as an admin session, making it cover more than one employee/month, or caching/indexing the public page.
- Breaking the v1 JSON shape by renaming fields instead of adding new ones.
- Putting business rules in `web/routes.ts` or API handlers.
- Serving the schedule editor from an env-backed calendar and pretending the save worked; env schedules are read-only.
- Logging the password hash, comm key, or bootstrap secrets.
