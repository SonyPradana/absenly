# API curl cookbook

Runnable examples for the implemented HTTP API. Copy, paste, run.

Status: **implemented endpoints only**. The contract lives in [`API.md`](API.md); this file
shows how to call it.

- Base URL: `http://127.0.0.1:3000`
- Base path: `/api/v1` (the collector relay uses `/relay/v1` on its own port; see section 18)
- Format: JSON, `Content-Type: application/json; charset=utf-8`
- Success body: `{ "data": ..., "meta"?: ... }`
- Error body: `{ "error": { "code": "...", "message": "...", "details"?: ... } }`
- All times are WIB (UTC+7). No UTC conversion anywhere.

## 1. Endpoint summary

| Method | Path                          | Auth     | Purpose                     |
| ------ | ----------------------------- | -------- | --------------------------- |
| GET    | `/api/v1/health`              | public   | status + last sync          |
| POST   | `/api/v1/auth/login`          | public   | create a session            |
| POST   | `/api/v1/auth/logout`         | session  | revoke the session          |
| GET    | `/api/v1/auth/me`             | session  | current session info        |
| GET    | `/api/v1/attendance`          | admin    | raw punches from the device |
| GET    | `/api/v1/employees`           | admin    | report names for dropdowns  |
| GET    | `/api/v1/users`               | admin    | employee login accounts     |
| GET    | `/api/v1/work-exceptions`     | admin    | list piket/overtime         |
| POST   | `/api/v1/work-exceptions`     | admin    | create a ledger row         |
| DELETE | `/api/v1/work-exceptions/:id` | admin    | delete a ledger row         |
| GET    | `/api/v1/recap`               | admin    | daily recap                 |
| GET    | `/api/v1/summary`             | admin    | recap totals                |
| GET    | `/api/v1/sync/status`         | admin    | last sync                   |
| POST   | `/api/v1/sync`                | admin    | manual full sync            |
| GET    | `/api/v1/sync-schedules`      | admin    | auto-sync schedules         |
| POST   | `/api/v1/sync-schedules`      | admin    | create a schedule           |
| POST   | `/api/v1/sync-schedules/:id`  | admin    | enable/disable a schedule   |
| DELETE | `/api/v1/sync-schedules/:id`  | admin    | delete a schedule           |
| GET    | `/api/v1/events`              | admin    | outbound event log          |
| GET    | `/api/v1/webhooks`            | admin    | webhook targets             |
| POST   | `/api/v1/webhooks`            | admin    | create a webhook target     |
| POST   | `/api/v1/webhooks/:id`        | admin    | update a webhook target     |
| DELETE | `/api/v1/webhooks/:id`        | admin    | delete a webhook target     |
| POST   | `/api/v1/webhooks/:id/test`   | admin    | send a test event           |
| GET    | `/api/v1/export.xlsx`         | admin    | Excel workbook              |
| GET    | `/api/v1/me`                  | employee | own profile                 |
| GET    | `/api/v1/me/attendance`       | employee | own raw punches             |
| GET    | `/api/v1/me/recap`            | employee | own daily recap             |
| GET    | `/api/v1/me/summary`          | employee | own monthly totals          |
| GET    | `/api/v1/me/work-exceptions`  | employee | own piket/overtime          |

## 2. Prerequisites

```bash
bun install
```

Copy `.env.example` to `.env` if you do not have one yet, then set at least:

```dotenv
ABSEN_WEB_USER=admin
ABSEN_WEB_PASSWORD=change-me
ABSEN_PORT=3000
ABSEN_HOSTNAME=127.0.0.1
ABSEN_DB=absen.sqlite
ABSEN_ZK_HOST=192.0.2.10
```

Notes:

- `ABSEN_WEB_PASSWORD` must not be empty, otherwise login cannot succeed. It is the bootstrap password; after Settings changes it, only the DB hash is accepted.
- `ABSEN_WEB_USER` defaults to `admin`.
- Never commit `.env`.
- `ABSEN_HOSTNAME=0.0.0.0` exposes the API and dashboard on the LAN. Use `127.0.0.1` for local work.
- `serve` needs `schedule.json` and the ZK config because `POST /api/v1/sync` uses them. Report routes read SQLite; only `POST /api/v1/sync` contacts the device. The web Jadwal editor hot-reloads the schedule without a restart.
- Outside the attendance network, `POST /sync` returns `502 DEVICE_UNAVAILABLE`; the rest of the API and dashboard still work.

