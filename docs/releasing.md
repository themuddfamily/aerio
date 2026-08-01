# Releasing Aerio for Windows

Aerio releases are built from version tags and initially uploaded as draft GitHub Releases. Installed NSIS builds can discover a published release, but portable builds must be replaced manually.

## One-time repository setup

Add these GitHub Actions secrets in **Settings → Secrets and variables → Actions**:

- `WIN_CSC_LINK`: a base64-encoded Windows code-signing certificate, or a secure certificate URL accepted by electron-builder.
- `WIN_CSC_KEY_PASSWORD`: the certificate password.
- `GOOGLE_OAUTH_CLIENT_ID`: the production Google Desktop app client ID.
- `GOOGLE_OAUTH_CLIENT_SECRET`: the production Google Desktop app client secret.

The Microsoft public desktop application ID is committed as Aerio's default and can be overridden with `MAIN_VITE_MICROSOFT_CLIENT_ID` when building against another registration. It is an identifier, not a client secret.

The release workflow deliberately fails when signing or built-in OAuth configuration is missing. This prevents an unsigned installer—or one that asks end users for developer credentials—from becoming an update candidate.

## Prepare a release

1. Finish the milestone on `main` and ensure the Windows build workflow is green.
2. Update `version` in `package.json` and `package-lock.json` together.
3. Add release notes and run `npm run verify:release` locally.
4. Commit and push the version change to `main`.
5. Create and push the matching tag, for example `v0.5.0` for package version `0.5.0`.

The tag starts `.github/workflows/release.yml`. It runs the automated checks, produces signed installer and portable artifacts, and creates a draft release with the update metadata.

## Publish safely

1. Download and install the draft installer on a clean Windows test account.
2. Confirm first launch, account setup, mail sync, compose/send, and uninstall behaviour.
3. Confirm the release contains the setup executable, its blockmap, and `latest.yml`.
4. Review the release notes, then publish the draft in GitHub.
5. From the previous installed Aerio version, use **Settings → Aerio updates** to verify discovery, download, and restart installation.

Do not rename or remove `latest.yml` or the installer blockmap. The installed app uses these files to validate and apply updates.
