# absenly CLI

Status: **serve (admin web + API + optional collector relay), sync, device probe, export, employees, users, admin reset-password, and relay status implemented; read-only viewer mode (phase 7B1) implemented and LAN-E2E verified 2026-10-29; ZeroTier-tunnel E2E pending**. Full viewer admin editing (7B2) is not implemented. The CLI uses the same services as the web/API. In collector mode it never calls HTTP; a viewer `serve`/`export` reads the collector through the relay client.

Binary: `app` (Windows: `dist/app.exe`). From source: `bun run src/app.ts <command>`.

The CLI uses the same services as the web/API. The CLI **does not** call HTTP and does not need a web server.

## 1. Commands

```
app serve [--port N] [--hostname H]
app sync [--json]
app device probe [--json]
app export --for-month YYYY-MM [--user ID] (--json | --excel [--mode raw,recap,user,poin] [--out PATH])
app export --from YYYY-MM-DD --to YYYY-MM-DD [--user ID] (--json | --excel [--mode raw,recap,user,poin] [--out PATH])
app employees list [--json]
app employees update --id ID [--display-name NAME] [--prefix-title T] [--suffix-title T] [--active true|false] [--json]
app users list [--json]
app users set-password [--username U] --employee-id ID --password P [--json]
app users delete --username U [--json]
app admin reset-password [--json]
app relay status [--json]
app help
app --version
```

`app` with no command = `help`.

## 2. `app serve`

Starts the admin web dashboard at `/` plus the HTTP API at `/api/v1`.

- Defaults from env: `ABSEN_PORT=3000`, `ABSEN_HOSTNAME=0.0.0.0`.
- `--port` / `--hostname` override env for that process.
- Role comes from `ABSEN_ROLE` (`collector` default, or `viewer`).
- Collector: needs storage + web + schedule + device config. Schedule config is needed for recap; device config is needed by `POST /api/v1/sync` and the read-only About probe. It does not connect to the device at startup.
- Optional collector relay: `ABSEN_RELAY_ENABLED=true` with `ABSEN_RELAY_HOST` (a specific ZeroTier address) and `ABSEN_RELAY_TOKEN` starts a second GET-only listener on `ABSEN_RELAY_PORT` (default `3100`). It serves `/relay/v1` from `SqliteReadStore` and never touches the device. A collector with `ABSEN_RELAY_URL` set is rejected (`CONFIG_RELAY_CHAIN`).
- Viewer (`ABSEN_ROLE=viewer`): needs web config plus `ABSEN_RELAY_URL` and `ABSEN_RELAY_TOKEN` only. It does not open `ABSEN_DB`, read device config, or load `schedule.json`; the schedule comes from the collector. A viewer with `ABSEN_ZK_HOST` or `ABSEN_RELAY_ENABLED=true` is rejected (`CONFIG_VIEWER_DEVICE`, `CONFIG_VIEWER_CHAIN`).
- Viewer login is env-only: `ABSEN_WEB_PASSWORD` is always the bootstrap password because a viewer has no `admin_credentials` row. The relay token stays server-side.
- Viewer is read-only: Settings and Hooks are not served (`404`), the UI hides sync, employee edit, share creation, schedule editing, and the device probe, and mutations return `403 READ_ONLY_VIEWER`. Sync never contacts the device from a viewer.
- Viewer fail-closed: if the collector is unreachable, rejects the token, times out, or returns malformed data, the request fails with `502 RELAY_UNAVAILABLE`, `502 RELAY_AUTH`, `502 RELAY_BAD_RESPONSE`, or `504 RELAY_TIMEOUT`. It never serves stale or empty data.
- Web pages: `/` (Home), `/generate`, `/log`, `/employees`, `/schedule`, `/hooks` (webhook targets + recent events), `/settings`, `/about`, plus the employee dashboard at `/me`. A browser uses clean URLs and lazy per-tab modules; data is read from `/api/v1`. The Hooks tab writes through `/api/v1/webhooks`; there is no separate web form route.
- Web actions (admin session + same-origin check): `POST /logout`, `POST /employees/:id/profile`, `POST /employees/:id/account`, `POST /employees/:id/account/delete`, `POST /schedule`, `POST /settings/password`, `POST /settings/logout-all`, and `POST /about/probe`. `GET /settings/backup` downloads a `VACUUM INTO` SQLite snapshot. An employee session gets `403 FORBIDDEN` and cannot reach the admin pages.
- Login: `ABSEN_WEB_PASSWORD` is the bootstrap password. After a password change, only the DB hash in `admin_credentials` is accepted. Five failed logins per IP in 15 minutes are throttled; sessions expire after 8 hours. Employee accounts live in `app_users` and log in with the same form/cookie; an employee session lands on `/me`.
- Schedule: `schedule.json` is read at startup and hot-reloaded on mtime changes. Saves from the web are validated, written atomically (temp + rename), and do not restart the server. Env-backed schedules are read-only.
- Implemented API routes: auth, `GET /api/v1/health`, raw `GET /api/v1/attendance`, `GET /api/v1/employees`, `GET /api/v1/recap`, `GET /api/v1/summary`, `GET|POST /api/v1/work-exceptions`, `DELETE /api/v1/work-exceptions/:id`, `GET /api/v1/sync/status`, `POST /api/v1/sync`, `GET /api/v1/export.xlsx`, and the employee-only `GET /api/v1/me*` routes.
- `POST /api/v1/sync` contacts the device only when called; outside the attendance network it returns `502 DEVICE_UNAVAILABLE`.
- Graceful shutdown on Ctrl+C.

