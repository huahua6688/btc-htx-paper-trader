# BTC/USDT 永续 V1.2 Dynamic Paper Trading

基于 HTX 公开行情的 BTC/USDT 本地合约模拟交易系统。程序启动后立即分析一次，之后每 5 分钟重新读取行情，独立比较 `LONG / SHORT / WAIT`，动态选择入场方式，并持续管理已有模拟净仓位。

本项目没有真实交易能力：不读取 HTX API Key、不调用私有接口；未来账户/下单端口目前只有默认报错的禁用接口，没有可用交易适配器。所有模拟仓位、手续费、Funding 和绩效只写入本地 SQLite。

## V1.2 的核心变化

- 每轮同时计算做多和做空机会分，不继承上一轮方向。
- 不再创建或持久化固定触发价、观察区或到期计划。
- 强机会可以按当轮当前价直接创建模拟仓位，不必机械等待回踩或突破。
- 方向成立但时机一般时，会说明更适合等待回落、重新走强/走弱或突破；下一轮仍全部重新计算。
- EMA、RSI、MACD、成交量、Order Book、Funding、OI、精英持仓、清算、Premium/Basis 与拥挤度共同参与判断。
- RSI、Funding 或拥挤度等任何单项都不能机械地一票否决方向。
- Risk Gate 只负责数据质量、账户风险、仓位约束和净 RR，不代替市场方向判断。
- 升级前遗留的 V1.1 固定计划会保留历史记录，并在首轮 V1.2 monitor 中自动标记为取消；不会控制新交易。
- 完整计算账户权益、动态风险、名义仓位、BTC 数量、杠杆、保证金、成本后净 RR 和 Paper 强平估算。
- 开仓后按新的完整 15m K 线动态选择持有、保本、移动止损、延长止盈或在原逻辑连续失效后提前退出；不会被普通 5 分钟噪音反复洗出。
- 风险设置保存在 SQLite，Telegram 管理员修改后下一轮生效，无需重启或改 `.env`。

## 2026-08-24 执行层与研究正确性重构

本轮只修 execution / sizing / infrastructure 与研究管线，**冻结的 V1.2 Champion 源码未改动**，
`src/analysis-engine.mjs` 的 SHA-256 仍为 `9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6`。

### 杠杆取整导致的仓位缺陷（严重）

`requiredLeverage = notional / availableMargin` 曾经被 `round(..., 2)` **四舍五入**。
一旦向下取整，`notional / leverage` 就会略高于可用保证金，于是：

- 修复前没有重新量化时：完全合法的候选被静默 `return null`；
- 有兜底重新量化时：仓位被一步步缩小，权益 5000 CNY、止损 1% 只能拿到 0.005 BTC，
  而约束其实允许 0.009 BTC。

现在使用「满足约束的最小可表示杠杆」（按 0.01 步进向上取整），并把名义仓位上限对齐到
可表示的杠杆步进，因此 `margin = notional / leverage ≤ availableMargin` 恒成立；
若向上取整后越过杠杆上限，则按合约步进缩小数量重算，绝不放行越界仓位。

固定网格（权益 3000～60000 × 5 档止损 × 4 档评分，共 5,496 个场景）的实测：

| | 可开仓候选 | 被拒 | 拒绝率 | 合计可建仓数量 |
|---|---|---|---|---|
| 修复前 | 3,460 | 2,036 | 37.0% | 148.657 BTC |
| 修复后 | 5,446 | 50 | 0.9% | 257.616 BTC |

### 拒绝原因码

仓位计算不再把所有失败混成一句「没有满足净 RR、合约步进……的有效仓位」。
每种拒绝都有机器可读的原因码（`BELOW_MIN_CONTRACT_STEP`、`NO_TARGET_MEETS_NET_RR`、
`LEVERAGE_CAP_BINDING`、`MARGIN_CAP_BINDING`、`RISK_BUDGET_EXCEEDED`、
`STOP_BEYOND_LIQUIDATION_BUFFER` 等），monitor、Telegram 与研究回放分别统计。
回放报告的 `entryRejections` 会把「因最小合约步进被拒」与「因风险/保证金被拒」分开计数。

### 分级数据质量门禁

数据源分为 `CRITICAL / IMPORTANT / AUXILIARY`，每轮输出 `DATA_OK / DATA_DEGRADED / DATA_BLOCKED`
以及具体缺失项，并区分「历史天然无档案」与「实时接口失败」，两者都绝不伪造或回填。

- 核心价格/K 线缺失：HARD BLOCK。
- 次要衍生品缺失：标记 missing、收缩风险预算、提高入场质量门槛；只有累计降级权重达到预算
  才升级为 HARD BLOCK。

降级不是只记一个数字：`riskMultiplier` 会真正乘进单笔风险预算，
`entryScoreBonus` 会真正抬高入场机会分门槛。

`dataPolicyMode` 运行时设置控制是否据此改变交易行为：

