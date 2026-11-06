# ZK device access

Read this guide first; `docs/API.md` is the production contract if they differ. `src/zk.ts` is the hardware-verified implementation (every user/record, 0 field diff against the retired reference client on 2026-10-21). Keep it self-contained instead of rewriting the protocol.

## Port and adapter

- `src/device.ts` defines the port `DeviceGateway`, `DeviceCounts`, `DeviceUser`, `DeviceAttendance`, and `DeviceError`.
- `src/zk.ts` implements `DeviceGateway` with the tested `ZkClient`.
- `src/sync.ts` receives a `DeviceGateway`, never imports `ZkClient` directly.
- Tests use a `FakeDevice`; no live device.

```ts
syncNow({ device, db }): Promise<SyncResult>
```

## Hard rules

1. **Read-only.** Only `connect`, `getCounts` (probe), `readSnapshot`, identity/time, optional `subscribe`, `disconnect`. Never clear data, delete users, set time, restart, power off, or write options. Never port pyzk `live_capture()`; it can enable/disable the device.
2. **One sync at a time per database.** `syncNow` holds the SQLite `sync_lock` row across processes. Do not open parallel sessions; a crashed process leaves a lock that expires after 5 minutes.
3. **Join by `id_number` (PIN), never `uid`.** The 40-byte attendance record's UID is unreliable.
4. **Device time is WIB.** Store date/time as-is. No UTC conversion.
5. **Abort on count mismatch.** If parsed attendance count != device record count, throw and commit nothing. A live punch can race `readSnapshot()`; retry the whole sync 1-2x.
6. **Always free device buffers and disconnect.** The client sends `CMD_FREE_DATA` in `finally`; keep that behavior.
7. **Never log the comm key or credentials.**
8. **Clock drift is a warning, not a write.** Warn above 5 minutes; never set the device clock.
9. **Relay never proxies the device.** A viewer reads recorded server data only; never expose ZK TCP, sync, or device commands through the relay or the tunnel. See `relay.md`.

## Device facts

| Item               | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| Model              | ZKTeco X606-S                                          |
| Firmware           | `Ver 6.60 Sep 19 2019`                                 |
| Platform           | `ZMM220_TFT`                                           |
| Protocol port      | `4370` (native ZK)                                     |
| Comm key           | from `ABSEN_ZK_COMM_KEY` (default `0`)                 |
| Users              | live (read every sync)                                 |
| Attendance records | live (grows)                                           |
| Verified range     | 2026-09-28 to 2026-10-21                               |
| Full sync duration | ~1.3 s for 2.6k records                                |
| Device clock       | ~9 s behind server WIB; warn if drift > 5 min          |
| Open ports         | 80 (old web, default password), 4370 (ZK), 23 (telnet) |

Do not use port 80 / the old web UI for reporting. It is a fallback only, returns HTTP 200 even when logged out, and `attlog.dat` can be empty. Do not use telnet. Isolate the device in a LAN/VLAN; never expose it to the internet.

## Client contract

```ts
const zk = new ZkClient(host, port, commKey, timeoutMs);
await zk.connect();
const snapshot = await zk.readSnapshot(); // counts + users + attendance
await zk.disconnect();
```

`getCounts()` remains available for `app device probe`; sync uses `readSnapshot()`.

Types (production definitions in `src/device.ts`):

- `ZkCounts` / `DeviceCounts`: `users`, `fingers`, `records`, `usersCap`, `recordsCap`.
- `ZkUser` / `DeviceUser`: `uid`, `idNumber`, `name`, `privilege`, `card`, `groupId`.
- `ZkAttendance` / `DeviceAttendance`: `idNumber`, `name`, `date` (`YYYY-MM-DD`), `time` (`HH:MM:SS`), `punch` (0/1), `verify` (15 = FACE).
- `DeviceSnapshot`: `counts`, `users`, `attendance`.

`ZkClient` implements `DeviceGateway`. `readSnapshot()` reads counts before and after the buffers; if they change, or the parsed users/attendance count differs from the device count, it throws retryable `DeviceError` with `code: "ZK_COUNT_MISMATCH"`. Do not catch and commit partial rows.

## Attendance record format

This device uses **40-byte records**:

```
uid        u16     offset 0    unreliable
id_number  char24  offset 2    PIN, join key
verify     u8      offset 26   15 = FACE
timestamp  u32     offset 27
punch      u8      offset 31   0/1, can be wrong
reserved   8 bytes offset 32
```

The buffer starts with `u32 total_size`, then `count * packetSize`. The client detects 8/16/40-byte formats; keep that.

8/16-byte records have no PIN. They resolve via `uid`, which can be wrong because UIDs are reused after a user is deleted. This device uses 40-byte records, so always join by `id_number`.

## Alternative library