## 3. `app sync`

Syncs the device to SQLite once, then exits.

- Read-only device access.
- Needs ZK + DB config; it does not read schedule or web config.
- Full snapshot + upsert.
- Writes `logs/YYYY-MM-DD.log`: `sync start`, retry, success (`users`, `records`, date range, duration), or error. Never names, PINs, or the comm key.
- One sync at a time per database; a second process gets `SYNC_IN_PROGRESS`. A stale lock expires after 5 minutes.
- Writes a success/failure `sync_log`.
- Writes `events` rows (`attendance.changed` when new punches arrived, then `sync.done`, or `sync.failed`) and flushes one webhook dispatch before it closes the DB. Dispatch failures are recorded on the event and never change the exit code.
- Exit `0` on success, `1` on failure.
- `--json`: summary to stdout, logs/progress to stderr.

Example human-readable output:

```
sync ok: 42 users, 1234 records, 2026-09-28..2026-10-20, 1241 ms
```

Example `--json`:

```json
{
  "data": {
    "ok": true,
    "users": 12,
    "records": 240,
    "first_date": "2026-09-28",
    "last_date": "2026-10-20",
    "duration_ms": 1241,
    "synced_at": "2026-10-20T07:30:00+07:00"
  }
}
```

## 4. `app device probe`

Read-only diagnostic: connect, read counts, disconnect. It needs ZK config only; it does not open the DB, read the schedule, or fetch users/attendance.

```json
{
  "data": {
    "host": "192.0.2.10",
    "port": 4370,
    "users": 12,
    "records": 240,
    "users_cap": 2000,
    "records_cap": 100000
  }
}
```

Connection/auth failure -> exit `1`, error to stderr.

## 5. `app export`

Reads SQLite and produces a recap. It **does not** need the device or the web server.

Period:

- `--for-month YYYY-MM`: from the 1st through the end of the month (WIB).
- `--from YYYY-MM-DD --to YYYY-MM-DD`: inclusive.
- `--for-month` is exclusive with `--from`/`--to`; exactly one form is required.
- `--from` and `--to` must be paired; `from <= to`; maximum 366 days.

Filters:

- `--user ID[,ID]`: exact `id_number` (PIN), not UID. Comma list, may repeat. Without it = all employees.
- `--presence all|complete|missing_in|missing_out`: default `all`. `--json` only.
- `--punctuality all|late|ontime`: default `all`. `--json` only.

Format (choose exactly one):

