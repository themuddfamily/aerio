# Hosted Matrix acceptance harness (D07)

This harness is ready to run when real hosted credentials are available. **No hosted pass has been recorded.** Contract tests and the offline runtime probe do not supply interoperability evidence or open Chat's gate.

The executable is `node scripts/matrix-hosted-interop.mjs --run`. It creates a disposable standalone Electron acceptance main using Aerio's production `ChatServiceHost`, rebuilds the actual shipped chat-service/preload bundles with the production Vite configurations, and loads them unchanged in sandboxed, isolated `WebContentsView` partitions. There is no in-memory SDK replacement, fake homeserver, preview environment override or gate waiver. The normal product gate remains untouched while the harness exercises the service beneath it.

## Required configuration and consent

Use **two dedicated disposable accounts** on one real public HTTPS homeserver that supports password login and the pinned SDK's crypto/backup APIs. The run creates login devices, a private encrypted room, cross-signing/secret-storage/key-backup data, encrypted text and media, and performs SAS verification. Recovery setup may replace an account's secret storage or key backup. Never use personal or production accounts containing history you need to preserve.

Place the following JSON in `.env.matrix-interop.local.json` (already covered by `.gitignore`'s `.env.*` rule), with file permissions restricted to you:

```json
{
  "homeserver": "https://matrix.your-public-domain.com",
  "userA": "@aerio-test-a:your-public-domain.com",
  "passwordA": "REPLACE_LOCALLY",
  "userB": "@aerio-test-b:your-public-domain.com",
  "passwordB": "REPLACE_LOCALLY",
  "disposableAccounts": true,
  "acceptServerMutations": true
}
```

Alternatively set `AERIO_MATRIX_INTEROP_CONFIG` to an ignored local JSON file, or supply `AERIO_MATRIX_HOMESERVER`, `AERIO_MATRIX_USER_A`, `AERIO_MATRIX_PASSWORD_A`, `AERIO_MATRIX_USER_B`, `AERIO_MATRIX_PASSWORD_B`, `AERIO_MATRIX_DISPOSABLE_USERS=1` and `AERIO_MATRIX_ACCEPT_SERVER_MUTATIONS=1`. Both consent flags are mandatory. Do not put secrets on the command line, in tracked files or in CI output.

The server must resolve exclusively to public addresses. Private/loopback hosts, HTTP, embedded credentials, URL queries/fragments, nonstandard ports, preview mode and disabled TLS verification are rejected. Secure OS credential storage is required; Linux `basic_text` is refused. Builds must use the pinned Matrix SDK. The harness needs a working Electron display environment and the existing development dependencies.

## Commands and their meaning

- `node scripts/matrix-hosted-interop.mjs --validate`: checks configuration structure only. No network, Electron acceptance or evidence output.
- `node scripts/matrix-hosted-interop.mjs --check-runtime`: rebuilds the shipped service/preload and runs their actual isolated encrypted-IndexedDB persistence self-test in Electron with a fresh profile. It checks OS secure storage and reopening with the same identity / refusal with another key. No credentials or hosted network calls are used. It writes no interoperability artifact.
- `node scripts/matrix-hosted-interop.mjs --run`: performs every hosted acceptance check below. Missing credentials fail before network or acceptance output.

Do not run the harness while another build is modifying the same `dist-electron` directories. It hashes the service/preload before and after acceptance and refuses evidence if either changes.

## Required hosted sequence

1. Verify secure credential storage, packaged-service availability, actual renderer Node isolation and encrypted Rust IndexedDB persistence. Record the running Electron version, pinned SDK, hosted client-server API versions and capability names/password support.
2. Sign in account A and account B through the production password-login helper. Create one private encrypted room and accept its invitation through the shipped isolated service. Verify both directions' text decryption and fetch the actual stored events to prove the server holds `m.room.encrypted` content.
3. Encrypt and upload an attachment in each direction using Aerio's production media helpers and isolated-service upload/download commands. Verify hosted media is ciphertext and the recipient decrypts the exact original bytes.
4. Set up A's recovery through the shipped service and require its `backupComplete` result. Sign in a second A device in a separate encrypted IndexedDB partition. Complete own-device SAS, then cross-user A↔B SAS. The disposable harness compares all seven independently generated emoji entries on both devices before confirming; the product does not auto-confirm verification.
5. Quit the whole Electron process. Launch a new Electron process with the same temporary profile, tokens, device IDs and wrapped crypto-store keys. Require unchanged Ed25519 device identities, persisted own-device trust, historical text/media decryption and new encrypted messages in both directions.
6. In the real isolated renderer, intercept one successful encrypted send response using Chrome's debugging protocol **after the hosted server accepted it**. Read the server's event ID, drop that response, then retry the same transaction ID. Require the same server event ID, one matching event in bounded server history, and one recipient event. This changes only transport delivery to the test client, not the server response data or SDK implementation.
7. Quit Electron again, keeping all older devices offline. Sign in A on a fresh device and partition. Require a historical event to be explicitly undecryptable before restore. Restore the actual server key backup using the recovery key; require imported keys and exact earlier text/media decryption. Live old devices cannot answer key requests during this phase.
8. Leave the disposable room and revoke only the sessions created by this run. No `/logout/all`, account deletion or other-device deletion is used.

Only after every check and cleanup pass is a sanitized version-bound JSON artifact written beneath the ignored `live-test-evidence/` directory. It contains SDK/Electron versions, public homeserver URL, checked time, API versions/capability names, fixed check results, platform/architecture and SHA-256 hashes of the exact service/preload. No access tokens, passwords, recovery keys, message bodies, room/user/device/event IDs or raw provider errors are written to that artifact.

The artifact is **release review input**, not a user-data gate file. The harness never edits `chat-gate.json` and does not implement a bundled gate fallback. A reviewed release integration must bind genuine hosted results to the shipped versions/artifact hashes, while retaining independent secure-storage and local crypto-persistence checks for every installation.

## Failures and cleanup

Any missing credential, unsupported authentication/backup policy, SAS mismatch, timeout, plaintext event, absent historical keys, changed build, incomplete phase or failed cleanup prevents evidence output. The console reports only the failing stage, suppressing raw exceptions and secrets. Failed runs attempt to revoke their own sessions. If cleanup cannot be confirmed, the OS-encrypted temporary profile is retained beneath the system temporary `aerio-hosted-matrix-*` directory for operator review; revoke that run's disposable-account sessions on the homeserver before removing the directory. Successful runs remove their temporary profile.

This harness currently tests password login only, matching Aerio's advertised login UI. Servers requiring interactive authentication for cross-signing, SSO/OIDC or unsupported policies fail closed; those flows need separate product support and acceptance evidence.

Protocol references: Matrix's official [client-server API](https://spec.matrix.org/v1.17/client-server-api/) defines transaction IDs, encrypted attachments, SAS verification and server key backups. The pinned SDK's `CryptoApi.requestDeviceVerification` initiates cross-user SAS; the shipped runtime validates target identifiers and still requires explicit verification confirmation.