- `FROZEN_V12_STRICT`（默认）：完全复现冻结 V1.2 的一票否决行为，作为可复现 baseline。
- `TIERED_DEGRADED`：启用 `V1.3-DATA-TIERED-CANDIDATE` 候选策略的降级放行。
  该候选**没有**通过任何 OOS/Shadow/Promotion Gate，Champion 保持不变。

该候选同时是回放的一等策略 id，可以进入研究路径：

```bash
# 单策略逐事件回放；--strategy 只接受 replay-engine 已登记的 id
npm run replay -- --strategy=data-tiered --from=... --to=...

# 走 walk-forward / Purged OOS 门禁
npm run validate -- --candidate-strategy=data-tiered
```

回放与实时共用 `analyzeDataTiered → applyTieredDataPolicy`，没有第二份行为实现。
**接线可用不等于阶段已执行**：在真实数据上跑出 Replay / Walk-forward / Purged OOS /
Monte Carlo 结果之前，这些阶段一律记为未执行，Promotion 保持 BLOCKED。

### 真正动态的 AUTO 风险参数

AUTO 曾经对 risk / margin / leverage / notional 直接取区间上限。现在这些值在下单时按
权益、机会质量、波动、止损距离、已有敞口、保证金占用、总风险、回撤、日内亏损、连亏
和仓位数动态计算，并始终夹在用户区间内、且不超过写入 SQLite 的天花板（原子复核因此仍然成立）。
Telegram 风险面板与「🤖 本轮自动限额」页会显示自动范围、本轮实际值和选择理由。

这些动态值是**真正的硬上限，不是展示值**：`riskPerTradePct` 会压住单笔风险预算
（并且赢过 `riskMin` 下限），AUTO 杠杆使用动态 `userMaxLeverage` 而不是静态 `leverageMax`，
margin / notional / totalRisk 同样直接进入 `buildPaperCandidate`。
测试断言 Telegram 展示的「本轮实际值」与真正用于建仓的值完全一致。

### 研究：两种资金视角

小账户下 0.001 BTC 最小合约就占权益 72%，仓位规模被合约步进主导。研究因此拆成两个视角，
必须分开报告，且**生产 Paper 初始资金仍然是 1000 CNY，没有被改动**：

- `PRODUCTION_FAITHFUL`（默认）：真实 Paper 资金与真实合约步进，回答「这个账户实际能执行出什么」。
- `EDGE_REFERENCE_CAPITAL`：`--capital=reference --reference-capital=50000`，仅供研究，
  回答「策略本身有没有 edge」，永不影响生产账户。

### 研究运行登记与失败分类

修复前只有 `research-v2-pipeline.mjs` 会写 `research_runs`，而该模块没有任何 CLI 入口，
等于永远不会执行——这就是「已登记策略版本 1 / 已持久化研究运行 0」的原因。
现在所有研究命令都会把运行结果登记进独立的研究 SQLite。一次 CLI invocation 只产生
**一条顶层 run**（成功 PASSED/PARTIAL，失败 BLOCKED/FAILED），子阶段作为 `summary.stages`
evidence 放进这条 run，管线不再自行重复登记。覆盖 `backtest / replay / validate / similarity /
robustness / counterfactual / external:audit / optimize / diagnose / ablation / edge:pipeline /
tradable-edge / anti-chase / full / research:v2 / research:v3 / data:update / multi-venue:update`；
`data:inspect / research:runs / research:register-candidate` 是纯查询/登记命令，明确豁免。

**登记簿位置**：默认与生产 Paper 库同级的持久化目录（例如
`/var/lib/btc-htx-paper/research-registry.sqlite`），**不是**随时可清空的 `research-output/`。
可用 `PAPER_RESEARCH_DB_PATH`、`RESEARCH_DB_PATH` 或 `--research-db=` 配置，
但解析结果绝不允许指向生产 Paper 库或 Shadow 库（会直接报错）。

**Telegram 接通**：Strategy Learning、Challenger / Shadow、Historical Similarity、
Research Results 全部从研究登记簿**只读**读取，因此 CLI 一旦成功持久化，面板立刻能看到，
不会再出现「CLI 写了、面板显示 0 条」。Champion 的实时状态仍以生产 Paper 库和冻结源码为准。
登记簿不存在时面板安全显示「尚无研究记录」，不会崩溃，也不会因为查看页面而创建或改动研究数据库。

失败必须分类，不允许一律记 BLOCKED：

- `BLOCKED`：已知外部前置条件缺失 —— 本地数据目录不存在、公网端点不可达、holdout 未成熟。
- `FAILED`：代码异常、断言失败、内部逻辑错误、参数用法错误。默认就是 FAILED，
  只有明确匹配到外部前置条件才降级为 BLOCKED。

`research-cli.mjs` 现在也只在被直接执行时才派发命令；被 `import` 时不会顺手启动一次研究运行。

