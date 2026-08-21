# BTC/USDT 永续 V1 Paper Trading

基于 HTX 公开行情的 BTC/USDT 本地模拟交易系统。程序每 5 分钟分析一次，把行情快照、`LONG / SHORT / WAIT`、资金事件和模拟仓位保存到 SQLite。

本项目没有真实交易能力：不读取 API Key、不调用私有接口、不包含交易所写操作。Linux 部署只增加运行、持久化、日志和健康检查，不修改分析或 Risk Gate 逻辑。

## 功能与风控

- 公开数据：15m/1h/4h/1d K 线和成交量、Order Book、Funding、OI、精英多空比、最近清算样本、Mark Price、Premium、Basis。
- 初始模拟资金 `1000 CNY`，固定按 `1 USDT = 7.20 CNY` 换算。
- 单笔风险不超过 `1%`，上海自然日损失达到 `3%` 后暂停新交易。
- 当日连续亏损 3 笔后暂停，次日恢复评估。
- 净 RR 小于 2 禁止交易；同一时间最多一个模拟仓位，名义敞口不超过现金 1 倍。
- 开仓和平仓各模拟 `0.05%` taker 手续费；Funding 按公开费率模拟结算。
- 同一可观察 K 线同时触及 SL/TP 时按 SL；开仓 K 线不用于高低点触发。
- 输出总交易次数、胜率、Profit Factor、Expectancy、最大回撤及累计收益。

## 本机命令

需要 Node.js 24 或更高版本。

```powershell
npm run monitor
npm run status
npm run health
npm run report
npm test
npm run check:safety
```

`npm run health` 只读本地 SQLite，不请求 HTX。最近 monitor 不是 `OK`、15 分钟内没有成功更新、SQLite 不可用或尚无快照时，它会返回非零退出码。

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

生产环境文件只包含：

```text
PAPER_DB_PATH=/var/lib/btc-htx-paper/paper-trading.sqlite
PAPER_HEALTH_MAX_AGE_MS=900000
```

不要向该文件加入 HTX/Huobi API Key、Secret 或任何交易凭据。

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

sudo systemctl start btc-htx-paper-health.service
sudo systemctl status btc-htx-paper-health.service --no-pager
```

health 成功时退出码为 0；不健康时为非零。`systemctl status` 查看进程状态，应用日志位于 `/var/log/btc-htx-paper/monitor.log`，systemd 生命周期日志可用下面命令查看：

```bash
sudo journalctl -u btc-htx-paper.service -u btc-htx-paper-health.service --since today
```

### 8. 持久化与日志轮转

- SQLite 固定存放在 `/var/lib/btc-htx-paper/paper-trading.sqlite`，不在 Git 目录内，更新代码不会覆盖历史记录。
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
- 健康检查仅允许本地 Unix/SQLite 访问，不连接 HTX。

## 不可弱化的安全边界

- 只允许 `futures-market`、`funding-rate`、`oi-tracker`、`elite-positioning`、`liquidation-stream`、`mark-price` 六类公开命令。
- 命令、子命令、参数和值使用白名单，交易对只允许 `BTC-USDT`。
- 子进程环境主动移除 HTX/Huobi 凭据变量。
- V0/V1 的高周期 RSI、衍生品挤压与拥挤度 Risk Gate 保持不变。
- 本地开仓和平仓只修改 SQLite；程序没有交易所写入模块。
- 每次 systemd 启动前自动执行源码安全检查，检查失败时监控不会启动。

## 数据限制

- 清算数据是 HTX 最近公开事件样本，不是全市场清算热力图。
- HTX 公开的是精英交易者比率，不是全体散户比率。
- 没有独立主动买卖量接口，本项目不会伪造该数据。
- Funding 使用监控时可见的当前公开费率模拟，不是历史费率的精确重建。
- 5 分钟轮询不是逐笔成交模拟。

本系统仅供机械规则研究，不构成投资建议。
