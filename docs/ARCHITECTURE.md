# absenly architecture

Status: **Phase 1 hardware-verified (2026-10-21); Phase 2 done (2026-10-21); Phase 3 admin API complete (2026-10-22); Phase 4 admin web complete (2026-10-23, offline tests); Phase 5 daily sync log done (2026-11-03); Phase 6 employee dashboard implemented (2026-11-04, offline tests); Phase 7A collector relay implemented; Phase 7B1 read-only viewer implemented (LAN E2E verified 2026-10-29)**. `src/schedule.ts`, `src/config.ts`, `src/time.ts`, `src/db.ts`, `src/device.ts`, `src/zk.ts`, `src/sync.ts`, `src/app.ts`, and `src/cli.ts` exist; CLI `sync` and `device probe` work against the X606-S. Live sync on 2026-10-22 pulled the full snapshot; a second run added no duplicates. Live sync on 2026-10-26 pulled twice with identical counts. Live sync on 2026-10-29 pulled twice with identical counts and distinct keys. Phase 2 adds `src/recap.ts`, `src/export.ts`, `app export --json`, and the Excel modes (`raw`, `recap`, `user`, `poin`). Phase 3 adds admin login/token, health, raw attendance, employees, recap, summary, work-exceptions, sync status/trigger, and Excel export through `serve`. Phase 4 adds the admin web shell, lazy vanilla-JS tabs, employee/schedule/settings actions, login throttle, password hash, backups, schedule hot reload, the Home late-streak card, Generate's combined `raw,recap,user,poin` mode, and public individual share links (schema v5 `share_links`, fixed 24-hour bearer URL). Phase 7A adds `store.ts` plus the collector relay listener (`src/relay/`, GET-only `/relay/v1`). Phase 7B1 adds `RelayReadStore`/`RelayScheduleStore`, viewer `serve`/`export`, read-only UI guards, and `app relay status`. LAN E2E on 2026-10-29 (collector `192.0.2.20:3100`, separate viewer process) matched the collector on employees, October recap, summary, and work-exceptions; the viewer served no local DB and failed closed on collector stop, wrong token, timeout, and malformed JSON. Full viewer admin features and ZeroTier-tunnel E2E remain pending.

Protocol reference and device facts: `docs/agent/zk-device.md`. Agent rules: [`AGENTS.md`](../AGENTS.md).

Contracts: [`API.md`](API.md) (device API + HTTP `/api/v1`) and [`CLI.md`](CLI.md) (the `app` command).

## Confirmed decisions

- Main admin web view: **Home dashboard** (active/today/month metrics, rankings, recent punches), with Generate, Log Absensi, Karyawan, Jadwal, Settings, and About tabs.
- Start and end times are stored in **`schedule.json`**: a full base week plus date-range overrides (e.g. Ramadan). One shift per day; `null` = day off. Env only points at the file and provides a flat `ABSEN_SCHEDULE_IN/OUT` fallback if the file is missing.
- The per-day end time is used to flag **early leave** (badge + minutes difference).
- Rare cases (piket, i.e. standby duty, overnight, overtime) are stored in the **`work_exceptions`** table. `applyWorkExceptions` (pure, in `work-exceptions.ts`) merges them into the daily recap: the start date becomes `piket`, and sanctions (`late`/`early`) are waived on every date the span touches.
- Sync: **manual from web + CLI** for external cron/Task Scheduler. No internal scheduler.
- Employee dashboard phase 6: **own recap + monthly summary**. Implemented as `web/me.ts` + `/api/v1/me/*` + `app_users`; leave/permission requests are not included. Self-service password change is `GET|POST /me/password` (no `/api/v1` route).
- Relay phase 7: a collector next to the device serves **raw data only** over a ZeroTier tunnel. A viewer on another PC pulls that raw data and does its own recap, export, and web. The viewer never gets device, sync, or write access, and a viewer can never serve another relay (no chain relay).

## 1. Goals

One Bun app for three jobs:

1. **Sync** - pull users and punches from the ZKTeco X606-S over TCP `4370` (read-only).
2. **Analyze** - turn raw punches into a daily recap: clock-in, clock-out, late, early leave.
3. **Serve** - admin HTML web + JSON `/api/v1` for a future dashboard/SPA/mobile.
4. **CLI** - `app sync`, `app device probe`, `app export --for-month ... --json|--excel`, `app serve`.

The employee dashboard is part of the same app: `web/me.ts` renders `/me`, the `/api/v1/me/*` handlers live in `api/handlers.ts`, and `app_users` holds the accounts. It does not change `zk.ts`/`sync.ts`.

Principles:

- **Modular monolith**: one process, one SQLite, one entrypoint.
- **Raw data is stored**: raw punches for audit; the recap can always be recomputed.
- **Pure analysis**: recap functions never touch the DB, web, or device.
- **Read-only against the device**: no clear data, delete user, set time, or restart.
- **KISS**: no web framework, ORM, React, or frontend build.
- **Device time = WIB**: dates/times are stored as-is, never converted to UTC.

## 2. Application shape

```
ZKTeco X606-S (host:port from config)
        |
        |  src/zk.ts  (adapter, TCP, read-only)
        v
   src/device.ts  (port: DeviceGateway)
        |
        v
   src/sync.ts  --->  SQLite
                       employees
                       attendance
                       sync_log
        |
        v
   src/recap.ts  (pure: punch -> daily)
        |
        v
   src/reports.ts (shared display names + report row selection)
        |
        +--> src/web/      (admin HTML + /me)
        +--> src/api/      (JSON /api/v1, dashboard later)
        +--> src/export.ts (XLSX)
        |
        +--> src/cli.ts    (serve | sync | device probe | export)
```

Relay (phase 7A collector + 7B1 read-only viewer implemented) is a second read path:

```
Collector: SQLite -> src/store.ts -> src/relay/server.ts  (read-only, bound to the tunnel address)
                                      |
                                      |  HTTP + token
                                      v
Viewer:    src/relay/client.ts (RelayReadStore) -> recap/export/web (no local DB or device)
```

A single entrypoint `src/app.ts` calls `src/cli.ts`:

```
app serve
app sync
app device probe
app export --for-month 2026-10 --json
app export --for-month 2026-10 --excel
app relay status
app help
```

Web, API, and CLI use the same services (`db`, `recap`, `sync`, `export`). The CLI does not call HTTP. API and web are two adapters over the same services.

## 3. Project structure

```
absenly/
├─ AGENTS.md
├─ README.md
├─ schedule.json               # base week + date overrides (non-secret)
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ API.md                   # device API contract + HTTP /api/v1
│  ├─ CLI.md                   # `app` command contract
│  └─ agent/                   # agent work guides (design-review, ponytail,
│                              #  zk-device, operations, relay)
├─ src/
│  ├─ app.ts                   # thin entrypoint -> cli.ts
│  ├─ cli.ts                   # parse argv, commands, JSON/human output
│  ├─ config.ts                # env + file -> Config + validation
│  ├─ period.ts                # pure: date/month/range validation
│  ├─ schedule.ts              # pure: calendar JSON, resolver, env fallback
│  ├─ time.ts                  # WIB, today, stamp, minutes, workday
│  ├─ log.ts                   # daily log to logs/
│  ├─ device.ts                # DeviceGateway port + errors
│  ├─ db.ts                    # SQLite, migrations, queries
│  ├─ zk.ts                    # adapter ZkClient -> DeviceGateway
│  ├─ sync.ts                  # device -> DB orchestration
│  ├─ recap.ts                 # pure: punch -> daily, filters, summary
│  ├─ reports.ts               # pure: display names + report row selection
│  ├─ employees.ts             # display names, active overlay views
│  ├─ work-exceptions.ts       # pure: ledger validation + recap waiver merge
│  ├─ share-links.ts           # UUID bearer links, fixed 24h TTL
│  ├─ share-report.ts          # pure: monthly metrics for the public share page
│  ├─ export.ts                # XLSX
│  ├─ auth.ts                  # session/token, DB/env password, guards
│  ├─ login-throttle.ts        # in-memory failed-login throttle
│  ├─ schedule-store.ts        # mutable calendar: mtime reload + atomic save
│  ├─ log.ts                   # append-only daily log (logs/YYYY-MM-DD.log)
│  ├─ version.ts               # single app version (CLI + web)
│  ├─ api/
│  │  ├─ router.ts             # /api/v1 dispatch + error envelope
│  │  ├─ handlers.ts           # endpoint handlers
│  │  └─ dto.ts                # snake_case wire format
│  ├─ relay/                  # collector listener + read-only viewer client
│  │  ├─ server.ts            # collector relay listener, GET only
│  │  ├─ client.ts            # RelayReadStore/RelayScheduleStore -> collector over HTTP
│  │  ├─ auth.ts              # relay token check
│  │  └─ dto.ts               # relay wire format
│  ├─ store.ts                # ReadStore + async AppStore ports
│  └─ web/
│     ├─ server.ts             # Bun.serve, mounts web + api, schedule reload
│     ├─ routes.ts             # login/shell/assets + web action/share routes
│     ├─ shell.ts              # HTML shell + login/error rendering
│     ├─ share.ts              # public server-rendered individual recap
│     ├─ me.ts                 # employee dashboard (/me), same cards as share
│     ├─ html.ts               # esc/escAttr/jsonAttr helpers
│     ├─ assets.ts             # embedded text assets + content types
│     └─ assets/               # app.js/css, lib/, lazy tabs/
├─ tests/
│  ├─ period.test.ts
│  ├─ schedule.test.ts
│  ├─ schedule-store.test.ts
│  ├─ recap.test.ts
│  ├─ reports.test.ts
│  ├─ db.test.ts
│  ├─ export.test.ts
│  ├─ api.test.ts
│  ├─ auth.test.ts
│  ├─ metrics.test.ts
│  ├─ share-report.test.ts
│  ├─ relay.test.ts
│  ├─ relay-client.test.ts
│  ├─ viewer.test.ts
│  ├─ web.test.ts
│  └─ cli.test.ts
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ .oxfmtrc.json
├─ .oxlintrc.json
└─ docs/agent/                 # agent work guides
   ├─ design-review.md
   ├─ zk-device.md
   ├─ relay.md
   └─ operations.md
```

