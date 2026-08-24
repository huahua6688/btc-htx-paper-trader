# btc-htx-paper Architecture Review and Gap Closure

更新时间：2026-08-23

## 2026-08-24 更新：既有研究结论降级为 BEFORE BASELINE

本轮在执行层发现并修复了一个会系统性改变仓位规模的缺陷（杠杆按 0.01 步进被四舍五入，
向下取整时 `notional / leverage` 超过可用保证金）。`replay-engine.mjs` 与实时 monitor 共用
同一个 `evaluatePaperEntry` / `buildPaperCandidate`，因此**下方所有历史数字都是在这个缺陷
存在的情况下产生的**：589 笔 Challenger、四窗口 Purged OOS、500 次 trade-order resampling、
500 次 block bootstrap、成本/滑点/延迟压力重放、Final OOS 与 Tradable Edge 分解全部受影响。

固定网格实测（权益 3000～60000 × 5 档止损 × 4 档评分，5,496 个场景）：拒绝率 37.0% → 0.9%，
合计可建仓数量 148.657 → 257.616 BTC。缺陷有两种表现：在没有重新量化兜底时直接静默拒绝，
在有兜底时把仓位缩小（权益 5000 CNY、止损 1% 只拿到 0.005 BTC，实际允许 0.009 BTC）。

因此：

- 下方的 `NO_CHALLENGER_GENERATED`、`Promotion Gate = BLOCKED` 等结论**保留为 BEFORE BASELINE**，
  不再作为当前有效证据。
- 重跑之前，**不得声称策略已经盈利，也不得声称 NO_EDGE 结论仍然成立**。修复只改变了执行层，
  没有增加任何 edge；成本吞掉 494.53% 毛收益这类结构性问题不会因为仓位变大而消失，
  但现有样本已不足以支撑任何方向的结论。
- 冻结的 V1.2 Champion 源码未改动，SHA-256 仍为
  `9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6`，仍是可复现 baseline。
- 已使用过的 Final OOS 不得重新用于调参。重跑必须按原有 Candidate → Replay → Walk-forward →
  Purged OOS → 未触碰 Final OOS → Monte Carlo → Shadow → Promotion Gate 的顺序重新走。

### AFTER 重跑状态：BLOCKED

本次实现环境无法执行重跑，原因是真实的、可复现的外部限制，不是选择性跳过：

| 前置条件 | 状态 | 实证 |
|---|---|---|
| 本地 15m/Funding 数据目录 | 缺失 | `npm run backtest` → `ENOENT ... candles-15m.json`；`data/research/` 在 `.gitignore` 中，从未提交 |
| HTX 公开历史端点 | 不可达 | `npm run data:update` → `HTTP 403`（本环境网络策略不允许出站到 `api.hbdm.com`） |
| `vendor/htx-cli-linux-x64` | 缺失 | 二进制在 `.gitignore` 中，实时 monitor 因此也无法运行 |
| 新 Final OOS 成熟度 | 未成熟 | 需要至少 30 个自然日与 2,880 根 15m K 线 |

这两次失败已经如实登记为 `BLOCKED` 研究运行（见下）。**没有伪造任何替代结果。**

### 研究闭环的真实状态

CONNECTED 只有在「同一个环境里真的把该阶段跑通过一次」时才允许标是。
本环境没有数据集，因此除了纯接线层面的单元测试之外，任何阶段都不得标 CONNECTED/EXECUTED。

| 步骤 | IMPLEMENTED | CONNECTED | EXECUTED | PERSISTED |
|---|---|---|---|---|
| Candidate 生成 | 是 | 未验证（无数据集） | 否 | 否 |
| Replay | 是 | 未验证（无数据集） | 否 | 否 |
| Walk-forward | 是 | 未验证（无数据集） | 否 | 否 |
| Purged OOS | 是 | 未验证（无数据集） | 否 | 否 |
| Final untouched OOS | 是 | 未验证（未成熟，且本轮不得触碰） | 否 | 否 |
| Monte Carlo / block bootstrap | 是 | 未验证（无数据集） | 否 | 否 |
| Shadow | 是 | 未验证（无 CLI 二进制） | 否 | 否 |
| Promotion Gate | 是 | 未验证 | 否 | 否 |

