# absenly

[![CI](https://github.com/SonyPradana/absenly/actions/workflows/ci.yml/badge.svg)](https://github.com/SonyPradana/absenly/actions/workflows/ci.yml)
[![Release](https://github.com/SonyPradana/absenly/actions/workflows/release.yml/badge.svg)](https://github.com/SonyPradana/absenly/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

One Bun application for pulling attendance data from a ZKTeco X606-S, calculating daily recaps, serving them through an admin web UI and a JSON API, and exporting them to Excel. The same process also serves an employee self-service page and a read-only relay for a second PC.

Tested device: **ZKTeco X606-S** (native TCP `4370`). Other ZK models may work but are not verified.

Status: **all documented phases except 7B2 are implemented.** Schema version is **8**. Live sync has been verified against the device; the relay collector and the read-only viewer have been verified on a LAN; a webhook has been delivered to a real receiver. A live ZeroTier-tunnel run is still pending.

## What it does

- **Read-only sync** from the device over TCP `4370` into SQLite. No delete, no clock write, no user write, ever.
- **Daily recap** from the schedule calendar: check-in, check-out, late, early leave, status.
- **`work_exceptions` ledger** for piket/overnight/holiday work, merged into the recap as a waiver. One night shift is one duty day; overtime minutes are not summed.
- **Admin web**: Beranda, Generate, Log Absensi, Karyawan, Jadwal, Hooks, Settings, About.
- **Excel export** in four modes: `raw`, `recap`, `user`, `poin`.
- **Public share page**: one employee, one month, 24-hour UUID link, no login.
- **Employee dashboard** at `/me`: own recap, monthly summary, own password change.
- **JSON API** `/api/v1` for the dashboard and any future client.
- **Read-only relay**: a collector next to the device serves raw data; a viewer PC computes its own recap, export, and web from it, with no device access, no sync, no writes, and no local clone.
- **Auto-sync**: DB-configured windows and intervals, started by `app serve` on the collector only, default off.

## Install

```bash
bun install
cp .env.example .env        # then fill in ABSEN_ZK_HOST and ABSEN_WEB_PASSWORD
```

Minimum viable `.env` for a collector:

```dotenv
ABSEN_ZK_HOST=192.0.2.10
ABSEN_WEB_USER=admin
ABSEN_WEB_PASSWORD=<choose one>
ABSEN_DB=absen.sqlite
ABSEN_ENV=production
ABSEN_SCHEDULE_FILE=schedule.json
```

Every key uses the `ABSEN_` prefix because Windows already sets `USERNAME` and dotenv does not override existing variables. See `.env.example` for the full list, the viewer block, and the relay block.

## First run

```bash
bun run sync          # pull users and punches, then verify the counts
bun run start         # admin web + API on http://127.0.0.1:3000
```

Open the dashboard and log in with `ABSEN_WEB_USER` / `ABSEN_WEB_PASSWORD`. That password is **bootstrap only**: once you change it in Settings, only the DB hash is accepted. `app admin reset-password` clears the hash locally so the env value works again (restart `serve` to drop live sessions).

Check the device without syncing:

```bash
bun run device -- probe --json
```

## Commands

```bash
bun run start                 # admin web + API
bun run dev                   # same, with watch
bun run sync                  # one sync
bun run export -- --for-month 2026-10 --json
bun run export -- --for-month 2026-10 --excel
bun run export -- --for-month 2026-10 --excel --mode raw,recap,user,poin
bun run check                 # fmt + lint + typecheck + test + compile
bun run e2e:local             # two real serve processes on 127.0.0.1, no device
bun run compile               # standalone dist/app(.exe)
```

Compiled CLI (`dist/app.exe` or `dist/app`):

```bash
app serve [--port 3000]
app sync
app device probe --json
app export --for-month 2026-10 --json
app export --for-month 2026-10 --excel --mode raw,recap,user,poin
app export --for-month 2026-10 --excel --mode user --user 992
app employees list [--json]
app employees update --id 992 --display-name "Budi" --prefix-title "H." --suffix-title ", S.Kom"
app employees update --id 993 --active false
app users list [--json]
app users set-password --employee-id 992 --password "rahasia-1"
app users delete --username budi
app admin reset-password
app relay status --json
```

`app help` and `app --version` work. `--json` writes only JSON to stdout, errors go to stderr, exit codes are `0`/`1`/`2`.

## CI and releases

GitHub Actions, both on `windows-latest`:

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: `fmt:check`, `lint`, `typecheck`, `test`, `e2e:local`, `compile`. No device and no network beyond loopback.
- **Release** (`.github/workflows/release.yml`) runs on a `v*` tag: the same checks, then a smoke test of `dist/app.exe` (`--version` must equal `package.json`), then it publishes `absenly-<tag>-windows-x64.zip` (binary + `.env.example` + README) with a `.sha256` file.

Cut a release:

```bash
# bump "version" in package.json first, then:
git tag v0.2.0
git push origin main --tags
```

The tag must be `v` + the `package.json` version, or the release job fails before building. There is no remote configured in this checkout yet; add one with `git remote add origin <url>` before pushing.

## Excel modes

| Mode    | Shape                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| `raw`   | One sheet `Raw`, every punch in the range, no dedupe, no employee filter                                     |
| `recap` | Two grids, `Masuk` and `Pulang`, dates as columns, employees as rows, real Excel formulas for totals         |
| `user`  | One sheet per employee, one row per punch, with a `Jadwal` column as the reference for `Telat`/`Pulang awal` |
| `poin`  | One sheet per employee, one row per day, mirroring the HTML recap on `/share` and `/me`                      |

Default is `recap`; `--mode` is a comma list. Without `--user`, only employees with punches get a sheet; with `--user`, every listed ID gets one even when empty. `poin` is one row per day with `Tanggal | Nama | Masuk | Pulang | Telat | Pulang cepat | Status`; minutes are text (`5 mnt`) and the name repeats on every row, matching the page.

## Web dashboard

- **Beranda**: attendance cards, punctuality, late rankings, longest late-streak list, last raw punches, and one weekday late-minutes chart. The chart switches to a log scale only when the spread exceeds 10x, and always prints the numeric value.
- **Generate**: one Excel file in any mode combination, plus a public one-employee share link.
- **Log Absensi**: today or a date range, employee filter, 100 raw punches per page.
- **Karyawan**: display name, prefix/suffix title, active flag, and the login column (create/reset/delete). Reset restores the default password `satutekad` and keeps the username; both actions revoke that employee's live sessions.
- **Jadwal**: base week plus date-range overrides, written atomically and hot-reloaded. The env fallback is read-only.
- **Hooks**: a thin event stream (`attendance.changed`, `sync.done`, `sync.failed`) plus optional webhook push with an HMAC signature. The server announces _that_ something changed; a bot or internal tool asks for the detail itself.
- **Settings**: password, backup download, logout-all, sync schedules, sync trigger.
- **About**: on-demand read-only device probe.

Inactive employees are hidden from the recap, `user`, and `poin` sheets, from the chart, and from the share picker. Existing share links stay valid until they expire.

## HTTP API

Login first, then call the API with the bearer token:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"<password>"}'

curl "http://127.0.0.1:3000/api/v1/attendance?month=2026-10&per_page=200" \
  -H "Authorization: Bearer <token>"
```

Success is `{ data, meta }`, errors are `{ error: { code, message } }`. The contract lives in [`docs/API.md`](docs/API.md); runnable examples for every endpoint are in [`docs/curl.md`](docs/curl.md).

## Hooks (events + webhooks)

Two ways to integrate, and the smaller one is usually enough.

**Poll (no secret, no webhook).** A bot asks what changed and decides what it means:

```bash
# events since id 41
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/events?since=41&limit=100"

# who checked in but has not checked out?
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/recap?from=2026-11-05&to=2026-11-05&presence=missing_out"
```

`presence` also accepts `all`, `complete`, and `missing_in`, and works on `/api/v1/summary`.

**Push (instant).** Register a URL in the Hooks tab or with `POST /api/v1/webhooks`. Each delivery carries `X-Rekap-Event` and `X-Rekap-Signature: sha256=<hmac(body, secret)>`; the secret is shown once, at creation.

Three events: `attendance.changed` (only when a sync inserted new punches), `sync.done`, `sync.failed`. Payloads are thin — counts, dates, duration, error text. No names, no PINs, no comm key: if the receiver needs detail, it calls the API.

Delivery is fire-and-forget after the sync, 5 s timeout, **one attempt, no retry**. A failed push leaves `attempts`/`last_error` on the event and the receiver recovers by polling `?since=`. Loopback and link-local URLs are rejected (`127.*`, `localhost`, `0.0.0.0`, `::1`, `169.254.*`); LAN, ZeroTier, and public hosts are allowed. A viewer has no event log and no webhooks (`403`).

## Relay (collector + viewer)

The collector runs next to the device and owns SQLite plus device access. It serves **raw** data on a separate GET-only listener over a ZeroTier address. The viewer pulls that data and computes its own recap, export, and web. It never touches the device, never triggers sync, never writes, never serves another relay, and keeps no local clone.

Collector:

```dotenv
ABSEN_RELAY_ENABLED=true
ABSEN_RELAY_HOST=192.0.2.20     # a specific ZeroTier address; 0.0.0.0/:: are rejected
ABSEN_RELAY_PORT=3100            # default
ABSEN_RELAY_TOKEN=<random token>
```

Viewer, from its own folder and its own `.env`:

```dotenv
ABSEN_ROLE=viewer
ABSEN_RELAY_URL=http://192.0.2.20:3100
ABSEN_RELAY_TOKEN=<same token>
ABSEN_WEB_USER=admin
ABSEN_WEB_PASSWORD=<choose one>
```

Do not copy the collector `.env` into the viewer folder: `ABSEN_ZK_HOST` there fails startup with `CONFIG_VIEWER_DEVICE`, and `ABSEN_RELAY_ENABLED=true` fails with `CONFIG_VIEWER_CHAIN`.

Routes: `/relay/v1/meta`, `/employees`, `/schedule`, `/attendance`, `/snapshot`. `attendance` and `snapshot` require `from`/`to`; `employee_id` is optional.

```bash
curl -H "Authorization: Bearer $ABSEN_RELAY_TOKEN" http://192.0.2.20:3100/relay/v1/meta
app relay status --json
```

**Known gap:** the relay is raw-only, so `work_exceptions` are not relayed. A viewer therefore reports the **unwaived** recap — a piket day shows as `telat` there while the collector shows `piket`. Admin writes on a viewer return `403 READ_ONLY_VIEWER`; full viewer editing is deferred to phase 7B2.

## Deployment layout

`bun run compile` produces a single executable, but the environment, schedule, and database stay external:

```text
app.exe
.env
schedule.json
absen.sqlite
logs/
```

Run the executable from that folder, or set absolute `ABSEN_SCHEDULE_FILE` / `ABSEN_DB`. `app serve` hot-reloads `schedule.json` when it changes and saves edits atomically; `app sync` and `app export` read the schedule at startup. A shortcut or Task Scheduler entry must set the working directory correctly.

`logs/YYYY-MM-DD.log` holds the daily sync log: one line per start, retry, completion, and error. It never records names, PINs, or the comm key.

## Security notes

- The device is **read-only**. This app never clears data, deletes users, sets the clock, restarts, or powers off.
- Secrets live only in `.env` and are never logged or rendered into HTML.
- The admin cookie is `HttpOnly`, `SameSite=Strict`, 8 hours. Failed logins are throttled at 5 per IP per 15 minutes.
- A downloaded backup contains the admin password hash, live share-link tokens, and webhook secrets. Treat it as a secret. `app admin reset-password` does not revoke running sessions; restart `serve`.
- A share link URL is a secret until it expires. There is no revoke and no active-link list.
- The relay token is read-only and stays server-side. Never expose ZK TCP `4370` through the tunnel.

## Documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map, schema, business rules, phase status.
- [`docs/API.md`](docs/API.md) — device port and HTTP `/api/v1` contract.
- [`docs/CLI.md`](docs/CLI.md) — `app` command contract, flags, JSON output, exit codes.
- [`docs/curl.md`](docs/curl.md) — runnable examples for every implemented endpoint.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, ground rules, and how to send a change.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability.
- [`AGENTS.md`](AGENTS.md) — working rules for agents.

## Stack

Bun + TypeScript (strict), `bun:sqlite`, `Bun.serve`, server-rendered HTML plus lazy vanilla-JS tabs, `xlsx`. No web framework, ORM, React, or frontend build step.

## License

[MIT](LICENSE).