## 3. Run the server

```bash
bun run start
```

`serve` starts the admin dashboard at `/` and the API at `/api/v1`. Log in at
`http://127.0.0.1:3000/login`; the API examples below still work independently.

Optional, needs the device reachable:

```bash
bun run sync
```

Without a sync, the database may be empty. Empty responses are valid and are not errors.

## 4. Base URL

Bash, Git Bash, and WSL:

```bash
BASE="${BASE:-http://127.0.0.1:3000}"
```

PowerShell:

```powershell
$Base = "http://127.0.0.1:3000"
```

## 5. Health

Public. Does not require a token and does not contact the device.

```bash
curl -sS "$BASE/api/v1/health"
```

Before any sync:

```json
{
  "data": {
    "ok": true,
    "last_sync": null
  }
}
```

After a successful sync:

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

`last_sync` is `null` when no sync has ever run.

## 6. Authentication

Two mechanisms share the same token:

- `Authorization: Bearer <token>` for scripts and API clients.
- Cookie `absen_session` for browsers (`HttpOnly`, `SameSite=Strict`, `Path=/`).

Sessions live in memory, expire after 8 hours, and there is no refresh token.
Restarting the server invalidates every token. Five failed logins per IP within 15
minutes return `429 TOO_MANY_ATTEMPTS` with `Retry-After`; a successful login clears
the counter. `ABSEN_WEB_PASSWORD` is bootstrap-only; after a Settings password change,
only the DB hash is accepted.

### 6.1 Login

```bash
curl -sS -X POST "$BASE/api/v1/auth/login" \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"change-me"}'
```

Success, `200`:

```json
{
  "data": {
    "token": "<opaque-session-token>",
    "expires_at": "2026-10-20T18:00:00+07:00",
    "user": {
      "role": "admin",
      "username": "admin"
    }
  }
}
```

The response also sets the `absen_session` cookie. The username is trimmed before the
comparison; the password is not.

Capture the token with `jq`:

```bash
TOKEN=$(curl -sS -X POST "$BASE/api/v1/auth/login" \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"change-me"}' \
  | jq -r '.data.token')
```

Without `jq`, copy the token from the response, or use the cookie jar instead.

### 6.2 Login with a cookie jar

```bash
curl -sS -c cookies.txt -X POST "$BASE/api/v1/auth/login" \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"change-me"}'

curl -sS -b cookies.txt "$BASE/api/v1/attendance?month=2026-10&per_page=5"
```

`cookies.txt` holds a live session token. Do not commit it.

### 6.3 Current session

```bash
curl -sS "$BASE/api/v1/auth/me" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "role": "admin",
    "username": "admin"
  }
}
```

Only the admin role exists today, so `employee_id_number` is not returned yet.

### 6.4 Logout

```bash
curl -sS -X POST "$BASE/api/v1/auth/logout" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "ok": true
  }
}
```

The token stops working immediately. Using it again returns `401 UNAUTHORIZED`.

## 7. Raw attendance

Requires an admin session. Returns the raw punches stored in the database.

```bash
curl -sS "$BASE/api/v1/attendance?per_page=5" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    {
      "id": 1,
      "date": "2026-10-20",
      "name": "Dummy Siti",
      "time": "07:28:34",
      "status": "IN",
      "verify": 15,
      "id_number": "992",
      "raw_punch": 0
    }
  ],
  "meta": {
    "from": "2026-10-01",
    "to": "2026-10-31",
    "total": 4,
    "page": 1,
    "per_page": 5,
    "total_pages": 1
  }
}
```

Field notes:

| Field       | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `id`        | database row id, not a device id                  |
| `date`      | `YYYY-MM-DD`, WIB                                 |
| `time`      | `HH:MM:SS`, WIB                                   |
| `name`      | employee name from the `employees` master table   |
| `status`    | `IN` or `OUT`, derived from the 10:00 rule        |
| `verify`    | device verification mode, `15` means FACE         |
| `id_number` | employee PIN, the join key with the device        |
| `raw_punch` | raw device value, `0` or `1`, and it can be wrong |

Ordering is `date ASC, time ASC, id_number ASC`.

