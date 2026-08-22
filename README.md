# BTC/USDT 永续 V1.1 Paper Trading

基于 HTX 公开行情的 BTC/USDT 本地模拟交易系统。程序每 5 分钟分析一次，把行情快照、待触发计划、`LONG / SHORT / WAIT`、资金事件和模拟仓位保存到 SQLite。

本项目没有真实交易能力：不读取 API Key、不调用私有接口、不包含交易所写操作。V1.1 以 `4h 方向 → 1h 结构 → 15m 确认` 取代 V1 的高周期单次打分入场；旧版快照只用于统计，不再控制新入场。

## 功能与风控

- 公开数据：15m/1h/4h/1d K 线和成交量、Order Book、Funding、OI、精英多空比、最近清算样本、Mark Price、Premium、Basis。
- 初始模拟资金 `1000 CNY`，固定按 `1 USDT = 7.20 CNY` 换算。
- 交易计划持久化为 `WATCHING / ARMED / TRIGGERED / INVALIDATED / EXPIRED / BLOCKED / CANCELLED`，重启不会忘记仍有效的观察条件。
- 第一阶段启用趋势回踩和突破延续；4h 决定方向、1h 建立计划、已完成的 15m K 线负责确认。
- 单笔风险不超过 `1%`；高周期 RSI 过热/超卖、一般衍生品拥挤或数据分项不足时降为 `0.5%`，不再由 RSI 单项一票否决。
- 只有极端拥挤、同方向 squeeze 和足够的公开清算样本同时出现，市场 Risk Gate 才硬性禁止新仓。
- 上海自然日损失达到 `3%` 后暂停新交易。
- 当日连续亏损 3 笔后暂停，次日恢复评估。
- 净 RR 小于 2 禁止交易；同一时间最多一个模拟仓位，名义敞口不超过现金 1 倍。
- 开仓和平仓各模拟 `0.05%` taker 手续费；Funding 按公开费率模拟结算。
- 同一可观察 K 线同时触及 SL/TP 时按 SL；开仓 K 线不用于高低点触发。
- 输出总交易次数、胜率、Profit Factor、Expectancy、最大回撤及累计收益。
- Telegram 通知模拟开多/开空、TP/SL、风控暂停、健康失败/恢复和每日绩效；`WAIT` 不通知。

## 本机命令

需要 Node.js 24 或更高版本。

```powershell
npm run monitor
npm run status
npm run health
npm run report
npm run gate:report
npm run telegram:test
npm test
npm run check:safety
```

`npm run health` 只读本地 SQLite，不请求 HTX。最近 monitor 不是 `OK`、15 分钟内没有成功更新、SQLite 不可用或尚无快照时，它会返回非零退出码。

`npm run gate:report` 默认统计最近 24 小时的方向偏好、最终决策、硬拦截、0.5% 风险降级和待触发计划状态。指定时间范围：

```powershell
npm run gate:report -- --hours=168
```

## V1.1 决策流程

```text
公开行情健康
  → 4h 判断 LONG / SHORT 方向
  → 1h 生成趋势回踩或突破延续计划
  → SQLite 保存计划及触发价、失效价、有效期
  → 已完成的 15m K线确认
  → 账户硬风控与净 RR 审核
  → 创建本地模拟仓位
```

日线只提供背景和风险降级，不再直接决定短线入场。`WAIT` 可能代表没有方向，也可能代表已有 `WATCHING/ARMED` 计划；使用 `npm run status` 可查看下一触发价和失效价。计划默认 6 小时到期。

## Telegram 通知

