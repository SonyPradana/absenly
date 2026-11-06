# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/SonyPradana/absenly/security/advisories/new)
(Security → Report a vulnerability) or email the maintainer at
`sonypradana@gmail.com`. You will get a reply as soon as possible; please allow
time for a fix before disclosing publicly.

## Scope

absenly talks to a ZKTeco attendance device and stores employee attendance data,
an admin password hash, employee login hashes, share-link tokens, and webhook
secrets. Reports about any of the following are especially welcome:

- Authentication or session bypass on `/api/v1`, `/me`, or the admin web.
- CSRF on a state-changing route, or an authorization gap between roles
  (admin / employee / anonymous share link / relay viewer).
- Injection, path traversal, or SSRF through a webhook URL.
- Leaking a secret (password, comm key, relay token, webhook secret) into a
  response, a log line, or rendered HTML.
- A write path that touches the device where only read should be possible.

## Operational notes for operators

- Keep `.env` out of version control; it holds every secret.
- A backup (`.sqlite`) contains the admin hash, live share tokens, and webhook
  secrets — treat the file as a secret.
- A share link URL is a bearer secret until it expires (fixed 24 h). There is no
  revoke; treat exposure as a leak.
- The relay token is read-only and stays server-side. Never expose the device
  TCP port `4370` through the tunnel.
- The device interface is read-only by design: this project never clears data,
  deletes users, sets the clock, restarts, or powers off the device.

## Supported versions

This is a young project. Only the latest tagged release is supported with
security fixes.