#### V1.3-DATA-TIERED 的阶段状态

`data-tiered` 已经成为 `runHistoricalReplay` 的一等策略 id，并且与实时 monitor
共用同一份 `analyzeDataTiered → applyTieredDataPolicy` 实现（有测试断言两条路径输出一致，
不存在第二份行为副本）。但是**接线可用不等于阶段已经执行**：

| V1.3 阶段 | 状态 | 说明 |
|---|---|---|
| Replay 接线 | IMPLEMENTED，单元测试已覆盖 | 策略 id 被接受、派发到同一个 tiered policy |
| Replay 执行 | **未执行** | 没有数据集，一根真实 K 线都没有回放过 |
| Walk-forward / Purged OOS | **未执行** | 同上 |
| Monte Carlo / block bootstrap | **未执行** | 同上 |
| Final untouched OOS | **未触碰** | 本轮明确不打开 |
| Shadow | **未启动** | 没有 HTX CLI 二进制 |
| Promotion | **BLOCKED** | 无任何 OOS/Shadow 证据 |

在这些阶段真正跑出结果之前，不得把 V1.3 的任何阶段报告为 CONNECTED 或 EXECUTED，
也不得据此声称它优于冻结 Champion。

「已持久化研究运行 = 0」的根因已经查清并修复：`recordResearchRun` 与 `registerStrategyVersion`
只在 `research-v2-pipeline.mjs` 中被调用，而该模块**没有任何 CLI 入口**，属于不可达代码；
其余所有研究命令只写 `research-output/` 下的 JSON，从不落库。现在所有研究命令都会登记，
失败也会以 `BLOCKED` 加真实原因入库，并新增 `npm run research:runs` 直接查询。

登记簿存放在与生产 Paper 库同级的持久化路径（可用 `PAPER_RESEARCH_DB_PATH` /
`RESEARCH_DB_PATH` / `--research-db=` 覆盖），解析结果绝不允许指向生产库或 Shadow 库。
Telegram 的 Strategy Learning / Challenger / Historical Similarity / Research Results
只读读取同一个登记簿，因此 CLI 持久化之后面板立即可见；Champion 的实时状态仍以生产库
与冻结源码为准。生产 Paper 库的 `research_runs` 始终保持为 0，不被研究任务污染。

本环境实测：4 次真实 CLI invocation（backtest / replay --strategy=data-tiered / similarity /
robustness）产生恰好 4 条顶层 run，全部为 `BLOCKED`（无数据集），
`registeredStrategyVersions` 为 2（新增 `V1.3-DATA-TIERED-CANDIDATE`，role=CHALLENGER，
lifecycle=CANDIDATE，promotion 明确为 BLOCKED；Champion 仍为 `V1.2-FROZEN` / `FROZEN`）。

## 结论

项目仍是 BTC-USDT 单品种、公开数据、Paper-only 系统。冻结的 V1.2 Champion 分析核心未修改，SHA-256 为：

`9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6`

本轮补齐了真实历史数据目录、逐事件回放、自动验证、历史相似状态、独立 Challenger/Shadow、候选实验、Monte Carlo/压力重放和事后反事实。研究结果没有证明当前 Challenger 可以晋级：正式 Champion 保持不变。

第一份预先声明的连续区间为 2024-09-01 至 2026-07-31，不根据收益挑选。该轮实际下载 67,104 根 15m K 线和 2,099 个 Funding 结算点；K 线缺口、重复、边界缺失均为 0，证据 manifest 哈希为 `3e58aee36e60485951d55feb050da061d46f91d43a037ddbc9630666a3d68ca3`。完整回放在该 manifest 上重新执行，得到：

