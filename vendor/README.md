# HTX CLI vendor note

The CLI files are fixed to the official HTX repository release:

- Repository: `htx-exchange/htx-skills-hub`
- Release: `v2.0.0`
- Published: `2026-06-08T02:53:50Z`
- Windows x64: `htx-cli-windows-x64.exe`, `98,629,632` bytes
- Windows SHA-256: `F53C7A79ACF22F25A7E9AC4171211CDB5204BDF1F9906BBC01EE2A0D8C2F8CDC`
- Linux x64: `htx-cli-linux-x64`, `94,738,560` bytes
- Linux SHA-256: `CFFBDEBD18D22AA6367CB3779A735E3FBFABAAF03F0E559EAC833130B5172FE0`

CLI binaries are runtime artifacts and are not committed. `htx-cli-source.json` is the tracked source lock; `vendor/.htx-runtime/installed.json` records the locally installed release, asset, SHA-256, install time, upstream identity, public-command compatibility result and capability report.

Use:

```text
npm run htx:status   # local identity only
npm run htx:check    # query official GitHub Release; no replacement
npm run htx:update   # stage → verify → compatibility → npm test → safety → atomic replace
```

The updater validates that release metadata and download URLs belong to the official `htx-exchange/htx-skills-hub` repository. When GitHub publishes an asset digest it must match. If no upstream checksum is present, metadata records that fact and never claims official checksum verification; the local SHA-256 and release identity are still recorded. The old binary is retained under `vendor/rollback/`, and a failed update leaves the production binary byte-identical.

The wrapper continues to permit only the existing public market-data command whitelist on either platform. Upstream commands never expand that whitelist automatically, and child processes receive a scrubbed environment without HTX/Huobi credentials or Telegram secrets.