```bash
npm run research:runs                 # 查看真实的持久化运行数与策略版本数
npm run research:v2                   # 之前无法从 CLI 触发的 V2 管线
npm run research:v3                   # 多交易所独立双向评分、消融、OOS 与压力测试
npm run research:register-candidate   # 登记 V1.3-DATA-TIERED 候选（不等于晋级）
```

V3 的数据语义、HTX 全技能覆盖边界、独立双向评分与 runner 持仓契约见
[RESEARCH_V3_MULTI_VENUE.md](./RESEARCH_V3_MULTI_VENUE.md)。
真实目录上的 V2/V3/V4 同口径结果、压力测试与“不晋级”决定见
[SIMULATION_RESULTS_2026_08_24.md](./SIMULATION_RESULTS_2026_08_24.md)。

```bash
# 4h 低频突破候选（Paper/研究专用）
npm run replay -- --strategy=breakout-v4 --capital=reference --reference-capital=20000
npm run robustness -- --strategy=breakout-v4 --capital=reference --reference-capital=20000 --iterations=1000
```

### 其它修复

- 剩余风险的退出成本改用止损成交价估算（原先误用止盈价）。
- 移动止损后，同一根 K 线中「止损生效之前」的 high/low 不再能立即触发新止损。
- `db.transaction` 支持 SAVEPOINT 嵌套，内层回滚不会破坏外层事务。
- 核心公开行情增加有限次退避重试（3 次），次要数据源仍然只降级不重试。
- 数据源时间戳改为 schema 感知，不再把任何名为 `id` 的数字当成时间戳。
- `confidencePct` 对外更名为 `signalQualityScore`（SQLite 列与旧字段保留为兼容别名），
  UI 不再称其为置信度或胜率。
- 生产运行目标统一为 Node 24：`package.json` engines、`.nvmrc` 与 GitHub Actions CI 一致。

### Telegram 鉴权

管理员判定不再只看 `chat.id`。新增可选环境变量：

```text
TELEGRAM_ADMIN_USER_ID=
```

- 私聊：未配置该变量时保持兼容（私聊 chat.id 等于用户 id）。
- 群组/超级群：**必须**配置 `TELEGRAM_ADMIN_USER_ID`，且只有该发送者本人可以修改风险、
  杠杆、保证金、NET/HEDGE、暂停/恢复、最大仓位数以及执行任何管理型 callback；
  群内其他成员即使看到按钮也无法操作。

## 严格保留的风控

- 初始模拟资金 `1000 CNY`，当前 Paper 换算假设为 `1 USDT = 7.20 CNY`。
- 每笔必须有止损和止盈，扣除双边手续费、Funding 和不利滑点后净 RR 必须至少为 2。
- 单笔账户风险使用可调区间：首次启动默认 `0.5%～5%`，Paper 绝对边界为 `0.1%～10%`；实际风险仍按权益、机会质量、波动、止损距离和已有敞口动态缩放，绝不会因为提高杠杆而突破选定风险。
- 上海自然日损失也使用自动/手动区间：首次启动默认 `3%～20%`，达到当轮采用阈值后暂停新交易。高阈值只用于 Paper 压力研究，不代表推荐实盘风险。
- 连亏暂停首次启动默认 `3～10` 笔区间；自动模式按风险偏好取区间内阈值，次日重新评估。
- 默认关闭加仓且最多一个模拟净仓位；开启后仍必须通过有利进展、新高质量信号、总风险、总保证金和总名义仓位检查。
- 开仓和平仓各模拟 `0.05%` taker 手续费。
- 开仓和平仓各模拟 `0.02%` 不利滑点。
- Funding 在 UTC 00:00/08:00/16:00 附近按当时可获得的公开费率模拟；若程序离线导致历史结算费率缺失，会记录缺口并跳过，绝不拿当前值回填历史。
- 先确定止损和允许亏损，再确定名义仓位，最后反推合理杠杆与保证金；提高杠杆不能提高允许亏损。
- 强平价使用明确标记的 Paper 隔离保证金估算，正常止损必须先于强平缓冲；它不是 HTX 真实强平公式。
- 同一根可观察 K 线同时触及 SL/TP 时保守按 SL；开仓所在 K 线不用于高低点回溯触发。
- 核心价格/K 线不足时禁止开仓和所有价格触发动作。
- 次要衍生品缺失绝不伪造数据：默认的 `FROZEN_V12_STRICT` 政策下仍然一票否决（冻结 V1.2 原行为），
  切到 `TIERED_DEGRADED` 后才会降级放行并同时收缩风险、提高入场门槛。两种政策每轮都会显式输出
  `DATA_OK / DATA_DEGRADED / DATA_BLOCKED` 与具体缺失项。

## Multi-Layer Market Context 与研究门禁

信息被分为 `LONG-TERM / MEDIUM-TERM / SHORT-TERM / EXECUTION` 四层。长期层只允许改变长期背景或风险权重，不能直接触发分钟/小时交易；中期层面向波段方向；短期层面向机会与入场；订单簿等面向执行质量。