### 7.1 Filters

Month:

```bash
curl -sS "$BASE/api/v1/attendance?month=2026-10&per_page=200" \
  -H "Authorization: Bearer $TOKEN"
```

Inclusive date range:

```bash
curl -sS "$BASE/api/v1/attendance?from=2026-10-01&to=2026-10-31" \
  -H "Authorization: Bearer $TOKEN"
```

One employee, exact PIN match:

```bash
curl -sS "$BASE/api/v1/attendance?employee_id=00123&month=2026-10" \
  -H "Authorization: Bearer $TOKEN"
```

Rules:

| Param         | Value         | Default       | Notes                                    |
| ------------- | ------------- | ------------- | ---------------------------------------- |
| `month`       | `YYYY-MM`     | current month | cannot be combined with `from`/`to`      |
| `from`        | `YYYY-MM-DD`  | -             | inclusive, must be paired with `to`      |
| `to`          | `YYYY-MM-DD`  | -             | inclusive, at most 366 days with `from`  |
| `employee_id` | 1 to 32 chars | all employees | exact match, trimmed, leading zeros kept |
| `page`        | integer >= 1  | `1`           |                                          |
| `per_page`    | 1 to 200      | `50`          |                                          |

- Without `month`, `from`, or `to`, the period is the current month in WIB.
- `month=2026-13` is invalid. `2026-02-31` is invalid.
- `from` must be on or before `to`.
- Filters apply before pagination. `meta.total` is the full filtered count.
- No results returns `200` with `data: []`, never `404`.

### 7.2 Pagination

```bash
curl -sS "$BASE/api/v1/attendance?month=2026-10&page=2&per_page=50" \
  -H "Authorization: Bearer $TOKEN"
```

`meta.total` stays the count of the whole filtered set, `meta.total_pages` is
`ceil(total / per_page)` and is `0` when there are no rows.

## 8. Employees

Admin. All employees, including inactive ones, ordered by report name. Not paginated.

```bash
curl -sS "$BASE/api/v1/employees" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    {
      "id_number": "00123",
      "name": "H. Budi, S.Kom",
      "device_name": "Dummy Budi",
      "display_name": "Budi",
      "prefix_title": "H.",
      "suffix_title": ", S.Kom",
      "card": 0,
      "group_id": "1",
      "privilege": 0,
      "active": true
    }
  ],
  "meta": { "total": 3 }
}
```

`name` is the report name: `prefix_title + (display_name ?? device_name) + suffix_title`.
`device_name` is the read-only device master name; `display_name`, titles, and `active`
are the editable profile overlay. `active: false` means the employee is hidden from
recap/summary unless you pass `employee_id` explicitly. `attendance` still returns
their raw punches.

### `GET /api/v1/users`

Admin. Employee login accounts from `app_users`, ordered by username. No password
hash, and the admin account is not listed. A viewer has no local accounts and returns
`[]`.

```bash
curl -sS "$BASE/api/v1/users" \
  -H "Authorization: Bearer $TOKEN"
```

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

Accounts are created from the Karyawan tab (admin session, same-origin):

```bash
# create or reset to the default password; a new account uses the PIN as username
curl -sS -X POST "$WEB/employees/992/account" \
  -H "Origin: $WEB" -b "$COOKIE" -H "content-type: application/json" -d '{}'

# delete the account; attendance rows stay
curl -sS -X POST "$WEB/employees/992/account/delete" \
  -H "Origin: $WEB" -b "$COOKIE" -H "content-type: application/json" -d '{}'
```

Both return `200`; reset/delete revoke that employee's live sessions in the running
server. A viewer returns `403 READ_ONLY_VIEWER`.

## 9. Daily recap

Admin. One row per `date + id_number`, ordered `date ASC, name ASC`.

```bash
curl -sS "$BASE/api/v1/recap?month=2026-10&per_page=5" \
  -H "Authorization: Bearer $TOKEN"
```

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
    "to": "2026-10-31",
    "total": 20,
    "page": 1,
    "per_page": 5,
    "total_pages": 4
  }
}
```

### 9.1 Filters

```bash
curl -sS "$BASE/api/v1/recap?month=2026-10&presence=missing_out&punctuality=late" \
  -H "Authorization: Bearer $TOKEN"
