# 模拟优化结果（2026-08-24）

本轮只改变研究与 Shadow Paper 路径。冻结的 V1.2 Champion 哈希仍为
`9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6`；没有启用认证、私有接口或交易所写操作。

## 数据事实

- HTX 主目录清单哈希：`06a47fa5044db51cc519f421f15494fab9d2640bc56206f48344d939d167ab03`。
- 主区间：`2024-09-01T00:00:00Z` 至 `2026-07-31T23:45:00Z`；15m K 线 67,104 根且无间断，Funding 2,098 条。
- Mark/Premium/Basis 各 1,428 条，仅覆盖官方最近窗口；Settlement 198 条，实际只覆盖
  `2026-05-27` 至 `2026-07-31`，因此能力声明为 `PAGED_BOUNDED_RETENTION`，不能声称任意历史可下载。
- 回放区间内没有可用的盘口、OI、精英多空比和清算历史，全部保持缺失，未用现值回填。
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

## V4 证据边界

- 全区间：28 笔，7 胜 21 负，净 +1,037.34 CNY（+5.19%），PF 1.153，最大回撤 10.02%，交易 Sharpe 0.379。
- 参数探索实际只使用到 `2026-01-17T06:30:00Z`。该开发段精确回放为 15 笔、+9.52%、PF 1.519。
- `2026-01-17T06:45:00Z` 之后单独启动回放为 9 笔、+5.88%、PF 1.648；这段没有参与 V4 参数网格，
  但已被项目过往研究触碰，不能重新包装成 untouched OOS。
- 全区间按交易时间四等分后，净值分别为 -422.69、+2,932.49、+15.82、-1,488.29 CNY；收益并不跨状态稳定。
- 1,000 次逐交易 bootstrap 的亏损概率为 38.7%，block bootstrap 为 38.2%；样本只有 28 笔，远低于研究门槛 100 笔。
- 前视审计 24/24 通过。150% 手续费为 +4.67%，200% 滑点为 +4.70%，2 根执行延迟为 +3.15%；
  lookback 38/42、止损 2.375×ATR、目标 4.2R 的邻域回放仍为正，说明峰值并非单点崩塌。

因此 V4 只满足“值得继续积累 Shadow 样本”，不满足“已有可靠生产 edge”。当前不登记为 Champion、不自动激活 Shadow，
也不打开真实交易端口。

## 可复现命令

```bash
npm run replay -- --strategy=research-v2 --capital=reference --reference-capital=20000
npm run replay -- --strategy=multi-venue-v3 --capital=reference --reference-capital=20000
npm run replay -- --strategy=breakout-v4 --capital=reference --reference-capital=20000
npm run robustness -- --strategy=breakout-v4 --capital=reference --reference-capital=20000 --iterations=1000
npm test
npm run check:safety
```