Structure notes:

- `app.ts` is thin; `cli.ts` owns parsing and output so it can be tested without launching the binary.
- `device.ts` is the port; `zk.ts` is the adapter. `sync.ts` depends on the port, not the protocol. Swapping the device/library just means swapping the adapter.
- `api/` and `web/` are two HTTP adapters over the same services. Both use `auth.ts`.
- `web/` serves a server-rendered shell and embeds client assets through text imports; tabs are lazy `import()` modules. Web actions are small POST routes; data reads still go through `/api/v1`.
- `GET /share/<uuid>` is the exception to the admin shell: a public, server-rendered, read-only page for one employee/month. It has no `/api/v1` equivalent and no client data fetch.
- `api/dto.ts` is the only place that maps internal camelCase -> snake_case wire. CLI `--json` uses the same DTOs so the shape stays consistent.
- `src/zk.ts` is the self-contained, hardware-verified protocol adapter. Tests exercise it through fixtures and a fake device; web/API never import it. `serve` passes a read-only probe callback from `cli.ts`.
- The employee dashboard adds `web/me.ts`, `/api/v1/me/*` handlers, and the `app_users` table. It does not change `zk.ts`/`sync.ts`.

## 4. Modules and dependency rules

| Module               | Responsibility                                      | May import                                                                             |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `app.ts`             | thin entrypoint: calls `cli.ts`                     | `cli.ts`                                                                               |
| `cli.ts`             | parse argv, commands, human/JSON output             | `config`, `db`, `employees`, `reports`, `sync`, `export`, `device`/`zk`, `api/dto`     |
| `config.ts`          | env + file -> `Config`, validation                  | `node:fs`, `node:path`, `schedule.ts`                                                  |
| `period.ts`          | date/month/range validation                         | none                                                                                   |
| `schedule.ts`        | calendar JSON, resolver, env fallback               | `period.ts`                                                                            |
| `time.ts`            | WIB and time utilities                              | none                                                                                   |
| `log.ts`             | write the daily log                                 | `time.ts`, `node:fs`                                                                   |
| `device.ts`          | `DeviceGateway` port, types, `DeviceError`          | none                                                                                   |
| `db.ts`              | schema, migrations, prepared statements             | `bun:sqlite`                                                                           |
| `zk.ts`              | ZK protocol adapter                                 | `node:net`, `device.ts`, `time.ts`                                                     |
| `sync.ts`            | lock, fetch, validation, transaction                | `device.ts`, `db.ts`, `log.ts`                                                         |
| `recap.ts`           | compute recap, filters, summary                     | `schedule.ts`, `time.ts`                                                               |
| `reports.ts`         | display names + report row selection                | `employees.ts`, `recap.ts`, `schedule.ts`                                              |
| `employees.ts`       | display names, active overlay views                 | `db.ts` (type)                                                                         |
| `work-exceptions.ts` | ledger validation, overlap, 48h limit, recap waiver | `period.ts`, `recap.ts` (`dailyStatus`, type)                                          |
| `auto-sync.ts`       | window+interval rules + `createAutoSync` ticker     | `schedule.ts`, `time.ts`, `log.ts`, type-only from `db.ts`/`store.ts`                  |
| `hooks.ts`           | event dispatch, HMAC, URL guard, test ping          | `node:crypto`, `log.ts`, type-only from `db.ts`/`store.ts`                             |
| `share-links.ts`     | UUID link creation, fixed 24h expiry                | `node:crypto`, `db.ts` (types), `time.ts`                                              |
| `share-report.ts`    | pure monthly metrics for the share page             | `period.ts`, `recap.ts` (type), `schedule.ts`                                          |
| `export.ts`          | XLSX workbook                                       | `recap.ts`, `reports.ts`, `period.ts`, `schedule.ts`, `xlsx`                           |
| `auth.ts`            | in-memory sessions, DB/env password                 | `config.ts`, `db.ts` (hash accessor)                                                   |
| `login-throttle.ts`  | failed-login throttle by key                        | none                                                                                   |
| `schedule-store.ts`  | mutable calendar, reload/save                       | `schedule.ts`, `node:fs`                                                               |
| `log.ts`             | append-only daily log                               | `time.ts`, `node:fs`                                                                   |
| `version.ts`         | app version                                         | `package.json`                                                                         |
| `api/dto.ts`         | snake_case wire format                              | `recap.ts` (types)                                                                     |
| `api/handlers.ts`    | endpoint handlers                                   | `db.ts`, `employees.ts`, `period.ts`, `recap.ts`, `reports.ts`, `auth.ts`, `dto.ts`    |
| `api/router.ts`      | `/api/v1` dispatch, error envelope                  | `handlers.ts`                                                                          |
| `web/routes.ts`      | login, shell, assets, web actions, shares, `/me`    | `auth.ts`, `db.ts`, `schedule-store.ts`, `shell.ts`, `share.ts`, `me.ts`, `share-*.ts` |
| `web/shell.ts`       | HTML shell/login/error rendering                    | `html.ts`, `schedule.ts` (types)                                                       |
| `web/share.ts`       | public 8-card share page, compact table             | `html.ts`, `recap.ts` (type), `share-report.ts` (type)                                 |
| `web/me.ts`          | employee `/me` page, same card layout               | `html.ts`, `recap.ts` (type), `share-report.ts` (type)                                 |
| `web/server.ts`      | `Bun.serve`, mounts web + api, hot reload           | `auth.ts`, `routes.ts`, `api/router.ts`, `schedule-store.ts`                           |
| `store.ts`           | `ReadStore` + async `AppStore` ports                | `db.ts` (`SqliteReadStore`), `relay/client.ts` (`RelayReadStore`)                      |
| `relay/server.ts`    | collector read-only relay listener                  | `store.ts`, `relay/auth.ts`, `relay/dto.ts`; never `zk.ts`/`sync.ts`                   |
| `relay/client.ts`    | viewer `RelayReadStore`/schedule store              | `relay/dto.ts`; never `zk.ts`/`sync.ts`                                                |

Rules:

- `recap.ts` **must not** import the DB, ZK, web, or API. This is what makes the analysis easy to test and reusable by the employee dashboard.
- `period.ts` is the only date/month/range validator; API, CLI, export, and schedule validation use it.
- `reports.ts` is the only display-name, active-employee, and recap-filter policy; API, CLI JSON, and the workbook use it.
- `share-report.ts` is pure. The public page renders its metrics; do not duplicate the late/streak rules in `web/share.ts`.
- `zk.ts` knows nothing about the DB, web, or API. If the app later moves to another API/library, only this adapter changes.
- `sync.ts` depends on `DeviceGateway` in `device.ts`, not `ZkClient` in `zk.ts`. Tests just swap the adapter for a `FakeDevice`.
- `auto-sync.ts` is pure for the decision (`isDue`, `parseSyncSchedule`) and owns the ticker. It calls an injected `sync` function, so it never imports `zk.ts` and tests never need a device.
- Only `web/server.ts` and `api/router.ts` touch HTTP.
- The CLI and API use the same `api/dto.ts`; the server-rendered web calls the services directly.
- One direction: `web/api/cli -> service -> db/device`. No imports back.
- Relay is a read-only adapter: `relay/server -> store -> db` on the collector, `relay/client -> HTTP -> relay/server` on the viewer. It must never import `zk.ts`, `device.ts`, or `sync.ts`.

## 5. Data model

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE employees (
  id_number  TEXT PRIMARY KEY,        -- PIN / ID Number, not UID
  name       TEXT NOT NULL,
  card       INTEGER NOT NULL DEFAULT 0,
  group_id   TEXT NOT NULL DEFAULT '',
  privilege  INTEGER NOT NULL DEFAULT 0,
  device_uid INTEGER,                 -- audit; not reliable in the 40-byte record
  synced_at  TEXT NOT NULL
);

CREATE TABLE attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,           -- YYYY-MM-DD, WIB
  id_number  TEXT NOT NULL REFERENCES employees(id_number),
  time       TEXT NOT NULL,           -- HH:MM:SS, WIB
  status     TEXT NOT NULL CHECK (status IN ('IN', 'OUT')),
  raw_punch  INTEGER NOT NULL,        -- 0/1 from the device, audit only
  verify     INTEGER NOT NULL,        -- 15 = FACE
  synced_at  TEXT NOT NULL,
  UNIQUE (id_number, date, time)
);

CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_person_date ON attendance(id_number, date);

