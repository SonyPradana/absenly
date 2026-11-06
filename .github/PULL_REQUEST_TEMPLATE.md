name: Pull request
description: Propose a change to absenly.
body:

- type: textarea
  id: what
  attributes:
  label: What and why
  description: What changes, and the problem it solves.
  validations:
  required: true
- type: textarea
  id: verification
  attributes:
  label: How it was verified
  description: Tests added or adjusted, and any manual check. Note anything not checked.
  validations:
  required: true
- type: checkboxes
  id: checklist
  attributes:
  label: Checklist
  options: - label: "`bun run check` is green (fmt + lint + typecheck + test + e2e:local + compile)"
  required: true - label: "Docs updated in the same change if an API route, query param, response field, auth rule, error code, or CLI flag changed"
  required: true - label: "No secret (password, comm key, relay token, webhook secret) added to code, a log, or rendered HTML"
  required: true - label: "Device stays read-only (no clear, delete user, set time, restart, or write)"
  required: true