```

| Param         | Values                                         |
| ------------- | ---------------------------------------------- |
| `presence`    | `all`, `complete`, `missing_in`, `missing_out` |
| `punctuality` | `all`, `late`, `ontime`                        |

- `complete` = both IN and OUT exist; `missing_*` = that punch is missing.
- `late` = `late_minutes > 0`; `ontime` = `late_minutes` is `0` (a missing IN is neither).
- `employee_id` still selects one PIN; `page`/`per_page` work as in attendance.
- Inactive employees are hidden unless `employee_id` is explicit.
- Times are WIB. `late_minutes`/`early_minutes` are `null` for a missing punch.

## 10. Summary

Admin. Totals for the entire filtered recap, not one page.

```bash
curl -sS "$BASE/api/v1/summary?month=2026-10" \
  -H "Authorization: Bearer $TOKEN"
```

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

- `rows` after filters; `present` rows with at least one punch.
- `incomplete` = no IN or no OUT.
- `late`/`early` count rows, `late_minutes`/`early_minutes` sum minutes.
- The same `month`/`from`/`to`, `employee_id`, `presence`, and `punctuality` filters apply.
- `page`/`per_page` do not change the totals.

## 11. Work exceptions

A separate piket/overtime ledger. It does not change attendance or the daily recap yet.

```bash
curl -sS "$BASE/api/v1/work-exceptions?month=2026-10" \
  -H "Authorization: Bearer $TOKEN"
```

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

`kind` is `overtime | night_shift | holiday_work | other`. Period filtering uses
`start_date`, so a cross-midnight piket appears in its starting month. Results are
ordered `start_date DESC, start_time DESC`.

Create:

```bash
curl -sS -X POST "$BASE/api/v1/work-exceptions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "id_number":"992",
    "kind":"night_shift",
    "start_date":"2026-10-20",
    "start_time":"21:00:00",
    "end_date":"2026-10-21",
    "end_time":"07:00:00",
    "note":"Piket"
  }'
```

Success is `201` with the created row. A duplicate/overlapping range for the same
employee returns `409 WORK_EXCEPTION_OVERLAP`; adjacent half-open ranges are allowed.
Unknown employee, unknown kind, bad date/time, or a duration over 48 hours returns
`400 INVALID_BODY` with `details.field`.

Delete:

```bash
curl -sS -X DELETE "$BASE/api/v1/work-exceptions/1" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "data": { "ok": true } }
```

A missing id returns `404 NOT_FOUND`.

## 12. Sync

Last sync status:

```bash
curl -sS "$BASE/api/v1/sync/status" \
  -H "Authorization: Bearer $TOKEN"
```

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

`last_sync` is `null` before the first sync. Manual full sync, no body:

```bash
curl -sS -X POST "$BASE/api/v1/sync" \
  -H "Authorization: Bearer $TOKEN"
```

Auto-sync schedules (window + interval, WIB, admin only):

```bash
curl -sS "$BASE/api/v1/sync-schedules" \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST "$BASE/api/v1/sync-schedules" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"days":"MONDAY,SATURDAY","start_time":"07:00","end_time":"09:00","every_minutes":15}'

# pause a row without deleting it
curl -sS -X POST "$BASE/api/v1/sync-schedules/1" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

curl -sS -X DELETE "$BASE/api/v1/sync-schedules/1" \
  -H "Authorization: Bearer $TOKEN"
```

`days` is `*` or a comma list. `start_time` is inclusive, `end_time` exclusive, and a window may not cross midnight. Many rows union; the shortest `every_minutes` wins while a window is open. The ticker re-reads the table every 30 seconds, so edits apply without a restart. Only `app serve` on the collector runs it; a viewer answers `403 READ_ONLY_VIEWER` and has no device to sync.

Events and webhooks (Hooks, collector only):

```bash
# Ask "what changed since event 41?" — the whole poll integration for a bot.
curl -sS "$BASE/api/v1/events?since=41&limit=100" \
  -H "Authorization: Bearer $TOKEN"

# Who checked in but has not checked out yet?
# The "not before 17:00" rule belongs in the bot, not here.
curl -sS "$BASE/api/v1/recap?from=2026-11-05&to=2026-11-05&presence=missing_out" \
  -H "Authorization: Bearer $TOKEN"