Feature Registry 记录每项特征的数据源、时间层、当前权重、适用 market regime、历史覆盖、预测期限、样本外贡献、最近有效性和 `enabled / research-only / disabled` 状态。Rainbow、200 周均线、Realized Price/MVRV、链上、期权、跨所衍生品、流动性和宏观候选当前均为 `research-only`、权重 0、未接入生产评分。

新增特征必须依次通过：严格训练/测试分离、无前视审计、walk-forward、Purging、Embargo、成本后增量贡献、实时 Shadow Paper、时间层作用边界测试和明确 Champion 晋级。历史 OOS 通过不会自动修改当前策略或风险设置。完整架构对照见 [ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)。

## Historical Research Engine

研究模块现在是可运行实现，不是验证字段或 README 占位。冻结的 V1.2 Champion 源码哈希保持为 `9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6`。研究运行不会修改 Champion，也不会改变实时 Risk Gate。

Historical Catalog V2 同时区分两类官方来源：REST 的 Kline/Funding 分页与有限最新窗口；以及独立的 HTX Historical Data Download Center。Download Center 已实测 BTC-USDT 现货和 `BTC-USDT-PERP` 永续的 Kline、逐笔成交、期货 150 档/现货 400 档深度、Mark/Index Kline 和 Funding。普通类型从 `2026-02-01` 起有真实档案，Depth 首个实测日期为 `2026-05-28`。小档案必须实际下载并让本地 SHA-256 与官方 `.CHECKSUM` 一致后，才转成带 `eventTime/visibleAt` 的 PIT 记录。大体量 trades/depth 默认只登记官方声明的 checksum、ETag 和大小，此时 `contentChecksumVerified=false`，不能称内容已校验。只有显式按需命令才下载、落盘并校验；depth 还必须额外确认大文件开关。Settlement REST 仍是有限保留窗口，绝不冒充 Download Center。超出真实覆盖的字段保持 `HISTORICAL_UNAVAILABLE`，不会用当前值倒填过去。完整能力矩阵和实测覆盖见 [HTX_INTEGRATION_V2.md](./HTX_INTEGRATION_V2.md) 与 [HTX_DOWNLOAD_CENTER_AUDIT_2026_08_24.json](./HTX_DOWNLOAD_CENTER_AUDIT_2026_08_24.json)。

HTX Skills Hub 的 17 个包只声明为“已审计”，不再声称 17/17 实际调用。`src/htx-skill-capabilities.mjs` 逐项标记 `AUDITED_ONLY / ACTUALLY_INVOKED / LOCAL_EQUIVALENT / RESEARCH_ONLY / INTERFACE_ONLY` 并给出代码证据。公开 `spot-market` 的 ticker、1h Kline、depth 和历史成交已进入每轮采集；现货/永续 premium 只作为研究展示，未改变 Champion。Private Account/Trading 仍为禁用接口，CLI 子进程不接收交易所凭据。

实时 monitor 每轮把已成功取得的 HTX 原始响应和 normalized 研究字段 best-effort 写入独立 `market-archive.sqlite`。归档失败只产生警告，不影响 Paper 仓位管理；原始 payload 不会因 parser 升级被重写，normalized 字段可从原始数据重新生成。Replay V2 只读取 `eventTime <= visibleAt`，Archive 还必须满足 `observedAt <= visibleAt`，并逐字段标记 `HTX_HISTORICAL / SELF_ARCHIVED / HISTORICAL_UNAVAILABLE / STALE / REPLAY_ARCHIVE_ERROR`。

```bash
# 必须显式给出连续区间；不会自动挑选收益最好看的时期
npm run data:update -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z
npm run data:download-center -- --from=2026-08-23 --to=2026-08-23
# trades：显式下载并校验；加 --parse=true 才转为 PIT 研究数据
npm run data:download-center:fetch -- --type=futuresTrades --date=2026-08-23 --parse=true
# depth：大文件必须再显式允许；默认目录扫描绝不会自动下载
npm run data:download-center:fetch -- --type=futuresDepth --date=2026-08-23 --allow-large-depth=true --parse=true
npm run data:inspect

# V4 参数选择和前视审计只使用固定 development cutoff，不读取未成熟 holdout
npm run research:v4-select
npm run research:v4-lookahead

# 查看 HTX CLI 身份、只检查官方 Release、受控更新，以及自建归档覆盖
npm run htx:status
npm run htx:status -- --verify  # 显式重新计算当前 binary SHA-256
npm run htx:check
npm run htx:update
npm run archive:status

# Champion 与 Challenger 同事件、独立 SQLite 的逐 15m 回放
npm run backtest -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z

# 自动生成的 Purged OOS / walk-forward / look-ahead / 增量贡献实验
npm run validate

# 历史相似状态与 1h/4h/12h/24h/3d/7d 后验分布
npm run similarity

# trade-order、block bootstrap、成本、滑点、延迟、连亏和参数扰动
npm run robustness

# 方向、入场、退出、止损、仓位、成本及 WAIT 的事后反事实
npm run counterfactual

# 外部数据来源与 200 周均线 research-only 审计
npm run external:audit

# Candidate → Replay → Purged 选择验证 → 未触碰 Final OOS → Stress → Shadow → Promotion Gate
npm run optimize

# 只在预声明开发区间诊断“追涨杀跌”；不会打开 Final OOS，也不会替换冻结 Champion
npm run anti-chase

# 诊断当前 Challenger：方向、regime、评分、持仓、入场/退出、gross/cost/net、MFE/MAE
npm run diagnose -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z

# OHLC → OHLCV → OHLCV+Funding 的逐窗口时点特征消融
npm run ablation -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z

# 使用已经生成的诊断/消融证据运行新候选和一次性 untouched holdout
npm run edge:pipeline -- --diagnosis=<challenger-diagnosis.json> --ablation=<feature-ablation-report.json>

# 使用源码中预先声明的完整连续区间运行整套研究验收
npm run research:run
```

