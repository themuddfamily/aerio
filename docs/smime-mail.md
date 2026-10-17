# S/MIME mail

Aerio signs, encrypts, decrypts, and verifies mail with S/MIME (RFC 8551, CMS RFC 5652). It uses [node-forge](https://github.com/digitalbazaar/forge) (`node-forge` 1.4.0) to read PKCS#12 files, create signatures, and create and open enveloped data. Signatures are verified by Aerio's own CMS code with Node's native crypto, because forge cannot verify CMS signatures. Certificate chains are checked with Node's `X509Certificate`.

S/MIME is a second protection method next to [OpenPGP](openpgp-mail.md). A message uses one or the other, never both.

## Where things run

- **Main process only.** Private keys and every crypto operation stay in the Electron main process (`electron/mail/smime-store.ts`, `smime-cms.ts`, `smime-certificate.ts`, `smime-ipc.ts`). The mail worker sends a protected draft's MIME to the main process with the same `openpgp-request` message OpenPGP uses, now with an `smime` field, and sends exactly what comes back. A missing or failed reply stops the delivery.
- **Renderer.** The renderer gets certificate summaries, recipient checks, signature results, and decrypted content the user asked to read. Decrypted text and HTML (sanitized with the normal message sanitizer) are held only in the message banner's React state. They are never written to the mail cache or search index.

## Certificates and keys

Certificates live in `smime-certificates.dat` in the profile folder:

- **Your certificate.** Import a PKCS#12 file (`.p12` or `.pfx`) with its password. The private key is re-encrypted as PKCS#8 (`ENCRYPTED PRIVATE KEY`, AES-256-CBC) with a passphrase: the file password, or a new passphrase of at least 8 characters if the password is shorter. The store refuses to write an unencrypted private key. Intermediate certificates in the file are kept with your certificate and included in your signatures.
- **Other people's certificates.** Import `.cer`, `.crt`, `.pem` (one or several), or `.der` files, or paste PEM text. Certificates from **valid** signed mail are saved automatically ("from signed mail") when the signature checks out, the chain is trusted, the certificate's address matches the sender, and the certificate allows encryption.
- **Secure storage.** The whole file is wrapped with Electron `safeStorage`, like the OAuth vault and the OpenPGP keyring. With no secure backend, certificates cannot be saved. If the file exists but cannot be read, Aerio will not overwrite it.
- **Not in profile backups.** `smime-certificates.dat` is outside the backup allowlist and on the backup engine's forbidden list, and a restore leaves the device's store as it was. To move your certificate, use **PKCS#12** in Settings: confirm the passphrase and choose an export password (8+ characters). The file contains your certificate, its chain, and the private key. Trust choices and harvested certificates are not exported.

## Trust and certificate details

Settings › S/MIME certificates lists each certificate with its status (your certificate, recipient certificate, certificate authority, expired, not yet valid), email addresses, expiry, and where it came from. **Certificate details** shows the subject, issuer, validity, key algorithm and serial, key usage (signing, encryption, email protection), the issuer chain, the SHA-256 fingerprint, and the revocation status.

- **Chain.** Aerio builds a path from the certificate to a trust anchor through certificates in the message and the store. Each link must verify, issuers must be CAs allowed to sign certificates, and issuers must be within their validity dates. Anchors are the Mozilla root store bundled with Electron/Node and any certificate you mark **Trust**. The result is *Chain trusted*, *Root not trusted* (self-signed root you have not trusted), *Issuer unknown*, or *Chain invalid*.
- **Trust.** On a CA certificate, Trust makes it an anchor for everything it issued. On a leaf, it accepts that certificate even though its issuer is not trusted. Check the fingerprint with its owner before you do either.
- **Revocation is not checked.** Aerio does not query CRLs or OCSP. Every summary and valid-signature line says so.

## Sending

The composer has an S/MIME shield button next to the OpenPGP lock: **Sign with S/MIME** and **Encrypt with S/MIME**. Turning either S/MIME option on turns OpenPGP off, and the other way round. The main process also refuses to save or send a draft that asks for both. The choice is saved with the draft (table `mail_draft_smime`), so Undo Send, the Outbox, and scheduled delivery all honor it.

- **Sender default.** **Use for new messages from this sender** remembers the current Sign/Encrypt choice for the From address (account or alias). New messages from that sender start with it until you change the protection yourself.
- **Recipient certificates.** Every To, Cc, and Bcc address needs a certificate that is valid now, allows key encipherment and email protection, uses RSA, and has a trusted chain (or that you trusted directly). Several matching certificates are offered as a choice; otherwise trusted and longest-valid comes first. The message is also encrypted to your own certificate when one can encrypt, so the Sent copy can be read.
- **Signing certificate.** Your certificate for the From address signs. It has to be unlocked with its passphrase in the composer. A signing certificate whose chain is not trusted on this device is allowed, with a warning.
- **Format.** Signed messages are `multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256` with a detached `smime.p7s` (SHA-256, RSA PKCS#1 v1.5, signed attributes with content type, message digest, and signing time, plus your certificate chain). Text parts are re-encoded as base64 first so the signed part stays 7-bit. Encrypted messages are `application/pkcs7-mime; smime-type=enveloped-data` (`smime.p7m`) with AES-256-CBC content encryption and RSA key transport. Sign plus encrypt signs first, then encrypts the signed entity.
- **Never plaintext by accident.** `mail:drafts:send` and `mail:drafts:schedule` check first and refuse to queue the message when a certificate is missing, expired, untrusted, or not for encryption, when the signing certificate is locked, or when Aerio is locked. Delivery checks again. Any failure marks the draft failed with the reason ("The message was not sent; your draft is kept.") and nothing is sent. Microsoft accounts send the protected MIME rather than the stored provider draft.
- **Drafts.** While S/MIME encryption is on, the draft stays on this device and is not uploaded to the provider. Mail merge is unavailable while S/MIME or OpenPGP is on.

## Reading

When a message has a `pkcs7-signature` or `pkcs7-mime` part (or an `smime.p7m`/`.p7s` attachment), the conversation view asks the main process to inspect the stored original:

- **Signed** (`multipart/signed`, and opaque `application/pkcs7-mime; smime-type=signed-data` behind **Show signed content**). Results: valid, invalid (the content changed), untrusted (chain), certificate does not match the sender's address, certificate not valid now (the line also says if the message claims it was signed while valid), signer certificate not included, or not checkable (RSA-PSS or an unknown digest). The signer's certificate details are shown under the result.
- **Encrypted.** The banner names the content cipher and shows **Decrypt** when one of your certificates is a recipient. Decryption asks for the passphrase if the key is not unlocked, then shows the body, the signature inside, and attachments. Attachments are decrypted again when saved.

## App lock and passphrases

Unlocked private keys are cached in memory for 10 minutes. **Forget passphrases** in Settings, or locking Aerio, clears them. While Aerio is locked, importing, unlocking, signing, decrypting, inspecting, and exporting a private key are refused.

## Tests

- `electron/mail/smime-store.test.ts`: a throwaway test CA, intermediate, and leaves (`smime-test-fixtures.ts`) for PKCS#12 import (wrong, missing, and short passwords), storage (encrypted PKCS#8, safeStorage wrap, no overwrite of an unreadable store), PEM/DER import and chain states, expired, not-yet-valid, and wrong-usage certificates; the signed-only round trip with harvesting and tampering; untrusted chains, self-signed and unknown signers, sender mismatch, expired signers, and opaque signed-data; the encrypted round trip (sign plus encrypt, binary attachment, sender copy, wrong recipient); missing, expired, untrusted, and sign-only recipient certificates and certificate choice; the app lock and passphrase cache; and recovery through a PKCS#12 export into a fresh store.
- `electron/mail/smime-interop.test.ts`: messages and a PKCS#12 made by OpenSSL 3.5 (`smime-openssl.fixtures.ts`): a PBES2/AES-256/SHA-256-MAC PKCS#12, detached and opaque RSA signatures, an ECDSA P-256 signature, AES-256-CBC enveloped data, and AES-256-GCM AuthEnvelopedData (refused with a clear message).
- `electron/mail/smime-ipc.test.ts`: the send check, OpenPGP-or-S/MIME routing, the import retry flow, decrypting with a passphrase prompt and sanitized HTML, saving attachments, exports, trust, and sender defaults.
- `electron/mail/smime-draft-store.test.ts`, `electron/mail-worker.test.ts`, `electron/main.test.ts`, `electron/preload.test.ts`, `electron/profile-backup-layout.test.ts`, and `src/components/Smime.test.tsx` cover draft storage, protected delivery and local-only encrypted drafts, the main-process gate, the IPC bridge, backup exclusion, and the composer control, banner, and certificate manager.

During development, Aerio's own signed and sign-plus-encrypted output was also checked by hand with `openssl cms -verify` and `openssl cms -decrypt`, and its PKCS#12 export with `openssl pkcs12 -info`. That check is not part of the automated tests.

## Known limits

- Only RSA certificates can be your own (signing and decryption) or receive encrypted mail. ECDSA and other signatures can be verified. RSA-PSS signatures, RSA-OAEP key transport, key agreement (ECDH) recipients, recipients identified only by subject key identifier, and AES-GCM (AuthEnvelopedData) cannot be decrypted or are reported as not checkable.
- Revocation (CRL, OCSP) is not checked, and there is no LDAP or directory lookup for certificates.
- Live delivery through Gmail, Microsoft Graph, and SMTP, and interoperability with Outlook, Apple Mail, and Thunderbird, have not been checked. Only OpenSSL-generated fixtures are tested.
- The PKCS#12 export uses forge's format: AES-256-CBC with PBKDF2-HMAC-SHA1 for the key, unencrypted certificate bags, and a SHA-1 MAC. OpenSSL 3 reads it; very strict importers may want a newer MAC.
- Subjects and other headers are not protected, and Bcc recipients appear as recipients in the encrypted data.
- Signature results are not saved, and encrypted mail is not searchable. The mail source is read as UTF-8, like OpenPGP, so signed parts with raw 8-bit bytes may fail to verify.
- The sender default covers S/MIME only. OpenPGP has no per-sender default.