- 冻结 Champion：61,345 个可回放时点全部 WAIT、0 笔交易。原因是历史 Order Book、OI、精英仓位、清算、Mark/Basis 无可靠时点档案，原数据门禁不允许伪造。
- 基础技术 Challenger：589 笔，胜率 41.94%，Profit Factor 0.7949，净收益 -395.7828 CNY（-39.5783%），最大回撤 41.346%。
- Challenger 按入场 regime：TRENDING -404.4511 CNY、TRANSITION -99.0934 CNY、RANGE +107.7617 CNY。
- 四窗口 Purged OOS 的 regime-filter 增量实验未通过：0/4 个正增益窗口，净 Sharpe 增量 -0.0004，Profit Factor 增量 -0.0001；因此该特征不得晋级。
- Prefix invariance look-ahead audit 运行 24 个检查，全部通过。

完整 Candidate → Replay → Walk-forward/Purged OOS → Stress → Shadow → Promotion Gate 也已实际执行：

- 候选生成只使用预先限定的小范围扰动，共 6 个；选择只读取训练段和 Purged selection-validation 段。
- 最后 25% 是候选排名未读取的 strict Final OOS。选中的 `candidate-01-base-v1` 在该段交易 279 笔，净收益 -19.3008%，Profit Factor 0.7840，最大回撤 20.0117%。
- 同一 Final OOS 的 baseline 为 -19.2893%；候选的净收益增量 -0.0115 个百分点、Sharpe 增量 -0.0011，没有增量价值。
- Historical Shadow 的 Champion/Challenger 事件数都为 16,777，事件流哈希同为 `1652b1bdf7e2ab06b64c7bbe2469ddec1eb62ccd180ebd33b251b1c5c048399b`；账户和 SQLite 完全独立。
- 500 次 trade-order resampling 的亏损概率为 95.4%，收益中位数 -18.3336%；500 次 block bootstrap 的亏损概率为 96.0%，收益中位数 -20.4104%，最大回撤中位数 24.1612%。
- 成本 150%、滑点 200%、执行延迟 2/3 bars 都进行了重新逐事件回放；结果分别为 -20.7879%、-21.9767%、-16.8274% / -20.2074%。
- Promotion Gate 为 `BLOCKED`，Champion 未改变。一次实时 HTX monitor 后，独立 live Shadow 已产生第一条 LONG 判断，但没有通过入场门禁；这只证明链路运行，不能代替至少 30 日/100 信号的未来 Shadow 证据。

这些负结果是有效产物，不会通过放宽 Risk Gate、修改 Champion 或挑选较好区间来修饰。

## Edge Diagnosis 与新 Holdout（2026-08-23）

本轮没有增加数据类型或 ML。Catalog 只把既有 15m OHLCV/Funding 连续更新到 2026-08-23 05:30 UTC：69,239 根 K 线、2,165 个 Funding、缺口 0，最新 manifest 为 `f68aaf9cf44140f635301a75217b2db31459c4ab5362c3712873a0f240a460e5`。