### Tradable Edge（可交易优势）

该层不改变冻结的 V1.2 Live Champion，并且不增加指标、ML 或数据源。历史回放和实时研究观测共用同一套非 ML 分解：

```text
净可交易优势
= 预计有效毛价格空间
- 往返手续费
- 往返不利滑点
- 不利 Funding 估算
- 统计不确定性缓冲
```

每个历史抽样时点同时生成 LONG/SHORT 的 1h、4h、12h、24h、3d forward return、MFE、MAE、MFE/MAE、time-to-MFE、time-to-MAE 和极值先后顺序。未来结果只作为标签，训练只能使用在 trainEnd 前已完整成熟的标签。

```bash
npm run tradable-edge -- --diagnosis=/absolute/path/to/challenger-diagnosis.json
```

旧方向分和新的 `Opportunity Index` 都不得称为置信度或成功概率。`Opportunity Index` 只是预计净可交易优势的顺序指标，必须另行证明它与 OOS 净结果具有稳定单调关系。

2026-08-23 的实际研究使用 2024-09-01 至 2026-01-17、10,567 个标签时点和 4 个 Purged/Embargo OOS 窗口。原 589 笔 Challenger 被判定为 overtrading：毛收益 100.3188 CNY、成本 496.1016 CNY、净亏 395.7828 CNY。五档净优势门槛全部失败；最严格的 0.50% 档降至 125 笔后仍净亏 98.4827 CNY、PF 0.8074，仅 2/4 窗口为正。

因此结果为 `NO_CHALLENGER_GENERATED`。新的 untouched Final OOS 从 2026-08-23 05:45 UTC 开盘 K 线开始收集，至少需要 30 天和 2,880 根 15m K 线；成熟前不读取结果、不运行 Final OOS/Monte Carlo，也不进入可建仓 Shadow。实时 monitor 只显示两侧净优势并保持 `observeOnly`。

所有生成数据位于 `data/research/`，运行报告位于 `research-output/`，二者默认不提交 Git。回放信号在完整 15m K 线收盘后产生，默认延迟到下一根 15m 开盘成交；1h/4h/1d 只有在各自周期完整收盘后才可见。成交继续复用 Paper 仓位、Risk Gate、动态持仓管理、手续费、滑点和 Funding 核心。

Edge pipeline 会先把新的 Final OOS 写入 `data/research/holdout-registry.json` 并标记 `UNTOUCHED`。候选生成和排名只接收 development view；唯一选中候选打开 holdout 后，状态永久改为 `USED`，同一 holdout 不得再用于调参或下一轮候选。退出类型和实际持仓时间属于事后变量，只能用于诊断，禁止转成入场过滤。

实时 monitor 默认同时运行一个独立 Challenger Shadow Paper 账户。两者读取同一份公开市场快照，但使用不同 SQLite：Champion 使用 `PAPER_DB_PATH`，Challenger 使用 `SHADOW_DB_PATH`。Shadow 失败会独立记录，不会改变 Champion 账户或阻断 Champion monitor。可通过运行环境设置：

```bash
SHADOW_PAPER_ENABLED=true
SHADOW_DB_PATH=/var/lib/btc-htx-paper/shadow-challenger.sqlite
```

当 active Shadow 是 Breakout V4 时，monitor 会在每个 4h 收盘边界增加一次墙钟唤醒；5/15/60/240 分钟的常规轮询设置仍保留，但不会再让较长周期静默跳过固定 5 分钟 signal-age 窗口。相同 4h signal bar 由持久化 signal key 幂等去重。

回放默认使用 `PAPER_CONFIG` 的组合限制：NET 模式、关闭加仓，因此 `maxOpenPositions` 被强制为 1。
单槽位下持仓期间的新信号会被直接丢弃，成交笔数可能受设置限制而非行情限制，报告的 `portfolioLimits`
会如实写明这一点。实盘账户的设置未必相同；要按真实账户重测，用：

```bash
npm run replay -- --strategy=breakout-v4 --max-open-positions=4 --allow-pyramiding=true
```

