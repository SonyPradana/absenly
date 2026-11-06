# Attendance fixtures

These fixtures are an offline, anonymized snapshot of a ZKTeco X606-S device.
Tests **must not** touch a live device. Every test uses the files in this folder,
a `:memory:` DB, and `FakeDevice`.

## Privacy

Preserved: dates, times, punch distribution, number of punches per user-day,
24-byte names, comma-containing names, empty names, leading-zero IDs, and
`raw_punch` anomalies. Replaced:

- All primary names start with `Dummy `.
- All primary IDs start with `9`; real names and IDs are not in the fixtures.
- The user password in the raw 72-byte record is zeroed.
- Cards contain synthetic values, not real card numbers.
- User UIDs are remapped; attendance UIDs intentionally do not match user UIDs
  so a test fails if code joins through UID.
- Attendance reserved bytes are zeroed.

Do not add real names, IDs, cards, passwords, or comm keys to any file in this
folder, including tests and this README. Snapshots used to regenerate fixtures
stay outside the repo and must not be committed.

## File map

| File                            | Contents                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| `users.json`                    | 56 synthetic users, decoded from the 72-byte layout            |
| `attendance.json`               | 2,567 synthetic punches, 20 dates, 705 user-days               |
| `device/users-72.bin`           | raw 72-byte users + `u32` payload-size prefix                  |
| `device/attendance-40.bin`      | raw 40-byte attendance + `u32` prefix                          |
| `edge-cases.json`               | 6 users, 42 punches, 19 golden daily rows                      |
| `device/edge-users-72.bin`      | raw edge users                                                 |
| `device/edge-attendance-40.bin` | raw edge attendance                                            |
| `legacy.json`                   | 28-byte user layout, 8/16-byte attendance, expected decode     |
| `device/legacy/*.bin`           | raw legacy records                                             |
| `scenarios/sync-race.json`      | count-mismatch, retry, and idempotent-sync scenario            |
| `work-exceptions.json`          | piket/overtime ledger, overlaps, and proof recap is unchanged  |
| `schedules.json`                | valid/invalid schedule config, valid/invalid env, IN/OUT pairs |
| `expected/main-summary.json`    | golden summary for the main dataset                            |
| `expected/api-employees.json`   | golden response for `GET /api/v1/employees`                    |
| `expected/api-recap-edge.json`  | golden edge recap response                                     |
| `expected/cli-export-edge.json` | golden CLI export edge output                                  |
| `manifest.json`                 | source stats, schedule, counts, and SHA-256 of every file      |

Device record counts are live. Do not hardcode 2,567 in production tests; use
`manifest.counts` or count the fixtures. The source snapshot was taken on
2026-10-20 14:50 WIB with 56 users and 2,567 records; these numbers are metadata
only.

## Fixture schedule

The fixtures use a per-day schedule rather than a Monday-Saturday assumption:

| Day           | IN    | OUT       |
| ------------- | ----- | --------- |
| Monday-Friday | 07:00 | 16:00     |
| Saturday      | 07:00 | **12:00** |
| Sunday        | empty | empty     |

Saturday is intentionally shorter so tests catch code that still hardcodes
`07:00-16:00` for every day. The production `schedule.json` uses Saturday
16:00; that is the production default, not the fixture schedule. A day off is
determined by `null`, not by the day name. Tests change `SUNDAY` to `07:00-12:00`
to prove Sunday can be a workday.

`schedule.json` is the primary production source: base week + date-range
overrides. The `schedules.json` fixture still stores the old weekly/environment
shape for the generator and manifest checks; production calendar tests live in
`tests/schedule.test.ts`.

`work_exceptions` is a separate ledger. Piket `21:00`-`07:00` is recorded as
`night_shift` and is **not** merged into the daily recap. Overlap is checked as
a half-open interval `[start, end)`, so `16:00-17:00` and `17:00-18:00` may be
adjacent.

## Schedule config validation

`schedules.json` stores valid and invalid examples for the config:

- `SCHEDULE_PAIR` - only IN or only OUT is set.
- `SCHEDULE_ORDER` - OUT is equal to or earlier than IN.
- `SCHEDULE_TIME` - the time is not a 24-hour `HH:MM` value.
- `SCHEDULE_EMPTY` - there is not a single workday.
- `SCHEDULE_DAY` - unknown day name.

Valid examples include a short Saturday, a Sunday intentionally made a workday,
and a schedule with only one workday. `env_valid`/`env_invalid` are legacy
references for the per-day `ABSEN_SCHEDULE_<DAY>_IN/OUT` shape; production now
uses `schedule.json` and the flat `ABSEN_SCHEDULE_IN/OUT` fallback.

## Edge cases

- The `09:59:59` (IN), `10:00:00` (OUT), and `10:00:01` (no IN) boundaries.
- Late/early leave by exactly 1 minute.
- Missing IN, missing OUT, and user-days without a complete pair.
- Sunday with punches (still `libur` while the Sunday schedule is empty).
- 1 to 9 punches per user-day.
- Midnight punches `00:00:00` and `23:59:59`.
- Leading-zero IDs, 24-character IDs, names exactly 24 bytes, empty names.
- Comma-containing names and names with HTML characters (`&`, `<`).
- Raw `punch` 0/1 values that do not match the time; IN/OUT always comes from time.
- 28-byte users, 8-byte attendance (join by UID), and 16-byte attendance
  (join by `id_number`). The 8-byte record is the UID trap; do not use it for
  the main 40-byte data.

## Regeneration

The existing fixtures are enough for offline tests. Regeneration is only needed
when the device snapshot changes. The capture tool and raw snapshot are not part
of the repo (the snapshot contains PII); provide a snapshot JSON explicitly:

```powershell
bun run tests/fixtures/generate.ts --snapshot <snapshot.json>
bun run fixtures:check
```

The generator rewrites the JSON, raw binary, expected golden files, and
`manifest.json`. Do not run it without a snapshot. Keep snapshots outside the
repo and never commit them.

**Privacy guardrails.** The generator replaces identities, zeroes passwords and
cards, and remaps UIDs, so its output is safe to commit. A raw snapshot is not:
it carries real names, PINs, card numbers, and the device password. Keep a
snapshot in a folder that is gitignored or outside the repo, and never pass a
real `.env`, `absen.sqlite`, or `logs/` export to the generator.

JSON and binary files produced by the generator are excluded from `oxfmt` via
`.oxfmtrc.json` so their SHA-256 values in `manifest.json` do not change because
of formatting alone. Do not format generated files manually; regenerate them.

## Using the fixtures

```ts
import { loadAttendance, loadEdge, loadManifest } from "./support/fixtures.ts";

const attendance = loadAttendance().records;
const edge = loadEdge();
const manifest = loadManifest();
```

Sync tests use `FakeDevice` from `tests/support/fake-device.ts`; recap tests use
`buildDaily` from `tests/support/recap-reference.ts`. These references are test
rules, not production modules. Production uses `src/recap.ts`.

Raw binary files use a `u32 little-endian` prefix containing the payload size,
not including the prefix itself. Example: an attendance file with 2,567 records
is `4 + 2,567 * 40` bytes.

## Verification

`tests/fixtures.test.ts` checks:

- SHA-256 and size of every file in `manifest.json`.
- Decoding raw 72/40-byte data matches the JSON exactly.
- Live-data invariants (user count, dates, punches per day, missing IN/OUT,
  raw punch anomalies, 24-byte names, commas, UID trap).
- Golden summary, API recap, and CLI export.
- Count-mismatch failure does not produce partial data.
- Race/retry and idempotency scenarios through `FakeDevice`.

`tests/work-exceptions.test.ts` checks validation, overlap, and proof that the
ledger does not change the normal recap.

`tests/schedule.test.ts` checks the calendar JSON (base + overrides), priority,
overlap, time order, at least one workday, and the flat env fallback.
