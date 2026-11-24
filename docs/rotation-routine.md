# Secrets: where they live and how to change them

What a deployment of this repository keeps secret, and the routine for changing each secret. No value is written here,
in the repository, in a log or in a chat; commands read a value from the macOS Keychain inside the command, so it is
never printed. (While such a command runs, a value passed as an argument is visible to other processes of the same
user, e.g. in `ps`; the routine assumes a machine with one user.)

## Where they live

| Secret | Kind | In production | On the maintainer's machine |
|---|---|---|---|
| `SERVICES_VOCAB_PATH` | the vocabulary service's secret path (48 characters) | Worker secret, `ondata-extended-services` | Keychain `ondata-extended-vocab-path` |
| `SERVICES_SKRIVPROV_PATH` | the write test's secret path (48 characters) | Worker secret | Keychain `ondata-extended-skrivprov-path` |
| `SKRIVPROV_LOGIN_PASSWORD` | the write test's login password | Worker secret | Keychain `ondata-extended-skrivprov-password` |
| `SKRIVPROV_LOGIN_SIGNING_SECRET` | the key every login token is signed with | Worker secret | nowhere: never needed again |
| `SKRIVPROV_WRITE_KEY` | the write API's key (64 hex), issued by the TemaTres side | Worker secret | Keychain `tematres-skrivprov-mcp`, owned by the tematres-test project |
| `AKN_GITHUB_TOKEN` (optional) | a GitHub token for the example host | Worker secret, if set | – |

Credentials on the maintainer's machine that can change the above: wrangler's Cloudflare login (it can replace every
Worker secret; `npx wrangler logout` ends it) and the GitHub CLI's login (`gh auth token`, also used by the scripts that
build the ecosystem index). The upstream watch in GitHub Actions uses the workflow's own `GITHUB_TOKEN`.

Configuration that is not secret (allowed hosts, rate limits) is in each `wrangler.toml` under `[vars]`. A Worker
secret cannot be read back; Cloudflare's stored logs and traces are off for the services Worker, since they would hold
the secret paths (DECISIONS, 2026-11-15).

## Changing a secret

Change a secret at once when it may have been seen by anyone else (a value shown in a chat counts), and when someone
who knew it no longer should; a yearly change is good where it gets done. Each change is a deployment and needs the maintainer's ok.

Each command below runs in a subshell that stops at the first failure, so the value never outlives it and a failure
reaches the caller. The new value goes first to a separate Keychain entry (`<entry>-new`), then to the Worker, and
only then over the old entry: if the upload fails, the old entry still holds the value the Worker uses. Check
afterwards with `npx wrangler secret list -c packages/host-services/wrangler.toml` (names only) and a call.

- **A secret path.** The old path answers 404 at once. The new connector address goes to the clipboard without being
  shown; replace it in each client (claude.ai connector, Claude Desktop), then empty the clipboard (`pbcopy </dev/null`).

  ```bash
  cd /path/to/ondata_extended && (
    set -e; E=ondata-extended-vocab-path; S=SERVICES_VOCAB_PATH
    P=$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')
    security add-generic-password -U -s "$E-new" -a "$USER" -w "$P"
    printf %s "$P" | npx wrangler secret put "$S" -c packages/host-services/wrangler.toml
    security add-generic-password -U -s "$E" -a "$USER" -w "$P"
    security delete-generic-password -s "$E-new" >/dev/null
    printf 'https://<worker host>/%s/mcp' "$P" | pbcopy
  ) && echo rotated || echo "FAILED: the old value is still in the entry; a new one, if made, is in <entry>-new"
  ```

  The write test's path the same way, with `E=ondata-extended-skrivprov-path` and `S=SERVICES_SKRIVPROV_PATH`.
- **The login password.** The same command with `E=ondata-extended-skrivprov-password`,
  `S=SKRIVPROV_LOGIN_PASSWORD`, `openssl rand -base64 24` (32 characters) and without the clipboard line. To log in,
  copy it from the Keychain (`security find-generic-password -s ondata-extended-skrivprov-password -w | tr -d '\n' |
  pbcopy`) and empty the clipboard afterwards.
- **The signing secret.** Made and set in one step, kept nowhere (the command is in `wrangler.toml`).
- **After a new password or signing secret**, every login ends, and so does every client's registration: a client id
  is signed with a key derived from both. A client that keeps its old id gets the page "This login request cannot be
  used" instead of the password form. Remove the connector and add it again, so that the client registers anew.
- **The write key.** Issued by the TemaTres side: ask its project, in a handoff file, for a new key in the Keychain
  entry; then set it with the command in `wrangler.toml` and check a dry run. The old key is withdrawn there.

After each change, the old value no longer works (404, or a refused login or key) and the new one does. Then check
where the current value of one Keychain entry appears: this repository's files and its git history. The answer is a
hit (with the file names), none, or an error; it says nothing about other folders, about earlier values, or about the
signing secret, which has no copy to compare with. Run the same `grep` over the AI assistant's session logs when one
was used.

```bash
cd /path/to/ondata_extended && (
  V=$(security find-generic-password -s <entry> -w) || { echo "ERROR: no such entry"; exit 2; }
  grep -rlF -e "$V" . --exclude-dir=node_modules; t=$?
  h=$(git log -p --all | grep -cF -e "$V")
  case $t in 0) echo "files: HIT (above)";; 1) echo "files: none";; *) echo "files: ERROR";; esac
  echo "history: $h lines"
)
```

## Guards

- A pre-commit hook runs gitleaks on what is staged (`.git/hooks/pre-commit`, local); `.gitleaksignore` lists the
  findings in past commits checked and known to be made-up test values. Its entries name a commit, so they do not cover
  a line changed later: a made-up value in a test is built in code (e.g. a part repeated), not written out whole, and
  no line carries a lasting `gitleaks:allow`.

  ```bash
  printf '#!/bin/sh\nexec gitleaks git --pre-commit --staged --redact --no-banner\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
  ```
- GitHub secret scanning and push protection are on for the repository.
- Password attempts on the write test's login are limited per client address (`[[ratelimits]]` in `wrangler.toml`):
  exactly on one connection, loosely across many (DECISIONS, 2026-11-24). The password's length is the main defence.
  To try the limit, send the attempts on one kept-alive connection (`curl … --next …`); one new connection per attempt
  measures how far the count lags, not whether it works.