- 原 Challenger 589 笔：平均毛 edge +0.1703 CNY，平均成本 0.8423 CNY，净期望 -0.6720 CNY，净 PF 0.7949。手续费 363.7259、滑点 145.4891、Funding 净贡献 +13.1134 CNY；成本吞掉了 494.53% 的总毛收益。
- LONG 330 笔在成本前已经为负；SHORT 259 笔成本前较好但扣费后仍为负。RANGE 全样本净 PF 1.2899，但净期望 95% 下界为负且没有通过多窗口门槛；禁止据此硬编码只做 RANGE。
- 持仓 4–12h 与 TP 子集表现较好，但二者是事后结果，明确禁止作为入场特征。方向、regime、评分和入场类型中没有任何子集通过预声明的稳定 OOS 门槛。
- Feature Ablation 显示 Volume 相对 OHLC、Funding 相对 OHLCV 都在 3/4 个增量窗口改善，因此 Historical-Compatible Champion 选为 `OHLCV_FUNDING`；但它自身仅 2/4 个窗口盈利，`stableNetEdgeProven=false`。
- 新 holdout 在候选排名前封存为 `UNTOUCHED`：2026-08-01 至 2026-08-23 05:30，共 2,135 个事件。排名时读取 holdout K 线数为 0；使用后永久改为 `USED`。
- 六个简单、非 ML 候选均未证明 development OOS 稳定 edge。相对最好的是成本缓冲候选：298 笔、2/4 盈利窗口、净 PF 0.8845、净期望 -0.4108 CNY、95% 下界为负。
- 新 Final OOS 中 Historical-Compatible Champion 为 21 笔、+53.4667 CNY、PF 2.1382；选中 Challenger 为 5 笔、+51.0295 CNY、PF 4.1706。Challenger 样本不足且净收益低 2.4372 CNY，因此不得晋级。
- 新 Challenger 已使用当前 HTX 同一公开快照启动独立 live Shadow：第一轮为 WAIT、无仓位、权益 1,000 CNY。Promotion 仍为 `BLOCKED`。

## 成熟框架设计原则对照

参考目标不是复制框架代码，而是采用适合当前 Node.js/HTX 项目的稳定原则。

### Freqtrade / FreqAI

- 回测和 dry-run 必须显式计入交易成本，研究特征必须分离训练、测试与实时验证。
- FreqAI 的模型标识、训练区间、过期策略和回测模型复用说明了模型/数据版本必须可追溯。
- 本项目采用：数据 manifest、策略/参数哈希、严格 OOS、Champion/Challenger 隔离。
- 未采用：Freqtrade 的交易所适配器、订单路由、Hyperopt 和真实交易能力。

