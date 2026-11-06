# AGENTS.md

Project: `absenly` - one Bun app to sync a ZKTeco X606-S, analyze attendance, and serve an admin web UI. A future employee dashboard will live in the same app.

Read in this order before changing code:

1. `docs/ARCHITECTURE.md` - module map, schema, business rules, phases.
2. `docs/API.md` - device port and HTTP `/api/v1` contract; `docs/CLI.md` - command `app`.
3. The matching guide in `docs/agent/` (`zk-device.md` or `operations.md`).
4. `src/device.ts` and `src/zk.ts` - device port and the hardware-verified adapter.

If a guide note conflicts with `docs/ARCHITECTURE.md`, `docs/API.md`, or `docs/CLI.md`, the docs win.

## Current state

Core Phase 1 is hardware-verified on 2026-10-21: `src/schedule.ts`, `src/config.ts`, `src/time.ts`, `src/db.ts`, `src/device.ts`, `src/zk.ts`, `src/sync.ts`, `src/app.ts`, and `src/cli.ts`. CLI `app sync` and `app device probe` work against the X606-S; `app help` and `app --version` work. Phase 2 is implemented: pure `src/recap.ts` (detik + menit), `app export --json`, and four Excel modes (`raw`, `recap`, `user`, `poin`) in `src/export.ts`. Phase 3 admin API is implemented: `app serve` provides admin login/token, health, raw attendance, employees, recap, summary, work-exceptions (list/create/delete), sync status/trigger, and Excel export. Phase 4 admin web is implemented on top of the same API/services: a vanilla-JS shell with Home, Generate, Log Absensi, Karyawan, Jadwal, Hooks, Settings, and About; lazy per-tab modules; password change/reset; login throttle; backup; atomic `schedule.json` editing with hot reload; Home's top-5 longest late-streak list; Generate's combined `raw,recap,user,poin` mode; and a public, server-rendered individual recap page. Schema v5 adds `share_links` (UUID bearer token, one employee/month, fixed 24-hour expiry) after v4's `admin_credentials` (password hash). `employee_profiles` (display name, prefix/suffix title, active) is managed by the web and `app employees list|update`; inactive employees are hidden from recap/user/poin sheets and the individual share picker, new share links for them are rejected, and the current-month grid stops at today. Existing share links stay valid until expiry. Phase 7A collector relay is implemented: `ReadStore`/`SqliteReadStore`, the GET-only `/relay/v1` listener with a separate Bearer token, and raw meta/employees/schedule/attendance/snapshot routes. Phase 7B1 read-only viewer is implemented: `RelayReadStore`/`RelayScheduleStore`, viewer `serve`/`export`, read-only UI guards, and `app relay status`; full viewer admin editing is deferred to 7B2. Phase 5 hardening adds the documented daily sync log: `src/log.ts` (`createFileLogger`, `NOOP_LOGGER`) writes `logs/YYYY-MM-DD.log` with `sync start`/retry/`sync done`/`sync error` lines, injected into `syncNow`, never logging names, PINs, or the comm key, and never throwing. Phase 6 employee dashboard is implemented offline: schema v6 `app_users` (argon2id, one account per `employee_id_number`, cascade on employee delete), employee login through the same form/cookie/Bearer, `app users list|set-password|delete` (collector-only), the server-rendered `/me` page (`src/web/me.ts`, month picker, last 6 months) and employee-only `GET /api/v1/me`, `/me/attendance`, `/me/recap`, `/me/summary`, `/me/work-exceptions` scoped by the session (never a query param). The Karyawan tab manages logins too: `GET /api/v1/users` plus `POST /employees/:id/account` (create/reset to `satutekad`, username defaults to the PIN, reset keeps the username) and `POST /employees/:id/account/delete`; both revoke that employee's live sessions and are hidden on a viewer. Employees change their own password at `GET|POST /me/password` (old password required, minimum 8 characters, current session kept, other sessions revoked, wrong old passwords share the login throttle). Admin pages redirect employee sessions to `/me`; admin write actions return `403`; `/me/*` returns `403` for admins. Do not pretend planned commands work. Live parity on 2026-10-21: every user and record matched field-by-field. Live sync on 2026-10-22: a full pull; a second run added no duplicates. Live sync on 2026-10-29: two identical pulls with zero duplicate keys. Phase 3/4 endpoint and web verification on 2026-10-22/23 used fixtures/fakes because the machine was outside the attendance network. Relay verification uses fakes in `tests/relay.test.ts`, `tests/relay-client.test.ts`, and `tests/viewer.test.ts`. LAN E2E on 2026-10-29 (collector `192.0.2.20:3100`, separate viewer on `:3020`) matched on employees, October recap, summary, and work-exceptions, created no local viewer DB, and failed closed on collector stop/wrong token/timeout/malformed JSON; live ZeroTier-tunnel E2E is pending. Schema v7 adds `sync_schedules` (auto-sync windows). `src/auto-sync.ts` holds the pure `isDue`/`parseSyncSchedule` rules and the `createAutoSync` ticker that `app serve` starts on the collector only; schedules are DB-configured from Settings or `/api/v1/sync-schedules` (no env key), default off, re-read every 30 seconds so an edit needs no restart. A live smoke on 2026-11-04 verified create/list/toggle/delete, `400` on a midnight-crossing window, `403` on cross-site, and a real tick that fired, failed on an absent device, logged `auto sync error`, and kept running. Phase 8 Hooks is implemented: schema v8 `events` (append-only outbound log: `attendance.changed`, `sync.done`, `sync.failed`, thin payloads only) and `webhooks` (url, HMAC secret, subscribed events, enabled, last attempt); `GET /api/v1/events?since=<id>&limit=` is the cursor a bot polls, `GET /api/v1/recap?presence=missing_out` answers "checked in, not out yet", and `GET|POST /api/v1/webhooks`, `POST /api/v1/webhooks/:id`, `DELETE /api/v1/webhooks/:id`, `POST /api/v1/webhooks/:id/test` manage push targets. Delivery is fire-and-forget (`serve` does not await it), 5 s timeout, one attempt, HMAC `X-Rekap-Signature`, loopback/link-local URLs rejected; a failure leaves `attempts`/`last_error` and the consumer recovers via `?since=`. A real webhook delivery was verified on 2026-11-05 (HMAC-verified against a public receiver). Hooks are collector-only (viewer `403`); the Hooks tab replaces the placeholder. `app sync` awaits one flush before closing the DB.