不传这些参数时行为与既往逐字节一致，已记录的研究数字保持可复现。

这次额外唤醒只运行 Shadow，不运行 V1.2 生产周期：启用一个研究 Shadow 不会改变冻结 Champion 的评估节奏。生产仍然严格按管理员选定的间隔执行。

所有策略的入场 K 线格统一由 `src/execution-timing.mjs` 按「执行观察时刻所在的 15 分钟格」解析。研究策略使用已收盘视图，其 `latest15mBar` 比入场那一格更早，因此不能直接当作 `entry_bar_ts`，否则 `paper-engine` 的回溯保护会放行入场之前的价格走势去触发 SL/TP。

Shadow 不会自动晋级。少于 30 个自然日或 100 个实际信号时，Promotion Gate 必须保持阻塞。ML 目前没有进入 Challenger：只有在简单统计/相似行情 baseline 之上通过严格 OOS 增量检验后，才允许研究 ML 候选。

## 使用的公开数据

- 15m、1h、4h、1d K 线与成交量
- EMA、RSI、MACD、ADX、ATR 和价格动量
- Order Book 前 20 档与点差
- Funding 当前值、历史分位
- Open Interest 当前值与约 24 小时变化
- HTX 精英账户/仓位多空比
- 最近公开清算事件样本
- Mark Price、Premium、Basis

清算数据不是全市场热力图；精英交易者比率不是全体散户比率；HTX 没有提供本项目可用的独立 Taker 主动买卖量接口。系统不会伪造缺失数据。

## 本机命令

需要 Node.js 24 或更高版本。

```powershell
npm run analyze
npm run monitor
npm run status
npm run health
npm run htx:status
npm run htx:check
npm run htx:update
npm run archive:status
npm run report
npm run gate:report
npm run telegram:test
npm test
npm run check:safety
```

- `analyze`：只读公开行情并输出当轮判断，不写交易所。
- `monitor`：立即运行一次，之后每 5 分钟分析、写 SQLite 并管理模拟仓位。
- `status`：第一部分显示实际数据库路径，并显示权益、可用资金、已/未实现盈亏、保证金、名义仓位、有效杠杆、净仓位、当前风险、最近判断和数据源质量。
- `health`：Paper DB、monitor 或快照异常时返回非零退出码；Research/Archive 状态失败仅显示 infrastructure warning，不会误报 Paper core 故障。
- `htx:status`：默认显示 installed metadata 中记录的 SHA-256，不重复读取约 100MB binary；只有显式增加 `--verify` 才重新计算并核对当前文件。
- `htx:check`：只查询官方 GitHub Release 并比较身份，不修改生产 binary。
- `htx:update`：下载到 staging，验证官方 release 身份/可用 checksum、跑全部已采用 public command 的兼容测试、项目测试和安全扫描，全部通过才原子替换并保留 rollback。它不会自动扩大白名单。
- `archive:status`：只读显示独立 Market Archive 的覆盖、缺口和存储统计。
- `report`：输出多/空交易、均盈亏、Profit Factor、Expectancy、最大回撤、RR、实际杠杆、保证金使用、毛收益、手续费、Funding、滑点、净收益和账户收益率。
- `gate:report`：统计方向偏好、动态入场方式和真实硬性拦截。

指定统计范围：

```powershell
npm run gate:report -- --hours=168
```

## 每轮决策流程

```text
读取最新公开行情并检查数据质量
  → 独立计算 LONG 机会分
  → 独立计算 SHORT 机会分
  → 比较方向优势和短周期入场质量
  → LONG / SHORT / WAIT
  → 当轮动态选择直接、突破、恢复，或说明继续等待的方式
  → 账户权益/组合风险/保证金/名义仓位/净 RR 审核
  → 先定风险与名义仓位，再反推杠杆和保证金
  → 只在本地 SQLite 创建模拟仓位
  → 后续每轮先保护固定 SL/强平，再按完整15m结构动态管理
```

输出会直接回答：当前 BTC、系统判断、3～5 个主要理由、是否现在入场；若入场则显示模拟入场价、止损、止盈、净 RR 和风险比例，若等待则显示缺少的条件。

## Telegram 通知

只有两个环境变量都存在时才启用：

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Token 只能从运行环境读取，不能写入源码、Git 或命令参数。通知规则：

- 真正创建模拟 LONG/SHORT 仓位时通知。
- 模拟 TP/SL、提前止盈、逻辑失效或 Paper 强平时通知，并列出原因、持仓时间、毛收益、手续费、Funding、滑点和净收益。
- 风控暂停、健康失败及恢复时通知。
- 上海时间 23:55 后的首轮 monitor 发送一次每日绩效。
- `WAIT`、普通快照和 Funding 结算不通知，避免刷屏。
- Telegram 超时或发送失败只写日志，不会让 monitor 崩溃或回滚模拟事件。
- Telegram 控制只接受 `TELEGRAM_CHAT_ID` 完全匹配的管理员；其他人无法查看或修改 Paper 设置。