- `--json`: write `{ "data": [...], "meta": {...} }` to stdout. Flat recap rows, same shape as `GET /api/v1/recap`; `--presence`/`--punctuality` apply here.
- `--excel`: write an `.xlsx` workbook with one or more sheet modes.
  - `--mode raw,recap,user,poin`: comma list, default `recap`, only with `--excel`.
  - `--out PATH` is optional; default `exports/rekap-<period>.xlsx`; the `exports/` folder is created automatically.
  - `--user ID[,ID]`: selects employees for the `user` and `poin` modes (comma list, may repeat). With `--excel` it requires `--mode user` or `--mode poin`.
  - `--presence`/`--punctuality` with `--excel` -> usage error, exit `2`.
- Recap/export does not include `work_exceptions` (piket/overtime) yet; that data has a separate endpoint.
- `--json` and `--excel` together -> usage error, exit `2`.
- No format -> usage error, exit `2`.
- Viewer mode reads punches, profiles, and the schedule from the collector over the relay; there is no local DB. A collector failure aborts the export with `RELAY_UNAVAILABLE`/`RELAY_AUTH`/`RELAY_TIMEOUT`/`RELAY_BAD_RESPONSE` and exit `1`.

### Excel modes

`raw` -> sheet `Raw`, every punch in the range, no dedupe:

| No  | ID    | Date     | Name       | Time     | Status | Verification |
| --- | ----- | -------- | ---------- | -------- | ------ | ------------ |
| 1   | 00123 | 01/10/26 | Dummy Budi | 06:58:12 | IN     | Face         |

- `ID` is `id_number` as text (leading zeros survive) and is the guard/sort key.
- `Status` is the 10:00 mapping: IN before `10:00:00`, OUT from `10:00:00`.
- `Verification` is `Face` for `verify=15`, otherwise `Unverified`.
- Sorted by date, time, then ID.

`recap` -> always two sheets, `Masuk` and `Pulang`:

- `Masuk`: `Nama | 01/10/26 … 21/10/26 | Total terlambat | Total hari terlambat | Total absen`
- `Pulang`: `Nama | 01/10/26 … 21/10/26 | Total pulang awal | Total tidak absen pulang`

Per employee row:

- Cell = seconds late (`Masuk`) or seconds early (`Pulang`); `0` when on time; empty when the punch is missing or the day is off.
- Totals are real Excel formulas over that row: `SUM`, `COUNTIF(...,">0")`, and `COUNTIFS` against a hidden workday row (1 = workday, 0 = day off), so empty holiday cells are not counted as absence.
- `Total absen` / `Total tidak absen pulang` = workday cells that are still empty.

`user` -> one sheet per employee, named `<id_number> - <name>` (sanitized, max 31 chars, duplicates get ` (2)`):

| Date     | Name       | Jadwal | Time     | Status | Verification | Keterangan Waktu      |
| -------- | ---------- | ------ | -------- | ------ | ------------ | --------------------- |
| 01/10/26 | Dummy Budi | 07:00  | 07:03:01 | IN     | Face         | Telat 3 menit 1 detik |

- `Jadwal` is the reference shift for that punch: the scheduled `in` on an IN row, the scheduled `out` on an OUT row, `Libur` on a day off. It is the baseline the human note is measured against.
- At most one IN and one OUT per day: earliest punch for IN, latest for OUT.
- `Keterangan Waktu`: `ok`, `Telat …`, `Pulang awal …`, or `Libur` on a day off.
- Without `--user`, only employees with punches in the range get a sheet; with `--user`, every listed ID gets one, even when empty.

`poin` -> one sheet per employee, one row per day, mirroring the HTML recap on `/share` and `/me`:

| Tanggal  | Nama | Masuk    | Pulang   | Telat | Pulang cepat | Status |
| -------- | ---- | -------- | -------- | ----- | ------------ | ------ |
| 01/10/26 | Budi | 07:03:01 | 16:01:00 | 3 mnt | —            | Telat  |

- `Nama` repeats on every row (the display name from `employee_profiles`), so a filtered or re-sorted sheet still identifies the employee.
- `Masuk`/`Pulang` are the earliest/latest punch of the day, `—` when missing.
- `Telat`/`Pulang cepat` are text (`5 mnt`, `1 jam 2 mnt`, `—` when zero) so the sheet reads exactly like the page.
- `Status` is Indonesian: `Lengkap`, `Telat`, `Pulang cepat`, `Tanpa masuk`, `Belum pulang`, `Piket`, `Libur`.
- When `user` and `poin` are both requested, the poin sheets get a ` (poin)` suffix; alone they use the plain `<id_number> - <name>` name.

