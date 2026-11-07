# API absenly

Status: **v1 contract**. The `DeviceGateway` port and read-only `ZkClient` adapter are implemented. Phase 3 admin endpoints are implemented: auth, health, raw attendance, employees, recap, summary, work-exceptions, sync, sync schedules, and Excel export. Phase 4 adds the admin web dashboard over the same API. Phase 6 adds employee accounts (`app_users`) and the employee-only `/api/v1/me/*` endpoints plus the server-rendered `/me` page. Phase 7A adds the collector relay listener (`/relay/v1`); phase 7B1 adds the read-only viewer (`ABSEN_ROLE=viewer`), `app relay status`, and `403 READ_ONLY_VIEWER` write guards.

Related docs: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`CLI.md`](CLI.md).

## 1. APIs and CLI

1. **Device API** - internal `DeviceGateway` contract to the ZKTeco device. Implementation: `src/zk.ts`. Used by `sync.ts`, never used by web/API.
2. **Outbound API** - HTTP JSON `/api/v1` for the admin web UI and the future employee dashboard. Implementation: `src/api/`.
3. **Relay API** - HTTP JSON `/relay/v1` (collector implemented; 7B1 viewer reads it). Read-only raw data, collector to viewer over a ZeroTier tunnel. See section 10.
4. **CLI** - uses the same services as web/API, it does not call HTTP. Details in [`CLI.md`](CLI.md).

Dependency direction:

```
api/  -> recap/db/sync/export -> device port -> zk adapter -> TCP 4370
web/  -> recap/db/sync/export -> device port -> zk adapter -> TCP 4370
cli   -> recap/db/sync/export -> device port -> zk adapter -> TCP 4370
relay/server -> store -> db             (collector; never the device)
relay/client -> HTTP -> relay/server    (viewer; never the device)
```

Web and API are two adapters over the same services. There is no recap logic inside routes.

## 2. Device API: `DeviceGateway`

`src/device.ts` is the **port**, `src/zk.ts` is the **adapter**:

```ts
export interface DeviceGateway {
  connect(): Promise<void>;
  readSnapshot(): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
}

export interface DeviceSnapshot {
  counts: DeviceCounts;
  users: DeviceUser[];
  attendance: DeviceAttendance[];
}

export interface DeviceCounts {
  users: number;
  fingers: number;
  records: number;
  usersCap: number;
  recordsCap: number;
}

export interface DeviceUser {
  uid: number; // audit only, not for joining
  idNumber: string; // PIN, join key
  name: string;
  privilege: number;
  card: number;
  groupId: string;
}

export interface DeviceAttendance {
  idNumber: string;
  name: string;
  date: string; // YYYY-MM-DD, WIB
  time: string; // HH:MM:SS, WIB
  punch: 0 | 1; // raw value, can be wrong
  verify: number; // 15 = FACE
}
```

Contract:

- **Read-only**: only `connect`, `readSnapshot`, `disconnect`; `ZkClient.getCounts()` is an extra read-only method for the probe.
- **One sync at a time per database**. `syncNow` holds the SQLite `sync_lock` row across processes; a crash releases it via the 5-minute expiry. One connection per process.
- `readSnapshot()` reads counts, users, and attendance on one connection. It re-reads counts after the buffers; if the device changed during the read, it throws retryable `ZK_COUNT_MISMATCH` and returns no rows. It validates parsed users/attendance counts against the device.
- `disconnect()` is mandatory in `finally`.
- Times are WIB as-is. No UTC conversion.
- `idNumber` is the PIN. `uid` is not reliable in the 40-byte record.

Errors:

```ts
export class DeviceError extends Error {
  code: "ZK_NETWORK" | "ZK_AUTH" | "ZK_PROTOCOL" | "ZK_PARSE" | "ZK_COUNT_MISMATCH" | "ZK_TIMEOUT";
  retryable: boolean;
}
```

`sync.ts` depends on `DeviceGateway`, not `ZkClient`:

```ts
export function syncNow(deps: { device: DeviceGateway; db: Db }): Promise<SyncResult>;
```

Tests use a `FakeDevice` that returns fixtures; no real device is needed. Production implementation:

```ts
const device = new ZkClient(host, port, commKey, timeoutMs);
await syncNow({ device, db });
```

### 2.1 Extended capabilities (optional)

The core contract above is enough for sync. A richer adapter may add:

```ts
export interface DeviceIdentity {
  serialNumber: string;
  deviceName: string;
  platform: string;
  firmwareVersion: string;
  os?: string;
}

export interface ExtendedDeviceGateway extends DeviceGateway {
  getIdentity(): Promise<DeviceIdentity>;
  getTime(): Promise<string>; // ISO 8601 WIB
  subscribe?(onPunch: (row: DeviceAttendance) => void): Promise<() => void>;
}
```