管理员控制面板包括：当前仓位、当前判断、账户状态、今日表现、风险设置、杠杆设置、加仓设置、暂停/恢复、最近交易、详细分析和研究页面。第一次发送 `/panel` 会创建一条面板消息；之后点击按钮只编辑这条消息，不再每点一次新增一条输出。运行中只显示“暂停新开仓”，手动暂停后只显示“取消手动暂停”。取消手动暂停只是重新允许评估，不能绕过日损、连亏、数据质量或 RR 等自动 Risk Gate。Token 不写 SQLite、不出现在日志，也不会传给 HTX CLI。所有设置修改记录时间、旧值、新值和来源。

风险、总风险、保证金使用、杠杆、总名义仓位、同时仓位数、日损失和连亏暂停都使用“最低值～最高值”区间，并可切换自动/手动。自动模式在区间内按权益、机会质量、波动、止损距离和已有暴露计算；手动模式使用用户选定值，但仍不能越过独立的 Paper/产品硬限制。旧 SQLite 设置不会被部署自动覆盖；管理员可在主面板点一次“✨ 一键启用新版自动区间”，或进入任一子页面逐项调整。设置写入 SQLite，下一轮 monitor 生效，程序或 VPS 重启后保留。

Windows 当前终端测试：

```powershell
$env:TELEGRAM_BOT_TOKEN = "从 BotFather 取得的 Token"
$env:TELEGRAM_CHAT_ID = "目标 Chat ID"
npm run telegram:test
```

## Ubuntu VPS 从 clone 到运行

以下命令适用于 Ubuntu 22.04/24.04 的 `x86_64` VPS。把 `<YOUR_REPOSITORY_URL>` 换成项目 Git 地址。

### 1. 安装 Node.js 24 和系统组件

```bash
sudo apt update
sudo apt install -y git curl ca-certificates gnupg logrotate
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node --version
npm --version
uname -m
```

### 2. 创建服务用户并 clone

```bash
sudo useradd --system --home-dir /var/lib/btc-htx-paper --shell /usr/sbin/nologin btc-htx
sudo git clone <YOUR_REPOSITORY_URL> /opt/btc-htx-paper
cd /opt/btc-htx-paper
```

用户已存在时可以忽略 `useradd` 的提示。

### 3. 受控安装或更新 HTX 官方公开行情 CLI

应用只允许既有白名单内的公开行情命令，不安装或调用交易 Skills。`htx:check` 只检查；`htx:update` 先在 staging 对所有项目实际使用的命令做兼容验证，再跑完整测试和安全扫描，全部成功后才原子替换。失败时原 binary 保持不变，旧 binary 保存在 `vendor/rollback/`。

```bash
sudo install -d -m 0750 -o root -g btc-htx /var/lib/btc-htx-paper/htx-cli
cd /opt/btc-htx-paper
sudo env HTX_CLI_STATE_DIR=/var/lib/btc-htx-paper/htx-cli npm run htx:check
sudo env HTX_CLI_STATE_DIR=/var/lib/btc-htx-paper/htx-cli npm run htx:update
sudo env HTX_CLI_STATE_DIR=/var/lib/btc-htx-paper/htx-cli npm run htx:status

sudo chown -R root:btc-htx /opt/btc-htx-paper
sudo chmod -R g+rX,o-rwx /opt/btc-htx-paper
```

若 GitHub Release 提供 `sha256:` digest，updater 必须匹配后才继续；若上游没有发布 checksum，状态会明确显示 `officialChecksumProvided=false`，仅记录本地 SHA-256 和 release identity，绝不会冒充官方 checksum 验证。

### 4. 部署前验证

```bash
cd /opt/btc-htx-paper
sudo -u btc-htx /usr/bin/node --test "test/*.test.mjs"
sudo -u btc-htx /usr/bin/node scripts/check-safety.mjs
```

### 5. 安装环境、systemd、health 和日志轮转

```bash
cd /opt/btc-htx-paper
sudo install -m 0640 -o root -g btc-htx deploy/systemd/btc-htx-paper.env.example /etc/btc-htx-paper.env
sudo install -m 0644 deploy/systemd/btc-htx-paper.service /etc/systemd/system/btc-htx-paper.service
sudo install -m 0644 deploy/systemd/btc-htx-paper-health.service /etc/systemd/system/btc-htx-paper-health.service
sudo install -m 0644 deploy/systemd/btc-htx-paper-health.timer /etc/systemd/system/btc-htx-paper-health.timer
sudo install -m 0644 deploy/logrotate/btc-htx-paper /etc/logrotate.d/btc-htx-paper
sudo systemd-analyze verify /etc/systemd/system/btc-htx-paper.service /etc/systemd/system/btc-htx-paper-health.service /etc/systemd/system/btc-htx-paper-health.timer
sudo logrotate --debug /etc/logrotate.d/btc-htx-paper
```

如需 Telegram，用 `sudoedit /etc/btc-htx-paper.env` 填入真实值。不要加入任何 HTX/Huobi Key 或 Secret。