Sheet order: `Raw`, `Masuk`, `Pulang`, then per-employee sheets sorted by `id_number`.

Names and activity come from `employee_profiles` (`app employees`): `Nama` uses the mapped display name, `Masuk`/`Pulang`/user/poin sheets skip inactive employees, and `Raw` keeps every punch. An explicit `--user ID` still selects an inactive employee. For the current month the date columns stop at today (WIB), so future dates are not counted as absence.

Examples:

```bash
# JSON to stdout, can be piped to jq
app export --for-month 2026-10 --json

# Excel recap package (Masuk + Pulang), default name
app export --for-month 2026-10 --excel

# All four modes in one workbook
app export --for-month 2026-10 --excel --mode raw,recap,user,poin

# One sheet per employee, only two employees
app export --for-month 2026-10 --excel --mode user --user 992,993

# Raw punches for a date range
app export --from 2026-10-01 --to 2026-10-20 --excel --mode raw

# Only late rows (JSON only)
app export --for-month 2026-10 --punctuality late --json
```

No rows:

- `--json`: still succeeds, `{ "data": [], "meta": { ..., "total": 0 } }`, exit `0`.
- `--excel`: error `NO_DATA`, exit `1`; no empty file is created.

## 6. `app employees`

Display mapping and active flag used by recap/export. Stored in `employee_profiles`; `app sync` never overwrites it.

```bash
app employees list [--json]
app employees update --id ID [--display-name NAME] [--prefix-title T] [--suffix-title T] [--active true|false] [--json]
```

- `list` prints `ID`, `NAME` (composed), `ACTIVE`, and `DEVICE NAME`.
- `list --json`: `{ "data": [ { "id_number", "device_name", "display_name", "prefix_title", "suffix_title", "name", "active", "updated_at" } ], "meta": { "total" } }`.
- `update` is partial: only the flags you pass change; at least one change flag is required.
- `--display-name ""` clears the override, so the device name is used again.
- Report name: `prefix_title + name + suffix_title`. A suffix starting with `.` or `,` attaches without a space (`Budi, S.Kom`).
- `--active false` hides the employee from `Masuk`/`Pulang`, user, and poin sheets. Raw punches stay in `Raw`, and `export --user ID` still selects the employee.
- Unknown `--id` -> `NOT_FOUND`, exit `1`. Bad flags -> exit `2`.

Examples:

```bash
app employees list
app employees update --id 992 --display-name "Budi Santoso" --prefix-title "H." --suffix-title ", S.Kom"
app employees update --id 993 --active false
```

## 7. JSON format

The envelope is the same as the API:

```json
{
  "data": [
    {
      "date": "2026-10-20",
      "id_number": "992",
      "name": "Dummy Siti, S.Kom",
      "in_time": "07:28:34",
      "out_time": "16:30:15",
      "late_minutes": 28,
      "early_minutes": 0,
      "status": "telat",
      "punches": 2
    }
  ],
  "meta": {
    "month": "2026-10",
    "from": "2026-10-01",
    "to": "2026-10-31",
    "total": 1,
    "page": 1,
    "per_page": 1,
    "total_pages": 1
  }
}
```

CLI export is not paginated: `data` contains every row, `meta.total` = row count. `page`/`per_page` are still present so the shape matches the API; their values are `1` and `total`.

## 8. Errors and exit codes

| Exit | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `0`  | success                                                  |
| `1`  | runtime/data/device error                                |
| `2`  | usage error (bad flag, no format selected, invalid date) |

Human-readable:

```
error: --for-month cannot be combined with --from/--to
```

`--json`:

```json
{
  "error": {
    "code": "INVALID_ARGS",
    "message": "--for-month cannot be combined with --from/--to"
  }
}
```

JSON errors are written to **stderr**, so stdout remains pipeable. Do not mix progress logs into stdout when `--json` is used.

## 9. Package scripts