The protocol implementation is self-contained in `src/zk.ts`; there is no local research checkout.

## Design first

Use the `docs/agent/design-review.md` guide (Design Thinking) for non-trivial work:

- Name the shapes (records, IDs, errors).
- Draw the happy path as a call graph.
- Mark retry/escape/die points.
- Validate at boundaries (env, HTTP, device bytes).
- Keep analysis pure; swap the data source in tests.

KISS: the smallest change that fully solves the task. No speculative abstractions.

## Ponytail (lazy senior dev mode)

Use the `ponytail` guide on every coding task; the full rules and levels are in
`docs/agent/ponytail.md`. Default to lazy senior dev mode: solve the
whole problem with the least new code, keep the change complete (callers, tests,
fixtures, config, exports), and end the reply with what was skipped or not
checked plus any risk the user must know. Do not cut validation at trust
boundaries, data-loss handling, security, accessibility, hardware calibration,
or anything the user asked for. Levels: `lite`, `full` (default), `ultra`.

## Stack

- Bun + TypeScript, strict mode.
- Native `bun:sqlite`.
- `Bun.serve` with a server-rendered HTML shell + vanilla-JS admin tabs, plus a JSON `/api/v1` for the future dashboard.
- No web framework, ORM, React, or frontend build; client tabs are lazy `import()` modules embedded as text assets.
- `xlsx` for Excel.
- One process, one SQLite DB, one entrypoint (`src/app.ts`). Do not split into services.

## Planned commands

```bash
bun install
bun run start          # admin web + API
bun run dev            # admin web + API, watch
bun run sync           # one device sync
bun run export -- --for-month 2026-10 --json
bun run export -- --for-month 2026-10 --excel
bun run check          # fmt + lint + typecheck + test + e2e:local + compile
bun run compile        # standalone dist/app.exe

# Compiled CLI
app serve
app sync
app device probe --json
app export --for-month 2026-10 --json
app export --for-month 2026-10 --excel
app export --for-month 2026-10 --excel --mode raw,recap,user
app employees list [--json]
app employees update --id 992 --display-name "Budi" --prefix-title "H." --suffix-title ", S.Kom" [--json]
app employees update --id 993 --active false [--json]
app users list [--json]
app users set-password [--username budi] --employee-id 992 --password "rahasia-1" [--json]
app users delete --username budi [--json]
app admin reset-password [--json]  # clears DB hash; env bootstrap applies again
app relay status --json
```

