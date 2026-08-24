# Research V3：多交易所模拟优化

`multi-venue-challenger-v3.0.0` 是独立 Challenger，不修改冻结的 V1.2 Champion。
当前阶段只使用公开、免认证数据进行历史回放和 Shadow Paper；账户、下单、撤单与杠杆设置只定义在
`exchange-live-interface.mjs` 的禁用接口中，默认调用必然失败，不读取密钥。

## 本次解决的结构问题

- LONG 与 SHORT 分别构造趋势结构、动量过程、成交参与和衍生品背景证据；两边分数不再互为补数。
- EMA/价格结构只属于一个趋势维度，MACD/RSI 只属于一个动量维度，不能靠重复指标凑“独立证据”。
- RSI 超买回落与超卖回升采用镜像条件；可复现的 antithetic 随机游走测试要求方向计数平衡。
- 入场继续要求成本后净 RR `>= 2`，但新仓位使用 `SWING_RUNNER_V1`：不再 1R 机械保本、1.5R 机械跟踪；
  实际保本和跟踪阈值按目标 R 的 60% / 78% 推导，并保留硬 SL/TP。
- Binance、Bybit、OKX 只下载已结算 Funding，按交易所和结算时间持久化。回放只看
  `visibleAt <= decision time` 的记录；场所缺失、过期或请求失败不会用别处数据填补。

## HTX 技能覆盖原则

官方目录中的 17 个技能/技能族都记录在 `src/htx-skill-capabilities.mjs`：

- 公共行情、Funding、OI、精英仓位、清算、Mark/Premium/Basis、Settlement、Spot 与分析技能进入实时采集、
  历史目录或研究计算；受官方保留窗口限制的字段保持 `HISTORICAL_UNAVAILABLE`。
- Settlement 历史进入数据目录并只作场所风险诊断；保险基金公开端点若处于 suspended 状态，明确标为部分覆盖。
- Settlement 即使支持 start/end 与分页，也受 HTX 当前保留窗口限制；清单必须记录实际首尾时间，不能把请求区间写成实际覆盖。
- Spot/Futures Account 与 Trading 属于私有读写能力，当前只能是 `INTERFACE_ONLY`，不能因为“技能已覆盖”而获得交易权限。
- sentiment 类特征没有可靠 point-in-time 历史证据时生产权重恒为 0。

## 可执行流程

```bash
# 1. HTX 主历史目录（含 Kline、Funding、可获得的衍生品窗口与 Settlement）
npm run data:update -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z

# 2. 三个外部场所的 Funding 历史目录
npm run multi-venue:update -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z

# 3. 单策略同事件回放
npm run replay -- --strategy=multi-venue-v3 --from=2024-09-01T00:00:00.000Z --to=2026-01-17T06:30:00.000Z --capital=reference

# 4. Purged / Embargo Walk-forward OOS
npm run validate -- --baseline-strategy=research-v2 --candidate-strategy=multi-venue-v3

# 5. 端到端 V3：baseline、同事件跨场所消融、OOS、成本/延迟/参数压力测试
npm run research:v3 -- --iterations=1000
```

`research:v3` 即使 OOS 通过也不会自动晋级。跨场所消融必须有真实时点覆盖，之后还必须完成正式 Shadow Paper；
任何一步证据不足都会以 `PARTIAL/BLOCKED` 留痕，不能伪装为完成。
