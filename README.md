# BTC/USDT 永续 V1.2 Dynamic Paper Trading

基于 HTX 公开行情的 BTC/USDT 本地合约模拟交易系统。程序启动后立即分析一次，之后每 5 分钟重新读取行情，独立比较 `LONG / SHORT / WAIT`，动态选择入场方式，并持续管理已有模拟净仓位。

本项目没有真实交易能力：不读取 HTX API Key、不调用私有接口、不包含交易所下单模块。所有模拟仓位、手续费、Funding 和绩效只写入本地 SQLite。

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

## 严格保留的风控

- 初始模拟资金 `1000 CNY`，当前 Paper 换算假设为 `1 USDT = 7.20 CNY`。
- 每笔必须有止损和止盈，扣除双边手续费、Funding 和不利滑点后净 RR 必须至少为 2。
- 单笔风险硬上限 `1%`；实际风险随账户权益、用户设置、机会质量、波动、止损距离和已有敞口动态缩放。
- 上海自然日损失达到 `3%` 后暂停新交易。
- 当日连续亏损 3 笔后暂停，次日重新评估。
- 默认关闭加仓且最多一个模拟净仓位；开启后仍必须通过有利进展、新高质量信号、总风险、总保证金和总名义仓位检查。
- 开仓和平仓各模拟 `0.05%` taker 手续费。
- 开仓和平仓各模拟 `0.02%` 不利滑点。
- Funding 在 UTC 00:00/08:00/16:00 附近按当时可获得的公开费率模拟；若程序离线导致历史结算费率缺失，会记录缺口并跳过，绝不拿当前值回填历史。
- 先确定止损和允许亏损，再确定名义仓位，最后反推合理杠杆与保证金；提高杠杆不能提高允许亏损。
- 强平价使用明确标记的 Paper 隔离保证金估算，正常止损必须先于强平缓冲；它不是 HTX 真实强平公式。
- 同一根可观察 K 线同时触及 SL/TP 时保守按 SL；开仓所在 K 线不用于高低点回溯触发。
- 核心价格/K 线不足时禁止开仓和所有价格触发动作；次要衍生品缺失会安全降级且绝不伪造数据。

## Multi-Layer Market Context 与研究门禁

信息被分为 `LONG-TERM / MEDIUM-TERM / SHORT-TERM / EXECUTION` 四层。长期层只允许改变长期背景或风险权重，不能直接触发分钟/小时交易；中期层面向波段方向；短期层面向机会与入场；订单簿等面向执行质量。

Feature Registry 记录每项特征的数据源、时间层、当前权重、适用 market regime、历史覆盖、预测期限、样本外贡献、最近有效性和 `enabled / research-only / disabled` 状态。Rainbow、200 周均线、Realized Price/MVRV、链上、期权、跨所衍生品、流动性和宏观候选当前均为 `research-only`、权重 0、未接入生产评分。

新增特征必须依次通过：严格训练/测试分离、无前视审计、walk-forward、Purging、Embargo、成本后增量贡献、实时 Shadow Paper、时间层作用边界测试和明确 Champion 晋级。历史 OOS 通过不会自动修改当前策略或风险设置。完整架构对照见 [ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)。

## Historical Research Engine

研究模块现在是可运行实现，不是验证字段或 README 占位。冻结的 V1.2 Champion 源码哈希保持为 `9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6`。研究运行不会修改 Champion，也不会改变实时 Risk Gate。

数据目录从 HTX 固定公开端点下载 BTC-USDT 永续 15m K 线与历史 Funding，按请求时间范围分页、校验、缓存和增量合并。`manifest.json` 记录来源、下载时间、覆盖范围、时间戳语义、缺口、重复、缺失率和文件 SHA-256。Order Book、历史 OI、精英持仓、清算与 Basis 如果没有可靠时点历史，会保持 `null`；绝不从 K 线合成。

```bash
# 必须显式给出连续区间；不会自动挑选收益最好看的时期
npm run data:update -- --from=2024-09-01T00:00:00.000Z --to=2026-07-31T23:45:00.000Z
npm run data:inspect

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
npm run report
npm run gate:report
npm run telegram:test
npm test
npm run check:safety
```

- `analyze`：只读公开行情并输出当轮判断，不写交易所。
- `monitor`：立即运行一次，之后每 5 分钟分析、写 SQLite 并管理模拟仓位。
- `status`：第一部分显示实际数据库路径，并显示权益、可用资金、已/未实现盈亏、保证金、名义仓位、有效杠杆、净仓位、当前风险、最近判断和数据源质量。
- `health`：只读 SQLite；超过 15 分钟没有成功 monitor、最近运行失败或数据库不可用时返回非零退出码。
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

管理员控制面板至少包括：当前仓位、当前判断、账户状态、今日表现、风险设置、杠杆上限、加仓设置、暂停/恢复、最近交易、详细分析和研究页面。Token 不写 SQLite、不出现在日志，也不会传给 HTX CLI。所有设置修改记录时间、旧值、新值和来源。

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

### 3. 安装固定版本的 HTX 官方公开行情 CLI

应用只允许白名单内的公开行情命令，不安装或调用交易 Skills。

```bash
sudo curl -fL \
  https://github.com/htx-exchange/htx-skills-hub/releases/download/v2.0.0/htx-cli-linux-x64 \
  -o /opt/btc-htx-paper/vendor/htx-cli-linux-x64

echo "cffbdebd18d22aa6367cb3779a735e3fbfabaaf03f0e559eac833130b5172fe0  /opt/btc-htx-paper/vendor/htx-cli-linux-x64" \
  | sha256sum -c -

sudo chmod 0750 /opt/btc-htx-paper/vendor/htx-cli-linux-x64
sudo chown -R root:btc-htx /opt/btc-htx-paper
sudo chmod -R g+rX,o-rwx /opt/btc-htx-paper
```

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
```

Telegram 测试不会把 Token 放入进程参数：

```bash
sudo -u btc-htx /bin/bash -c 'set -a; . /etc/btc-htx-paper.env; set +a; cd /opt/btc-htx-paper; exec /usr/bin/node src/telegram-test.mjs'
```

systemd 使用 `Restart=on-failure`，程序异常后自动重启；`enable` 保证 VPS 重启后自动启动。程序优雅处理 SIGTERM/SIGINT，并在结束前停止 Telegram polling、等待当前周期并关闭 SQLite。

SQLite 位于 `/var/lib/btc-htx-paper/paper-trading.sqlite`，Telegram 去重状态位于同目录的 `notification-state/`。日志位于 `/var/log/btc-htx-paper/monitor.log`，每日轮转、达到 10MB 提前轮转、压缩并保留 14 份。

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
- 单笔风险不超过 1%、日损失不超过 3%、连亏最多 3 笔、净 RR ≥ 2；用户配置不能越过交易所/Paper 硬上限。
- Telegram Token 只从环境读取；安全扫描拒绝疑似 Token 或交易能力进入项目。
- systemd 每次启动前自动运行安全扫描，扫描失败时 monitor 不启动。
- HTX 公共 `query-elements` 当前可提供 `0.001 BTC` 合约步进和一般展示值，但不能可靠提供账户对应仓位档位的实时最大杠杆/维持保证金；项目使用独立、明确标记的 Paper 20x 安全硬上限与 0.5% 维持保证金估算，绝不声称它们是 HTX 实时限制。用户默认上限 5x，实际值通常更低且动态反推。

本系统仅供机械规则研究，不构成投资建议。
