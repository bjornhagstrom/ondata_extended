# Secrets: where they live and how to change them

What a deployment of this repository keeps secret, and the routine for changing each secret. No value is ever written
here, in the repository, in a log or in a chat; commands read a value from the macOS Keychain inside the command, so it
is never shown.

## Where they live

| Secret | Kind | In production | On the maintainer's machine |
|---|---|---|---|
| `SERVICES_VOCAB_PATH` | the vocabulary service's secret path (48 characters) | Worker secret, `ondata-extended-services` | Keychain `ondata-extended-vocab-path` |
| `SERVICES_SKRIVPROV_PATH` | the write test's secret path (48 characters) | Worker secret | Keychain `ondata-extended-skrivprov-path` |
| `SKRIVPROV_LOGIN_PASSWORD` | the write test's login password | Worker secret | Keychain `ondata-extended-skrivprov-password` |
| `SKRIVPROV_LOGIN_SIGNING_SECRET` | the key every login token is signed with | Worker secret | nowhere: never needed again |
| `SKRIVPROV_WRITE_KEY` | the write API's key (64 hex), issued by the TemaTres side | Worker secret | Keychain `tematres-skrivprov-mcp`, owned by the tematres-test project |
| `AKN_GITHUB_TOKEN` (optional) | a GitHub token for the example host | Worker secret, if set | – |

Configuration that is not secret (allowed hosts, rate limits) is in each `wrangler.toml` under `[vars]`. A Worker
secret cannot be read back; Cloudflare's stored logs and traces are off for the services Worker, since they would hold
the secret paths (DECISIONS, 2026-11-15).

## Changing a secret

Change a secret once a year, at once when it may have been seen by anyone else, and when someone who knew it no longer
should. Each change is a deployment and needs the maintainer's ok.

- **A secret path.** Make a new one in the Keychain and in the Worker, then copy the new connector address to the
  clipboard without showing it, and replace the address in each client (claude.ai connector, Claude Desktop). The old
  path answers 404 at once.

  ```bash
  cd /path/to/ondata_extended && P=$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n') && \
    security add-generic-password -U -s ondata-extended-vocab-path -a "$USER" -w "$P" && \
    printf %s "$P" | npx wrangler secret put SERVICES_VOCAB_PATH -c packages/host-services/wrangler.toml && \
    printf 'https://<worker host>/%s/mcp' "$P" | pbcopy; unset P
  ```

  The write test's path the same way, with `ondata-extended-skrivprov-path` and `SERVICES_SKRIVPROV_PATH`.
- **The login password.** The same, with `ondata-extended-skrivprov-password` and `SKRIVPROV_LOGIN_PASSWORD` (32
  random characters, nothing copied). Every login ends; each client logs in again.
- **The signing secret.** Made and set in one step, kept nowhere (the command is in `wrangler.toml`). Every login ends.
- **The write key.** Issued by the TemaTres side: ask its project, in a handoff file, for a new key in the Keychain
  entry; then set it with the command in `wrangler.toml` and check a dry run. The old key is withdrawn there.

After each change: the old value no longer works (404, or a refused login or key), the new one does, and the value
appears in no file (`grep -rlF` with the value read from the Keychain inside the command).

## Guards

- A pre-commit hook runs gitleaks on what is staged (`.git/hooks/pre-commit`, local); `.gitleaksignore` lists the
  findings checked and known to be made-up test values.

  ```bash
  printf '#!/bin/sh\nexec gitleaks git --pre-commit --staged --redact --no-banner\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
  ```
- GitHub secret scanning and push protection are on for the repository.
- Password attempts on the write test's login are limited per client address (`[[ratelimits]]` in `wrangler.toml`).