```text
PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite
MARKET_ARCHIVE_DB_PATH=/var/lib/btc-htx-paper/market-archive.sqlite
HTX_CLI_STATE_DIR=/var/lib/btc-htx-paper/htx-cli
PAPER_HEALTH_MAX_AGE_MS=900000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 6. 启动、开机自启并检查

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now btc-htx-paper.service
sudo systemctl enable --now btc-htx-paper-health.timer
sudo systemctl status btc-htx-paper.service --no-pager
sudo tail -n 100 /var/log/btc-htx-paper/monitor.log
```

查看状态、健康和绩效：

```bash
cd /opt/btc-htx-paper
sudo -u btc-htx /usr/bin/env PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite /usr/bin/node src/status.mjs
sudo -u btc-htx /usr/bin/env PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite PAPER_HEALTH_MAX_AGE_MS=900000 /usr/bin/node src/health.mjs
sudo -u btc-htx /usr/bin/env PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite /usr/bin/node src/report.mjs
sudo -u btc-htx /usr/bin/env PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite /usr/bin/node src/gate-report.mjs --hours=24
sudo -u btc-htx /usr/bin/env MARKET_ARCHIVE_DB_PATH=/var/lib/btc-htx-paper/market-archive.sqlite /usr/bin/node src/market-archive-cli.mjs status
```

Telegram 测试不会把 Token 放入进程参数：

```bash
sudo -u btc-htx /bin/bash -c 'set -a; . /etc/btc-htx-paper.env; set +a; cd /opt/btc-htx-paper; exec /usr/bin/node src/telegram-test.mjs'
```

systemd 使用 `Restart=on-failure`，程序异常后自动重启；`enable` 保证 VPS 重启后自动启动。程序优雅处理 SIGTERM/SIGINT，并在结束前停止 Telegram polling、等待当前周期并关闭 SQLite。

Paper SQLite 位于 `/var/lib/btc-htx-paper/paper-trading.sqlite`，研究 registry 位于独立的 `research-registry.sqlite`，长期 HTX 公开行情归档位于独立的 `market-archive.sqlite`；三者不会混表。Telegram 去重状态位于同目录的 `notification-state/`。日志位于 `/var/log/btc-htx-paper/monitor.log`，每日轮转、达到 10MB 提前轮转、压缩并保留 14 份。

## 已部署 VPS 的最少升级步骤

```bash
sudo systemctl stop btc-htx-paper.service
sudo mkdir -p /var/backups/btc-htx-paper
sudo cp -a /var/lib/btc-htx-paper/paper-trading.sqlite* /var/backups/btc-htx-paper/
sudo git -C /opt/btc-htx-paper pull --ff-only

cd /opt/btc-htx-paper
sudo install -m 0644 deploy/systemd/btc-htx-paper.service /etc/systemd/system/btc-htx-paper.service
sudo systemctl daemon-reload
sudo -u btc-htx /usr/bin/node --test "test/*.test.mjs"
sudo -u btc-htx /usr/bin/node scripts/check-safety.mjs
sudo systemctl restart btc-htx-paper.service
sudo systemctl restart btc-htx-paper-health.timer
sudo tail -n 100 /var/log/btc-htx-paper/monitor.log
```

V1.2 兼容现有 SQLite，不删除旧快照、历史仓位、绩效或 Telegram 运行时设置。新默认值只在首次启动创建，部署新版不会覆盖管理员已经保存的配置。遗留活动计划只会被取消，不会被执行。

## 不可弱化的安全边界

- 只允许公开的 futures-market、funding-rate、oi-tracker、elite-positioning、liquidation-stream 和 mark-price 命令。
- 命令、参数和值均使用白名单，交易对只允许 `BTC-USDT`。
- HTX CLI 子进程主动移除 HTX/Huobi 凭据以及 Telegram Token/Chat ID。
- 本地模拟开平仓只修改 SQLite；没有交易所写入模块。
- 单笔风险、总风险、保证金、杠杆、名义仓位、日损失和连亏阈值均有绝对边界与用户可调区间；净 RR 仍须 ≥ 2。提高杠杆不会提高允许亏损，程序先确定止损和账户风险，再反推名义仓位与保证金。
- Telegram Token 只从环境读取；安全扫描拒绝疑似 Token 或交易能力进入项目。
- systemd 每次启动前自动运行安全扫描，扫描失败时 monitor 不启动。
- HTX 官方公开产品规则说明 USDT 本位合约杠杆范围最高可到 200x，BTC/ETH 产品支持最高 200x；这只是产品公开上限。Paper 不登录账户，无法可靠知道 KYC、仓位档位、地区和账户当时实际可用上限，也无法精确复现 HTX 强平价。项目把公开 200x 作为独立产品约束，账户上限明确显示“未知”，强平只标记为 Paper 估算，绝不冒充账户实时限制。

本系统仅供机械规则研究，不构成投资建议。
