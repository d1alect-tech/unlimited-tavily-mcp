# Security Policy

API keys stay on disk outside git. Never commit `tavily.keys`, `.env`, or anything under `secrets/`.

## Rules

No tokens or API keys in code, docs, tests, scripts, or logs. Checked-in files use placeholders (`tvly-your-key`). Real keys live in:

`~/.config/opencode/secrets/tavily.keys`

Logs redact `tvly-*` values before printing.

## On leak

Rotate the key at tavily.com immediately, then purge it from git history before pushing. Treat any committed secret as compromised.

## Reporting

Open a GitHub issue on this repo. Name the credential and path. Never paste the secret.
