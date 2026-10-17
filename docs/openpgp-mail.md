# OpenPGP mail

Aerio signs, encrypts, decrypts, and verifies mail with OpenPGP using PGP/MIME (RFC 3156). It uses [OpenPGP.js](https://openpgpjs.org/) v6 (`openpgp` 6.3.2). Inline PGP (`-----BEGIN PGP MESSAGE-----` and cleartext-signed text) can be read and verified but is never produced.

## Where things run

- **Main process only.** All key material and every crypto operation stay in the Electron main process (`electron/mail/openpgp-keyring.ts`, `electron/mail/openpgp-ipc.ts`). The mail worker never sees a key: when a draft asks to be signed or encrypted, the worker builds the normal MIME message, sends it to the main process with an `openpgp-request` message, and sends exactly what comes back. A missing or failed reply aborts the delivery.
- **Renderer.** The renderer only gets key summaries, recipient checks, signature results, and decrypted content the user asked to read. Decrypted text and HTML (sanitized with the normal message sanitizer, so remote images stay blocked) are held only in the message banner's React state. They are never written to the mail cache or search index.

## Key storage

Keys live in `openpgp-keyring.dat` in the profile folder:

- Private keys are stored only in their passphrase-encrypted OpenPGP form. Generated keys are created with a passphrase; an imported secret key that has no passphrase is refused until the user chooses one, and is then encrypted with it before anything is written. The keyring refuses to store a decrypted secret key.
- The whole keyring file is also wrapped with Electron `safeStorage` (DPAPI, Keychain, or libsecret/KWallet), following `electron/mail/secure-storage.ts`. With no secure backend, keys cannot be saved. If the file exists but cannot be read, Aerio will not overwrite it.
- **Not in profile backups.** The backup layout is an allowlist and does not include the keyring. `openpgp-keyring.dat` is also on the backup engine's forbidden list, and a restore leaves the device's keyring as it was. To move keys to another device, export them: the public key as armored text, and the private key (after the passphrase is confirmed) still protected by its passphrase.

## Trust details

Settings › OpenPGP keys lists each key's user IDs, fingerprint (in groups of four), algorithm, creation and expiry dates, revocation and expiry state, whether a private key is present, and whether it is unlocked. Each key has a manual **verified / unverified** state for recording that you compared the fingerprint with its owner. Keys you generate start as verified; imported keys start as unverified. Re-importing a key merges new user IDs, subkeys, and revocation certificates into the stored key and keeps its verification state.

## Sending

The composer's lock button opens **Sign with OpenPGP** and **Encrypt with OpenPGP**. The choice is saved with the draft (table `mail_draft_openpgp`), so Undo Send, the offline Outbox, and scheduled delivery all honor it.

- **Recipient keys.** Every To, Cc, and Bcc address needs a usable encryption key: not revoked, not expired, with a valid encryption subkey. When several keys match, the verified one is preferred, then the newest. The composer lists the chosen key for each address and offers a choice when there are several. The message is also encrypted to the sender's own key when there is one, so the Sent copy can be read.
- **Signing key.** The secret key whose user ID matches the From address (alias identities included) signs. It has to be unlocked with its passphrase; the composer has a passphrase field for this.
- **Format.** Signed-only messages are `multipart/signed; protocol="application/pgp-signature"` with a detached signature. Text parts are re-encoded as base64 first so the signed part stays 7-bit clean. Encrypted messages are `multipart/encrypted; protocol="application/pgp-encrypted"`. Sign plus encrypt uses one combined OpenPGP message (RFC 3156 section 6.2).
- **Never plaintext by accident.** `mail:drafts:send` and `mail:drafts:schedule` run a check first and refuse to queue the message when a key is missing, expired, or revoked, when the signing key is locked, or when Aerio is locked. The error ends with "The message was not sent; your draft is kept." Delivery checks again. Any failure (including a passphrase cache that expired before a scheduled send) marks the draft as failed with that message, and nothing is sent. With encryption on, Microsoft accounts send the protected MIME rather than the stored provider draft.
- **Drafts.** While encryption is on, a draft stays on this device and is not uploaded to the provider. A draft that was already synced before encryption was turned on keeps its earlier provider copy until it is sent or discarded.

## Reading

When a message looks like OpenPGP (a `pgp-signature` or `pgp-encrypted` part, an `.asc` attachment, or an inline armor block), the conversation view asks the main process to inspect its stored original:

- Signed messages are checked automatically against the keyring. Results are valid (with the manual verification state), invalid (the content changed), unknown key, expired key, or revoked key, with the fingerprint and signing time.
- Encrypted messages show **Decrypt** when one of your private keys can read them. Decryption asks for the passphrase if the key is not already unlocked, then shows the decrypted body, any signatures inside (combined, or a nested `multipart/signed`), and the attachments. Attachments are decrypted again when saved, so plaintext is not kept around between actions.

## App lock and passphrases

Unlocked keys are cached in memory for 10 minutes. **Forget passphrases** in Settings, or locking Aerio, clears the cache immediately. While Aerio is locked, every operation that needs a private key or reads mail (unlocking a key, signing, decrypting, inspecting, importing, generating, exporting a private key) is refused.

## Tests

- `electron/mail/openpgp-keyring.test.ts`: key generation and storage (passphrase-protected, safeStorage-wrapped, no overwrite of an unreadable keyring), import, merge, export and revocation, the sign and encrypt round trip with binary attachments, recipient key selection, missing, expired, and revoked keys, the lock and cache behavior, and interoperability fixtures built directly with OpenPGP.js (a text-mode detached signature, inline cleartext signatures, inline encryption, a message for another key).
- `electron/mail/openpgp-mime.test.ts`: the RFC 3156 structure, multipart splitting, 7-bit re-encoding.
- `electron/mail/openpgp-ipc.test.ts`: the send check, inspection, passphrase prompts, decrypting with sanitized HTML, nested sign-then-encrypt, saving decrypted attachments, and key-file import and export.
- `electron/mail-worker.test.ts`: protected delivery, refusal without sending, the Microsoft draft bypass, and encrypted drafts that are not uploaded.
- `electron/profile-backup-layout.test.ts`: the keyring stays out of backups and is kept across a restore.
- `src/components/OpenPgp.test.tsx`: the composer control, the message banner, and the key manager.

## Known limits

- Interoperability is tested only with messages that OpenPGP.js produces, in the shapes that GnuPG, Thunderbird, and other clients use. A round trip with a real GnuPG or Thunderbird install has not been run.
- Live delivery through Gmail, Microsoft Graph, and SMTP has not been checked. In particular, it is not confirmed that Microsoft Graph MIME upload passes `multipart/encrypted` and `multipart/signed` through unchanged.
- Subjects and other headers are not protected. Protected headers and Autocrypt are not implemented. Bcc recipients' key IDs appear in the encrypted message.
- There is no key-server or WKD lookup. Keys have to be imported.
- Signature results are not saved, and messages are not decrypted for search. Encrypted mail is not searchable.
- The mail source is read as UTF-8, so a signed part with non-UTF-8 8-bit bytes (which RFC 3156 forbids) may fail to verify.