# Register a receiver. `secret` comes back once only.
curl -sS -X POST "$BASE/api/v1/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://bot.example.com/rekap-hook","events":["sync.done","sync.failed"]}'

curl -sS -X POST "$BASE/api/v1/webhooks/1/test" \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST "$BASE/api/v1/webhooks/1" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

curl -sS -X DELETE "$BASE/api/v1/webhooks/1" \
  -H "Authorization: Bearer $TOKEN"
```

A delivery looks like this. The signature is `sha256=<hex HMAC-SHA256 of the raw body>`; verify it with the webhook secret before trusting the payload.

```http
POST /rekap-hook HTTP/1.1
Content-Type: application/json
X-Rekap-Event: attendance.changed
X-Rekap-Signature: sha256=...

{"id":42,"event":"attendance.changed","at":"2026-11-05T08:12:00+07:00",
 "data":{"from":"2026-11-05","to":"2026-11-05","inserted":12,"records":300,"users":12}}
```

Timeout is 5 seconds, one attempt, no retry: a failed push leaves `attempts`/`last_error` on the event and the receiver catches up with `?since=`. Loopback and link-local URLs are rejected with `400 BLOCKED_URL`; a viewer answers `403 READ_ONLY_VIEWER`.

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

- Synchronous; allow at least 60 seconds on the client.
- Another sync running -> `409 SYNC_IN_PROGRESS`.
- Device unreachable/failing -> `502 DEVICE_UNAVAILABLE` with
  `details.device_code` (`ZK_TIMEOUT`, `ZK_NETWORK`, etc.).
- This is the only endpoint that may contact the device. It never clears data or
  commits a partial snapshot.

## 13. Excel export

```bash
curl -sS "$BASE/api/v1/export.xlsx?month=2026-10&mode=recap" \
  -H "Authorization: Bearer $TOKEN" \
  -o absen-recap-2026-10-01_2026-10-31.xlsx
```

`mode` is a comma list of `raw`, `recap`, `user`, `poin` (default `recap`).
`employee_id` narrows the recap grids, user sheets, and poin sheets; `employee_ids`
accepts a comma list (additive v1) and is mutually exclusive with `employee_id`.
`raw` is always the full punch workbook and ignores employee filters. `user` and `poin`
are the two per-employee layouts: `user` is one row per punch with a `Jadwal` reference
column, `poin` is one row per day mirroring the `/share` recap table. Asking for both
gives the poin sheet a ` (poin)` name suffix. `presence`/`punctuality` are rejected because
they are daily-row filters; use `/api/v1/recap` for those.

- The response is an XLSX file, not JSON.
- `404 NO_DATA` if no punches match.
- The filename is `absen-{mode}-{from}_{to}.xlsx`; combined modes join the names.
- Layouts match `app export --excel`; see `CLI.md` section 5.

## 14. Errors

Every error uses the same envelope:

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "month must be in YYYY-MM format",
    "details": {
      "field": "month"
    }
  }
}
```

| Status | Code                     | When                                                              |
| ------ | ------------------------ | ----------------------------------------------------------------- |
| 400    | `INVALID_BODY`           | invalid JSON body or work-exception field                         |
| 400    | `INVALID_QUERY`          | bad parameter; see `details.field`                                |
| 401    | `INVALID_CREDENTIALS`    | wrong username or password                                        |
| 401    | `UNAUTHORIZED`           | missing, expired, or revoked token                                |
| 403    | `FORBIDDEN`              | session exists but lacks admin rights, not reachable today        |
| 403    | `READ_ONLY_VIEWER`       | write attempted on a viewer (sync, profile edit, share, schedule) |
| 404    | `NOT_FOUND`              | unknown path, missing work-exception, or missing data             |
| 404    | `NO_DATA`                | Excel export with no matching punches                             |
| 405    | `METHOD_NOT_ALLOWED`     | wrong method; the `Allow` header lists the right one              |
| 409    | `SYNC_IN_PROGRESS`       | another sync still holds the lock                                 |
| 409    | `WORK_EXCEPTION_OVERLAP` | piket/overtime range overlaps                                     |
| 429    | `TOO_MANY_ATTEMPTS`      | 5 failed logins from this IP in 15 minutes                        |
| 500    | `INTERNAL_ERROR`         | unexpected server error                                           |
| 502    | `DEVICE_UNAVAILABLE`     | device error; see `details.device_code`                           |
| 502    | `RELAY_UNAVAILABLE`      | viewer cannot reach the collector                                 |
| 502    | `RELAY_AUTH`             | collector rejected the relay token                                |
| 502    | `RELAY_BAD_RESPONSE`     | malformed collector response                                      |
| 504    | `RELAY_TIMEOUT`          | collector request timed out                                       |

