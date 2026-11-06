# Contributing to absenly

Thanks for taking a look. This is a small, single-process Bun app; the goal is to keep it that way.

## Setup

```bash
bun install
cp .env.example .env      # fill in ABSEN_ZK_HOST and ABSEN_WEB_PASSWORD
bun run check             # fmt + lint + typecheck + test + e2e:local + compile
```

You do **not** need the device to work on the code. Tests use fixtures and a fake device; `bun run e2e:local` runs two real `app serve` processes on loopback. Only `app sync` and `app device probe` touch hardware.

## Before you open a pull request

```bash
bun run fmt        # format
bun run check      # the full gate CI runs
```

`bun run check` must be green. It runs on `windows-latest` and `ubuntu`-free CI (Windows only), so avoid POSIX-only shell assumptions.

## Ground rules

Read [`AGENTS.md`](AGENTS.md) first — it is the working contract. The short version:

1. **The device is read-only.** No clear, no delete user, no set time, no restart, no write of any kind. Do not port `live_capture()`.
2. **Use `id_number` (PIN), not `uid`.** UID is unreliable in the 40-byte record.
3. **Times are WIB.** Store the device `date`/`time` as-is; never convert to UTC.
4. **Sync is idempotent and all-or-nothing.** `UNIQUE (id_number, date, time)` + upsert; a partial sync aborts and commits nothing.
5. **No business rules in `web/` or `api/`.** They are thin HTTP adapters. Rules live in `recap.ts`, `reports.ts`, `period.ts`, `hooks.ts`.
6. **Secrets stay in `.env`.** Never hardcode, log, or render a password, comm key, or the relay/webhook token.
7. **Escape HTML.** Use `esc()` for any user or device data in a rendered page.
8. **No new runtime dependency without a real need.** Currently only `xlsx`.

## Changing the API or CLI

If a route, query parameter, response field, auth rule, or error code changes, update [`docs/API.md`](docs/API.md) and [`docs/curl.md`](docs/curl.md) in the same change. If a command or flag changes, update [`docs/CLI.md`](docs/CLI.md). `v1` is additive only.

## Style

TypeScript strict; `unknown` at boundaries with narrowing, no `any`. Small pure functions for rules, side effects at the edges. Comments only for non-obvious decisions (protocol quirks, the 10:00 rule, the UID trap). Run `bun run fmt` before finishing.

## Commit messages

Conventional-commit prefixes are used in history: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `perf:`, `refactor:`, `ci:`. Scope is optional (`feat(web):`). Keep the subject imperative and under ~72 characters.

## Releases

Maintainers cut a release by bumping `version` in `package.json`, committing, then tagging `v<version>` and pushing the tag. The `Release` workflow builds and publishes the Windows binary. A tag that does not match `package.json` fails on purpose.
