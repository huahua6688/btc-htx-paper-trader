# HTX CLI vendor note

The CLI files are fixed to the official HTX repository release:

- Repository: `htx-exchange/htx-skills-hub`
- Release: `v2.0.0`
- Published: `2026-06-08T02:53:50Z`
- Windows x64: `htx-cli-windows-x64.exe`, `98,629,632` bytes
- Windows SHA-256: `F53C7A79ACF22F25A7E9AC4171211CDB5204BDF1F9906BBC01EE2A0D8C2F8CDC`
- Linux x64: `htx-cli-linux-x64`, `94,738,560` bytes
- Linux SHA-256: `CFFBDEBD18D22AA6367CB3779A735E3FBFABAAF03F0E559EAC833130B5172FE0`

The Windows binary is vendored for local use. The Linux binary is downloaded and checksum-verified during VPS setup, then ignored by Git. The wrapper only permits the existing public market-data command whitelist on either platform.
