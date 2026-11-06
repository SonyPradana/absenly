# Relay (collector <-> viewer)

Read this guide first; `docs/ARCHITECTURE.md` section 13 and `docs/API.md` section 10 are the contract if they differ.

Relay replaces the old "pairing" idea. It is **not** a paired remote, not a device bridge, and not database replication.

## What relay is

- The collector runs next to the device and owns `zk.ts` plus SQLite.
- The viewer is the same app on another PC, connected over a ZeroTier tunnel.
- The viewer pulls **raw** data from the collector and does its own recap, export, and web.
- The collector exposes a read-only relay endpoint. The viewer has no device, no sync, and no local attendance clone.

```
Device <-LAN-> PC A collector: zk -> sync -> SQLite -> relay (ZeroTier address)
                                                     ^
                                                     | HTTP + token
                                         PC B viewer: relay client -> recap/export/web
```

## Roles

| Role                  | Device | Sync  | Local attendance DB | Relay server | Data source     |
| --------------------- | ------ | ----- | ------------------- | ------------ | --------------- |
| `collector` (default) | yes    | yes   | yes                 | opt-in       | own SQLite      |
| `viewer`              | never  | never | no                  | never        | collector relay |

`ABSEN_ROLE=collector|viewer`. `viewer` with relay enabled is a config error: no chain relay.

## Hard rules

1. **The relay never reaches the device.** `src/relay/**` must not import `zk.ts`, `device.ts`, or `sync.ts`, and must never open port 4370.
2. **Read-only.** Relay routes are GET only: meta, employees, schedule, attendance, snapshot. No sync, no device, no work-exception writes, no export.
3. **One hop.** A viewer cannot serve a relay. A collector always reads its own SQLite, never another relay.
4. **No clone.** The viewer queries live per request. No SQLite clone and no persistent cache in v1.
5. **Raw data only.** The relay sends `date`/`time`/`punch`/`verify` and the calendar; the viewer recomputes IN/OUT, status, recap, late, and early leave.
6. **No silent stale.** If the collector is unreachable, the viewer returns an error, never an empty or old result.
7. **Token stays server-side.** The relay token lives in `.env` on both sides, never in a browser, never in a log.
8. **Bind to the tunnel.** The relay listener binds the ZeroTier address, not `0.0.0.0` on a public interface. Never expose ZK TCP through the tunnel.

## Data contract

The relay serves raw values, not derived ones:

- `employees`: id_number, name, card, group_id, privilege, device_uid
- `attendance`: id_number, date, time, punch, verify (no recap fields)
- `schedule`: the calendar JSON as-is
- `meta`: app_version, schema_version, last_sync, counts

Freshness means "as fresh as the collector's last sync", not the device. Say that in the UI.

## Config keys

| Key                   | Default     | Needed by                 | Notes                                 |
| --------------------- | ----------- | ------------------------- | ------------------------------------- |
| `ABSEN_ROLE`          | `collector` | all                       | `collector` or `viewer`               |
| `ABSEN_RELAY_ENABLED` | `false`     | collector                 | opt-in relay listener                 |
| `ABSEN_RELAY_HOST`    | -           | collector + relay enabled | ZeroTier address to bind              |
| `ABSEN_RELAY_PORT`    | `3100`      | collector + relay enabled | separate from the admin API port      |
| `ABSEN_RELAY_TOKEN`   | -           | collector + relay, viewer | collector accepts it, viewer sends it |
| `ABSEN_RELAY_URL`     | -           | viewer                    | collector base URL                    |

Validation rules:

- `viewer` with `ABSEN_ZK_HOST` set -> startup error.
- `viewer` with relay enabled -> startup error (no chain).
- `collector` with `ABSEN_RELAY_URL` set -> startup error.
- Relay enabled without `ABSEN_RELAY_HOST` or `ABSEN_RELAY_TOKEN` -> startup error.
- `viewer` without `ABSEN_RELAY_URL` or `ABSEN_RELAY_TOKEN` -> startup error.

## Planned module layout

```
src/relay/
  ├─ server.ts   # read-only listener + routes, bound to the tunnel
  ├─ client.ts   # RelayReadStore -> collector over HTTP
  ├─ auth.ts     # constant-time token check
  └─ dto.ts      # wire format
src/store.ts     # ReadStore port (planned)
```

`SqliteReadStore` (collector) and `RelayReadStore` (viewer) implement the same port, so `recap.ts`, `web/`, and `api/` do not care where the rows came from. `recap.ts` stays pure.

## Planned relay API

Base `/relay/v1`, GET only, `Authorization: Bearer <token>`, `{ data, meta }` / `{ error }` envelope.

- `GET /relay/v1/meta`
- `GET /relay/v1/employees`
- `GET /relay/v1/schedule`
- `GET /relay/v1/attendance?from&to&id_number`
- `GET /relay/v1/snapshot?from&to` -> employees + schedule + attendance + meta in one consistent read (preferred for the viewer)

Never expose the `/api/v1` admin routes through the relay.

## Implementation order (later)

1. `ReadStore` port + `SqliteReadStore`, with behaviour unchanged.
2. Relay server on the collector: read-only routes, token auth, bound to the tunnel.
3. `RelayReadStore` + `viewer` role; `sync` and `device probe` refuse to run in viewer mode.
4. `app relay status [--json]`.
5. Web and API on the viewer read through `ReadStore`.

## Tests

- Relay auth: missing or wrong token -> 401; the token value never appears in logs.
- Allowlist: GET allowed; POST/PUT/DELETE and admin routes denied.
- No device: the relay module must not import `zk.ts`/`device.ts`/`sync.ts`; a viewer must refuse `sync` and `device probe`.
- No chain: viewer with relay enabled is a startup error.
- Freshness: viewer output matches a fake collector snapshot; collector unreachable -> error, not empty.
- Everything runs offline: fake collector, no live device, no ZeroTier.

## Traps

- Do not reuse the admin session token for the relay; it is a separate service principal.
- Do not proxy `/api/v1` wholesale; that would expose sync, export, and write routes.
- Do not let the viewer open a device connection "just in case".
- Do not add a SQLite clone or persistent cache to the viewer in v1; it breaks the freshness promise.
- Do not bind the relay to `0.0.0.0` on a public interface.
