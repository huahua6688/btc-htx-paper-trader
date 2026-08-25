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
| Mark Price | REST latest window plus official daily Download Center Kline | REST max 2,000; Download Center daily archives | REST window as previously measured; Download Center verified from `2026-02-01` | PIT-normalize checksum-verified daily archives |
| Premium | Latest bounded Kline window | No arbitrary range; max 2,000 rows | At 60m: `2026-06-02 07:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Basis | Latest bounded series | No arbitrary range; max 2,000 rows | At 60m: `2026-06-02 07:00` through `2026-08-24 14:00 UTC` | Download intersection only |
| Liquidations | Current v3 returns the latest 50 events | No historical page cursor | Audit response covered only about 31 minutes | Download real intersection only; accumulate forward in archive |
| Order Book / Depth | REST current snapshot plus official Download Center L2 archives | Futures 150 levels; spot 400 levels; daily archives | First available archive observed `2026-05-28`, through probed `2026-08-23` | Advertised checksum/ETag/size catalog by default; explicit large-file opt-in is required to download and verify content |

The legacy liquidation endpoint described as 90-day history returned an HTX error during this audit and is not represented as usable history. Endpoint windows move forward over time. The Dataset manifest records the exact `fetchedAt`, endpoint coverage, requested-range intersection and raw payload hash for every run.

## Official Historical Data Download Center (2026 service)

This is a separate source from Settlement REST pagination. The official landing page advertises history from `2026-02-01`; direct archive and `.CHECKSUM` probes confirmed these BTC types:

| Market | Type | Instrument/path identity | Verified coverage | Catalog policy |
|---|---|---|---|---|
| Futures | 15m Kline, trades, mark Kline, index Kline, funding | `BTC-USDT-PERP` | `2026-02-01` through probed `2026-08-23` | Kline/mark/index/funding are downloaded, checksum-verified and PIT-normalized; trades are explicit on demand |
| Futures | L2 order book, 150 levels | `BTC-USDT-PERP` | `2026-05-28` through probed `2026-08-23` | advertised checksum/ETag/size catalog only by default; explicit download + large-file opt-in required |
| Spot | 15m Kline, trades | `BTC-USDT` | `2026-02-01` through probed `2026-08-23` | Kline PIT-normalized; trades on demand |
| Spot | L2 order book, 400 levels | `BTC-USDT` | `2026-05-28` through probed `2026-08-23` | advertised checksum/ETag/size catalog only by default; explicit download + large-file opt-in required |

The original `2026-08-23` catalog run ingested 96 rows each for futures Kline/mark/index and spot Kline, plus 3 funding rows. Catalog-only trades/depth entries recorded an advertised checksum but did not claim content verification. A follow-up real on-demand run downloaded and verified the 635,202-byte futures trades archive and the 91,568,808-byte futures depth archive. Trades produced 68,947 PIT rows. Depth's real format is TAR.GZ containing JSONL snapshot/update events; the parser reconstructs the order book and emitted 96 final-visible 15m PIT snapshots. Spot trades/depth remain catalog-only until explicitly fetched. Every normalized Kline uses candle open as `eventTime` and close as `visibleAt`; Funding uses the official `fundingTime`.

```bash
npm run data:download-center:fetch -- --type=futuresTrades --date=2026-08-23 --parse=true
npm run data:download-center:fetch -- --type=futuresDepth --date=2026-08-23 --allow-large-depth=true --parse=true
```

The first command downloads and verifies a trade archive. The second is deliberately guarded because a daily depth archive can exceed 100 MB. Omitting `--parse=true` stores only the verified raw archive; parsing is opt-in and produces PIT series that `loadHistoricalDataset` can expose to research/Replay.

Dates before the verified start or an official 404 remain `HISTORICAL_UNAVAILABLE`. The implementation never derives order book, trades, index or mark history from OHLCV.

## HTX Skills wiring audit

The 17 Skill Hub packages are all audited, but they are not claimed as 17 actual invocations. The executable report distinguishes five states: `ACTUALLY_INVOKED`, `RESEARCH_ONLY`, `LOCAL_EQUIVALENT`, `AUDITED_ONLY`, and `INTERFACE_ONLY`. Public spot ticker/Kline/depth/history-trade are now real `MARKET_TASKS`; technical-analysis, derivatives-analyst, market-overview and ta-master are explicitly local equivalents instead of claimed official invocations; sentiment remains audited-only with zero weight. Four private account/trading packages remain interface-only and cannot load credentials or write to HTX.

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

`market-archive.sqlite` is separate from both `paper-trading.sqlite` and `research-registry.sqlite`. After each successful public market collection, monitor best-effort archives spot ticker/Kline/Depth/trades plus futures ticker, Klines, Depth, Funding, OI, Elite ratios, Liquidations, Mark, Premium, Basis and contract metadata.

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