`zkteco-protocol` 0.6.1 was tested against this device and works after patching its comm-key-0 check, but it has bugs and no upstream hardware verification. Production stays with `src/zk.ts`. Its extra features (`getIdentity`, `getTime`, `subscribe`) can inspire an optional `ExtendedDeviceGateway` adapter later; they are not part of the core sync path.

- `getAttendanceLogs({ since })` filters on the client; the device still sends the full buffer.
- `subscribe()` does not reconnect or backfill, and other calls on the same connection throw while subscribed. Polling remains the source of truth.
- Its naming is different: `status` = verify byte (15 = FACE), `verifyMode` = raw punch. Do not confuse them with pyzk's `status`/`punch`.

## Protocol traps

- Frame magic: `0x5050`, `0x7D82`, then `u32` length.
- Checksum is 16-bit little-endian sum, complemented, mod `0xFFFF`.
- pyzk computes the checksum with `reply_id` before increment but sends the incremented `reply_id`. Copy this quirk exactly; "consistent" variants time out.
- Initial `reply_id` is 65534; the first packet goes out with reply `0`.
- Device replies `CMD_ACK_UNAUTH (2005)` even with comm key 0. Continue to auth, don't treat it as fatal.
- Buffered read: `1503` payload `<bhii>` = `1, command, fct, ext`; size is `payload[1..5]`; chunks via `1504` max `0xFFC0`; ACK each chunk; `1502` in `finally`. Reject a buffer > 5 MB.
- Only retry connection/network failures. Never retry auth or parse errors. Budget: connect 5 s, command 10 s, total sync 60 s.
- Validate timestamp year 2000-2100 and a real calendar date; reject `2026-02-31`.
- A 24-byte name may have no NUL terminator. Use the whole field; do not trim the last character.
- `readSnapshot()` is always a full read. The protocol has no `since` filter; client-side filtering does not reduce device traffic.
- Firmware comes from `CMD_GET_VERSION`, not `OPTIONS_RRQ`. Identity parameters (`~SerialNumber`, `~DeviceName`, `MAC`) are optional extended reads.

## IN/OUT rule

```
IN  : 00:00:00 <= time < 10:00:00   (earliest)
OUT : time >= 10:00:00              (latest)
```

The raw `punch` field has known errors (two records at 12:06 were marked 0/IN). Recompute from time. Store `raw_punch` only for audit.

The 10:00 split is for normal day-shift recap. The resolved `schedule.json` day changes late/early thresholds only. A piket/overnight `21:00`-`07:00` must be stored in `work_exceptions` (`kind = night_shift`); do not put it in the daily schedule or expect the 10:00 rule to pair it correctly.

## Sync integration

```
device.connect -> device.readSnapshot
              -> transaction: upsert employees, ensure orphan employees, upsert attendance, sync_log
              -> device.disconnect
```

- `syncNow({ device, db })` is called by `app sync` and `POST /api/v1/sync`. Both use the same lock and path.
- Upsert key: `(id_number, date, time)`.
- Full snapshot every sync: ~1.24 s at a few thousand records. At 100k it is ~50 s, near the 60 s budget; plan archive/compaction before the device fills.
- Do not hardcode a record count. Read counts every sync.
- Do not delete rows that disappear from the device. Log a warning if the record count drops.
- A live punch can race `readSnapshot()`. Retry the whole sync 1-2x; never commit partial rows.
- Clock drift > 5 min: log a warning; never set the device clock.
- `sync_log` stores attempt, duration, counts, first/last date, `ok`, `error`. Serial/firmware can be added when the adapter exposes identity; do not fake them.
- If an attendance `id_number` has no master, insert a placeholder employee with `name = id_number`.
- Web, API, and CLI sync use the same service.

## Before changing `zk.ts` / `sync.ts`

- The docs win on conflict.
- Keep `src/device.ts` dependency-free (types + error only).
- Keep `src/zk.ts` free of DB/web/API imports and self-contained.
- Live probing, if needed, is a temporary read-only script that imports `src/zk.ts`; never commit device data.
- Keep `sync.ts` importing `device.ts`, not `zk.ts`.
- Keep the adapter's count validation and `finally` cleanup.
- Add tests with fixtures; **never** make `bun test` depend on the device.

## Common mistakes

- Importing `zk.ts` from `sync.ts`, web, or API instead of using `DeviceGateway`.
- Joining attendance and users by `uid`.
- Using raw `punch` for IN/OUT, or treating `verify=15` as IN/OUT.
- Converting timestamps to UTC.
- Committing partial attendance when parsing fails, or failing to retry a live count-mismatch.
- Opening two connections during a sync.
- Assuming 2 punches per user-day (real data has 1-9).
- Hardcoding a record count; the device is live.
- Hardcoding Monday-Saturday or treating a `21:00`-`07:00` piket as a normal daily shift.
- Using the web UI/`attlog.dat`/telnet instead of the native protocol.
- Porting pyzk `live_capture()`; it can change device state.
- Using a client-side `since` filter as if it reduces device traffic.
- Hardcoding the comm key or device password.
