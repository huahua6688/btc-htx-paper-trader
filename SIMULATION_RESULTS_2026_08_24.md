# 模拟优化结果（2026-08-24）

本轮只改变研究与 Shadow Paper 路径。冻结的 V1.2 Champion 哈希仍为
`9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6`；没有启用认证、私有接口或交易所写操作。

## 数据事实

- HTX 主目录清单哈希：`06a47fa5044db51cc519f421f15494fab9d2640bc56206f48344d939d167ab03`。
- 主区间：`2024-09-01T00:00:00Z` 至 `2026-07-31T23:45:00Z`；15m K 线 67,104 根且无间断，Funding 2,098 条。
- Mark/Premium/Basis 各 1,428 条，仅覆盖官方最近窗口；Settlement 198 条，实际只覆盖
  `2026-05-27` 至 `2026-07-31`，因此能力声明为 `PAGED_BOUNDED_RETENTION`，不能声称任意历史可下载。
- 另行审计了官方 2026 Historical Data Download Center；它不是 Settlement REST。BTC-USDT 现货与 `BTC-USDT-PERP`
  永续 Kline/trades/mark/index/funding 从 `2026-02-01` 起有真实档案，期货 150 档和现货 400 档 depth
  首个实测档案为 `2026-05-28`。`2026-08-23` 单日 9 类档案校验全部成功，清单哈希为
  `c6ddcac6ebc31d230d8e9f39445c28a9e4e1017fdabe404ba488521271da11b6`。
- 小型 Download Center 档案通过官方 `.CHECKSUM` 后转成 PIT 记录；逐笔与 depth 默认只登记 checksum、ETag、大小并按需下载。
  回放区间中仍未实际载入的盘口、OI、精英多空比和清算保持缺失，未用现值或 Kline 伪造。
- 外部 Funding：Binance 2,097 条；当前执行网络下 Bybit/OKX 返回站点不可用，目录状态为 `PARTIAL`。
  V3 的跨场所消融因此实际比较 HTX + Binance；失败场所没有伪造记录。

## 同一 Paper 执行核心下的结果

研究参考资金均为 20,000 CNY；入场为信号后下一根 15m 开盘，包含真实 Paper 手续费、逆向滑点、
时点可见 Funding，且同一根 K 线同时触及 SL/TP 时先按 SL 结算。

| 策略 | 交易 | 毛 PnL (CNY) | 成本后收益 | PF | 结论 |
|---|---:|---:|---:|---:|---|
| Research V2 | 187 | -833.79 | -29.89% | 0.639 | 淘汰；负毛 edge 且过度交易 |
| Multi-venue V3.0（HTX + Binance） | 64 | -1,067.67 | -10.60% | 0.492 | 淘汰；跨场所数据有改善但没有 edge |
| V3.0 HTX-only 消融 | 71 | -1,465.47 | -13.12% | 0.455 | 跨场所 Funding 减少 7 笔并改善 2.52 个百分点，但仍失败 |
| V3.1 target-aligned | 64 | -1,191.75 | -11.18% | 0.472 | 比 V3.0 更差，保留为可复现实验而非默认值 |
| Breakout V4 | 28 | +1,413.91 | +5.19% | 1.153 | 保留为研究/Shadow 候选，不晋级 |

V4 是 4h Donchian(40) 突破、EMA50 方向/斜率、2.5×ATR14 硬止损、固定 4R 硬目标。
`HARD_BRACKET_HOLD_V1` 禁止旧的 1R 保本、1.5R 跟踪、目标延伸和短周期反向评分退出，解决“按 4R 入场、按 1R 离场”的契约冲突。

## V4 live Shadow 4h 修复

- 决策不再要求 ticker 时间戳精确满足 `now % 4h == 0`，而是绑定最近一根已经完整关闭的 4h signal bar。
- signal key 由策略哈希、品种、周期和 4h bar 开盘时间组成。Shadow SQLite 用主键原子 claim，同一 signal bar 跨 5 分钟轮询和进程重启都只处理一次；Replay 使用同一 key 做事件级去重。
- `4h close +37 秒`、`+3 分钟` 均与 Replay 整点得到相同方向、signal key 和 signal bar；第二次 Shadow cycle 返回 `DUPLICATE_SIGNAL_BAR`，不重复开仓。
- 修复后全区间精确 Paper 结果仍为 28 笔、+5.1867%、PF 1.1532，说明只修 live 可达性/幂等，没有借机改变研究成绩。

## V4 development-only 参数选择记录