CREATE TABLE employee_profiles (
  id_number    TEXT PRIMARY KEY REFERENCES employees(id_number) ON DELETE CASCADE,
  display_name TEXT,                   -- NULL = use employees.name
  prefix_title TEXT NOT NULL DEFAULT '',
  suffix_title TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at   TEXT NOT NULL
);

CREATE TABLE sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  users       INTEGER NOT NULL DEFAULT 0,
  records     INTEGER NOT NULL DEFAULT 0,
  first_date  TEXT,
  last_date   TEXT,
  ok          INTEGER NOT NULL,
  error       TEXT
);

CREATE TABLE work_exceptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  id_number   TEXT NOT NULL REFERENCES employees(id_number),
  kind        TEXT NOT NULL CHECK (kind IN ('overtime', 'night_shift', 'holiday_work', 'other')),
  start_date  TEXT NOT NULL,           -- YYYY-MM-DD, WIB
  start_time  TEXT NOT NULL,           -- HH:MM:SS, WIB
  end_date    TEXT NOT NULL,           -- can be the next day for piket
  end_time    TEXT NOT NULL,           -- HH:MM:SS, WIB
  note        TEXT,
  created_at  TEXT NOT NULL,
  CHECK (end_date > start_date OR (end_date = start_date AND end_time > start_time)),
  UNIQUE (id_number, start_date, start_time, kind)
);

CREATE INDEX idx_work_exceptions_person_date ON work_exceptions(id_number, start_date);

CREATE TABLE sync_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  owner       TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,        -- epoch ms
  expires_at  INTEGER NOT NULL         -- epoch ms; stale lock can be taken over
);

CREATE TABLE admin_credentials (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,         -- Bun.password argon2id
  updated_at    TEXT NOT NULL
);

CREATE TABLE share_links (
  token      TEXT PRIMARY KEY,          -- UUID v4; the URL is the bearer capability
  id_number  TEXT NOT NULL REFERENCES employees(id_number) ON DELETE CASCADE,
  month      TEXT NOT NULL,             -- YYYY-MM
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL           -- epoch ms; fixed 24h TTL
);

CREATE TABLE app_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,     -- Bun.password argon2id
  role               TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  employee_id_number TEXT REFERENCES employees(id_number) ON DELETE CASCADE,
  created_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_app_users_employee
  ON app_users(employee_id_number) WHERE employee_id_number IS NOT NULL;

CREATE TABLE sync_schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  days          TEXT NOT NULL,          -- '*' or 'MONDAY,SATURDAY'
  start_time    TEXT NOT NULL,          -- 'HH:MM' WIB, inclusive
  end_time      TEXT NOT NULL,          -- 'HH:MM' WIB, exclusive
  every_minutes INTEGER NOT NULL CHECK (every_minutes BETWEEN 1 AND 1440),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event        TEXT NOT NULL,           -- attendance.changed | sync.done | sync.failed
  at           TEXT NOT NULL,           -- WIB stamp
  payload      TEXT NOT NULL,           -- thin JSON: counts and dates only
  delivered_at TEXT,                    -- NULL until every subscriber accepted it
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);

CREATE TABLE webhooks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,        -- http(s), no loopback/link-local
  secret          TEXT NOT NULL,        -- plaintext; HMAC key, in backups
  events          TEXT NOT NULL,        -- comma list of subscribed event names
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at      TEXT NOT NULL,
  last_status     INTEGER,
  last_attempt_at TEXT,
  last_error      TEXT
);
```

Current schema version: **8**.

Decisions:

- **`employees` is separate** from `attendance`. The user name lives in one place, the filter dropdown can list every user (including those with no attendance yet), and the employee dashboard can use `id_number` as identity.
- **`employee_profiles` is the display/active overlay**, keyed by `id_number`. Sync never writes it. Every employee gets a profile row (active default 1); existing rows are never overwritten. `display_name` NULL means the device name; the report name is `prefix_title + name + suffix_title` (a suffix starting with `.` or `,` attaches without a space). `active = 0` hides the employee from recap, user, and poin sheets, but raw punches stay in `Raw` and an explicit `--user` still selects them.
- **`admin_credentials` stores one password hash**, never the plaintext. `ABSEN_WEB_PASSWORD` is bootstrap only; once a hash exists, login accepts only the DB password. Changing it revokes all sessions; `app admin reset-password` deletes the hash locally. The hash is included in SQLite backups.
- **`share_links` is a capability table**, not an account. One UUID token maps to one `id_number` and one `month`; new links are created only for active employees, and the fixed TTL is 24 hours. The token is stored as plaintext in the local DB because the URL is the only secret and there is no link list/revoke UI. Expired rows are purged opportunistically when a new link is created. A leaked link remains readable until expiry.
- **`app_users` is the employee login**, separate from `employees` and from `share_links`. One row per username, unique `employee_id_number` (partial index, so one account per employee), argon2id hash. The admin is not a row here: it stays `admin_credentials` + `ABSEN_WEB_PASSWORD`. Created/reset/deleted from the web Karyawan tab (admin actions) or `app users` on the collector; a viewer has no local DB and no employee login. A new account defaults to the PIN as username and `satutekad` as password; both paths refuse a second account for the same employee. Deleting an employee cascades its account.
- **`sync_schedules` is the auto-sync config**, one row per window+interval. Empty table or all-disabled rows means the ticker never fires. Only the collector's `app serve` runs the ticker; a viewer never has a device to poll.
- **`events` is an append-only outbound log**, written after the sync transaction commits. It is the durable half of Hooks: even when no receiver answers, the row stays and a consumer can catch up with `GET /api/v1/events?since=<id>`. Payloads are thin on purpose (counts, dates, error text — never names, PINs, or the comm key), because the server announces _that_ something changed and lets the consumer decide what that means. `attendance.changed` is written only when a sync actually inserted new punches; a re-read of the same rows changes nothing a consumer can act on.
- **`webhooks` holds outbound targets**, one row per receiver, with a plaintext HMAC secret (same trade-off as `share_links`: backups contain it). Delivery is one POST per event per subscriber, 5 s timeout, **no retry**: a failure bumps `attempts` and sets `last_error` and the event stays visible; the consumer polls `?since=` to recover. An event with no enabled subscriber is marked delivered immediately so the backlog cannot grow while nothing is configured.
- **`attendance` stays raw**. There is no daily recap table. a few thousand records is still small; the recap is computed on read. If it gets slow later, then add a table/materialized view.
- **`UNIQUE (id_number, date, time)`** makes sync idempotent. No duplicates even when sync runs repeatedly.
- **`status` is stored** from the `< 10:00` = IN, `>= 10:00` = OUT rule, but `time` remains the source of truth. The recap recomputes from `time`.
- **`raw_punch` and `verify`** are stored for audit. `verify=15` is the FACE type, not IN/OUT status.
- **`device_uid`** is not used for joins. The 40-byte record is not reliable for UID.
- **`work_exceptions` is a ledger**, not a replacement for `attendance`. Planned piket/overnight/overtime is stored here; raw punches stay in `attendance`.
- **`work_exceptions` feeds the recap as a waiver**, not as attendance. `applyWorkExceptions` marks the span's `start_date` as `piket` and zeroes `late`/`early` on every touched date, so a piket Mon 21:00 - Tue 07:00 excuses a Tuesday arrival of 09:30. A night shift counts **one** duty day (the start date), never two. `inTime`/`outTime` stay `null` when there is no punch; the day still counts as present because `isPiket` is true. No overtime-minute arithmetic yet: `kind` and the span duration are stored but not summed into hours. The merge rule is a waiver so recap, export, `/api/v1`, `/me`, shares, and the CLI all agree without a new column.
- **`sync_lock` is an advisory lock**, one row, owner + expiry. `syncNow` acquires it before touching the device and releases it in `finally`; a crashed process leaves a stale lock that expires after 5 minutes.
- **Migrations**: `PRAGMA user_version` + a migration array in `db.ts`. No migration framework.
- **No automatic delete** during sync. If the device record count drops, the server data stays; the admin decides.

## 6. Business rules

Identity:

- **`id_number` is the PIN** used in the report. It is the join key to `employees`.
- **The internal `uid` is not reliable** in the 40-byte record. Never join or filter by UID.
- The name comes from `employees`. If the user is not found, insert a placeholder `name = id_number` so the FK stays valid.

Time:

- **IN**: earliest punch with `time < 10:00:00`.
- **OUT**: latest punch with `time >= 10:00:00`.
- The `10:00:00` boundary is the `SPLIT_TIME` constant, not config. This rule is for the daily recap of the day shift.
- **Late**: on a workday, `inTime > resolvedSchedule.in`; the minute difference is computed, **with no tolerance**.
- **Early leave**: on a workday, `outTime < resolvedSchedule.out`; the minute difference is computed.
- **Workday**: a day that has a schedule after `schedule.json` is resolved (base or the winning override). There is no hardcoded Monday-Saturday; Sunday is a day off only when the calendar sets `null`. Days off do not compute late/early leave.
- **Global override**: the override with `from <= date <= to` and the highest `priority` wins. An override with `schedule: null` means the whole range is off. Overrides that overlap with the same priority are rejected at startup. A global schedule (e.g. Ramadan) goes in the calendar, not `work_exceptions`.
- **One shift per day**: the daily schedule is only for the day shift with `out > in`. Night piket 21:00-07:00 is never made a daily schedule; store it in `work_exceptions` (`kind = night_shift`).
- **WIB**: device dates/times are already WIB. `today()` and `stamp()` use `Asia/Jakarta` through `Intl`, so the server may run in another timezone.
- A punch at `12:06` recorded as `punch=0` still becomes OUT because of the time rule. `raw_punch` is audit only.

Display status (badges, not one rigid column):

| Condition                           | Badge            |
| ----------------------------------- | ---------------- |
| Day with no schedule (e.g. Sunday)  | Libur            |
| No IN                               | Tanpa masuk      |
| IN present, no OUT                  | Belum pulang     |
| `lateMinutes > 0`                   | Telat N m        |
| `earlyMinutes > 0`                  | Pulang cepat N m |
| IN and OUT complete, not late/early | Lengkap          |

If someone is both late and leaving early, both badges are shown. Filters use flags (`lateMinutes`, `earlyMinutes`, `inTime`, `outTime`), not labels.

## 7. Sync flow

```
syncNow({ device, db })
  ├─ acquire sync_lock (one sync across processes)
  ├─ device.connect()                  # production: ZkClient
  ├─ device.readSnapshot()             # counts + users + attendance, one connection
  ├─ db.transaction:
  │    ├─ upsert employees
  │    ├─ ensure every attendance id_number has an employee
  │    ├─ upsert attendance ON CONFLICT DO UPDATE
  │    └─ insert successful sync_log
  ├─ device.disconnect() in finally
  ├─ insert events row (own transaction, failure swallowed:
  │    attendance.changed when inserted > 0, then sync.done)
  └─ on failure: insert failed sync_log + sync.failed event, throw error
