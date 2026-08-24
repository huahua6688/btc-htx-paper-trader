# HTX Integration + Research Data Infrastructure V2

This change is infrastructure-only. It does not modify the frozen V1.2 Champion, production strategy parameters, the Risk Gate, or Paper execution rules. It does not enable V1.3 and does not run or open a Final OOS holdout.

## Official CLI identity and update model

- Source repository: `https://github.com/htx-exchange/htx-skills-hub`
- Audited release: `v2.0.0`
- Release commit: `1b7094675c7c93931d6b424b8a8fa9c71bcca60e`
- Published: `2026-06-08T02:53:50Z`
- Windows x64 asset: `htx-cli-windows-x64.exe`
- Windows SHA-256: `f53c7a79acf22f25a7e9ac4171211cdb5204bdf1f9906bbc01ee2a0d8c2f8cdc`
- Linux x64 asset: `htx-cli-linux-x64`
- Linux SHA-256: `cffbdebd18d22aa6367cb3779a735e3fbfabaaf03f0e559eac833130b5172fe0`

`vendor/htx-cli-source.json` is the tracked source lock. Installed binaries, staging files, rollback copies and runtime metadata are ignored by Git. `htx:update` accepts only the official repository release identity and asset URL, downloads to staging, records the local SHA-256, verifies an official digest when one exists, runs compatibility against every command currently used by `MARKET_TASKS`, then runs the full project test and safety suites. Only then is the binary atomically replaced. A previous binary is retained for rollback. Failure before replacement leaves the original unchanged; failure while writing installation metadata restores the previous binary.

The command and parameter whitelist in `src/htx-cli.mjs` remains authoritative. New upstream commands are reported but never adopted automatically. HTX/Huobi credentials and Telegram secrets are removed from the child process environment.

## Audited HTX public history capability

The table records observed endpoint behavior, not capability inferred from a command name. The audit used the official public host and no API key.

| Data | Public endpoint behavior | Pagination/range | Verified coverage on 2026-08-24 | Catalog V2 policy |
|---|---|---|---|---|
| Kline | Historical closed candles | `from/to`, chunks up to 2,000 | Earliest BTC-USDT linear sample reached `2020-10-21 09:00 UTC` | Download requested range |
| Funding | Historical settlements | `page_index/page_size`, 50 per page | Earliest settlement reached `2020-10-21 16:00 UTC` | Download requested range; preserve exact-settlement/last-observed-estimate semantics |
| Open Interest | Historical samples, latest bounded window | No arbitrary historical cursor; max 200 rows | At 60m: about 200 hours; audit window `2026-08-16 07:00` through `2026-08-24 14:00 UTC` | Download intersection with requested range; otherwise unavailable |
| Elite Account Ratio | Latest bounded samples | No pagination; 30 rows | At 60m: `2026-08-23 09:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Elite Position Ratio | Latest bounded samples | No pagination; 30 rows | At 60m: `2026-08-23 09:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Mark Price | Latest bounded Kline window | No arbitrary range; max 2,000 rows | At 60m: `2026-06-02 07:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Premium | Latest bounded Kline window | No arbitrary range; max 2,000 rows | At 60m: `2026-06-02 07:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Basis | Latest bounded series | No arbitrary range; max 2,000 rows | At 60m: `2026-06-02 07:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Liquidations | Current v3 returns the latest 50 events | No historical page cursor | Audit response covered only about 31 minutes | Download real intersection only; accumulate forward in archive |
| Order Book / Depth | Current snapshot | No historical endpoint | Snapshot only | `HISTORICAL_UNAVAILABLE`; accumulate forward in archive |

The legacy liquidation endpoint described as 90-day history returned an HTX error during this audit and is not represented as usable history. Endpoint windows move forward over time. The Dataset manifest records the exact `fetchedAt`, endpoint coverage, requested-range intersection and raw payload hash for every run.

## Catalog V2 evidence

An unselected continuous verification range, `2026-08-17 00:00 UTC` through `2026-08-23 00:00 UTC`, was downloaded after implementation. The resulting manifest was `VALID` and recorded:

- 577 closed 15m Klines, zero gaps and zero duplicates.
- 19 Funding settlements inside the requested range. A cached settlement eight hours after the requested end is excluded from manifest coverage and Replay evidence.
- 145 OI observations.
- 145 Mark Price, 145 Premium and 145 Basis observations.
- No Elite observations inside that requested range because the endpoint's actual 30-hour window started later.
- No liquidation observations inside the range because the actual latest-50 window was on 2026-08-24.
- No Depth history because HTX exposes only a current snapshot.

The run used checkpoint/resume: an initial OI/Elite response-shape incompatibility was recorded as a fetch error, fixed at the integration adapter, then resumed without downloading completed Kline/Funding phases again. The final manifest quality is `VALID`; unavailable intersections remain explicit rather than fabricated.

## Self archive

`market-archive.sqlite` is separate from both `paper-trading.sqlite` and `research-registry.sqlite`. After each successful public market collection, monitor best-effort archives ticker, Klines, Depth, Funding, OI, Elite ratios, Liquidations, Mark, Premium, Basis and contract metadata.

Each event stores:

- `event_type + source + event_time` unique identity;
- `observed_at`, provenance and schema versions;
- immutable gzip-compressed raw HTX JSON and its SHA-256;
- normalized research JSON that can be regenerated from raw;
- installed HTX CLI release and SHA-256.

Duplicate observations do not rewrite raw history. Archive write failure is returned as a monitor warning and cannot fail analysis or position management. Coverage, gaps and storage statistics are available through `npm run archive:status` and the read-only Telegram data page.

## Point-in-time Replay V2

Replay uses a field only when it was visible at the replay clock. Historical authoritative series use their documented event/close visibility. Self-archived data additionally requires `observed_at <= replay visibleAt`. No query may return an event with `eventTime > visibleAt`.

Each derivative field has an explicit TTL. A matching but old observation becomes `STALE`, not current. Missing fields remain `null` with one of:

- `HTX_HISTORICAL`
- `SELF_ARCHIVED`
- `LIVE_OBSERVED`
- `HISTORICAL_UNAVAILABLE`
- `STALE`
- `LIVE_FAILURE`

Replay now passes real timestamp-visible OI, Elite, Liquidation, Mark, Premium and Basis payloads into the existing strategy core when present. A coverage report warns `NO_DERIVATIVES_HISTORY` when an entire replay range lacks derivative evidence, preventing a test-only green result from hiding an all-WAIT production replay caused by missing inputs.

## Safety boundary

- API Key: none
- HTX private endpoints: none
- Real orders: none
- Account, transfer or leverage writes: none
- Paper-only behavior: unchanged
- Frozen Champion SHA-256: `9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6`