The login failure message is intentionally generic and is returned exactly as:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Username atau password salah."
  }
}
```

Responses never contain stack traces, SQL, credentials, or the device comm key.

## 15. Test matrix

Run from a clean shell against a running server.

| #   | Request                                                    | Expected                          |
| --- | ---------------------------------------------------------- | --------------------------------- |
| 1   | `GET /api/v1/health` without auth                          | `200`                             |
| 2   | `GET /api/v1/attendance` without auth                      | `401 UNAUTHORIZED`                |
| 3   | login with a wrong password                                | `401 INVALID_CREDENTIALS`         |
| 4   | login with a non-JSON body                                 | `400 INVALID_BODY`                |
| 5   | login with a correct password                              | `200`, token and `Set-Cookie`     |
| 6   | `GET /api/v1/auth/me` with the token                       | `200`, `role` is `admin`          |
| 7   | `GET /api/v1/attendance` with the token                    | `200`, `data` and `meta` present  |
| 8   | `GET /api/v1/attendance?month=2026-10`                     | `meta.from` and `meta.to` match   |
| 9   | `GET /api/v1/attendance?from=2026-10-01&to=2026-10-31`     | inclusive range                   |
| 10  | `GET /api/v1/attendance?employee_id=00123`                 | exact PIN, no partial matches     |
| 11  | `GET /api/v1/attendance?page=2&per_page=1`                 | second page, `meta.total` intact  |
| 12  | `GET /api/v1/attendance?month=2026-13`                     | `400 INVALID_QUERY`               |
| 13  | `GET /api/v1/attendance?month=2026-10&from=2026-10-01`     | `400 INVALID_QUERY`               |
| 14  | `GET /api/v1/attendance?from=2026-10-01`                   | `400 INVALID_QUERY`               |
| 15  | `GET /api/v1/attendance?page=0`                            | `400 INVALID_QUERY`               |
| 16  | `GET /api/v1/attendance?per_page=201`                      | `400 INVALID_QUERY`               |
| 17  | `POST /api/v1/attendance`                                  | `405`, `Allow: GET`               |
| 18  | `GET /api/v1/nope`                                         | `404 NOT_FOUND`                   |
| 19  | `POST /api/v1/auth/logout` then reuse the token            | `401 UNAUTHORIZED`                |
| 20  | restart the server, then reuse the old token               | `401 UNAUTHORIZED`                |
| 21  | `GET /api/v1/employees`                                    | `200`, `active` present           |
| 22  | `GET /api/v1/recap?month=2026-10`                          | `200`, daily rows and `meta`      |
| 23  | `GET /api/v1/recap?presence=missing_out`                   | only rows without OUT             |
| 24  | `GET /api/v1/summary?month=2026-10`                        | totals, no `meta`                 |
| 25  | `GET /api/v1/recap?presence=maybe`                         | `400 INVALID_QUERY`               |
| 26  | `POST /api/v1/work-exceptions` with a valid row            | `201`, created row                |
| 27  | repeat the same range                                      | `409 WORK_EXCEPTION_OVERLAP`      |
| 28  | `GET /api/v1/work-exceptions?month=2026-10`                | row list and `meta`               |
| 29  | `DELETE /api/v1/work-exceptions/<id>`                      | `200`, then `404` on repeat       |
| 30  | `GET /api/v1/sync/status`                                  | `last_sync` object or `null`      |
| 31  | `POST /api/v1/sync` with the device reachable              | `200`, full sync result           |
| 32  | `POST /api/v1/sync` with the device unreachable            | `502 DEVICE_UNAVAILABLE`          |
| 33  | `GET /api/v1/export.xlsx?month=2026-10`                    | XLSX attachment                   |
| 34  | `GET /api/v1/export.xlsx?from=2025-01-01&to=2025-01-02`    | `404 NO_DATA`                     |
| 35  | `GET /api/v1/export.xlsx?month=2026-10&presence=late`      | `400 INVALID_QUERY`               |
| 36  | `GET /api/v1/sync-schedules`                               | `data` list and `meta.next_at`    |
| 37  | `POST /api/v1/sync-schedules` valid window                 | `201`, normalized `days`          |
| 38  | `POST /api/v1/sync-schedules` `start_time=22:00,end=02:00` | `400 INVALID`                     |
| 39  | `POST /api/v1/sync-schedules/<id>` `{"enabled":false}`     | `200`, `enabled: false`           |
| 40  | `DELETE /api/v1/sync-schedules/<id>`                       | `200`, then `404` on repeat       |
| 41  | `GET /api/v1/events?since=0`                               | `data` list and `meta.next_since` |
| 42  | `GET /api/v1/events?since=1` after one event               | only rows with a bigger `id`      |
| 43  | `GET /api/v1/events?since=abc`                             | `400 INVALID_QUERY`               |
| 44  | `POST /api/v1/webhooks` `{"url":"https://..."}`            | `201`, `secret` returned once     |
| 45  | `GET /api/v1/webhooks` after creating one                  | rows, no `secret` field           |
| 46  | `POST /api/v1/webhooks` `{"url":"http://127.0.0.1/x"}`     | `400 BLOCKED_URL`                 |
| 47  | `POST /api/v1/webhooks` `{"events":["nope"]}`              | `400 INVALID_EVENTS`              |
| 48  | `POST /api/v1/webhooks/<id> {"enabled":false}`             | `200`, `enabled: false`           |
| 49  | `POST /api/v1/webhooks/<id>/test` with a live receiver     | `200`, `ok: true`                 |
| 50  | `DELETE /api/v1/webhooks/<id>`                             | `200`, then `404` on repeat       |

## 16. PowerShell

In PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` for the bash
examples above, or use `Invoke-RestMethod`:

