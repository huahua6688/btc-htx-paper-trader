# BTC/USDT 永续 V1.2 Dynamic Paper Trading

基于 HTX 公开行情的 BTC/USDT 本地模拟交易系统。程序启动后立即分析一次，之后每 5 分钟重新读取行情，独立比较 `LONG / SHORT / WAIT`，并决定当前适合直接入场、等待回落、等待重新走强/走弱，还是等待突破确认。

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

## 严格保留的风控

- 初始模拟资金 `1000 CNY`，固定按 `1 USDT = 7.20 CNY` 换算。
- 每笔必须有止损和止盈，扣除双边手续费及不利 Funding 后净 RR 必须至少为 2。
- 单笔风险最高 `1%`；高风险机会降为 `0.5%`。
- 上海自然日损失达到 `3%` 后暂停新交易。
- 当日连续亏损 3 笔后暂停，次日重新评估。
- 同时最多一个模拟仓位，名义敞口不超过当前现金 1 倍。
- 开仓和平仓各模拟 `0.05%` taker 手续费。
- Funding 按公开费率在 UTC 00:00/08:00/16:00 跨越点模拟结算。
- 同一根可观察 K 线同时触及 SL/TP 时保守按 SL；开仓所在 K 线不用于高低点回溯触发。
- Order Book、Funding、OI、精英多空比、Mark/Basis 或关键 K 线异常时禁止新仓。

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
- `status`：显示资金、最近判断、双向机会分、入场状态和当前模拟仓位。
- `health`：只读 SQLite；超过 15 分钟没有成功 monitor、最近运行失败或数据库不可用时返回非零退出码。
- `report`：输出交易次数、胜率、Profit Factor、Expectancy、最大回撤和累计收益。
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
  → 账户风控 + 净 RR 审核
  → 只在本地 SQLite 创建模拟仓位
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
- 模拟 TP/SL 平仓时通知。
- 风控暂停、健康失败及恢复时通知。
- 上海时间 23:55 后的首轮 monitor 发送一次每日绩效。
- `WAIT`、普通快照和 Funding 结算不通知，避免刷屏。
- Telegram 超时或发送失败只写日志，不会让 monitor 崩溃或回滚模拟事件。

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

systemd 使用 `Restart=on-failure`，程序异常后自动重启；`enable` 保证 VPS 重启后自动启动。程序优雅处理 SIGTERM/SIGINT，并在结束前关闭 SQLite。

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

V1.2 兼容现有 SQLite，不删除旧快照、历史仓位或绩效。遗留活动计划只会被取消，不会被执行。

## 不可弱化的安全边界

- 只允许公开的 futures-market、funding-rate、oi-tracker、elite-positioning、liquidation-stream 和 mark-price 命令。
- 命令、参数和值均使用白名单，交易对只允许 `BTC-USDT`。
- HTX CLI 子进程主动移除 HTX/Huobi 凭据以及 Telegram Token/Chat ID。
- 本地模拟开平仓只修改 SQLite；没有交易所写入模块。
- 单笔 1%、高风险 0.5%、日损失 3%、连亏 3 笔、净 RR ≥ 2 和单持仓限制不可弱化。
- Telegram Token 只从环境读取；安全扫描拒绝疑似 Token 或交易能力进入项目。
- systemd 每次启动前自动运行安全扫描，扫描失败时 monitor 不启动。

本系统仅供机械规则研究，不构成投资建议。
