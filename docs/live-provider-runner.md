# Opt-in live-provider checks

`npm run test:live` runs checks against explicitly selected, preconfigured test accounts. It is disabled unless `AERIO_LIVE_TESTS=1` and `--run` are both supplied. It does not launch the desktop application or use its personal profile. Each account gets a fresh temporary SQLite database and mail directory, which are removed after the run.

Build the worker with `npm run build:main`. Copy `docs/live-test-config.example.json` to the ignored `live-test-config.local.json`, retaining only the accounts you intend to check. Configure each account's named environment variable with its credential JSON, then run:

```powershell
$env:AERIO_LIVE_TESTS = '1'
npm run test:live -- --run --config live-test-config.local.json --output live-test-evidence
```

Credentials belong in the process environment or your test secret manager, never in the account config, evidence, command arguments, or repository. OAuth accounts use this JSON shape in their named variable:

```json
{"type":"oauth","email":"test-account@example.test","accessToken":"CURRENT_TEST_ACCOUNT_ACCESS_TOKEN"}
```

Supply a current access token from the test account's existing OAuth setup, with the scopes Aerio requires. The runner verifies the token but does not refresh it or initiate consent. Refresh or replace expired tokens through that setup before another run.

IMAP accounts use the following shape. Set `config.provider` to `imap`, `icloud`, `yahoo`, `fastmail`, or `proton-bridge` as appropriate, with actual test-server settings:

```json
{
  "type": "imap",
  "email": "test-account@example.test",
  "config": {
    "provider": "imap",
    "email": "test-account@example.test",
    "username": "test-account@example.test",
    "password": "TEST_ACCOUNT_PASSWORD",
    "imapHost": "imap.example.test",
    "imapPort": 993,
    "imapSecurity": "tls",
    "smtpHost": "smtp.example.test",
    "smtpPort": 587,
    "smtpSecurity": "starttls"
  }
}
```

TLS and STARTTLS are accepted; certificate verification remains enabled unless a test configuration explicitly sets `allowInvalidCertificates: true`, for example for a disposable local server or Bridge. Account aliases must use the matrix's class prefix: `gmail-`, `microsoft-consumer-`, `microsoft-365-`, `icloud-`, `yahoo-`, `fastmail-`, `custom-imap-`, or `proton-bridge-`. The Microsoft account class is a configuration assertion, not an independently verified tenant classification. All selected credentials are validated before any account is contacted. The optional timeout, from 1 second to 1 hour, limits each worker request and the sync-completion wait; the default is 3 minutes.

The runner verifies credentials, completes a fresh mail sync, checks SQLite/file diagnostics, then checks offline pagination and cached identities across a worker restart. IMAP verification authenticates to SMTP but sends no message. The command creates no rules, draft, send, or message mutation operations; it reads remote folders/messages and keeps the resulting cache only in its temporary profile. It exits nonzero on failed checks, timeouts, or invalid configuration, and continues other selected accounts after an account fails.

The output directory contains a JSON diagnostic report and Markdown rows matching the matrix's execution-log columns. Output is constructed from allowlisted aliases, build version/commit, operating system, timestamps, phase counts, numeric health counters, and fixed failure categories. It omits credentials, addresses, message identities/content, raw provider errors, response payloads, and local profile paths. The filename identifies the corresponding JSON report. Reports do not include existing Aerio logs.

Evidence is scoped precisely: preconfigured credential verification is only a **Partial** result for `AUTH-01`; sync completion without an independent server inventory is **Partial** for `SYNC-01`; pagination/restart without a seeded search corpus is **Partial** for `MAIL-02`. `HEALTH-01` may receive **Pass** when all required diagnostics pass and the working tree matches its recorded commit. A dirty working tree produces **Partial** evidence even for that check. These rows do not complete the full live-provider release matrix. Review them before adding applicable rows to the execution log; the runner does not edit that log automatically.

Unit fixtures verify configuration rejection, failure/restart paths, secret-free diagnostics, and evidence scope. `npm run test:imap` also invokes the real CLI against its disposable loopback server and checks the output and absence of SMTP delivery. These automated fixtures prove runner behavior, not success against real Gmail, Microsoft, or other hosted accounts. Live runs remain opt-in and are not executed by ordinary CI.