```powershell
$Base = "http://127.0.0.1:3000"

$Login = Invoke-RestMethod -Method Post -Uri "$Base/api/v1/auth/login" `
  -ContentType "application/json" `
  -Body (@{ username = "admin"; password = "change-me" } | ConvertTo-Json)

$Headers = @{ Authorization = "Bearer $($Login.data.token)" }

Invoke-RestMethod -Uri "$Base/api/v1/health"
Invoke-RestMethod -Uri "$Base/api/v1/auth/me" -Headers $Headers
Invoke-RestMethod -Uri "$Base/api/v1/attendance?month=2026-10&per_page=5" -Headers $Headers
```

Copy the example file on Windows:

```powershell
Copy-Item .env.example .env
```

## 17. Troubleshooting

| Symptom                               | Cause and fix                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `curl: (7) Failed to connect`         | server not running, or `ABSEN_PORT` does not match `BASE`                         |
| `401 UNAUTHORIZED`                    | token expired after 8 hours, or the server restarted                              |
| `401 INVALID_CREDENTIALS`             | wrong username/password; after a password change, use the DB password, not `.env` |
| `429 TOO_MANY_ATTEMPTS`               | wait for `Retry-After`; restarting the server clears the in-memory throttle       |
| `400 INVALID_QUERY`                   | read `details.field`, then check the filter rules                                 |
| `502 DEVICE_UNAVAILABLE`              | device is off-network; check `details.device_code`                                |
| `data` is empty                       | no rows for that period, or the database was never synced                         |
| `jq: command not found`               | copy the token manually or use the cookie jar                                     |
| PowerShell errors on `curl`           | use `curl.exe` or `Invoke-RestMethod`                                             |
| browser fetch fails with a CORS error | CORS is off; call the API from a server or a terminal                             |

Security notes:

- `curl -v` prints the `Authorization` header. Do not paste that output into shared logs.
- Do not commit `cookies.txt`, tokens, `.env`, or device data.
- Login is throttled after 5 failures per IP per 15 minutes, but keep a strong admin
  password and bind the server to `127.0.0.1` unless the LAN needs access.
- A Settings backup contains the admin password hash; treat the file as a secret.

## 18. Collector relay (implemented)

The collector relay has its own base path and port; do not send admin cookies. It is
GET-only, uses a separate Bearer token, and returns raw rows, the employee master plus
display/active overlay, and the schedule only. The 7B1 viewer reads this API; it never
enables a relay of its own.