These scripts exist in `package.json`; they start working as the phases land.

## Architecture map

```
app.ts -> cli.ts
  ├─ serve  -> web/ (shell + assets + actions) + api/ (JSON /api/v1) -> services
  ├─ sync   -> sync.ts -> device.ts (port) <- zk.ts -> TCP 4370
  ├─ export -> db.ts + reports.ts + export.ts
  └─ relay  -> collector serves read-only raw data over ZeroTier; viewer client reads it (no device, no chain)
```

- `device.ts` is the device port (`DeviceGateway`); `zk.ts` is the adapter. `sync.ts` depends on the port, never on the protocol adapter.
- `employees.ts` composes the report name from `employee_profiles` and exposes the active flag; export consumes `EmployeeView`, not raw DB rows.
- `zk.ts` is the only module that talks to the device. Never import it from web/API; `serve` passes a read-only probe callback from `cli.ts`.
- `recap.ts` is pure: no DB, no HTTP, no device. Admin, API, CLI, and employee views reuse it.
- `reports.ts` owns the shared display-name, active-employee, and recap-filter policy; API, CLI JSON, and the workbook use it.
- `share-report.ts` is pure monthly share math; `share-links.ts` owns UUID creation and the fixed 24-hour TTL; `web/share.ts` only renders. Do not duplicate streak/late rules in the web layer.
- `period.ts` owns date/month/range validation; API, CLI, export, and schedule validation use it.
- `hooks.ts` owns event dispatch: URL guard, HMAC signature, 5 s timeout, one attempt, never throws. `sync.ts` only writes event rows; no business rule (who is late, who forgot to check out) lives in the server — consumers ask `GET /api/v1/recap?presence=missing_out`.
- `db.ts` owns schema, migrations, and queries; `schedule-store.ts` owns hot reload + atomic schedule writes; `login-throttle.ts` owns the in-memory login throttle.
- `api/` and `web/` are HTTP adapters; `auth.ts` is shared. No business rules hidden there. Web mutations are POST routes under web paths; the SPA reads `/api/v1`.
- `cli.ts` calls services directly, never HTTP.
- Dependency direction is one-way: `web/api/cli -> service -> db/device`.

## Never break