```bash
bun run start          # = serve
bun run serve
bun run sync           # = sync
bun run device -- probe --json
bun run export -- --for-month 2026-10 --json
bun run compile        # dist/app(.exe)
bun run e2e:local      # collector + viewer on loopback; prints pass/fail
```

For `device probe` from source:

```bash
bun run src/app.ts device probe --json
```

## 10. Operational rules

- `app export` is safe to run while the server is up (SQLite WAL, read-only).
- `bun run e2e:local` starts two real `app serve` processes (collector + viewer) on loopback in a temp directory, compares `health`/`employees`/`raw attendance`/`recap`/`summary`, checks the `READ_ONLY_VIEWER` guard and the wrong-token relay 401, then stops the collector to prove the viewer fails closed (`502 RELAY_UNAVAILABLE`). It needs no device and no ZeroTier tunnel; it exits `1` on any failed check.
- `app sync` and `POST /api/v1/sync` append to `logs/YYYY-MM-DD.log` (WIB date), relative to the working directory. The auto-sync ticker inside `app serve` appends the same file (`auto sync start`, `auto sync error`, `auto sync skipped (busy)`). `logs/` is gitignored. Logging failures never abort a sync.
- Do not run two syncs at once. The lock only covers one process; the `sync_lock` row (5-minute expiry) rejects a second sync in the same window, so cron and the auto-sync ticker never overlay.
- `app serve` runs both the web UI and the auto-sync ticker from `sync_schedules`. `app sync` still works standalone for cron/Task Scheduler; both share the same lock and the same daily log.
- `app serve` and `app sync` may run as separate processes, but their syncs must not overlap.
- Webhooks are pushed after the sync, never inside it. `app serve` fires the dispatch in the background (`void`), so a dead receiver cannot delay the HTTP response; `app sync` waits for one flush because the process is about to close SQLite. Delivery is one POST per event per subscriber, 5 s timeout, one attempt, no retry; a failure is recorded in `events.attempts`/`last_error` and recovered with `GET /api/v1/events?since=`. Hooks exist on the collector only; a viewer answers `403 READ_ONLY_VIEWER` and serving `/hooks` returns `404`.
- `--json` is a scripting contract; do not add extra text to stdout.
- All times are WIB. Do not rely on the OS timezone.
- A viewer process has no local attendance clone. Stop and restart it if the collector URL or token changes; there is no hot reload for relay config.

## 11. `app relay status`

Status: **implemented (collector listener in 7A, read-only viewer in 7B1)**.

A relay instance is read-only. The collector runs next to the device and owns SQLite plus
device access; a viewer on another PC pulls raw data over a ZeroTier tunnel and computes its
own recap, export, and web. The collector and the viewer are the same binary.

```
app relay status [--json]
```

`status` reports the role (`collector` or `viewer`), whether the relay listener is enabled
and its bind URL, collector reachability (viewer, or an enabled collector listener), the
collector's `app_version`, `schema_version`, `counts`, and `last_sync`. It never prints the
token.

- Exit `0` when the config is valid and the relay is reachable or disabled.
- Exit `1` when the collector is unreachable, auth fails, the request times out, or the
  response is malformed.
- Exit `2` for usage/config errors (bad flag, invalid viewer URL, chained relay).
- `--json` uses the normal `{ data }` / `{ error }` envelope on stdout/stderr.

Viewer, reachable:

```json
{
  "data": {
    "role": "viewer",
    "relay_url": "http://10.42.0.2:3100",
    "reachable": true,
    "app_version": "0.1.0",
    "schema_version": 5,
    "counts": { "employees": 12, "attendance": 310 },
    "last_sync": {
      "at": "2026-10-26T12:24:58+07:00",
      "ok": true,
      "users": 12,
      "records": 310,
      "duration_ms": 4120,
      "first_date": "2026-09-28",
      "last_date": "2026-10-26",
      "error": null
    }
  }
}
```

Collector with the listener disabled:

```json
{ "data": { "role": "collector", "relay_enabled": false, "relay_url": null, "reachable": null } }
```

Collector with the listener enabled adds `relay_enabled: true`, the local relay URL as
`relay_url`, `reachable`, `app_version`, `schema_version`, `counts`, and `last_sync`.