```bash
RELAY="http://192.0.2.20:3100"
RELAY_TOKEN="<ABSEN_RELAY_TOKEN>"

curl -H "Authorization: Bearer $RELAY_TOKEN" "$RELAY/relay/v1/meta"
curl -H "Authorization: Bearer $RELAY_TOKEN" "$RELAY/relay/v1/employees"
curl -H "Authorization: Bearer $RELAY_TOKEN" "$RELAY/relay/v1/schedule"
curl -H "Authorization: Bearer $RELAY_TOKEN" \
  "$RELAY/relay/v1/attendance?from=2026-10-01&to=2026-10-31&employee_id=992"
curl -H "Authorization: Bearer $RELAY_TOKEN" \
  "$RELAY/relay/v1/snapshot?from=2026-10-01&to=2026-10-31"
```

- `from` and `to` are required for `attendance` and `snapshot`; `employee_id` is optional.
- A missing/wrong token returns `401 UNAUTHORIZED`; a non-GET method returns `405`.
- `/meta` includes `counts`, `app_version`, `schema_version`, and `last_sync`
  (`at`, `ok`, `users`, `records`, `duration_ms`, `first_date`, `last_date`, `error`).
- `/employees` includes `display_name`, `prefix_title`, `suffix_title`, `active`, and
  `updated_at`; apply the same report-name and inactive-employee rules as the collector.
- The listener must bind a specific ZeroTier address (`0.0.0.0`/`::` are rejected).
  Keep `ABSEN_RELAY_TOKEN` server-side and out of shell history/logs.

PowerShell:

```powershell
$Relay = "http://192.0.2.20:3100"
$RelayHeaders = @{ Authorization = "Bearer $env:ABSEN_RELAY_TOKEN" }
Invoke-RestMethod -Uri "$Relay/relay/v1/meta" -Headers $RelayHeaders
Invoke-RestMethod -Uri "$Relay/relay/v1/snapshot?from=2026-10-01&to=2026-10-31" -Headers $RelayHeaders
```

## 19. Employee dashboard (implemented)

Employee accounts are created on the collector from the web Karyawan tab or the CLI
(not HTTP):

```bash
app users list
app users set-password --employee-id 992 --password "rahasia-1"   # username defaults to 992
app users set-password --username siti --employee-id 992 --password "rahasia-1"
app users delete --username siti
```

The web action `POST /employees/992/account` creates the account with username `992`
and password `satutekad`; pressing it again resets that password and keeps the
username. `POST /employees/992/account/delete` removes the account only.

Then log in with the same endpoints and read only your own rows:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"siti","password":"rahasia-1"}' | jq -r .data.token)

curl -s http://127.0.0.1:3000/api/v1/me -H "authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:3000/api/v1/me/recap?month=2026-10" -H "authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:3000/api/v1/me/summary?month=2026-10" -H "authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:3000/api/v1/me/attendance?month=2026-10" -H "authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:3000/api/v1/me/work-exceptions?month=2026-10" -H "authorization: Bearer $TOKEN"
```

- Scope comes from the session. `employee_id` in a `/me/*` query -> `400 INVALID_QUERY`.
- An admin token on `/me*` -> `403 FORBIDDEN`; an employee token on the admin routes -> `403`.
- The HTML page is `GET /me` (optional `?month=YYYY-MM`); an employee login redirects there.
- An expired/never-created `app_users` row makes the login fail with `401 INVALID_CREDENTIALS`.

## 20. Not available yet

These paths are planned in [`API.md`](API.md) but are **not implemented**. Requests to
them return `404 NOT_FOUND`.

```text
(none currently)
```

The collector relay, the 7B1 read-only viewer, and `app relay status` are implemented.
Full viewer admin editing (7B2) is not. Employees change their own password at
`/me/password`; there is no admin reset-by-email.

The admin web dashboard is implemented at `/` for every page listed in section 3;
`GET /` returns a login redirect when no session cookie is present.

## 21. Keeping this document in sync

This cookbook follows the implementation. If a route, query parameter, response field,
auth rule, or error code changes, update the same change:

1. `src/api/` (or `src/relay/` for relay routes)
2. [`API.md`](API.md)
3. this file
4. `tests/api.test.ts` (or `tests/relay.test.ts`)
5. run `bun run check`