- 程序：`src/breakout-v4-selection.mjs`；固化记录：`BREAKOUT_V4_DEVELOPMENT_SELECTION_2026_08_24.json`。
- 固定网格共 128 组：Donchian lookback `[20,40,60,80]` × stop ATR `[1.5,2,2.5,3]` × target R `[2,3,4,5]` × trend filter `[EMA50_DIRECTION_SLOPE, EMA50_PRICE_ALIGNMENT]`。
- 开发截止为 `2026-01-17T06:30:00Z`；实际最大读取 K 线开盘 `06:15`、最大 `visibleAt` 正好 `06:30`。测试把截止后的 OHLCV 全部毒化后，winner 和 selection hash 不变；未打开未成熟 holdout。
- 选择顺序固定为：资格 → 正收益开发四分段数 → 最差分段净收益 → PF → 总净收益 → 参数哈希。winner 为 40 / 2.5 / 4R / EMA50 方向+斜率，参数哈希
  `e9d7949efe6de1780d608f477303ff4435eab41e4af7e9d259e178e7950a0921`，selection hash
  `916c4dfbe1d76ca0793682bae5c8be2492a27ee2850b2486b85f0119a7eaf917`。
- 网格指标是固定单位名义的未杠杆价格收益代理，不冒充 Paper 账户收益。winner 另走精确 Paper 核心确认：15 笔、+9.5243%、PF 1.5189。

## V4 证据边界

- 全区间：28 笔，7 胜 21 负，净 +1,037.34 CNY（+5.19%），PF 1.153，最大回撤 10.02%，交易 Sharpe 0.379。
- 参数探索实际只使用到 `2026-01-17T06:30:00Z`。该开发段精确回放为 15 笔、+9.5243%、PF 1.5189。
- `2026-01-17T06:45:00Z` 之后单独启动回放为 9 笔、+5.88%、PF 1.648；这段没有参与 V4 参数网格，
  但已被项目过往研究触碰，不能重新包装成 untouched OOS。
- 全区间按交易时间四等分后，净值分别为 -422.69、+2,932.49、+15.82、-1,488.29 CNY；收益并不跨状态稳定。
- 1,000 次逐交易 bootstrap 的亏损概率为 38.7%，block bootstrap 为 38.2%；样本只有 28 笔，远低于研究门槛 100 笔。
- development-only 前视审计 24/24 通过，`holdoutOpened=false`。150% 手续费为 +4.67%，200% 滑点为 +4.70%，2 根执行延迟为 +3.15%；
  lookback 38/42、止损 2.375×ATR、目标 4.2R 的邻域回放仍为正，说明峰值并非单点崩塌。

因此 V4 只满足“值得继续积累 Shadow 样本”，不满足“已有可靠生产 edge”。当前不登记为 Champion、不自动激活 Shadow，
也不打开真实交易端口。

## 17 项 HTX Skills 实际接线审计

17 项只是全部完成审计，不是 17/17 实际调用。当前证据状态为：`ACTUALLY_INVOKED=7`、`LOCAL_EQUIVALENT=4`、
`RESEARCH_ONLY=1`、`AUDITED_ONLY=1`、`INTERFACE_ONLY=4`。公开 `spot-market` 的 ticker、1h Kline、depth、历史成交已经进入
`MARKET_TASKS`；`technical-analysis / derivatives-analyst / market-overview / ta-master` 明确标成项目本地等价实现；sentiment 没有可审计 PIT 输入，继续零权重。四个 Private Account/Trading 能力保持接口禁用，未加载 API Key，未扩大 exchange-write 权限。

## 本次合并前验证

- 完整测试：254/254 通过。
- Safety：通过；冻结 Champion SHA-256 仍为 `9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6`，未发现 exchange credential、write command 或提交的 Telegram Token。
- V4 development-only prefix invariance：24/24 通过，`holdoutOpened=false`。
- 官方 Download Center `2026-08-23` 单日真实目录：9/9 类型成功，无 fetch error；大体量 depth 未默认下载。

## 可复现命令

```bash
npm run replay -- --strategy=research-v2 --capital=reference --reference-capital=20000
npm run replay -- --strategy=multi-venue-v3 --capital=reference --reference-capital=20000
npm run replay -- --strategy=breakout-v4 --capital=reference --reference-capital=20000
npm run robustness -- --strategy=breakout-v4 --capital=reference --reference-capital=20000 --iterations=1000
npm run data:download-center -- --from=2026-08-23 --to=2026-08-23
npm run research:v4-select
npm run research:v4-lookahead
npm test
npm run check:safety
```
