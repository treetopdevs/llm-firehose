# Desktop release runbook

How an Agent Firehose desktop release is produced (migration plan, Phase 3
"desktop release tasks"). CI (`.github/workflows/desktop.yml`) proves the
bundles build on macOS, Windows, and Linux on every change; the steps below
turn a green build into a shippable, signed release.

> **Human-credential steps are marked ⚠** — they need org-owned secrets and
> cannot be performed by an agent. Everything else is scripted.

## 0. Preconditions

- `main` green: `gofmt` clean, `go vet`, `go test ./...`,
  `pnpm -C apps/tauri-desktop test`, `cargo test` in `src-tauri`.
- Version bumped in **four** places (keep them identical):
  `cmd/firehose/main.go`, `cmd/firehosed/main.go`,
  `apps/tauri-desktop/package.json`, `apps/tauri-desktop/src-tauri/tauri.conf.json`
  (and `Cargo.toml`).
- `docs/compatibility.md` row added for the new version.

## 1. Build artifacts

Local (current platform):

```sh
scripts/build-sidecar.sh              # firehosed → src-tauri/binaries/<triple>
pnpm -C apps/tauri-desktop tauri build
```

Cross-platform: run the `desktop` workflow (workflow_dispatch) and collect
the per-triple artifacts.

## 2. macOS signing + notarization ⚠

Requires an Apple Developer ID Application certificate.

1. Import the cert into the CI keychain (secrets: `APPLE_CERTIFICATE`,
   `APPLE_CERTIFICATE_PASSWORD`).
2. Set `bundle.macOS.signingIdentity` in `tauri.conf.json` (or env
   `APPLE_SIGNING_IDENTITY`).
3. Notarize: env `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`
   — the Tauri bundler submits and staples automatically when these are set.
4. Verify: `spctl -a -vv "Agent Firehose.app"` reports `accepted`.

The bundled `firehosed` sidecar is signed as part of the app bundle; do not
ship an unsigned sidecar inside a signed app (notarization will reject it).

## 3. Windows code signing ⚠

Authenticode cert (EV or OV). Set `bundle.windows.certificateThumbprint` /
`signCommand` in `tauri.conf.json`; CI signs the `.msi`/`.exe` during
`tauri build`.

## 4. Linux packages

AppImage + `.deb` + `.rpm` come out of the Ubuntu CI leg unsigned (normal
for AppImage). Optionally sign the AppImage with GPG and publish the key.

## 5. Updater feed ⚠

Auto-update (migration plan M3) uses `tauri-plugin-updater`:

1. Generate the updater keypair once: `pnpm tauri signer generate` —
   the private key becomes CI secret `TAURI_SIGNING_PRIVATE_KEY`; the public
   key goes into `tauri.conf.json > plugins.updater.pubkey`. **Losing the
   private key strands existing installs** — store it in the org vault.
2. Add the plugin (`tauri-plugin-updater`) and an endpoint serving
   `latest.json` (static hosting or GitHub Releases `latest.json` pattern).
3. Every release uploads: platform bundles + detached signatures +
   `latest.json` with version, notes, per-platform URLs and signatures.
4. The app checks the feed on launch; the daemon/UI compatibility rule
   (docs/compatibility.md) still applies after update.

## 6. Publish

- Tag `v<version>`; GitHub Release with artifacts + signatures + notes.
- Update `latest.json` last — that is the moment the fleet sees the update.

## 7. Post-release checks

- Fresh-machine install: onboarding wizard → install adapters → doctor all ✓
  → live events visible (Phase 3 exit criterion).
- Update-in-place from previous version: spool + `config.json` untouched
  (exit criterion: updating never destroys spool data or settings).
- `firehosed` restartable independently of the UI (exit criterion).
- Log outcomes in `docs/migration/pain-review.md` §results — install
  failures, crash reports, and support load feed the Phase 4 decision.