1. **Device is read-only.** Only read-only operations: connect, counts/identity/time, users, attendance, optional subscribe, disconnect. Never clear data, delete user, set time, restart, power off, or write options. Never port pyzk `live_capture()`; it can enable/disable the device.
2. **Use `id_number` (PIN), not `uid`.** UID is unreliable in the 40-byte attendance record.
3. **IN/OUT comes from time:** earliest punch `< 10:00:00` is IN; latest punch `>= 10:00:00` is OUT. Raw `punch` 0/1 can be wrong.
4. **No tolerance, schedule from the JSON calendar.** Late if IN is after the resolved day's `in`; early if OUT is before the resolved day's `out`. `schedule.json` holds a full base week plus date-range overrides (monthly/seasonal, e.g. Ramadan). A workday is a resolved day with a schedule; never hardcode Monday-Saturday or Sunday. Sunday is off only when the calendar says `null`.
5. **Times are WIB.** Store device `date`/`time` as-is. Do not convert to UTC.
6. **Sync is idempotent.** `UNIQUE (id_number, date, time)` + upsert. Running twice must not add rows.
7. **No partial sync.** If the parsed count differs from the device count, abort and commit nothing. A live punch can race `readSnapshot()`; retry the whole sync 1-2x, never commit partial rows.
8. **No automatic deletes.** A drop in device records is a warning, not a reason to delete server data. At the 100k capacity, archive/compaction is an admin decision; never clear the device from the app.
9. **Secrets stay in `.env`.** Never hardcode or log credentials/comm key. All env keys use the `ABSEN_` prefix. The device's old web login/telnet password is not an app credential; do not integrate or commit it.
10. **Auth on every data route.** Public only: `GET /login`, `POST /login`, `GET /assets/*`, `POST /api/v1/auth/login`, `GET /api/v1/health`, and `GET /share/<uuid>` (bearer link). Sync/export/work-exceptions/share creation admin-only; `/me/*` employee-only; employee scope is enforced on the server. Web mutations require an admin session and same-origin/Sec-Fetch-Site checks, except `/me/password` which requires an employee session (it changes only that account's own password and revokes its other sessions); the cookie is `HttpOnly`, `SameSite=Strict`, 8 hours. `Origin: null` is treated as absent (a proxied/saved page sends it) and `Sec-Fetch-Site` remains the gate; a rejected origin on an employee page returns HTML, never JSON. Failed logins are throttled (5 per IP / 15 minutes); wrong old passwords on `/me/password` share the same throttle. `ABSEN_WEB_PASSWORD` is bootstrap only; once `admin_credentials` has a hash, only the DB password is accepted, and `app admin reset-password` clears it locally.
11. **Escape HTML.** Never interpolate user/device data into HTML without `esc()`; no secrets, password hash, comm key, or stack traces in the shell bootstrap.
12. **Tests never hit the live device.** Use fixtures, `:memory:` DB, and fake config.
13. **API v1 contract.** Base `/api/v1`, snake_case wire format, success `{ data, meta }`, error `{ error: { code, message } }`. Additive changes only in v1. No stack traces, SQL, credentials, or comm key in responses.
14. **CLI JSON is a contract.** `--json` writes only JSON to stdout; errors go to stderr; exit `0`/`1`/`2`. Never mix progress logs into stdout.
15. **One app.** Web, API, and CLI share the same services. Do not call HTTP from the CLI or duplicate recap logic.
16. **Device code is self-contained.** `src/zk.ts` owns the protocol and must not import DB, web, or API modules.
17. **Rare work stays in `work_exceptions` and merges as a waiver.** Store piket/overnight/overtime planned spans there; never mutate raw attendance. `applyWorkExceptions` (pure) flags the span's `start_date` as `piket` and zeroes `late`/`early` on every date the span touches. One night shift is one duty day. Overtime minutes are not computed. Piket `21:00`-`07:00` is `night_shift`, not a daily schedule.
18. **Relay is read-only and never reaches the device.** The collector serves raw data only over the ZeroTier tunnel; a viewer may read raw rows and the schedule, never device, sync, or write. Keep the relay token server-side, never expose ZK TCP through the tunnel, and never let a viewer serve another relay (no chain).
19. **Schedule writes are atomic and hot-reloaded.** `ScheduleStore.save` validates via `parseScheduleCalendar`, writes a temp file + rename, updates the in-memory calendar, and `reloadIfChanged` watches mtime. Env-backed schedules are read-only. Browser reload is not a server restart; recap status is not recalculated in a table.
20. **Backups use SQLite `VACUUM INTO`.** A downloaded backup contains the admin password hash and share-link tokens; treat it as a secret. `app admin reset-password` does not revoke running sessions; restart `serve` to drop them.
21. **Share links are public, read-only, and scoped.** One active employee + one month, UUID v4 bearer token, fixed 24-hour expiry. Inactive employees are hidden from the picker and new links for them are rejected; existing links stay valid. Invalid/expired/malformed links share the same generic 404. Responses are `no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`. No active-link list, no revoke, no `/api/v1` share endpoint, no client data fetch. Treat a link URL as a secret until it expires.
22. **Hooks never block a sync.** `dispatchEvents` is fire-and-forget after the sync commits, has a 5 s timeout, one attempt, no retry, and never throws; a dead receiver must not slow a sync or fail a request. Event payloads stay thin (no names, PINs, or comm key) and the server holds no business rule — a consumer asks `/api/v1/recap?presence=missing_out`. Webhook URLs reject `127.*`, `localhost`, `*.localhost`, `0.0.0.0`, `::1`, and `169.254.*`. Hooks are collector-only (viewer `403`); the webhook secret is a secret in backups and is returned only once, on create.

## Data rules

- `employees` is the master; `employee_profiles` is the display/active overlay (keyed by `id_number`, never written by sync); `attendance` stores raw punches; `sync_log` stores sync metadata; `work_exceptions` stores planned rare-work spans; `sync_lock` is the internal cross-process sync lock; `admin_credentials` holds the single admin password hash; `share_links` holds UUID bearer links (one employee/month, 24h).
- `employee_profiles` is seeded for every employee (active default 1) and never overwritten by sync; the web and CLI edit the same overlay. `display_name` NULL means use the device name.
- `sync_log` stores every attempt, duration, counts, first/last date, `ok`, and `error`. Serial/firmware/clock drift can be added when the adapter exposes identity/time; do not fake them.
- `sync_lock` is an internal one-row advisory lock. `syncNow` acquires it before device access and releases it in `finally`; never bypass it. A stale lock expires after 5 minutes.
- `admin_credentials` stores a `Bun.password` (argon2id) hash. It is never synced or exposed; `VACUUM INTO` backups include it. `app_users` stores employee logins (also argon2id, never synced/exposed, included in backups) and is created by the Karyawan tab or `app users`; a new account defaults to the PIN as username and `satutekad` as password, and reset keeps the username. Current schema version is 8.
- `share_links` maps a plaintext UUID v4 token to one `id_number` + `month` with a fixed 24-hour `expires_at` (epoch ms). There is no revoke/list UI; expired rows are purged opportunistically on link creation. The URL is the secret.
- `events` is an append-only outbound log written after the sync transaction commits. Three names: `attendance.changed` (only when a sync inserted new punch rows), `sync.done`, `sync.failed`. Payloads are thin: counts, dates, duration, error text — never names, PINs, or the comm key. A failed event write is logged and swallowed; it never fails a sync. `GET /api/v1/events?since=<id>` is the durable recovery path.
- `webhooks` holds outbound targets: `url` (http/https, no loopback/link-local), plaintext `secret` for the HMAC, subscribed `events`, `enabled`, and the last attempt's status/error. Delivery is fire-and-forget after the sync, 5 s timeout, one attempt, **no retry**: a failure sets `attempts`/`last_error` and the consumer catches up through `?since=`. An event with no enabled subscriber is marked delivered immediately. Both tables are collector-only; a viewer has neither.
- Relay rows are raw: `id_number`, `date`, `time`, `punch`, `verify`, plus the calendar. Names on raw rows come from the device (`employees.name`), never the display overlay. The viewer recomputes IN/OUT, status, and recap; it keeps no local clone and falls back to nothing when the collector is unreachable. Work exceptions are not relayed, so a viewer has no piket/overtime ledger and reports the unwaived recap.
- `work_exceptions` is a ledger, not attendance. `kind` is `overtime | night_shift | holiday_work | other`; `night_shift` covers piket. `end_date` may be the next day. It merges into recap/export as a waiver (`piket` status, `late`/`early` zeroed); overtime minutes are not summed.
- Store `raw_punch` and `verify` for audit. `verify=15` means FACE, not IN/OUT.
- Name is normalized via `employees.id_number`. If an attendance ID has no master, insert a placeholder (`name = id_number`).
- Do not assume 2 punches per user-day. Real data has 1-9; the earliest/latest rule handles it.
- Device counts are live and change between reads. Never hardcode a record count.
- A device clock drift >5 minutes is a warning only. Never set the device clock.
- Do not add a daily recap table until read performance actually requires it.
- Migrations use `PRAGMA user_version` in `db.ts`; do not add a migration framework.

## Code style

- TypeScript strict; avoid `any`. Use `unknown` at boundaries and narrow.
- Small pure functions for rules; side effects at the edges.
- Explicit error messages with stable codes where the UI/CLI needs them.
- Comments only for non-obvious decisions (protocol quirks, 10:00 rule, UID trap).
- Match the existing formatting; run `bun run fmt` before finishing.
- No new runtime dependency without a real need. `xlsx` is the only one planned.

## Testing

- `bun test` must pass without network or device. `bun run e2e:local` (`scripts/e2e-local.ts`) is the one loopback-only check: two real `app serve` processes on `127.0.0.1` in a temp dir, no device, no ZeroTier. `bun run check` runs it, so a viewer/collector regression fails the normal gate.
- Cover sync lifecycle logging (`tests/log.test.ts`, `tests/sync.test.ts`): start/done/retry/error lines, one line per event, no names/PINs, and logging failure must not throw.
- Cover auto-sync (`tests/auto-sync.test.ts`, `tests/db.test.ts`, `tests/api.test.ts`, `tests/web.test.ts`): window edges, `every_minutes` since the last attempt (a failed attempt still rate-limits), weekday lists, multi-row union, midnight-crossing rejection, `nextAt`, ticker fire/idle/`SYNC_IN_PROGRESS` skip/failure keeps ticking, `sync_schedules` CRUD, admin-only API, web CSRF, and viewer `403`.
- Cover Hooks (`tests/hooks.test.ts`, `tests/api.test.ts`, `tests/web.test.ts`): loopback/link-local/credential/scheme URL rejection, event subset and dedupe, HMAC signature, dispatch to a subscribed webhook only, disabled and unsubscribed skips, one failed attempt that is never retried, a throwing fetch captured, a store failure swallowed, batch paging, `sendTestEvent`, `attendance.changed` only when a sync inserted rows, `sync.done`/`sync.failed`, a sync that still succeeds when the event write throws, the `?since=` cursor and `meta.next_since`, secret returned once on create and never on list, and viewer `403` / admin-only access.
- Cover the 10:00 boundary, earliest/latest, late by 1 minute, base vs override schedule (Monday vs Saturday), day off (Sunday), missing IN/OUT, and idempotent upsert.
- Cover calendar validation: full week, `IN < OUT`, at least one workday, date ranges, priority/overlap, flat env fallback.
- Cover `work_exceptions` validation/overlap and the recap waiver (`tests/work-exceptions-recap.test.ts`): late/early zeroed after a piket, a piket with no punch still present, a piket on a day off is not `libur`, one night shift is one duty day.
- Cover API envelope/error/pagination and CLI argument/exit behavior.
- Cover web auth/CSRF/headers, employee profile actions, schedule save/hot reload/read-only, password change, logout-all, backup, and probe with fakes and `:memory:` DB.
- Cover auth bootstrap-vs-DB password behavior, throttling, and session expiry; schedule-store reload/atomic save/error retention; dashboard metrics/schedule-impact helpers.
- Cover share auth/scope: admin-only creation, fixed 24h expiry, one-employee isolation, public rendering without a session, invalid/expired/malformed 404, and no-store/no-referrer/noindex headers.
- Cover employee dashboard (`tests/me.test.ts`, `tests/web.test.ts`): employee login role/scope, `/api/v1/me*` own-data isolation, `employee_id` rejection, admin `403` on `/me/*`, employee `403` on admin routes, `/me` HTML role redirects and month validation, `app users` create/rotate/delete and exit codes, account create/reset/delete from the web (default password, username reuse, session revocation, viewer `403`, CSRF), and `/me/password` (old password required, 8-character minimum, other sessions revoked, current session kept, throttle `429`, admin redirect).
- Cover collector relay auth: the relay token is read-only; no sync/device/write; the listener never proxies `/api/v1`; viewer mode/no-chain tests land with 7B.
- Manual integration: `app sync`; verify the full user list and record snapshot (live count grows). Run twice: no duplicates; counts may grow if a punch arrives. The Phase 4 web/schedule/probe checks are offline until the machine is back on the attendance network.
- `bun run check` before declaring done once `src/` exists.

## Guides

- `docs/agent/design-review.md` - design/architecture review method.
- `docs/agent/ponytail.md` - lazy senior dev mode; smallest complete change, levels `lite|full|ultra`.
- `docs/agent/zk-device.md` - device protocol, client contract, traps, read-only rules.
- `docs/agent/operations.md` - config, schema, recap rules, API/CLI contracts, web/auth, export, tooling.
- `docs/agent/relay.md` - collector/viewer roles, read-only relay over ZeroTier, no chain, no device.

## Workflow

1. Read the docs/guide for the area.
2. Write the smallest change; keep module boundaries.
3. Add/adjust tests for business rules.
4. Run `bun run check`.
5. Report what changed, what was verified, and what remains.
6. If an `/api/v1` route, query parameter, response field, auth rule, or error code changed, update `docs/API.md` and `docs/curl.md` in the same change. `docs/curl.md` documents implemented endpoints only.

## Environment notes

- Windows, PowerShell. In a PowerShell terminal use `;` instead of `&&` between shell commands. Package scripts run through Bun's shell and may use `&&`.
- Bun is the package manager. Use `bun add`, `bun add -d`, `bun install`.
- `src/zk.ts` is the hardware-verified protocol implementation; keep it self-contained and free of DB/web/API imports.
- Tests use fixtures and a fake device; never make `bun test` contact the live device.