```

The caller, not `syncNow`, decides when to dispatch: `serve` fires it in the background, `app sync` awaits one flush before closing the DB.

| Event                | Condition                                        |
| -------------------- | ------------------------------------------------ |
| `attendance.changed` | the sync inserted at least one new punch         |
| `sync.done`          | every successful sync, including a no-op re-read |
| `sync.failed`        | every failed sync, with the device error text    |

Rules:

- `syncNow` is called by `app sync` and `POST /api/v1/sync`. Both use the same lock and the same path.
- **Full snapshot** on every sync. a few thousand records / ~100 KB is still cheap (~1.24 seconds). At 100k records it is ~50 seconds, close to the 60-second budget; plan archiving before the device fills up.
- **Upsert**, not blind insert. Repeated syncs do not add duplicates.
- **Never deletes** data that is not on the device. If the record count drops, write a warning to the log; do not delete.
- **Count validation** is done by the adapter. `readSnapshot()` reads counts before and after the users/attendance buffers; if they change, it throws retryable `ZK_COUNT_MISMATCH`, the whole sync is aborted, and no partial data is committed. A live punch can race the snapshot; retry the whole sync 1-2x.
- **One sync at a time per database**. `syncNow` acquires the SQLite `sync_lock` row before connecting; a second process (server, cron, manual CLI) gets `SYNC_IN_PROGRESS`. One connection per process; the lock prevents parallel device sessions. A crashed process leaves a stale lock that expires after 5 minutes.
- **Read-only**. Only `connect`, `getCounts` (probe), `readSnapshot`, identity/time, optional `subscribe`, `disconnect`. No write command.
- Connection retry 3x (1s/2s/4s) is hardening, not a core phase.
- Web sync runs synchronously (~1.24 seconds). `Bun.serve` uses `idleTimeout: 30`.
- Device clock drift > 5 minutes is written as a warning; never set the device clock.

### Auto-sync schedules

Three ways to start a sync, all through the same `syncNow` and the same lock:

| Caller                  | Trigger                                   |
| ----------------------- | ----------------------------------------- |
| `app sync`              | external cron / Task Scheduler            |
| `POST /api/v1/sync`     | Beranda button                            |
| `createAutoSync` ticker | `sync_schedules` rows, inside `app serve` |

Rules:

- Schedules live in SQLite (`sync_schedules`, schema v7), **not** in `.env` and not in `schedule.json`. Editing them is an admin action, and it takes effect without a restart because the ticker re-reads the table every 30 seconds.
- A row is a **window + interval**: `days` (`*` or a list), `start_time` (inclusive), `end_time` (exclusive), `every_minutes` (1-1440), `enabled`. Many rows union; inside an open window the shortest interval wins. A window may not cross midnight — the day list would then describe two different days.
- `isDue(rules, lastAttemptAt, now)` is pure (WIB): it decides `due`, `nextAt`, and `waitingForInterval`. Recap, admin, API, and UI reuse it; nothing else re-implements the window math.
- `lastAttemptAt` comes from `sync_log.startedAt`, **including failed attempts**. A dead device therefore retries once per interval, not once per tick, and a restart does not immediately re-sync.
- Empty table = auto-sync off. That is the default for a fresh DB.
- The ticker only starts on the collector (`serve` with a device). A viewer has no device and no local DB, so it never syncs.
- `SYNC_IN_PROGRESS` from a manual sync is a normal skip, logged as `auto sync skipped (busy)`, not an error.
- The ticker stops in the `SIGINT`/`SIGTERM` shutdown path alongside the relay and the HTTP server.

### Hooks (outbound events)

| Piece                           | Role                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ |
| `events` row                    | Durable record that something changed. Never mutates attendance.         |
| `src/hooks.ts` `dispatchEvents` | POSTs undelivered events to subscribed webhooks. Never throws, no retry. |
| `webhooks` row                  | One receiver: url, HMAC secret, subscribed event names.                  |

Flow: `syncNow` commits its transaction, then writes `attendance.changed` / `sync.done` / `sync.failed` in a separate transaction. A failed event write is logged and swallowed — it must not turn a good sync into a failed one. The caller then dispatches:

- `app serve` calls `void dispatchEvents(...)` after `syncNow` returns, so a dead receiver can never delay the HTTP response or hold the sync lock. If `app serve` is stopped mid-dispatch, the event stays undelivered.
- `app sync` awaits one dispatch before it closes the DB, because the process is about to exit; the events are already committed either way.

No business rule lives here. "Budi has not checked out by 17:00" is a policy that belongs to the consumer, which asks `GET /api/v1/recap?presence=missing_out`. The server only stores and forwards thin events.

SSRF guard: the URL is validated at create/update time (`127.*`, `localhost`, `*.localhost`, `0.0.0.0`, `::1`, `169.254.*` rejected; LAN, ZeroTier, and public hosts allowed). Delivery uses a 5-second `AbortSignal.timeout`.

Replay: `GET /api/v1/events?since=<id>` is the recovery path. `listUndeliveredEvents` selects only rows with `attempts = 0`, so a failed push is **never** retried automatically — the event stays visible with `attempts = 1` and `last_error`, and the consumer recovers the data by polling the cursor API.

## 8. Analysis

`recap.ts` takes punches from the DB, a schedule resolver (from `schedule.ts`), and the `SPLIT_TIME` constant:

```ts
type DailyRow = {
  date: string;
  idNumber: string;
  name: string;
  inTime: string | null;
  outTime: string | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  isWorkday: boolean;
  punches: number;
};
```

Functions:

- `buildDaily(punches, resolveSchedule, splitTime)`: group by `date + id_number`, pick IN/OUT, compute late/early using the resolved schedule for that date, mark days off. `resolveSchedule` is a pure function `(date) => DaySchedule | null`; whether its source is a JSON file or the DB does not matter to the recap.
- `filterDaily(rows, filters)`: employee, presence (`all | complete | missing_in | missing_out`), punctuality (`all | late | ontime`).
- `summarize(rows)`: present, late, early leave, incomplete.
- `paginate(rows, page, perPage)`: UI 100/page; API default 50, max 200.
- `buildDaily` does **not** take `work_exceptions`; it stays a pure punch-to-day rule. `applyWorkExceptions(rows, spans)` is the separate pure step: it runs after `buildDaily` inside `composeDailyRows` and only waives sanctions / flags `piket`. Do not make `buildDaily` guess night shifts.

The date range is filtered in SQL (`date BETWEEN ? AND ?`) so the query stays small. Status filters run in memory after the recap.

Default view: **start of the current month through today** (WIB). Maximum range 366 days. If there is no data, show an empty state.

`share-report.ts` provides the public-page monthly metrics: present days, late/on-time days, late rate, on-time (punctuality) rate, late minutes, early-leave days/minutes, longest late streak, and a status level. `Total absen` means days with at least one punch, not absent days. A calendar-defined holiday is skipped for the streak; absence or a non-late workday resets it. Current-month links compare the previous month through the same number of elapsed workdays; past-month links compare full months. Status comes from total late minutes: `<30` = 0, `30–59` = 1, `60–89` = 2, `>=90` = 3.

## 9. HTTP: web, API, and auth

Two HTTP adapters over the same services:

- `src/web/` -> server-rendered HTML for the admin (and `/me` later).
- `src/api/` -> JSON `/api/v1` for dashboard/SPA/mobile. Full contract in [`API.md`](API.md).

`src/auth.ts` is shared by both. Browsers use a cookie; API clients use the same Bearer token.

Web routes:

| Method | Path                              | Access   | Function                                     |
| ------ | --------------------------------- | -------- | -------------------------------------------- |
| GET    | `/login`                          | public   | login form                                   |
| POST   | `/login`                          | public   | check credentials, set cookie                |
| GET    | `/assets/*`                       | public   | embedded JS/CSS                              |
| POST   | `/logout`                         | session  | delete session/token                         |
| GET    | `/`                               | admin    | Home tab shell                               |
| GET    | `/generate`                       | admin    | Generate tab shell                           |
| GET    | `/log`                            | admin    | Log Absensi tab shell                        |
| GET    | `/employees`                      | admin    | Karyawan tab shell                           |
| GET    | `/schedule`                       | admin    | Jadwal tab shell                             |
| GET    | `/hooks`                          | admin    | Hooks tab (webhook targets + events)         |
| GET    | `/settings`                       | admin    | Settings tab shell                           |
| GET    | `/about`                          | admin    | About tab shell                              |
| POST   | `/employees/:id/profile`          | admin    | update display name/titles/active            |
| POST   | `/employees/:id/account`          | admin    | create or reset an employee login            |
| POST   | `/employees/:id/account/delete`   | admin    | delete an employee login                     |
| POST   | `/schedule`                       | admin    | validate + save calendar atomically          |
| POST   | `/settings/sync-schedules`        | admin    | create an auto-sync schedule                 |
| POST   | `/settings/sync-schedules/update` | admin    | enable/disable an auto-sync schedule         |
| POST   | `/settings/sync-schedules/delete` | admin    | delete an auto-sync schedule                 |
| POST   | `/settings/password`              | admin    | change password, revoke all sessions         |
| POST   | `/settings/logout-all`            | admin    | revoke all sessions                          |
| GET    | `/settings/backup`                | admin    | download `VACUUM INTO` SQLite snapshot       |
| POST   | `/about/probe`                    | admin    | read-only device probe                       |
| POST   | `/generate/share`                 | admin    | create a 24-hour link for an active employee |
| GET    | `/share/:uuid`                    | link     | public 8-card recap + daily table            |
| GET    | `/me`                             | employee | own recap page                               |
| GET    | `/me/password`                    | employee | self-service password form                   |
| POST   | `/me/password`                    | employee | change own password, revoke other sessions   |
| *      | `/api/v1/*`                       | role     | JSON API, see `API.md`                       |

The pages are one shell with clean URLs; `app.js` lazy-imports the tab module from `/assets/tabs/*.js` and keeps an in-memory cache. The shell bootstrap contains only non-secret runtime facts (version, WIB date, host/port, DB path/mode, schedule calendar/source, counts, password source). The tabs read data from `/api/v1`; web POST routes are only for mutations and return small JSON, except login/logout which are form POSTs.

The share page is not part of the admin shell. `POST /generate/share` validates an active employee and a non-future month, creates a UUID v4 token with a fixed 24-hour TTL, and returns a relative `/share/<uuid>` path. Existing links stay valid for their full 24 hours even if the employee is later deactivated; new links for inactive employees are rejected. `GET /share/<uuid>` renders one employee/month with no login and no client data fetch. Invalid, expired, future, or malformed links return the same generic 404 page. Responses set `no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`; there is no active-link list or revoke endpoint.

Auth:

- Admin username comes from `ABSEN_WEB_USER`. `ABSEN_WEB_PASSWORD` is the bootstrap password; once `admin_credentials` has a hash, only the DB password is accepted.
- Sessions are kept in an in-memory `Map`; restarting the server = everyone logged out. TTL is 8 hours.
- Cookie `absen_session`: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` matching the session.
- The API also accepts `Authorization: Bearer <token>` with the same session token.
- The session carries `{ role: "admin" | "employee", employeeIdNumber?: string }`. Admin comes from `admin_credentials`/env; employee session comes from `app_users` and is always server-scoped to that `id_number`.
- Failed logins are throttled in memory: 5 failures per IP per 15 minutes. API returns `429`/`Retry-After`; the login page renders the same message.
- The relay uses `ABSEN_RELAY_TOKEN` as a read-only service principal, not a user session; see section 13.
- `POST /api/v1/sync`, `GET /api/v1/export.xlsx`, `/api/v1/work-exceptions` (all methods), and the web action routes (`/employees/:id/profile`, `/employees/:id/account`, `/employees/:id/account/delete`, `/schedule`, `/settings/*`, `/about/probe`, `/generate/share`) are admin-only. `/me/password` is employee-only.
- Public reads are only login/assets, `/api/v1/health`, `/api/v1/auth/login`, and `GET /share/<uuid>`. A share link is a bearer capability: no session, one employee/month, 24 hours. Treat the URL as a secret; there is no revoke.
- Generic login error: "Username atau password salah."
- CSRF: `SameSite=Strict` cookie plus Origin/Sec-Fetch-Site checks on web mutations. Bearer is not vulnerable to CSRF. CORS is off by default. `Origin: null` (opaque origin from a proxied or saved page) is treated as absent so `Sec-Fetch-Site` stays the gate; a rejected origin on an employee page renders HTML, never the JSON envelope.
- HTML is escaped through `esc()`/`escAttr()`; the bootstrap JSON is escaped for an HTML attribute. Never insert raw user input into HTML.
- Responses set CSP (`script-src 'self'`), `nosniff`, `DENY` framing, and no-store for HTML/JSON. Request bodies are size-limited.
- Client assets are text imports (`src/web/assets/`) so `bun build --compile` embeds them; there is no frontend build step.
- The API uses `api/dto.ts` for the snake_case wire format and the `{ data, meta }` / `{ error }` envelope. Never leak stack traces, password hashes, or the comm key.

Dashboard tabs:

- **Home**: active employee count, today cards (hadir, belum pulang, belum absen), punctuality from present and active employees, monthly attendance denominator (elapsed workdays × active employees), average/worst late, stable and frequently-late rankings, a top-5 longest late-streak list (holidays skipped, absence breaks), last 10 raw punches, month progress, and one Mon–Sun late-minutes chart. Cards use content height with a capped scroll only for the log.
- **Generate**: one Excel file; modes Raw, Recap, User, Poin, or All (`raw,recap,user,poin`). Raw is the full workbook; Recap/User/Poin use a multi-employee selection. User is one row per punch with a `Jadwal` reference column; Poin is one row per day. Default range is the current month through today; filename is `absen-{mode}-{from}_{to}.xlsx`. A separate card creates a public 24-hour individual recap link for one employee/month.
- **Log Absensi**: today or date range, employee filter, 100 raw punches per page.
- **Karyawan**: edit display name, prefix/suffix, active; device name is read-only; composed-name preview. The Akun column shows only whether the employee has a login (`ada`/`belum`, from `/api/v1/users` joined on `employee_id_number`); Buat/Reset/Hapus live inside the Edit modal, which never prints the stored password — only that a new one is `satutekad`. A new account uses the PIN as username and the default password `satutekad`; Reset restores that password and keeps the username; both revoke that employee's live sessions. The whole column is hidden on a viewer.
- **Jadwal**: base week + date overrides, including holidays/expired overrides. Writes the whole calendar atomically; env fallback is read-only. Import replaces the whole calendar (base + overrides) after a summary confirmation; export downloads the displayed calendar as `schedule.json`. Both run client-side and reuse `POST /schedule`.
- **Settings**: runtime info, SQLite backup, logout-all, password change, DB-configured auto-sync schedules, and a read-only "Relay kolektor" card listing the env keys (`ABSEN_RELAY_ENABLED`/`_HOST`/`_PORT`/`_TOKEN`); the relay is configured in `.env`, not from the UI.
- **Hooks**: webhook targets (URL, subscribed events, enable toggle, test, delete) and the delivery status of the last attempt. Collector only.
- **About**: version, last sync, counts, and an on-demand read-only device probe.

Schedule save/hot reload:

- `ScheduleStore.reloadIfChanged()` runs before HTTP work and compares `mtimeMs`; a bad edit keeps the last valid calendar and surfaces `lastError`.
- `ScheduleStore.save()` validates with the pure schedule parser, writes `<path>.<pid>.<ms>.tmp`, then renames over `schedule.json`, and updates the in-memory calendar. No server restart is needed.
- The client reloads the browser page after saving; recap status is recomputed on read, not stored.

`GET /api/v1/health` returns the last sync status, not a device handshake on every request:

```json
{ "data": { "ok": true, "last_sync": { "at": "...", "ok": true, "users": 56, "records": 2518 } } }
```

API v1 is the full contract for the dashboard. Phase 3/4 admin endpoints are implemented, including work-exceptions, sync, and Excel export; phase 6 adds the employee-only `/me/*` endpoints and the `/me` HTML page.

## 10. Export: Excel and JSON

- Dependency: `xlsx` (the only runtime dependency). The free writer supports column widths and a hidden helper row; bold/freeze panes are not available.
- `export.ts` takes raw punches + `DailyRow[]` and builds the workbook. JSON uses the DTOs in `api/dto.ts`.
- `--mode raw|recap|user|poin` (comma list, default `recap`) picks the sheets; one request can combine all four.
- `raw`: `No | ID | Date | Name | Time | Status | Verification`. Every punch, no dedupe. `ID` is `id_number` written as text (leading zeros survive) and acts as the guard/sort key. `Status` is the 10:00 mapping. `verify=15` -> `Face`, anything else -> `Unverified`.
- `recap`: two sheets, always together. `Masuk`/`Pulang` are grids: dates as columns (`dd/mm/yy`), employees as rows, cells in seconds (`0` when on time, empty when the punch is missing or the day is off). Totals are Excel formulas over the row (`SUM`, `COUNTIF`, `COUNTIFS`); a hidden workday row (1 = workday, 0 = day off) keeps holiday blanks out of `Total absen` and `Total tidak absen pulang`.
- `user`: one sheet per employee, `Date | Name | Jadwal | Time | Status | Verification | Keterangan Waktu`. Earliest IN and latest OUT per day. `Jadwal` is the resolved shift for that punch (scheduled `in` on an IN row, `out` on an OUT row, `Libur` on a day off) and is the reference the note is measured against. Notes are `ok`, `Telat …`, `Pulang awal …`, or `Libur`.
- `poin`: one sheet per employee, one row per day: `Tanggal | Nama | Masuk | Pulang | Telat | Pulang cepat | Status`, mirroring the HTML recap on `/share` and `/me`. `Nama` repeats on every row so a filtered sheet stays readable. Minutes are text (`5 mnt`, `1 jam 2 mnt`, `—` when zero); status is Indonesian. When `user` and `poin` are both requested, poin sheet names get a ` (poin)` suffix.
- `Nama` comes from `employee_profiles` (`display_name`, then `prefix_title`/`suffix_title`); inactive employees are skipped in `Masuk`/`Pulang`/user/poin sheets. `Raw` keeps every punch, and an explicit `--user` still selects an inactive employee.
- Date columns for the current month stop at today (WIB); future dates are not counted as absence. Past months show the full month.
- Sheet names: `Raw`, `Masuk`, `Pulang`, then `<id_number> - <name>` (sanitized, max 31 chars, deduped).
- Seconds are the source of truth in `recap.ts`; `late_minutes`/`early_minutes` stay in the JSON contract for compatibility.
- HTML web: the Generate tab calls `GET /api/v1/export.xlsx` with the same modes and employee selection; there is no separate web export route.
- API: `GET /api/v1/export.xlsx?month=...&mode=...` returns a file. `employee_ids` (comma list, additive v1) narrows `Masuk`/`Pulang`, user, and poin sheets; `employee_id` remains the single-ID form and is mutually exclusive with `employee_ids`. `raw` is always the full punch workbook and ignores employee selection. `presence`/`punctuality` are rejected (JSON-only). JSON uses `GET /api/v1/recap`.
- API filename: `absen-{mode}-{from}_{to}.xlsx`; CLI default remains `exports/rekap-{period}.xlsx`.
- Generated web file: one file per action, no preview; the browser downloads it directly.
- CLI:
  - `app export --for-month 2026-10 --json`
  - `app export --for-month 2026-10 --excel [--mode raw,recap,user,poin] [--out exports/oktober.xlsx]`
  - `app export --from 2026-10-01 --to 2026-10-31 --excel --mode user --user 992,993`
  - `--for-month` is exclusive with `--from`/`--to`; exactly one of `--json`/`--excel` is required.
- CLI filters: `--user` works for JSON and for the `user` mode; `--presence`/`--punctuality` are JSON-only.
- `--json` writes `{ "data": [...], "meta": {...} }` to stdout; the shape matches the API.
- Default Excel file: `exports/rekap-2026-10.xlsx` or `exports/rekap-2026-10-01_2026-10-31.xlsx`. The folder is created automatically.
- No data: web/API `404 NO_DATA`; CLI `--json` succeeds with `data: []`; CLI `--excel` exits 1 and does not create an empty file.
- Dates are written as `dd/mm/yy` and times as `HH:MM:SS` strings so they do not shift timezone.
- `work_exceptions` feeds the recap/export as a sanction waiver plus a `piket` status; overtime minutes are not computed yet.
- Contract details: [`CLI.md`](CLI.md) and [`API.md`](API.md).

## 11. Config

Every key must be prefixed with `ABSEN_`.

| Key                      | Default         | Needed by                | Notes                                          |
| ------------------------ | --------------- | ------------------------ | ---------------------------------------------- |
| `ABSEN_ZK_HOST`          | -               | `sync`, `probe`, `serve` | device IP/hostname, no `http://`               |
| `ABSEN_ZK_PORT`          | `4370`          | `sync`, `probe`, `serve` | ZK protocol port                               |
| `ABSEN_ZK_COMM_KEY`      | `0`             | `sync`, `probe`, `serve` | device comm key                                |
| `ABSEN_ZK_TIMEOUT_MS`    | `10000`         | `sync`, `probe`, `serve` | command timeout                                |
| `ABSEN_SCHEDULE_FILE`    | `schedule.json` | `serve`, recap, export   | calendar JSON path; may be absolute            |
| `ABSEN_SCHEDULE_IN`      | -               | recap, export            | `HH:MM`, WIB; only used if the file is missing |
| `ABSEN_SCHEDULE_OUT`     | -               | recap, export            | `HH:MM`, WIB; only used if the file is missing |
| `ABSEN_WEB_USER`         | -               | `serve`                  | required admin login                           |
| `ABSEN_WEB_PASSWORD`     | -               | `serve`                  | required bootstrap; DB hash wins after change  |
| `ABSEN_PORT`             | `3000`          | `serve`                  | web port                                       |
| `ABSEN_HOSTNAME`         | `0.0.0.0`       | `serve`                  | `127.0.0.1` for local                          |
| `ABSEN_DB`               | `absen.sqlite`  | `serve`, `sync`, export  | SQLite path                                    |
| `ABSEN_ENV`              | `production`    | `serve`, `sync`, export  | `production`, `staging`, or `test`; guards DB  |
| `ABSEN_ROLE`             | `collector`     | all                      | `collector` or `viewer`                        |
| `ABSEN_RELAY_ENABLED`    | `false`         | collector                | opt-in read-only listener                      |
| `ABSEN_RELAY_HOST`       | -               | collector                | specific tunnel address; wildcard rejected     |
| `ABSEN_RELAY_PORT`       | `3100`          | collector                | separate from the admin API port               |
| `ABSEN_RELAY_TOKEN`      | -               | collector + viewer       | read-only token; never log                     |
| `ABSEN_RELAY_URL`        | -               | viewer                   | collector base URL over the tunnel             |
| `ABSEN_RELAY_TIMEOUT_MS` | `5000`          | viewer                   | per-request relay timeout                      |

Each command loads only its own capability: collector `serve` = storage + web + schedule + device config (for the manual sync endpoint); viewer `serve` = web + relay client only, with no device config and no local attendance DB; `sync`/`probe` = device; collector `export` = storage + schedule; viewer `export` = relay client. A relay-enabled collector `serve` still owns the device and SQLite. A malformed `schedule.json` must not block a device probe or sync.

Validation:

- `ABSEN_JAM_MASUK`, `ABSEN_JAM_PULANG`, and `ABSEN_SCHEDULE_<DAY>_*` are **removed**.
- The main schedule source is `schedule.json`:
  - `version: 1`
  - `base`: full week `SUNDAY`..`SATURDAY`; each day is `{ "in": "HH:MM", "out": "HH:MM" }` or `null` for a day off
  - `overrides[]`: `{ id, from, to, priority?, note?, schedule }`; dates inclusive, `schedule` is a full week or `null` for the whole range off
  - `from <= to`; `priority` integer >= 0; `id` unique; overrides with the same priority must not overlap
  - `IN < OUT`; at least one workday per weekly schedule
- Resolution: the override with `from <= date <= to` and the highest priority wins; if none, use `base`.
- If the file is missing: fall back to `ABSEN_SCHEDULE_IN`/`ABSEN_SCHEDULE_OUT`, one flat shift for **every day** (including Sunday), no overrides. If the fallback is also incomplete, startup fails.
- `ABSEN_WEB_PASSWORD` is required as the bootstrap password; it is not stored in the DB. A password change writes an argon2id hash to `admin_credentials`; after that, only the DB password is accepted. `app admin reset-password` removes the hash so the env bootstrap applies again.
- The file exists but is invalid: startup fails; do **not** silently fall back to env.
- In `app serve`, `schedule.json` is hot-reloaded when its mtime changes; saves validate and write atomically. `app sync`/`app export` and other one-shot commands read it at startup, so restart them after editing.
- An empty or whitespace-only `ABSEN_SCHEDULE_FILE` uses the default `schedule.json`.
- The daily schedule does not accept `OUT <= IN` (night shift). Piket/overnight is stored in `work_exceptions`.
- Test DBs use `:memory:` or an explicit temporary path; staging uses a separate `ABSEN_DB`. `ABSEN_ENV=test|staging` with the default `absen.sqlite` fails before opening the file.
- `ABSEN_ENV` must be `production`, `staging`, or `test`; it defaults to `production`.
- Relay config (collector): `ABSEN_RELAY_ENABLED=true` requires `ABSEN_RELAY_HOST` and `ABSEN_RELAY_TOKEN`; wildcard hosts `0.0.0.0`/`::` are rejected; the relay port is 1-65535 and defaults to `3100`. Disabled is the default. A collector with `ABSEN_RELAY_URL` set is rejected (`CONFIG_RELAY_CHAIN`).
- Viewer validation: `ABSEN_ROLE=viewer` requires `ABSEN_RELAY_URL` + `ABSEN_RELAY_TOKEN`, accepts only an http(s) base URL without credentials/path/query/fragment, and rejects `ABSEN_ZK_HOST` or `ABSEN_RELAY_ENABLED=true`. The viewer never opens `ABSEN_DB`.
- Port 1-65535, timeout > 0.
- The host must not contain a scheme.
- Bun reads `.env` from the working directory. `.env` is never committed.
- Auto-sync schedules are **not** env keys. They live in the `sync_schedules` table and are edited from Settings or `/api/v1/sync-schedules`. An empty table means auto-sync is off.
- The app timezone is the constant `Asia/Jakarta`, not env, so there is no second source of truth.

Example `schedule.json`:

```json
{
  "version": 1,
  "base": {
    "SUNDAY": null,
    "MONDAY": { "in": "07:00", "out": "16:00" },
    "TUESDAY": { "in": "07:00", "out": "16:00" },
    "WEDNESDAY": { "in": "07:00", "out": "16:00" },
    "THURSDAY": { "in": "07:00", "out": "16:00" },
    "FRIDAY": { "in": "07:00", "out": "16:00" },
    "SATURDAY": { "in": "07:00", "out": "12:00" }
  },
  "overrides": [
    {
      "id": "ramadan-2027",
      "from": "2027-02-18",
      "to": "2027-03-19",
      "priority": 10,
      "note": "Ramadan",
      "schedule": {
        "SUNDAY": null,
        "MONDAY": { "in": "08:00", "out": "15:00" },
        "TUESDAY": { "in": "08:00", "out": "15:00" },
        "WEDNESDAY": { "in": "08:00", "out": "15:00" },
        "THURSDAY": { "in": "08:00", "out": "15:00" },
        "FRIDAY": { "in": "08:00", "out": "15:00" },
        "SATURDAY": { "in": "08:00", "out": "12:00" }
      }
    }
  ]
}
```

## 12. Employee dashboard (phase 6)

Implemented (2026-11-04, offline tests).

Goal: employees log in and see only their own recap. Still one app. Phase 6 scope: own recap + monthly summary. Leave/permission requests are not part of phase 6. A logged-in employee can change their own password at `/me/password` (old password required, argon2id, other sessions revoked).

Changes:

1. Table:

```sql
CREATE TABLE app_users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,     -- Bun.password argon2id
  role               TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  employee_id_number TEXT REFERENCES employees(id_number) ON DELETE CASCADE,
  created_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_app_users_employee
  ON app_users(employee_id_number) WHERE employee_id_number IS NOT NULL;
```

2. `src/auth.ts`: the fixed admin username is checked first (env bootstrap only while no DB hash exists); every other username is looked up in `app_users`. The session carries the role and `employeeIdNumber`; cookie and Bearer use the same token.
3. Routes `GET /me` (HTML, `src/web/me.ts`) and `GET /api/v1/me`, `/api/v1/me/attendance`, `/api/v1/me/recap`, `/api/v1/me/summary`, `/api/v1/me/work-exceptions` (JSON). Current month by default, month picker for the last 6 months, summary cards, own daily table.
4. Scope is **enforced on the server**: the handler reads `session.employeeIdNumber` and passes it as `idNumber`. Never trust a query param. `employee_id`/`employee_ids` in `/me/*` -> `400 INVALID_QUERY`.
5. `POST /api/v1/sync`, `GET /api/v1/export.xlsx`, `/api/v1/work-exceptions` (all methods), and the web admin pages/actions stay admin-only. `/me` and `/me/*` are employee-only. Admin sessions are redirected to `/`; employee sessions are redirected to `/me` from admin pages and get `403` from admin write actions.
6. Employee passwords use `Bun.password.hash/verify` (argon2id). The admin password is a DB hash after the first change; the env password is bootstrap only.
7. Employee account management is the `app users list|set-password|delete` CLI plus the Karyawan tab (create/reset/delete). Employees change their own password at `/me/password`; there is no admin-visible password and no reset-by-email.

What does **not** change: `zk.ts`, `sync.ts`, `attendance`, and the recap rules. The dashboard only reads data that already exists. `sharePage` and `/me` share `monthlyReport()` in `web/routes.ts`, so the streak/compare rules exist once. A viewer serves neither `/me` login nor employee accounts (no local DB).

## 13. Relay (phase 7A collector + 7B1 read-only viewer)

Goal: the collector runs next to the device and serves **raw** data over a ZeroTier tunnel.
A viewer PC pulls that raw data and computes its own recap, export, and web. The relay
never exposes the device.

Two roles, one binary:

- `collector`: owns SQLite and `zk.ts`, runs sync, serves the admin API/web, and may start the read-only relay listener.
- `viewer` (7B1): no ZK config, no sync, no device probe, and no local attendance clone. It reads raw rows, the employee display/active overlay, and the schedule from the collector and does its own processing. Full viewer admin editing is deferred to 7B2.

Rules:

- Transport: HTTP pull over the ZeroTier tunnel on its own port and path (`/relay/v1`). The relay never proxies the admin `/api/v1` routes; a viewer never serves `/relay/v1`.
- Auth: Bearer relay token -> read-only service principal. Allowed GET: meta, employees, schedule, raw attendance, snapshot. Denied: sync, device, work-exception writes, export.
- Data: raw attendance plus the employee master and the display/active overlay. The relay sends `id_number`, `date`, `time`, `punch`, `verify`, employee display fields, and the calendar. The viewer recomputes IN/OUT, status, recap, late, and early leave.
- `store.ts` is the read port: `ReadStore` has `SqliteReadStore` and the HTTP-backed viewer uses `RelayReadStore` through the async `AppStore`. `snapshot()` reads employees, profiles, attendance, last sync, counts, and schema version in one SQLite transaction.
- Freshness: the viewer queries live per request; no clone, no persistent cache. Freshness is bounded by the collector's last sync. If the collector is unreachable, times out, rejects the token, or returns a malformed body, the viewer answers with an error, never stale or empty data.
- One hop: a viewer can never enable a relay, and a collector never reads from another relay. Config rejects both.
- The viewer keeps its own admin login (env password only; `RelayReadStore.getAdminPasswordHash()` is `null`). The relay token stays server-side (never in the browser or logs).
- The viewer UI hides Settings/Hooks, sync, employee edit, share creation, and device probe. Web/API writes return `403 READ_ONLY_VIEWER`; schedule save returns the same guard before the read-only schedule store.
- The relay binds the ZeroTier address, never `0.0.0.0` on a public interface, and ZK TCP is never exposed through the tunnel. Config and the server both reject wildcard binds.
- `app relay status [--json]` reports role/config/reachability without printing the token; exit `0` reachable/disabled, `1` unreachable/auth failure, `2` usage/config.
- `tests/relay.test.ts`, `tests/relay-client.test.ts`, and `tests/viewer.test.ts` cover the collector, the HTTP client, and the read-only viewer with fake stores/servers. `bun run e2e:local` (`scripts/e2e-local.ts`) runs the same path with two real `app serve` processes on loopback: parity for health/employees/raw attendance/recap/summary, device-name raw rows, the write guard, a wrong relay token, and `502 RELAY_UNAVAILABLE` after the collector stops.
- Design details: `docs/agent/relay.md`.

## 14. Testing and operations

Automated tests must never touch the real device:

- `tests/recap.test.ts`: earliest/latest, the `10:00:00` boundary, late by 1 minute per day, Saturday early finish, day off (Sunday), no IN, no OUT, late + early leave.
- `tests/db.test.ts`: `:memory:` migrations, open guard rejects the default `absen.sqlite` for test/staging mode, idempotent upsert, unique constraint, employee/date filters, sync log, `work_exceptions` overlap, share-link storage/purge, sync lock ownership/expiry across connections, `sync_schedules` insert/list/toggle/delete.
- `tests/auto-sync.test.ts`: `parseDays`/`parseSyncSchedule` (times, inverted and midnight-crossing windows, interval bounds), `isDue` (window edges, `every_minutes` since the last attempt, failed attempts rate-limit, weekday lists, multi-row union, `nextAt`), and `createAutoSync` (fires, idles, `SYNC_IN_PROGRESS` skip, failure keeps ticking, idempotent start/stop).
- `tests/sync.test.ts`: full snapshot, idempotency, count-mismatch retry, lock rejection, lock release on success/failure.
- `tests/hooks.test.ts`: webhook URL validation (loopback/link-local/credentials/scheme), event subset and dedupe, HMAC signature, dispatch to a subscribed webhook, unsubscribed and disabled skips, one failed attempt never retried, throwing fetch captured, store failure swallowed, batch paging, `sendTestEvent`, sync events (`attendance.changed` only on new rows, `sync.done`, `sync.failed`), and a sync that still succeeds when the event write throws.
- `tests/export.test.ts`: XLSX buffer read back, headers and row count correct.
- `tests/api.test.ts`: auth, envelope, filters, pagination, errors, export, work-exceptions validation/overlap, sync-schedules CRUD/validation/read-only, events cursor/validation, webhook CRUD/validation/secret-once/read-only.
- `tests/work-exceptions-recap.test.ts`: the recap waiver — late/early zeroed after a piket, a piket with no punch still present, a piket on a day off is not `libur`, one night shift is one duty day, and another employee's piket changes nothing.
- `tests/auth.test.ts`: env bootstrap vs DB hash, session expiry, password verification, logout-all, login throttle window/reset.
- `tests/schedule-store.test.ts`: mtime reload, bad JSON keeps the last calendar, atomic save, env read-only.
- `tests/metrics.test.ts`: today/month dashboard metrics, rankings, longest late streak, schedule impact, expired overrides.
- `tests/share-report.test.ts`: late status thresholds, previous month/cutoff, holiday skip, absence break, early-leave metrics.
- `tests/schedule.test.ts`: base week + date overrides, priority/overlap, `IN < OUT`, at least one workday, flat env fallback, invalid file does not fall back.
- `tests/cli.test.ts`: argument parsing, `--for-month`, JSON shape, exit code, admin reset, `users` create/list/rotate/delete, viewer command blocking, viewer export, relay status.
- `tests/log.test.ts`: daily log file naming/append, one line per event, never throws on write failure.
- `tests/relay.test.ts`: collector listener auth, GET-only boundary, raw DTOs, filters, snapshot, and no device/web imports; fake store, no device.
- `tests/relay-client.test.ts`: HTTP client parsing, token header, timeout/auth/malformed/non-OK failures, read-only writes, and the read-only schedule store.
- `tests/viewer.test.ts`: viewer login, read-through data, profile/inactive parity, hidden pages, write guards, no chained relay, and fail-closed on unreachable collector/bad token.
- `tests/web.test.ts`: login/assets/headers, throttle, employee action, schedule save/hot reload/errors, password/logout-all, backup, probe, share creation/public rendering/expiry/isolation, sync-schedules web routes/CSRF/viewer, Hooks page/assets/viewer `404`/webhook round-trip, employee `/me` scoping and role redirects.
- `tests/me.test.ts`: employee login role/scope, `/api/v1/me*` own-data isolation, `employee_id` rejection, admin forbidden on `/me`, employee forbidden on admin routes.
- Manual integration test: `app sync` against the device, check the full user list and record snapshot (the live count may grow), run it twice and make sure there are no duplicates.

Operations:

- Daily log at `logs/YYYY-MM-DD.log`: sync start/done/error, duration, user/record counts. Auto-sync adds `auto sync start` and `auto sync error`/`auto sync skipped (busy)` lines. Never dump names/PINs and never log the comm key.
- `GET /api/v1/health` for lightweight monitoring.
- Auto-sync schedules (Settings / `/api/v1/sync-schedules`) run inside `app serve` on the collector; no Task Scheduler entry is required for sync anymore. External `app sync` via Windows Task Scheduler/cron still works and shares the sync lock.
- SQLite WAL. The Settings page downloads a consistent backup via `VACUUM INTO`; the file contains the admin password hash and share-link tokens, so treat it as a secret. Manual copy still requires a checkpoint/stopped app.
- Share links expire after 24 hours and cannot be revoked from the UI. A leaked URL stays readable until expiry. Expired rows are purged when an admin creates a new link; the public page never lists active links.
- `bun run check` = format check, lint, typecheck, test, `e2e:local`, compile.
- Standalone build: `bun run compile` -> `dist/app.exe`. Run it from the deployment folder containing `.env`, `schedule.json`, and the DB; `logs/` is relative to the working directory. A shortcut or Task Scheduler entry must set the working directory correctly, or use an absolute `ABSEN_SCHEDULE_FILE`/`ABSEN_DB`.
- API sessions/tokens are in-memory; restarting the server = everyone logged out. The login throttle is also in-memory and resets on restart. If persistent tokens are needed, add an `api_tokens` table later.
- `app serve` hot-reloads a changed `schedule.json`; no restart is needed. A malformed edit keeps the last valid calendar and shows the error in Settings/Jadwal.
- Bind the web to the LAN only if needed. Never expose it to the internet without an HTTPS reverse proxy and a strong password.

## 15. Non-goals and constraints

- Writes nothing to the device (users, logs, clock, restart).
- The normal daily recap assumes the day shift (split `10:00`). Piket/overnight is stored in `work_exceptions` and merged as a waiver + `piket` status; overtime minutes are not summed.
- Overtime minutes are not computed yet; `work_exceptions` waives sanctions and marks piket days. Do not add hour arithmetic until the rate/rounding policy is agreed.
- No incremental sync yet; full snapshot until the data approaches capacity.
- No real-time monitoring yet. ADMS/push is not available on the X606-S; `subscribe()` is only an adapter option, not a source of truth.
- The collector relay listener (7A) and read-only viewer (7B1) are implemented. Phase 7 is read-only and pull-based over a ZeroTier tunnel: the viewer pulls raw data, keeps no local clone or cache, and never gets device, sync, or write access. A viewer can never serve another relay. Full viewer admin editing is deferred to 7B2.
- No payroll, leave, permission, or salary recap yet.
- Not multi-tenant; one company, one device. Share links are one employee/month, 24 hours, with no list or revoke; they are not employee accounts.
- API v1 is for LAN/same-origin; CORS and persistent API keys do not exist yet.
- The API contract is written in `docs/API.md`; there is no generated OpenAPI yet.
- The CLI and web both manage `employee_profiles`; keep the shared display-name/active policy in `reports.ts`/`employees.ts`.
- No internal scheduler in phase 1. Auto-sync (collector `app serve`) is DB-configured windows, not a full cross-process scheduler.
- Does not split scraper/analyzer/web/API/CLI into separate services.

## 16. Implementation phases

| Phase | Content                                                                                                           | Done when                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Skeleton: docs, API/CLI contracts, config, agent rules, agent guides                                              | structure and contracts approved                                                                                                                     |
| 1     | Core: `config`, `schedule`, `time`, `device` port, `zk` adapter, `db`, `sync`, `app sync`, `app device probe`     | `app sync` pulls the full snapshot; a second sync does not duplicate; calendar schedule validated; `work_exceptions` table created; JSON probe works |
| 2     | Analysis + export core: `recap`, DTOs, XLSX, `app export --for-month --json/--excel`                              | daily rules (late/early leave/days off) pass; `work_exceptions` do not change `buildDaily`; JSON and Excel match                                     |
| 3     | Auth + admin API v1: login/token, employees, attendance, recap, summary, sync, export, work-exceptions            | admin endpoints work, envelope/errors consistent, overlap validation works                                                                           |
| 4     | Admin web dashboard: shell, Home, Generate, Log, Karyawan, Jadwal, Settings, About; auth throttle/password/backup | dashboard tabs work; schedule saves atomically and hot-reloads; tests pass offline                                                                   |
| 5     | Hardening: logs, health, errors, API/web tests, compile                                                           | `bun run check` passes, manual sync succeeds                                                                                                         |
| 6     | Employee dashboard: `app_users`, `/me` HTML + `/api/v1/me/*`                                                      | employee login sees only their own data; `/me/work-exceptions` is scoped; admin pages/actions reject employee sessions                               |
| 7A    | Relay collector: `ReadStore`, GET-only listener, relay token, raw routes                                          | raw routes over a specific tunnel bind; auth/read-only/filter tests pass offline; no live device in tests                                            |
| 7B1   | Read-only viewer: read-through `RelayReadStore`, no chain relay, `app relay status`, read-only UI                 | viewer pulls raw data over the tunnel; cannot sync/device/write; token stays server-side; live E2E pending                                           |
| 7B2   | Full viewer admin: write-through profile/schedule/share/work-exception actions (deferred)                         | only if a viewer must edit collector data; needs explicit write contract and auth review                                                             |

Phases 1-3 are the API/CLI core; the admin web is phase 4 (done); the employee dashboard is phase 6 (done); the relay is phase 7.

Working order agreed with the user: 2 → 3 → 4 → 7 → 6 → 5 (relay before the employee dashboard, hardening last so it covers relay code).

Phase 2 is done (2026-10-21): `src/recap.ts`, `src/api/dto.ts`, `src/export.ts`, `app export --json`, and `app export --excel --mode raw,recap,user,poin`. Phase 3 admin API is complete (2026-10-22): auth, `health`, raw attendance, employees, recap, summary, work-exceptions, sync status/trigger, and Excel export. Phase 4 admin web is complete (2026-10-23): shell + lazy tabs, employee/schedule/settings actions, login throttle, DB password hash, backup, schedule hot reload, Home late-streak list, Generate All mode, and public individual share links (schema v5). Endpoint/web verification used fixtures/fakes because the machine was outside the attendance network. Live sync on 2026-10-22: the second run was idempotent (identical row and distinct-key counts). Phase 5 hardening adds the daily `logs/YYYY-MM-DD.log` sync log (2026-11-03). Phase 6 employee dashboard is implemented offline (2026-11-04): schema v6 `app_users`, `app users` CLI, employee login, `/me` HTML, and the scoped `/api/v1/me/*` routes. Phase 7A collector relay is implemented and tested with a fake store. Phase 7B1 read-only viewer is implemented and LAN-E2E verified on 2026-10-29: employees, records, and October recap rows matched the collector exactly, no local viewer DB, and fail-closed `RELAY_UNAVAILABLE`/`RELAY_AUTH`/`RELAY_TIMEOUT`/`RELAY_BAD_RESPONSE`. Live ZeroTier-tunnel E2E is still pending; `/me` has not been exercised on a real device/PC. Phase 8 (Hooks) is implemented offline (2026-11-05): schema v8 adds `events` and `webhooks`, `GET /api/v1/events?since=` is a cursor for poll-based consumers, webhook push is fire-and-forget with HMAC `X-Rekap-Signature`, `presence=missing_out` is available on `GET /api/v1/recap`, and the Hooks tab manages targets. A webhook was delivered to a real receiver on 2026-11-05 (HMAC-verified), so the push path is no longer unverified.
