# Releasing Aerio for Windows

Aerio releases are built from version tags and initially uploaded as draft GitHub Releases. Installed NSIS builds can discover a published release, but portable builds must be replaced manually.

## One-time repository setup

Add these GitHub Actions secrets in **Settings → Secrets and variables → Actions**:

- `WIN_CSC_LINK`: a base64-encoded Windows code-signing certificate, or a secure certificate URL accepted by electron-builder.
- `WIN_CSC_KEY_PASSWORD`: the certificate password.
- `GOOGLE_OAUTH_CLIENT_SECRET`: the production Google Desktop app client secret.

The Google and Microsoft public desktop application IDs are committed as Aerio's defaults. They can be overridden with `MAIN_VITE_GOOGLE_CLIENT_ID` and `MAIN_VITE_MICROSOFT_CLIENT_ID` when building against other registrations. Application IDs identify public clients; they are not client secrets.

The release workflow deliberately fails when signing or built-in OAuth configuration is missing. This prevents an unsigned installer—or one that asks end users for developer credentials—from becoming an update candidate.

## Prepare a release

Review `npm audit` alongside the release checks. The 2026-10-01 dependency refresh replaces the affected Electron 43, Vitest 4, Sharp, HTML sanitizer and transitive dependency versions with patched releases; the resulting lockfile reports zero audit findings, including with `--omit=dev`. Nodemailer moves to 10.0.13 because its remaining address-parser fix is unavailable on the project's previous major release. Its Node 20 minimum is covered by Aerio's Node 24 minimum, and its bundled declarations preserve the existing types layout. See the [Nodemailer changelog](https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md) and [address-parser advisory](https://github.com/advisories/GHSA-v53p-9fqp-m79j). A clean audit describes the registry's known findings at that time; retain mail, desktop and packaging verification when refreshing dependencies.

1. Finish the milestone on `main` and ensure the Windows build workflow is green.
2. Update `version` in `package.json` and `package-lock.json` together.
3. Add release notes and run `npm run verify:release` locally.
4. Commit and push the version change to `main`.
5. Create and push the matching tag, for example `v0.5.0` for package version `0.5.0`.

The tag starts `.github/workflows/release.yml`. It runs the automated checks, produces signed installer and portable artifacts, and creates a draft release with the update metadata. Both Windows workflows verify the packaged files before uploading the CI artifact; the release workflow also checks the files produced by its signed draft build.

`npm run verify:artifacts` checks the current package version's setup executable, portable executable, gzip blockmap structure and installer coverage, `latest.yml` file sizes and SHA-512 checksums, and the installed `app-update.yml` GitHub provider. It rejects missing/empty artifacts, corrupt blockmaps, stale or inconsistent metadata, duplicate entries, and unexpected installer URLs. Existing artifacts for older versions are ignored. Run `node scripts/verify-release-artifacts.mjs <directory> <architectures>` to check another output directory or a comma-separated architecture list; defaults are `release` and `x64`. These checks verify artifact consistency, not code-signing trust or a real installer upgrade.

The Windows build artifact includes `latest.yml` and blockmaps alongside both executables. Updater unit tests simulate discovery, pending download/progress, failures and retry, and restart installation without contacting GitHub or installing software. The metadata format is documented in [electron-builder's version 26 auto-update guide](https://www.electron.build/v26/docs/features/auto-update/).

## Publish safely

1. Download and install the draft installer on a clean Windows test account.
2. Confirm first launch, account setup, mail sync, compose/send, and uninstall behaviour.
3. Confirm the release contains the setup executable, its blockmap, and `latest.yml`.
4. Review the release notes, then publish the draft in GitHub.
   Before publication, complete the live-provider matrix for the candidate version, run `npm run verify:live-evidence`, and review its diagnostics against the candidate commit. The CI matrix check validates checklist structure only.
5. From the previous installed Aerio version, use **Settings → Aerio updates** to verify discovery, download, and restart installation.

Do not rename or remove `latest.yml` or the installer blockmap. The installed app uses these files to validate and apply updates.