- `sync.ts` only needs `DeviceGateway`; do not force a minimal adapter to implement all of it.
- `getIdentity()`/`getTime()` can be used later for health checks and clock drift warnings.
- `subscribe()` is realtime; optional and **not a source of truth**. Polling + backfill remains the main path.
- `zkteco-protocol` 0.6.1 has this feature, but it has a comm key 0 bug and has not been verified on hardware. Do not replace the production adapter without testing against the X606-S.
- Read-only also applies to realtime: no writes to the device.

## 3. Outbound API principles

- Base path: **`/api/v1`**.
- Format: JSON, `Content-Type: application/json; charset=utf-8`.
- Success: `{ "data": ..., "meta"?: ... }`.
- Error: `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.
- The wire format uses **snake_case**. Internal TypeScript may use camelCase; the mapping lives in `src/api/dto.ts`.
- Dates `YYYY-MM-DD`, times `HH:MM:SS`, ISO 8601 timestamps with a `+07:00` offset.
- All times are WIB. Never send UTC without an offset.
- Pagination: `page` (default 1), `per_page` (default 50, max 200).
  `meta`: `{ page, per_page, total, total_pages }`.
- Deterministic order: attendance `date ASC, time ASC`; recap `date ASC, name ASC`.
- `Cache-Control: no-store` for all attendance/piket data.
- Additive changes in v1; breaking change -> `/api/v2`.
- CORS is off by default (same-origin). If an external dashboard needs it, add explicit config later.
- Never send stack traces, credentials, comm key, or raw DB contents.

## 4. Auth

Two mechanisms are supported with the same token:

1. **Cookie** `absen_session` for browsers (HttpOnly, SameSite=Strict, Path=/, 8 hour TTL).
2. **Bearer** `Authorization: Bearer <token>` for API clients/external CLI.

Endpoints:

### `POST /api/v1/auth/login`

Public. Body:

```json
{ "username": "admin", "password": "..." }
```

Success `200`:

```json
{
  "data": {
    "token": "opaque-session-token",
    "expires_at": "2026-10-20T18:00:00+07:00",
    "user": { "role": "admin", "username": "admin" }
  }
}
```

An employee account (`app_users`) returns `"user": { "role": "employee", "username": "siti", "employee_id_number": "992" }` instead. The admin username wins first; every other username is looked up in `app_users`.

The response also sets the cookie. Failure is `401 INVALID_CREDENTIALS` with a generic message. Five failed logins per IP in 15 minutes return `429 TOO_MANY_ATTEMPTS` with a `Retry-After` header. Successful login clears the counter.

`ABSEN_WEB_PASSWORD` is the bootstrap password. Once the admin changes the password in Settings (or a hash exists in `admin_credentials`), only the DB hash is accepted; the env password no longer logs in. Reset locally with `app admin reset-password`; restart `app serve` to drop running sessions.

Employee accounts are created from the CLI (`app users set-password --username U --employee-id ID --password P`), never from the web UI. Delete with `app users delete --username U`. One account per employee (unique `employee_id_number`).

### `POST /api/v1/auth/logout`

Auth. Deletes the session/token and the cookie. `200 { "data": { "ok": true } }`.

### `GET /api/v1/auth/me`

Auth. Employee example:

```json
{
  "data": {
    "role": "employee",
    "username": "992",
    "employee_id_number": "992",
    "name": "Dummy Siti, S.Kom"
  }
}
```

Roles: `admin` | `employee`. Phase 6 adds employee sessions; the admin dashboard stays admin-only while `/me` and `/api/v1/me/*` are employee-only. Sessions are stored in memory; restarting the server logs out all tokens. 8 hour TTL. No refresh token.

Collector relay (phase 7A): `ABSEN_RELAY_TOKEN` is a read-only service principal, not a user role or login session. It may `GET` raw employees, raw attendance, the schedule, and relay metadata. It may not sync, probe the device, write work-exceptions, or export. The relay serves its own `/relay/v1` namespace and never proxies the admin `/api/v1` routes. The viewer holds the token server-side and never sends it to a browser. See section 10.

## 5. Common query parameters

The same filters are used by `attendance`, `recap`, `summary`, and `export`:

| Param          | Value                                          | Notes                      |
| -------------- | ---------------------------------------------- | -------------------------- |
| `month`        | `YYYY-MM`                                      | exclusive with `from`/`to` |
| `from`         | `YYYY-MM-DD`                                   | inclusive                  |
| `to`           | `YYYY-MM-DD`                                   | inclusive                  |
| `employee_id`  | string                                         | exact PIN, admin only      |
| `employee_ids` | comma list                                     | export only (additive)     |
| `presence`     | `all \| complete \| missing_in \| missing_out` | IN/OUT pair status         |
| `punctuality`  | `all \| late \| ontime`                        | late/not late              |
| `page`         | integer >= 1                                   | default 1                  |
| `per_page`     | 1..200                                         | default 50                 |

Rules:

- `month` is exclusive with `from`/`to`. `from` and `to` must be paired.
- Default period: current month (WIB).
- `from <= to`, at most 366 days.
- Dates must be valid; `2026-02-31` -> `400`.
- `employee_id` is trimmed, max 32 characters, exact match (not LIKE).
- `employee_ids` is an export-only comma list of 1–200 unique IDs; each is trimmed/max 32 chars. It is mutually exclusive with `employee_id`.
- No results: `200` with `data: []`, not 404.
- Filters are applied before pagination. `summary` counts the entire filtered result set, not one page.
- `recap` and `summary` hide employees with `active=0` unless `employee_id` selects one explicitly. Raw `attendance` is never filtered by `active`.
- `presence` and `punctuality` apply to `recap`, `summary`, and `export`; raw `attendance` ignores them.
- `work-exceptions` uses the same period and `employee_id`, plus `kind`; `presence`/`punctuality` do not apply.

## 6. Admin endpoints

| Method | Path                          | Function                              |
| ------ | ----------------------------- | ------------------------------------- |
| GET    | `/api/v1/health`              | lightweight status, public            |
| GET    | `/api/v1/employees`           | list of all users for dropdown/filter |
| GET    | `/api/v1/users`               | employee login accounts               |
| GET    | `/api/v1/work-exceptions`     | list piket/overtime                   |
| POST   | `/api/v1/work-exceptions`     | record piket/overtime                 |
| DELETE | `/api/v1/work-exceptions/:id` | delete a piket/overtime record        |
| GET    | `/api/v1/attendance`          | raw punches                           |
| GET    | `/api/v1/recap`               | daily recap                           |
| GET    | `/api/v1/summary`             | recap summary                         |
| GET    | `/api/v1/sync/status`         | last sync                             |
| POST   | `/api/v1/sync`                | manual sync                           |
| GET    | `/api/v1/sync-schedules`      | auto-sync schedule list               |
| POST   | `/api/v1/sync-schedules`      | create an auto-sync schedule          |
| POST   | `/api/v1/sync-schedules/:id`  | enable/disable a schedule             |
| DELETE | `/api/v1/sync-schedules/:id`  | delete a schedule                     |
| GET    | `/api/v1/events`              | outbound event log (cursor)           |
| GET    | `/api/v1/webhooks`            | webhook target list                   |
| POST   | `/api/v1/webhooks`            | create a webhook target               |
| POST   | `/api/v1/webhooks/:id`        | update url/events/enabled             |
| DELETE | `/api/v1/webhooks/:id`        | delete a webhook target               |
| POST   | `/api/v1/webhooks/:id/test`   | send a test event                     |
| GET    | `/api/v1/export.xlsx`         | Excel file                            |

Implemented: `health`, `auth`, raw `attendance`, `employees`, `recap`, `summary`, `work-exceptions`, `sync`, `sync-schedules`, `events`, `webhooks`, `export.xlsx`, and the employee-only `/me*` endpoints. Collector relay `/relay/v1`, the 7B1 read-only viewer, and `app relay status` are implemented.

### `GET /api/v1/health`

Public, no auth. Does not handshake with the device.

```json
{
  "data": {
    "ok": true,
    "last_sync": {
      "at": "2026-10-20T07:30:00+07:00",
      "ok": true,
      "users": 12,
      "records": 240
    }
  }
}
```

`last_sync` = `null` if a sync has never run.
`GET /api/v1/health` is a lightweight monitor: it reads the last `sync_log` row and never calls the device. A viewer returns its last collector sync.

### `GET /api/v1/employees`

Admin. All employees, including inactive ones, ordered by report `name ASC`. Not paginated.

`name` is the report name from `employee_profiles`: `prefix_title + (display_name ?? device name) + suffix_title`. `active: false` means the employee is hidden from `recap`/`summary` by default; an explicit `employee_id` still returns them.

```json
{
  "data": [
    {
      "id_number": "992",
      "name": "Siti, S.Kom",
      "device_name": "Dummy Siti",
      "display_name": "Siti",
      "prefix_title": "",
      "suffix_title": ", S.Kom",
      "card": 0,
      "group_id": "Group1",
      "privilege": 0,
      "active": true
    }
  ],
  "meta": { "total": 3 }
}
```

`card`, `group_id`, and `privilege` come from the device master. `id_number` is the PIN (not UID). `device_name` is the device master name (read-only from the web); `display_name`, `prefix_title`, `suffix_title`, and `active` are the `employee_profiles` overlay. These fields are additive in v1.

### `GET /api/v1/users`

Admin. Login accounts from `app_users` (employees only; the admin password lives in `admin_credentials` and never appears here). Ordered by `username ASC`. Not paginated.

The web joins this with `GET /api/v1/employees` on `employee_id_number` to show who has an account. `password_hash` is never returned; there is no endpoint that reads a password.

```json
{
  "data": [
    {
      "username": "992",
      "role": "employee",
      "employee_id_number": "992",
      "created_at": "2026-10-22T09:00:00+07:00"
    }
  ],
  "meta": { "total": 38 }
}
```

A viewer keeps no local `app_users`, so it returns `data: []`. Accounts are created, reset, and deleted through the web actions below (or `app users`); there is no `POST`/`DELETE` on this path.

### `GET /api/v1/work-exceptions`

Admin. List of planned rare cases: piket/overnight, overtime, holiday work, or other. This is a **separate ledger**; it does not change `attendance` and does not yet affect `/recap`.

Query: `month` or `from`/`to`, `employee_id`, `kind`, `page`, `per_page`.
`kind` optional: `overtime | night_shift | holiday_work | other`.

```json
{
  "data": [
    {
      "id": 1,
      "id_number": "992",
      "name": "Dummy Siti, S.Kom",
      "kind": "night_shift",
      "start_date": "2026-10-20",
      "start_time": "21:00:00",
      "end_date": "2026-10-21",
      "end_time": "07:00:00",
      "note": "Piket",
      "created_at": "2026-10-20T15:00:00+07:00"
    }
  ],
  "meta": {
    "from": "2026-10-01",
    "to": "2026-10-31",
    "total": 1,
    "page": 1,
    "per_page": 50,
    "total_pages": 1
  }
}
```

- Ordered by `start_date DESC, start_time DESC`.
- `night_shift` covers piket `21:00`-`07:00`; `end_date` may be the next day.
- Period filtering uses `start_date` (shift start). A piket spanning months appears in its starting month.
- Unknown `kind` -> `400 INVALID_QUERY`.
- No results: `200` with `data: []`.

### `POST /api/v1/work-exceptions`

Admin. Records a planned rare case. Does not touch the device and does not delete raw punches.

```json
{
  "id_number": "992",
  "kind": "night_shift",
  "start_date": "2026-10-20",
  "start_time": "21:00:00",
  "end_date": "2026-10-21",
  "end_time": "07:00:00",
  "note": "Piket"
}
```

- Required fields: `id_number`, `kind`, `start_date`, `start_time`, `end_date`, `end_time`. `note` is optional (string or `null`).
- `id_number` must exist in `employees`; otherwise -> `400 INVALID_BODY`.
- `kind`: `overtime | night_shift | holiday_work | other`. Unknown kind -> `400 INVALID_BODY`; `overtime` is only a ledger label, there is no pay/overtime calculation yet.
- Times are WIB, format `HH:MM:SS`. `end` must be after `start`; maximum duration 48 hours.
- Invalid date/time/order/duration -> `400 INVALID_BODY`; `details.field` names the field (`range` for order/duration).
- The range must not overlap another `work_exceptions` row for the same employee (half-open `[start, end)`). Overlap -> `409 WORK_EXCEPTION_OVERLAP`.
- Success `201` with `{ "data": { ... } }` containing the created row.
- `work_exceptions` does not automatically enter the recap. The merge rules for piket/overtime await policy.

### `DELETE /api/v1/work-exceptions/:id`

Admin. Deletes a single ledger record (not device/attendance data).

- Success `200 { "data": { "ok": true } }`.
- Missing -> `404 NOT_FOUND`.

### `GET /api/v1/attendance`

Admin. Raw punches, ordered `date ASC, time ASC`.

Query: `month` or `from`/`to`, `employee_id`, `page`, `per_page`.

```json
{
  "data": [
    {
      "id": 1,
      "date": "2026-10-20",
      "time": "07:28:34",
      "id_number": "992",
      "name": "Dummy Siti, S.Kom",
      "status": "IN",
      "raw_punch": 0,
      "verify": 15
    }
  ],
  "meta": {
    "from": "2026-10-01",
    "to": "2026-10-20",
    "total": 2,
    "page": 1,
    "per_page": 50,
    "total_pages": 1
  }
}
```

`status` is computed from `time`, not `raw_punch`. `id` is the DB primary key for audit/debug. `verify` is the Verification column (15 = FACE); `raw_punch` is the device value kept for audit.

### `GET /api/v1/recap`

Admin. One row per `date + id_number`, ordered `date ASC, name ASC`.

Query: `month` or `from`/`to`, `employee_id`, `presence`, `punctuality`, `page`, `per_page`.

`name` is the report name. Inactive employees (`active=0`) are excluded unless `employee_id` names one explicitly.

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
    "from": "2026-10-01",
    "to": "2026-10-20",
    "total": 20,
    "page": 1,
    "per_page": 50,
    "total_pages": 1
  }
}
```

- `status`: `lengkap | telat | pulang_cepat | tanpa_masuk | belum_pulang | piket | libur` (complete, late, left early, no clock-in, not clocked out yet, piket/overtime duty day, day off).
- `late_minutes` / `early_minutes`: `null` if the corresponding punch is missing, `0` if on time.
- A day can be both late and leaving early; `status` is only the primary label, the second number is still filled in.
- Late/early-leave use the schedule resolved from `schedule.json` for that date, with no tolerance.
- Days without a schedule (e.g. Sunday): `status: "libur"`, `late_minutes`/`early_minutes` = 0.
- `work_exceptions` merge as a **waiver** (additive in v1): the span's `start_date` becomes `piket`, and `late_minutes`/`early_minutes` are `0` on every date the span touches. A piket Mon 21:00 - Tue 07:00 therefore excuses a Tuesday arrival of 09:30. One night shift counts one duty day, never two.
- A `piket` row with no punch keeps `in_time`/`out_time` as `null` but still counts in `present`. Overtime minutes are not computed.
- The viewer relay does **not** ship `work_exceptions`, so a viewer reports the unwaived recap. Read `/work-exceptions` on the collector for context.

### `GET /api/v1/summary`

Admin. Summary of the entire filtered result set (not one page).

Query: `month` or `from`/`to`, `employee_id`, `presence`, `punctuality`.

Inactive employees (`active=0`) are excluded unless `employee_id` names one explicitly.

```json
{
  "data": {
    "rows": 20,
    "present": 20,
    "late": 2,
    "early": 1,
    "incomplete": 1,
    "late_minutes": 15,
    "early_minutes": 30
  }
}
```

- `rows`: number of recap rows after filtering.
- `present`: rows with at least one punch.
- `incomplete`: no IN or no OUT.
- `late`: `late_minutes > 0`; `early`: `early_minutes > 0`.
- `late_minutes`/`early_minutes`: total minutes.

### `GET /api/v1/sync/status`

Admin.

```json
{
  "data": {
    "last_sync": {
      "started_at": "2026-10-20T07:29:58+07:00",
      "finished_at": "2026-10-20T07:30:00+07:00",
      "duration_ms": 1241,
      "users": 12,
      "records": 240,
      "first_date": "2026-09-28",
      "last_date": "2026-10-20",
      "ok": true,
      "error": null
    }
  }
}
```

`last_sync` = `null` if a sync has never run.

### Sync schedules (auto-sync)

Admin. A schedule row is **one window + interval**: `days` (`*` or a `MONDAY,SATURDAY` list), `start_time` (inclusive), `end_time` (exclusive), `every_minutes` (1-1440). Many rows union; the row with the shortest interval wins inside an open window. Only `enabled` rows count. Times are WIB. A window may not cross midnight (`start < end`).

- `GET /api/v1/sync-schedules` — list, admin:
  `{ "data": [ { "id": 1, "days": "MONDAY,SATURDAY", "start_time": "07:00", "end_time": "09:00", "every_minutes": 15, "enabled": true, "created_at": "..." } ], "meta": { "next_at": "..." } }`. `meta.next_at` is the next moment any enabled schedule can fire (or `null` when nothing is active).
- `POST /api/v1/sync-schedules` — create, admin, body `{ days, start_time, end_time, every_minutes, enabled? }`; returns the row with `201`.
- `POST /api/v1/sync-schedules/:id` — body `{ enabled: boolean }`, admin; toggles and returns the row.
- `DELETE /api/v1/sync-schedules/:id` — admin; `{ "data": { "ok": true } }`, `404` when unknown.

Validation errors are `400 INVALID` (message and `field` are the doc for the exact reason). A viewer answers `403 READ_ONLY_VIEWER`. The web UI writes through `/settings/sync-schedules`, `/settings/sync-schedules/update`, and `/settings/sync-schedules/delete` (admin + same-origin); the running ticker re-reads the DB every 30 seconds, so no restart is needed.

### Events and webhooks (Hooks)

Admin and **collector only**: a viewer answers `403 READ_ONLY_VIEWER` on every route in this section.

The server announces that something changed and stores the event; it never decides who is late or who forgot to check out. A consumer (bot, internal tool) fetches the detail it needs from the existing read endpoints.

Three event names:

| Event                | Written when                           | `data`                                                                       |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `attendance.changed` | a sync inserted at least one new punch | `{ from, to, inserted, records, users }`                                     |
| `sync.done`          | every successful sync                  | `{ users, records, inserted, first_date, last_date, duration_ms, attempts }` |
| `sync.failed`        | every failed sync                      | `{ error, duration_ms, attempts }`                                           |

Payloads are **thin by design**: counts and dates only, never employee names, PINs, or the comm key. Event rows are written after the sync transaction commits, in their own transaction; a failed event write never fails a sync.

- `GET /api/v1/events?since=<id>&limit=<n>` — ascending by `id`, `since` exclusive (default `0`), `limit` 1-500 (default 100). `meta.next_since` is the id to pass next; it stays at the previous value when the page is empty, so a short page never skips events.
  ```json
  {
    "data": [
      {
        "id": 42,
        "event": "attendance.changed",
        "at": "2026-11-05T08:12:00+07:00",
        "data": {
          "from": "2026-11-05",
          "to": "2026-11-05",
          "inserted": 12,
          "records": 300,
          "users": 12
        },
        "delivered_at": null,
        "attempts": 0,
        "last_error": null
      }
    ],
    "meta": { "since": 0, "limit": 100, "next_since": 42 }
  }
  ```
  Polling with `next_since` is the whole integration for a bot: no webhook, no secret, no retry logic. A bot that asks "who has checked in but not out?" calls `GET /api/v1/recap?presence=missing_out` (~`&from=`/`&to=` or `month=`); the "not before hour X" rule stays in the bot.
- `GET /api/v1/webhooks` — target list. `secret` is **never** returned here.
- `POST /api/v1/webhooks` — body `{ url, events?, enabled? }`. `events` defaults to all three and must be a non-empty subset. Returns the row plus `secret` **once**, with `201`; store it then, it cannot be read again.
- `POST /api/v1/webhooks/:id` — partial update `{ url?, events?, enabled? }`; the merged result is revalidated. Returns the row.
- `DELETE /api/v1/webhooks/:id` — `{ "data": { "ok": true } }`, `404` when unknown.
- `POST /api/v1/webhooks/:id/test` — sends one `test.ping` event and returns `{ ok, status, error }`; the outcome is also recorded in `last_status`/`last_error`.

Webhook validation: `url` must be `http`/`https`, at most 2048 characters, carry no credentials, and must not point at a loopback/link-local host (`127.*`, `localhost`, `*.localhost`, `0.0.0.0`, `::1`, `169.254.*`). LAN, ZeroTier, and public hosts are allowed. Errors are `400 INVALID_URL`, `400 BLOCKED_URL`, or `400 INVALID_EVENTS`.

Delivery: `POST` with `content-type: application/json`, `X-Rekap-Event: <name>`, and `X-Rekap-Signature: sha256=<hex HMAC-SHA256 of the raw body using the webhook secret>`. Timeout is 5 seconds, **one attempt, no retry**. Dispatch is fire-and-forget after the sync, so a dead receiver cannot stall a sync or a request. An event is marked `delivered_at` when every subscribed enabled webhook accepted it; a failure bumps `attempts` and sets `last_error` and is never retried — a consumer that missed the push catches up through `?since=`. An event no webhook subscribes to is marked delivered immediately, so the backlog cannot grow while no target exists.

A viewer has no event log and no webhook targets, so both the Hooks tab and these routes are unavailable there.

### `POST /api/v1/sync`

Admin. No body. Full snapshot sync, upsert, no delete.

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

- `409 SYNC_IN_PROGRESS` if another sync is still running.
- `502 DEVICE_UNAVAILABLE` if the device fails; `details.device_code` contains `ZK_TIMEOUT`, `ZK_NETWORK`, etc.
- Synchronous; the server `idleTimeout` is 30 seconds. Clients are advised to use a 60 second timeout.
- No partial commit.

### `GET /api/v1/export.xlsx`

Admin. Uses the same period (`month` or `from`/`to`) and employee filters as `/recap`, plus `mode=raw|recap|user|poin` (comma list, default `recap`). Returns an Excel file, not JSON.

- `presence`/`punctuality` return `400 INVALID_QUERY`; they are daily-row filters and cannot be represented in the recap grid. Use `/recap` for those.
- `employee_id` narrows `Masuk`/`Pulang` and user sheets to one employee. `employee_ids` (additive v1) does the same for a comma list; it is mutually exclusive with `employee_id`. `raw` always contains every punch in the period and ignores employee selection.
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition: attachment; filename="absen-{mode}-{from}_{to}.xlsx"` (combined modes use the joined list, e.g. `absen-raw-recap-...`).
- `404 NO_DATA` if there are no punches in the range (or for the selected employee).
- Sheets per mode: `Raw`; `Masuk` + `Pulang`; or `<id_number> - <name>` per employee. Layouts are in `ARCHITECTURE.md` section 10 and `CLI.md` section 5.
- Clients that need JSON use `/recap`.

## 7. Employee endpoints (phase 6)

Implemented. All endpoints below are for the `employee` role only. Admins use the admin endpoints with `employee_id`.

| Method | Path                         | Function                   |
| ------ | ---------------------------- | -------------------------- |
| GET    | `/api/v1/me`                 | logged-in employee profile |
| GET    | `/api/v1/me/attendance`      | own raw punches            |
| GET    | `/api/v1/me/recap`           | own daily recap            |
| GET    | `/api/v1/me/summary`         | own monthly summary        |
| GET    | `/api/v1/me/work-exceptions` | own piket/overtime         |

`GET /me` (HTML) is the same data server-rendered for the employee, with an optional `?month=YYYY-MM` (default: current month, last 6 months in the picker). Admin sessions are redirected to `/`; an anonymous request is redirected to `/login`. The page carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`.

`GET /me/password` renders the self-service password form and `POST /me/password` saves it (`old_password`, `new_password`, `confirm_password`; form-encoded, employee session + same-origin). Minimum 8 characters; a wrong old password returns `400` and counts against the 5-per-15-minute login throttle (`429`). On success the current session stays logged in, every other session for that username is revoked, and the browser is redirected to `/me?changed=1`. There is no `/api/v1` password route, and an admin session is redirected to `/`. A viewer answers `403 READ_ONLY_VIEWER`.

Rules:

- Scope is **mandatory on the server**: `WHERE id_number = session.employeeIdNumber`. Never take `employee_id` from the query.
- `employee_id` in a `/me/*` query -> `400 INVALID_QUERY` (so it is not misleading).
- The period uses `month` (recommended) or `from`/`to`, at most 366 days.
- The response shape is the same as the admin endpoints, but only the caller's own data.
- `/me/work-exceptions` uses the same shape as the admin endpoint, without `employee_id` in the query.
- An admin calling `/me/*` -> `403 FORBIDDEN`.
- Employees cannot sync/export all data. An employee export can be added later if needed.

Example `GET /api/v1/me/recap?month=2026-10`:

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
    "per_page": 50,
    "total_pages": 1
  }
}
```

## 8. Errors

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "from must be in YYYY-MM-DD format",
    "details": { "field": "from" }
  }
}
```

| HTTP | Code                     | Condition                               |
| ---- | ------------------------ | --------------------------------------- |
| 400  | `INVALID_QUERY`          | invalid parameter                       |
| 400  | `INVALID_BODY`           | invalid JSON body/missing field         |
| 401  | `UNAUTHORIZED`           | token/cookie missing or expired         |
| 401  | `INVALID_CREDENTIALS`    | login failed                            |
| 403  | `FORBIDDEN`              | role/scope not allowed                  |
| 403  | `READ_ONLY_VIEWER`       | write attempted on a viewer             |
| 404  | `NOT_FOUND`              | route/data not found                    |
| 404  | `NO_DATA`                | export with no rows                     |
| 405  | `METHOD_NOT_ALLOWED`     | wrong method                            |
| 409  | `SYNC_IN_PROGRESS`       | sync overlap                            |
| 409  | `WORK_EXCEPTION_OVERLAP` | piket/overtime range overlap            |
| 429  | `TOO_MANY_ATTEMPTS`      | 5 failed logins/IP/15 minutes           |
| 502  | `DEVICE_UNAVAILABLE`     | device error; see `details.device_code` |
| 502  | `RELAY_UNAVAILABLE`      | viewer cannot reach the collector       |
| 502  | `RELAY_AUTH`             | collector rejected the relay token      |
| 502  | `RELAY_BAD_RESPONSE`     | malformed collector response            |
| 504  | `RELAY_TIMEOUT`          | collector request timed out             |
| 500  | `INTERNAL_ERROR`         | bug/DB error                            |

Never leak stack traces, SQL, credentials, or the comm key. Log details on the server, send a generic message to the client.

## 9. Contract evolution

- `docs/API.md` is the source of truth for v1. OpenAPI can be generated later from this contract.
- Additive changes (new fields/endpoints) are safe in v1. Renaming/removing fields -> `/api/v2`.
- The CLI `--json` uses the same envelope and DTOs as the API, so scripts and dashboards see a consistent data shape.
- CORS is off by default (same-origin). If the dashboard is on a different origin, add an explicit allowlist; do not use `*` while carrying cookies.
- API tokens are currently in-memory. If long-term external integration is needed, add an `api_tokens` table (token hash, expiry, revoke) without changing the endpoint contract.

## 10. Relay API (collector + 7B1 read-only viewer)

Status: **collector listener and read-only viewer implemented; LAN E2E verified 2026-10-29, ZeroTier-tunnel E2E pending**. `app relay status` reports
role/config/reachability. Full viewer admin editing is deferred to 7B2.

The relay lets a viewer PC pull **raw** data from a collector over a ZeroTier tunnel. The
collector owns the device and the SQLite DB; the viewer has no device, no sync, and no local
clone of the attendance rows. It computes recap, export, and web itself, and fails closed
when the collector is unreachable.

### Rules

- Base path `/relay/v1`, separate from the admin API `/api/v1`. The relay never proxies admin routes.
- GET only. No POST, PUT, PATCH, or DELETE.
- Auth: `Authorization: Bearer <ABSEN_RELAY_TOKEN>`, compared in constant time. Missing or wrong token -> `401 UNAUTHORIZED`.
- The token stays server-side on both sides. It is never sent to a browser and never logged.
- The collector binds the relay listener to its ZeroTier address, not `0.0.0.0` on a public interface. ZK TCP is never exposed through the tunnel.
- Raw attendance plus the employee master and display/active overlay: attendance rows carry `id_number`, `date`, `time`, `punch`, `verify`. The viewer recomputes IN/OUT, status, recap, late, and early leave; the stored `status` is not authoritative.
- The relay sends the calendar (`schedule`) so the viewer resolves the same workdays.
- One hop: a viewer can never serve a relay, and a collector never reads from another relay. `ABSEN_RELAY_ENABLED=true` and `ABSEN_RELAY_URL` are mutually exclusive by role.
- Viewer failures map to `502 RELAY_UNAVAILABLE`, `502 RELAY_AUTH`, `502 RELAY_BAD_RESPONSE`, or `504 RELAY_TIMEOUT`; no stale/empty fallback. Viewer writes return `403 READ_ONLY_VIEWER`.

### Endpoints

| Method | Path                   | Function                                 |
| ------ | ---------------------- | ---------------------------------------- |
| GET    | `/relay/v1/meta`       | versions, last sync, row counts          |
| GET    | `/relay/v1/employees`  | raw employees                            |
| GET    | `/relay/v1/schedule`   | calendar JSON as-is                      |
| GET    | `/relay/v1/attendance` | raw punches, filtered by date and user   |
| GET    | `/relay/v1/snapshot`   | employees + schedule + attendance + meta |

`GET /relay/v1/attendance` requires `from` and `to` (`YYYY-MM-DD`, inclusive) and accepts an
optional `employee_id`. `GET /relay/v1/snapshot` takes the same filters and returns everything
the viewer needs in one consistent read, so a page never mixes two different collector states.
Missing, invalid, or over-366-day ranges return `400 INVALID_QUERY`. The other three routes
take no filters.

Response shapes: `/meta` returns the flat meta object; `/employees` and `/attendance` return
arrays; `/snapshot` returns `{ meta, employees, schedule, attendance }`.
`/meta` includes `counts: { employees, attendance }` and `last_sync` (`at`, `ok`, `users`,
`records`, `duration_ms`, `first_date`, `last_date`, `error`) so a viewer can detect a changed
collector without transferring all rows. Employee rows include `display_name`, `prefix_title`,
`suffix_title`, `active`, and `updated_at` so the viewer applies the same display names and
hides inactive employees from recap/user/poin sheets.

### Example

```json
{
  "data": {
    "meta": {
      "app_version": "0.1.0",
      "schema_version": 5,
      "last_sync": {
        "at": "2026-10-21T14:43:22+07:00",
        "ok": true,
        "users": 12,
        "records": 265,
        "duration_ms": 4120,
        "first_date": "2026-09-28",
        "last_date": "2026-10-21",
        "error": null
      },
      "counts": { "employees": 12, "attendance": 265 }
    },
    "employees": [
      {
        "id_number": "992",
        "name": "Dummy Siti",
        "card": 0,
        "group_id": "1",
        "privilege": 0,
        "device_uid": 1,
        "display_name": null,
        "prefix_title": "",
        "suffix_title": "",
        "active": true,
        "updated_at": null
      }
    ],
    "schedule": {
      "version": 1,
      "base": {
        "MONDAY": { "in": "08:00", "out": "16:00" },
        "TUESDAY": { "in": "08:00", "out": "16:00" },
        "WEDNESDAY": { "in": "08:00", "out": "16:00" },
        "THURSDAY": { "in": "08:00", "out": "16:00" },
        "FRIDAY": { "in": "08:00", "out": "16:00" },
        "SATURDAY": { "in": "08:00", "out": "12:00" },
        "SUNDAY": null
      },
      "overrides": []
    },
    "attendance": [
      { "id_number": "992", "date": "2026-10-20", "time": "07:28:34", "punch": 0, "verify": 15 }
    ]
  }
}
```

Freshness: the relay reflects the collector's last sync, not the device. The viewer queries
the collector on each request and answers an error if the collector is unreachable, rejects
the token, times out, or returns a malformed body; it never falls back to stale or empty data.