项目使用 Telegram 官方 Bot API 的 HTTPS `sendMessage`。只有以下两个环境变量都存在时才启用：

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Bot Token 只能从环境变量读取，不允许写入源码、README、Git 或命令参数。请在 Telegram 的 `@BotFather` 创建 Bot，先从目标私聊向 Bot 发送 `/start`，再取得对应 Chat ID。Telegram 官方说明 Bot 不能主动开始与用户的对话，Token 应按密码保管：[Bot 教程](https://core.telegram.org/bots/tutorial)、[Bot API](https://core.telegram.org/bots/api)。

Windows 当前终端测试：

```powershell
$env:TELEGRAM_BOT_TOKEN = "从 BotFather 取得的 Token"
$env:TELEGRAM_CHAT_ID = "目标 Chat ID"
npm run telegram:test
```

关闭该 PowerShell 窗口后临时环境变量即消失。不要把真实值写进 `.env.example`。

通知规则：

- 模拟开多、开空、止盈和止损：每个实际 Paper Trading 事件通知一次。
- 风控暂停：同一上海自然日只通知一次。
- health 失败：状态首次变为不健康时通知；恢复后通知一次。
- 每日绩效：上海时间 `23:55` 后的首个 monitor 周期发送一次。
- `WAIT` 本身、普通行情快照和 Funding 结算不通知，避免刷屏。
- 发送超时、HTTP 错误或 Telegram API 拒绝会写入应用日志，不会回滚模拟成交或让 monitor 崩溃。

通知去重状态保存在 SQLite 同目录的 `notification-state/`，VPS 默认位于 `/var/lib/btc-htx-paper/notification-state/`。

## Ubuntu VPS 生产部署

下面以 Ubuntu 22.04/24.04、`x86_64` VPS 为例。HTX `v2.0.0` 当前提供的 Linux 文件是 x64 版本，因此 ARM VPS 不适用于这套固定版本部署。

### 1. 安装系统组件和 Node.js 24

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

确认 Node 输出 `v24` 或更高、架构输出 `x86_64`。NodeSource 当前的 Ubuntu/Node 24 支持和安装脚本见其[官方发行仓库](https://github.com/nodesource/distributions)。

### 2. 创建无登录服务用户并 clone

把 `<YOUR_REPOSITORY_URL>` 换成保存本项目的 Git 地址：

```bash
sudo useradd --system --home-dir /var/lib/btc-htx-paper --shell /usr/sbin/nologin btc-htx
sudo git clone <YOUR_REPOSITORY_URL> /opt/btc-htx-paper
cd /opt/btc-htx-paper
```

如果用户已经存在，`useradd` 提示存在即可，不要重复创建。

### 3. 安装并校验 HTX 官方 Linux CLI

项目不会运行 HTX 的通用安装器，也不会安装账户或交易 Skills。只下载固定的官方公开行情 CLI 二进制，应用自身仍用严格白名单限制可调用命令。

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

Linux 文件名来自 [HTX 官方仓库](https://github.com/htx-exchange/htx-skills-hub)，上面的 SHA-256 固定对应 `v2.0.0`。

### 4. 部署前测试

```bash
cd /opt/btc-htx-paper
sudo -u btc-htx /usr/bin/node --test "test/*.test.mjs"
sudo -u btc-htx /usr/bin/node scripts/check-safety.mjs
```

必须确认全部测试通过且安全检查没有发现账户、交易、订单、杠杆或凭据写入命令。

### 5. 安装 systemd、环境文件和日志轮转

```bash
cd /opt/btc-htx-paper

sudo install -m 0640 -o root -g btc-htx \
  deploy/systemd/btc-htx-paper.env.example \
  /etc/btc-htx-paper.env

sudo install -m 0644 deploy/systemd/btc-htx-paper.service \
  /etc/systemd/system/btc-htx-paper.service
sudo install -m 0644 deploy/systemd/btc-htx-paper-health.service \
  /etc/systemd/system/btc-htx-paper-health.service
sudo install -m 0644 deploy/systemd/btc-htx-paper-health.timer \
  /etc/systemd/system/btc-htx-paper-health.timer
sudo install -m 0644 deploy/logrotate/btc-htx-paper \
  /etc/logrotate.d/btc-htx-paper

sudo systemd-analyze verify \
  /etc/systemd/system/btc-htx-paper.service \
  /etc/systemd/system/btc-htx-paper-health.service \
  /etc/systemd/system/btc-htx-paper-health.timer
sudo logrotate --debug /etc/logrotate.d/btc-htx-paper
```

生产环境文件包含部署路径和 Telegram 配置：

```text
PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite
PAPER_HEALTH_MAX_AGE_MS=900000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

用 `sudoedit /etc/btc-htx-paper.env` 填写 Telegram 两项真实值。该文件权限为 `0640 root:btc-htx`，不会进入 Git。不要加入 HTX/Huobi API Key、Secret 或任何交易凭据。

### 6. 启动并设置开机自启

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now btc-htx-paper.service
sudo systemctl enable --now btc-htx-paper-health.timer

sudo systemctl status btc-htx-paper.service --no-pager
sudo systemctl status btc-htx-paper-health.timer --no-pager
```

主服务启动后立即分析一次，之后保持 5 分钟周期。进程异常退出时 systemd 会在 10 秒后重启；`enable` 使 VPS 重启后自动启动。5 分钟 health timer 只负责暴露异常，不会因短暂行情网络错误反复重启主程序。

### 7. 验证行情、SQLite、status 和 health

等待首次公开行情采集完成：

```bash
sudo tail -n 100 /var/log/btc-htx-paper/monitor.log

cd /opt/btc-htx-paper
sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  /usr/bin/node src/status.mjs

sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  PAPER_HEALTH_MAX_AGE_MS=900000 \
  /usr/bin/node src/health.mjs

sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  /usr/bin/node src/report.mjs

sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  /usr/bin/node src/gate-report.mjs --hours=24

sudo systemctl start btc-htx-paper-health.service
sudo systemctl status btc-htx-paper-health.service --no-pager
```

从 `/etc/btc-htx-paper.env` 安全加载 Telegram 配置并发送测试消息，Token 不会出现在命令行参数中：

```bash
cd /opt/btc-htx-paper
sudo -u btc-htx /bin/bash -c \
  'set -a; . /etc/btc-htx-paper.env; set +a; exec /usr/bin/node src/telegram-test.mjs'
```

health 成功时退出码为 0；不健康时为非零。`systemctl status` 查看进程状态，应用日志位于 `/var/log/btc-htx-paper/monitor.log`，systemd 生命周期日志可用下面命令查看：

```bash
sudo journalctl -u btc-htx-paper.service -u btc-htx-paper-health.service --since today
```

### 8. 持久化与日志轮转

- SQLite 固定存放在 `/var/lib/btc-htx-paper/paper-trading.sqlite`，不在 Git 目录内，更新代码不会覆盖历史记录。
- Telegram 去重状态位于 `/var/lib/btc-htx-paper/notification-state/`，同样随 systemd StateDirectory 持久化。
- systemd 的 `StateDirectory` 自动创建并授权 `/var/lib/btc-htx-paper`。
- 日志位于 `/var/log/btc-htx-paper/monitor.log`。
- logrotate 每日检查，文件达到 10MB 也会提前轮转，保留 14 份并压缩。
- `copytruncate` 让常驻进程无需重新打开日志文件；其机制存在极小的复制/截断竞态窗口，适合本项目低频文本日志。

手动测试轮转配置：

```bash
sudo logrotate --debug /etc/logrotate.d/btc-htx-paper
```

### 9. 优雅重启、停止和 VPS 重启验证

```bash
# systemd 发送 SIGTERM；程序等待当前只读采集结束并关闭 SQLite
sudo systemctl restart btc-htx-paper.service

sudo systemctl stop btc-htx-paper.service
sudo systemctl start btc-htx-paper.service

# 确认已设置开机启动
sudo systemctl is-enabled btc-htx-paper.service
sudo systemctl is-enabled btc-htx-paper-health.timer
```

服务同时处理 SIGTERM 和 SIGINT。systemd 预留 150 秒让当前最多 20 秒超时的并发公开查询安全收尾；超过该时间才会强制停止。

### 10. SQLite 备份

最稳妥的备份方式是短暂停止服务后复制 SQLite 及 WAL 文件：

```bash
sudo systemctl stop btc-htx-paper.service
sudo mkdir -p /var/backups/btc-htx-paper
sudo cp -a /var/lib/btc-htx-paper/paper-trading.sqlite* /var/backups/btc-htx-paper/
sudo systemctl start btc-htx-paper.service
```

确认备份完成后再继续其他维护操作。

### 11. 更新代码

```bash
sudo systemctl stop btc-htx-paper.service
sudo git -C /opt/btc-htx-paper pull --ff-only
sudo chown -R root:btc-htx /opt/btc-htx-paper
sudo chmod -R g+rX,o-rwx /opt/btc-htx-paper

cd /opt/btc-htx-paper
sudo -u btc-htx /usr/bin/node --test "test/*.test.mjs"
sudo -u btc-htx /usr/bin/node scripts/check-safety.mjs

# 首次运行新代码会创建 trade_setups 表；不会删除旧快照和交易
sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  /usr/bin/node src/status.mjs

sudo systemctl start btc-htx-paper.service
sudo systemctl status btc-htx-paper.service --no-pager
```

若 `deploy/systemd` 或 `deploy/logrotate` 有更新，重新执行第 5 步的 `install` 命令并运行 `systemctl daemon-reload`。SQLite 位于 `/var/lib`，不会因 `git pull` 被替换。

## systemd 运行特性

- `Restart=on-failure`：异常退出自动重启，带有速率限制，避免永久配置错误形成无限重启风暴。
- `WantedBy=multi-user.target`：开机自动启动。
- 直接运行 `/usr/bin/node src/monitor.mjs`：信号直接送达 Node，不经过 npm 包装进程。
- `ProtectSystem=strict`、`NoNewPrivileges`、独立非登录用户等限制缩小进程权限。
- 仅 `/var/lib/btc-htx-paper` 和 `/var/log/btc-htx-paper` 可写；项目代码在生产服务中只读。
- 健康检查只读取本地 SQLite；仅在健康状态变化时通过 HTTPS 连接 Telegram，不连接 HTX。

## 不可弱化的安全边界

- 只允许 `futures-market`、`funding-rate`、`oi-tracker`、`elite-positioning`、`liquidation-stream`、`mark-price` 六类公开命令。
- 命令、子命令、参数和值使用白名单，交易对只允许 `BTC-USDT`。
- HTX CLI 子进程环境主动移除 HTX/Huobi 凭据以及 Telegram Token/Chat ID。
- V1.1 将高周期 RSI 和一般拥挤度改为 0.5% 风险降级；极端拥挤与有充分样本的同方向 squeeze 组合仍是硬性市场闸门。
- 单笔 1%、日损失 3%、连亏 3 笔、净 RR ≥ 2、单持仓和名义敞口限制不可弱化。
- 本地开仓和平仓只修改 SQLite；程序没有交易所写入模块。
- Telegram Token 只从进程环境读取；安全检查会拒绝疑似 Bot Token 被提交到源码或部署文件。
- 每次 systemd 启动前自动执行源码安全检查，检查失败时监控不会启动。

## 已部署 VPS 的最少更新步骤

升级前先备份现有 SQLite。V1.1 使用兼容迁移保留旧快照、账户、仓位和绩效记录。

```bash
sudo systemctl stop btc-htx-paper.service
sudo mkdir -p /var/backups/btc-htx-paper
sudo cp -a /var/lib/btc-htx-paper/paper-trading.sqlite* /var/backups/btc-htx-paper/
sudo git -C /opt/btc-htx-paper pull --ff-only

cd /opt/btc-htx-paper
sudo install -m 0644 deploy/systemd/btc-htx-paper.service \
  /etc/systemd/system/btc-htx-paper.service
sudo install -m 0644 deploy/systemd/btc-htx-paper-health.service \
  /etc/systemd/system/btc-htx-paper-health.service

sudoedit /etc/btc-htx-paper.env
sudo systemctl daemon-reload

sudo -u btc-htx /usr/bin/node --test "test/*.test.mjs"
sudo -u btc-htx /usr/bin/node scripts/check-safety.mjs
sudo -u btc-htx /usr/bin/env \
  PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite \
  /usr/bin/node src/status.mjs

sudo -u btc-htx /bin/bash -c \
  'set -a; . /etc/btc-htx-paper.env; set +a; cd /opt/btc-htx-paper; exec /usr/bin/node src/telegram-test.mjs'

sudo systemctl restart btc-htx-paper.service
sudo systemctl restart btc-htx-paper-health.timer
```

如果 Telegram 已经配置，不需要修改 Token 或 Chat ID；不得把 `/etc/btc-htx-paper.env` 上传 Git。启动后运行一次 `gate:report`，即可分别看到旧版拦截记录和 V1.1 新计划状态。

## 数据限制

- 清算数据是 HTX 最近公开事件样本，不是全市场清算热力图。
- HTX 公开的是精英交易者比率，不是全体散户比率。
- 没有独立主动买卖量接口，本项目不会伪造该数据。
- Funding 使用监控时可见的当前公开费率模拟，不是历史费率的精确重建。
- 5 分钟轮询不是逐笔成交模拟。

本系统仅供机械规则研究，不构成投资建议。