Config:

- Collector: `ABSEN_RELAY_ENABLED=true` plus `ABSEN_RELAY_HOST` (tunnel address) and `ABSEN_RELAY_TOKEN` enable the read-only relay listener. Unset = disabled. `0.0.0.0`/`::` are rejected. `ABSEN_RELAY_URL` must be unset.
- Viewer: `ABSEN_ROLE=viewer` plus `ABSEN_RELAY_URL` (http(s), no credentials/path/query/fragment) and `ABSEN_RELAY_TOKEN`. Optional `ABSEN_RELAY_TIMEOUT_MS` (default `5000`). `ABSEN_ZK_HOST` and `ABSEN_RELAY_ENABLED=true` are rejected. Run the viewer from its own directory/`.env`; copying the collector `.env` carries `ABSEN_ZK_HOST` and fails startup with `CONFIG_VIEWER_DEVICE`.
- A viewer can never enable a relay, and a collector never reads from another relay.
- HTTP over the ZeroTier tunnel; the relay binds its own port and never exposes ZK TCP.

Viewer mode command matrix:

| Command                            | Collector | Viewer                     |
| ---------------------------------- | --------- | -------------------------- |
| `serve`                            | yes       | yes (read-only)            |
| `export`                           | local DB  | via collector              |
| `relay status`                     | yes       | yes                        |
| `sync`                             | yes       | no (`READ_ONLY_VIEWER`, 2) |
| `device probe`                     | yes       | no (`READ_ONLY_VIEWER`, 2) |
| `employees list\|update`           | yes       | no (`READ_ONLY_VIEWER`, 2) |
| `users list\|set-password\|delete` | yes       | no (`READ_ONLY_VIEWER`, 2) |
| `admin reset-password`             | yes       | no (`READ_ONLY_VIEWER`, 2) |

Future: relay token rotation and per-client tokens; not v1.

## 12. `app users`

Employee dashboard accounts (`app_users`). Collector-only; a viewer has no local DB.

```bash
app users list [--json]
app users set-password [--username U] --employee-id ID --password P [--json]
app users delete --username U [--json]
```

- `set-password` is create-or-update: a new username inserts the row, an existing username rotates the hash. One account per employee (`employee_id_number` is unique).
- `--username` is optional and defaults to the employee's PIN (`--employee-id`). A reset reuses the existing username even if it differs from the PIN. Passing a different `--username` for an employee who already has an account exits `1` (`employee ID already has account: U`) instead of creating a second row.
- `--employee-id` must exist in `employees`/`employee_profiles`, otherwise exit `1` (`employee not found: ID`).
- `--password` must be at least 8 characters (exit `2`); it is hashed with `Bun.password` (argon2id) and never printed.
- `delete` removes the account, not the employee. An unknown username exits `1`.
- `--json` shape: `{ "data": [{ "username", "role", "employee_id_number", "created_at" }] }` for `list`, `{ "data": { "username", "role", "employee_id_number" } }` for `set-password`, `{ "data": { "ok": true, "username" } }` for `delete`.
- Human output: `user ok: siti -> employee 992`, `user deleted: siti`, or `no employee accounts`.
- Running sessions are not revoked by `set-password`/`delete`: the CLI is a separate process and cannot reach the server's in-memory sessions. Restart `app serve` to drop them. The web actions `POST /employees/:id/account` and `POST /employees/:id/account/delete` do revoke that employee's live sessions immediately.

## 13. `app admin reset-password`

Local recovery for a forgotten web/API admin password.

```bash
app admin reset-password [--json]
```

- Opens the configured SQLite DB and deletes the single hash in `admin_credentials`.
- After the reset, `ABSEN_WEB_PASSWORD` is the active bootstrap password again.
- Does not require the web server or device.
- Human output: `admin password reset: DB hash removed; env bootstrap is active again` (or `no DB hash; env bootstrap is already active`).
- `--json`: `{ "data": { "ok": true, "cleared": true|false } }` on stdout; errors to stderr.
- Running sessions are **not** revoked by this command; restart `app serve` to drop them.
- The backup file from Settings contains the hash; deleting the hash in the live DB does not scrub old backups.