官方参考：[Freqtrade Backtesting](https://docs.freqtrade.io/en/stable/backtesting/)、[FreqAI Running](https://www.freqtrade.io/en/stable/freqai-running/)。

### Jesse

- 策略按时间顺序处理 K 线，回测报告必须同时看净收益、回撤和风险指标。
- 本项目采用：逐 15m 事件推进、同一 Paper 生命周期、完整成本和 regime 分解。
- 未采用：Jesse 的路由、交易所账户、优化器和 Live Trade 模式。

官方参考：[Jesse Backtest](https://docs.jesse.trade/docs/backtest/)。

### NautilusTrader

- Backtest 与 live 应复用策略、风险和执行组件；事件时间、可见时间和执行延迟必须明确。
- 本项目采用：K 线收盘可见语义、高周期完整收盘边界、下一根开盘成交、可压力测试的延迟、独立账户状态。
- 未采用：Nautilus 的高性能消息总线、原生订单簿重放、多资产组合和真实执行适配器。

官方参考：[NautilusTrader Overview](https://nautilustrader.io/docs/latest/concepts/overview/)、[Backtest execution flow](https://nautilustrader.io/docs/latest/concepts/backtesting/)。

## 原 Gap 状态

状态只按可运行实现判断；Schema、字段、Mock 或文档不计为 IMPLEMENTED。

| 原 Gap | 状态 | 证据与限制 |
|---|---|---|
| BTC Historical Data Catalog / Dataset Manager | IMPLEMENTED | REST 分页与官方 Download Center 分开建模；现货/永续 Kline、trades、150/400 档 depth、mark/index/funding 有真实覆盖、`.CHECKSUM`、本地 SHA、PIT 和 provenance。大档案按需目录化，Settlement REST 不冒充下载中心。 |
| Historical Replay Engine | IMPLEMENTED | 逐 15m 事件推进；每个时点只构建当时可见的市场对象；完整区间实际运行 61,345 个事件。 |
| 15m/1h/4h/1d 防未来泄漏 | IMPLEMENTED | 15m 收盘后可见；1h/4h/1d 只在周期完整收盘后进入策略；prefix invariance audit 实际通过。 |
| Replay 与实时共用策略/风险/仓位/执行核心 | IMPLEMENTED | Champion 调用原 `analyzeSnapshot`；Challenger 和实时 Shadow 调用同一分析函数；两者共用 Paper sizing、Risk Gate、Funding、退出和 position manager。回放编排器不同，但没有回测专用的成交/风险公式。 |
| 手续费、Funding、滑点、执行延迟 | IMPLEMENTED | 开/平仓费用、HTX 时点 Funding、不利滑点、下一根开盘成交；2/3 bar 延迟和成本恶化可重放。 |
| 完整 Backtest Report | IMPLEMENTED | 交易、方向、胜率、PF、Expectancy、回撤、RR、杠杆、保证金、毛收益、成本、净收益、regime、决策和动作统计均由实际账本产生。 |
| OOS | IMPLEMENTED | 测试区间独立逐事件回放，不复用训练结果。 |
| Walk-forward | IMPLEMENTED | 四个扩展训练/前推测试窗口自动运行。 |
| Purging / Embargo | IMPLEMENTED | 7 天最大标签窗口 Purging + 1 天 Embargo；边界对齐 15m。 |
| Look-ahead audit | IMPLEMENTED | 完整数据集输出与仅含当时前缀的数据集输出做哈希不变性比较。 |
| Baseline vs feature 增量贡献 | IMPLEMENTED | baseline 关闭 regime filter，候选只改变该特征；四窗口成本后增量实际计算，结果未通过。 |
| Feature Ablation / Trade / Cost Attribution | IMPLEMENTED | LONG/SHORT、regime、机会评分、持仓时间、入场/退出类型均输出 gross edge、费用、净期望、PF、MFE/MAE；事后变量不可进入候选。 |
| Historical-Compatible Champion | IMPLEMENTED | 逐层比较 OHLC、OHLCV、OHLCV+Funding；只用各历史时点真实可见数据，缺失衍生品/盘口不填补；当前只是 research benchmark，不替换 Live Champion。 |
| Untouched holdout 封存 | IMPLEMENTED | 选择前记录范围与内容哈希；候选排名读取 0 根 holdout K 线；唯一候选使用后状态永久为 USED。 |
| 调用者提交证据即可通过 | IMPLEMENTED（已移除） | `recordFeatureValidation` 和 `recordFeatureShadowValidation` 明确拒绝外部声明值；证据由 Validation Engine 生成。 |
| Historical Similarity Engine | IMPLEMENTED | 真实 15m 数据形成 16,440 行矩阵；regime、距离、时间远近和质量加权；支持 1h/4h/12h/24h/3d/7d 收益、涨跌率、MFE、MAE；不足时返回 insufficient evidence。 |
| 历史 Champion / Challenger 同事件对照 | IMPLEMENTED | 两者事件 timestamp/close 完全一致，使用独立 SQLite、独立资金和成本；Challenger 不影响 Champion。 |
| 实时 Shadow Challenger | IMPLEMENTED | monitor 把同一份公开 market snapshot 交给独立 Challenger，并写入 `SHADOW_DB_PATH`；异常独立降级，重启从该 SQLite 恢复。 |
| Shadow 晋级样本成熟度 | PARTIAL | 新成本缓冲 Challenger 已使用当前 HTX 公开行情真实运行 1 次：WAIT / NO_ENTRY，独立权益 1,000 CNY；尚未积累至少 30 个自然日和 100 个实时信号，Promotion Gate 必须阻塞。 |
| Candidate 生成、实验、淘汰 | IMPLEMENTED | 使用有界小扰动候选，分别运行训练 replay 和 Purged 选择验证，按预先定义的验证评分排序；不直接改 Champion。 |
| 候选选择后严格 Final OOS | IMPLEMENTED | 最后 25% 连续数据不参与候选排名，与选择区间之间另设 Embargo；只有选出的 Challenger 才能读取。 |
| Stress Test | IMPLEMENTED | 成本、滑点、2/3 bar 延迟、连亏顺序和参数 ±5% 均实际执行；结果很差，未把“成功跑完”误写成策略通过。 |
| Promotion Gate | IMPLEMENTED | 必须同时满足自动生成的验证、稳健性和真实 Shadow 样本；无明确证据时 BLOCKED。 |
| 自动 Champion 晋级 | NOT IMPLEMENTED | 有意不实现无人批准自动替换。当前需求和安全设计要求候选先过长期 Shadow，之后仍需明确批准。 |
| 版本、数据和原因追踪 | IMPLEMENTED | Strategy Registry 保存参数、参数/代码/数据哈希、训练/验证区间、性能、状态和原因。 |
| Rollback | IMPLEMENTED | 版本指针只能回到 Registry 中已登记的 Champion；研究候选不能成为隐式回滚目标。 |
| trade-order resampling | IMPLEMENTED | 从真实净交易结果有放回抽样，输出收益/回撤分位数。 |
| block bootstrap | IMPLEMENTED | 以连续交易块重采样，保留部分序列相关性。 |
| 成本/滑点/延迟/连亏/参数扰动 | IMPLEMENTED | 成本、滑点和延迟是重新逐事件回放；连亏与 bootstrap 是账户路径模拟；参数扰动重新运行策略。 |
| 每笔交易自动复盘 | IMPLEMENTED | 分别输出方向、入场、退出、止损、仓位和成本评价。 |
| WAIT 后续追踪与 LONG/SHORT/WAIT/延迟反事实 | IMPLEMENTED | 回放结束后生成 24h 反事实和 MFE/MAE，明确 `eligibleAsDecisionInput=false`，不会回写策略输入。 |
| 200 周均线 | IMPLEMENTED（research-only） | HTX 公开现货 2,000 日线、无缺口；固定 `HTX_SPOT_WEEKLY_CLOSE_UTC_MONDAY_SMA200_V1` 公式。尚未证明 OOS 增益，生产权重为 0。 |
| Rainbow 类长期估值 | BLOCKED | 选定公共来源没有覆盖 BTC 早期历史，无法可靠固定完整公式；未抓网页颜色、未回填历史。 |
| Realized Price / MVRV / 链上 | BLOCKED | 尚无已选定的、无凭证、可复现且 point-in-time 覆盖足够的历史来源。 |
| 期权市场历史 | PARTIAL | 公共当前数据存在，但没有构建时间完整的 IV/skew/term-structure 历史目录，因此不进评分。 |
| 跨交易所 Funding/OI/Basis | PARTIAL | HTX Funding 历史已实现；跨交易所同步历史尚未实现，权重 0。 |
| 跨市场流动性 | BLOCKED | 缺少稳定 instrument mapping 的 point-in-time 历史目录。 |
| 宏观背景 | BLOCKED | 尚未解决 release timestamp 与 vintage/revision 对齐；禁止使用最终修订值回填。 |
| ML / 历史模型训练 | NOT IMPLEMENTED | 有意保持 research-only：当前简单 Challenger 已失败，且没有 OOS 证据表明 ML 相比相似行情/统计 baseline 有稳定增量。没有为了“有 ML”而训练模型。 |

## 本轮实际验收产物

| 产物 | 本机路径 |
|---|---|
| 数据 manifest | `data/research/catalog/htx-btc-usdt-linear-15m-v1/manifest.json` |
| 完整 Champion / Challenger 回放 | `research-output/backtest-2026-08-22T16-55-27-987Z/` |
| 四窗口 OOS / Walk-forward / Look-ahead audit | `research-output/optimization-2026-08-22T16-17-52-814Z/selected/validation/` |
| Strict Final OOS、历史 Shadow、Monte Carlo、压力回放 | `research-output/optimization-2026-08-22T16-17-52-814Z/selected/` |
| Strategy Version Registry | `research-output/optimization-2026-08-22T16-17-52-814Z/strategy-version-registry.json` |
| Historical Similarity 查询 | `research-output/similarity-2026-08-22T16-55-00-971Z/` |
| 自动交易/WAIT 反事实复盘 | `research-output/counterfactual-2026-08-22T16-04-32-159Z/` |
| 外部特征真实来源审计 | `research-output/external-features-2026-08-22T16-12-16-976Z/` |
| Challenger 亏损与交易/成本归因 | `research-output/edge-diagnosis-2026-08-23T05-58-19-993Z/` |
| OHLC/OHLCV/Funding Feature Ablation | `research-output/feature-ablation-2026-08-23T05-59-23-166Z/` |
| 新候选、封存 holdout、Monte Carlo 与 Promotion | `research-output/edge-candidate-pipeline-2026-08-23T06-06-53-328Z/` |
| 持久化 holdout 状态 | `data/research/holdout-registry.json` |
| Tradable Edge 标签、评分校准、频率/成本实验 | `research-output/tradable-edge-2026-08-23T07-09-30-541Z/` |
| 下一段未来 untouched holdout | `data/research/holdout-registry-v2.json` |

这些目录中的 JSON 是运行器产生的证据；不接受调用者手填 `historicalSamples`、`netSharpeDelta`、`walkForwardWindows` 或 `noLookaheadAudit` 来改变 Feature/Promotion 状态。

## 重要模块评审

| 模块 | 结论 | 原因 |
|---|---|---|
| V1.2 动态 LONG/SHORT/WAIT | KEEP | 冻结源码，真实回放不为改善成绩修改。 |
| Risk Gate 与合约仓位数学 | KEEP | 先定止损与净风险，再计算名义仓位、杠杆和保证金；回放复用。 |
| SQLite Paper 生命周期 | KEEP | 原子开平仓、成本、Funding、重启恢复和审计可复用。 |
| 历史执行编排 | IMPROVE | 已支持下一 bar 开盘与压力延迟；仍只有 OHLC 路径，无法重建真实盘口排队和部分成交。 |
| 冻结 Champion 历史可测性 | REPLACE DESIGN（未来版本） | 把不可长期归档的执行层数据设为方向入场硬门槛，导致历史上不可验证。不能修改冻结 V1.2；未来 Champion 应把执行数据与方向数据解耦并自行持续归档。 |
| 自动学习 | REPLACE DESIGN | 不允许“最近亏损 → 自动调参数 → 直接生产”。正确隔离是离线 Candidate、Purged OOS、Stress、未来 Shadow、明确晋级。 |
| ML | NOT APPLICABLE（当前） | 样本/数据覆盖和简单 baseline 尚未达到先引入 ML 的条件。 |
| Tradable Edge 估计与回放 Gate | KEEP（research-only） | 历史和实时共用同一非 ML 毛空间/成本/不确定性分解；逐窗口模型冻结，净优势不达门槛即 WAIT。 |
| 原方向分校准 | REPLACE DESIGN | 方向分对 OOS 净收益的四窗口 Spearman 为 0.9/-0.9/0.9/0.1，不稳定；禁止称为置信度或成功概率。 |
| Opportunity Index | IMPROVE | 已按预计净优势重构并完成 OOS 校准，但四窗口 Spearman 为 0.4/1.0/-0.2/-0.4，仍不稳定，保持 research-only。 |
| 交易频率/成本控制 | REPLACE DESIGN | 原 589 笔成本为毛收益绝对值 494.53%；0.50% 档降至 125 笔仍为负，说明仅靠阈值减频没有解决可捕获利润空间。 |
| 新 Final OOS | PARTIAL | 已注册从 2026-08-23 05:45 UTC 开盘 K 线开始的未来区间；至少需 30 日/2,880 根，当前 0 根，禁止提前读取。 |
| 新 Tradable Edge Challenger | NOT IMPLEMENTED | 五档都未证明稳定正净 edge，因此有意不生成；实时层只是 observe-only 诊断，不是可建仓 Shadow。 |
| 多资产/真实订单适配器 | NOT APPLICABLE | 当前严格单 BTC、Paper-only。 |

## 数据与时间语义

1. 15m K 线在 `open timestamp + 15m` 后才可见。
2. 1h/4h/1d 从 15m 聚合，只有完整周期结束后才进入输入。
3. 策略在收盘事件上生成 LONG/SHORT/WAIT。
4. 默认成交在下一根 15m 开盘，并施加不利滑点和手续费。
5. 持仓随后观察新 bar 的 OHLC，沿用 Paper 的 SL 优先、动态管理、TP 和 Funding 规则。
6. 反事实和未来收益仅在整段 replay 完成后生成，不能加入当时特征。

HTX 没有提供的历史 Order Book/OI/精英仓位/清算/Basis 保持缺失。缺失历史不是 0，更不是当前值。

## 仍存在的技术债务和风险

- 冻结 Champion 的历史交易数为 0，意味着无法仅靠当前公开历史验证其真实交易表现。必须从现在开始持续归档执行层数据，或在未来新 Champion 设计中解除方向与执行层的错误耦合。
- 基础 Challenger 明显亏损，不能作为可晋级策略。它的价值是提供一个真实可失败的 baseline 和完整生命周期，不是生产改进结论。
- OHLC 回放不知道 bar 内先后路径；同 bar 同时触及 SL/TP 时保守按 SL。真实盘口滑点、排队、部分成交未实现。
- Funding 历史可用，但 OI、精英仓位、清算与 Basis 还没有同等历史目录。
- 2026-08-24 的 HTX Integration V2 后续基础设施改造已新增 Catalog/Archive/PIT Replay 接线：OI、精英比率、Mark、Premium、Basis 和最近清算会在官方实际窗口内进入目录，Depth 及超出官方窗口的历史仍明确不可用；详见 `HTX_INTEGRATION_V2.md`。本条上方的旧研究验收结论属于当时数据集证据，不应被解释为后来新增字段已参与或改善了当时策略结果。
- 实时 Shadow 尚未积累足够未来样本；任何现在的晋级都属于数据泄漏式自我证明。
- 200 周均线只有真实数据与固定公式，尚未完成相对无该特征的增量 OOS 验证，不能进入生产权重。
- Monte Carlo 基于已观察交易分布和明确压力情景，不会创造未见过的市场结构；其分位数不是未来概率保证。
- 研究运行对 CPU、磁盘和 SQLite 写入有明显成本；大规模候选应使用任务队列和只读特征缓存，但不能以跳事件降低真实性。

## 明确未采用的成熟框架功能

- 真实交易所订单、API Key、账户、转账、杠杆修改和订单路由。
- 多交易所实盘适配器、撮合网关和投资组合保证金。
- 自动 Hyperopt 后直接上线。
- 未经 OOS 增量证明的 ML、深度学习或在线自学习。
- 逐笔 L2/L3 撮合模拟；当前没有可靠历史 Order Book 数据。
- 多资产、多策略资金分配；当前范围只有 BTC-USDT Paper。

## 完成度声明

`IMPLEMENTED` 表示存在可运行代码，并在真实 HTX 历史数据上产生了实际结果。`PARTIAL` 表示已有真实子集，但缺少关键历史覆盖或必须等待未来 Shadow。`BLOCKED` 表示缺少可靠数据源或时间语义，继续实现会迫使系统伪造。`NOT IMPLEMENTED` 表示明确没有实现，且不会用接口、字段或 Mock 冒充。

安全边界未改变：没有 HTX 私有接口、API Key、真实订单、真实账户、真实杠杆或交易所写操作。
