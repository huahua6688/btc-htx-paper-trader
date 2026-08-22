const money = (value) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "—";
const valueOrDash = (value, suffix = "") => value === null || value === undefined ? "—" : `${value}${suffix}`;

export function formatChinese(report) {
  const lines = [
    "BTC/USDT 永续只读分析 V1.1（Paper Trading）",
    `时间：${report.generatedAt}`,
    `结论：${report.decision}`,
    ...(report.candidateDecision !== report.decision ? [`方向偏好：${report.candidateDecision}（当前处于等待触发或风控状态）`] : []),
    `置信度：${report.confidencePct}%`,
    `综合方向分：${report.finalScore}（技术 ${report.scores.technical} / 衍生品 ${report.scores.derivativesDirectional}）`,
    `当前价：${money(report.currentPrice)} USDT`,
    `市场状态：${report.strategy?.marketRegime ?? "—"} / ${report.strategy?.state ?? "—"} / 风险档位 ${valueOrDash(report.strategy?.riskPct ? report.strategy.riskPct * 100 : null, "%")}`,
    "",
    "交易研究计划（不会下单）",
    `入场区间：${report.plan.entryZone ? `${money(report.plan.entryZone[0])} – ${money(report.plan.entryZone[1])}` : "—（WAIT）"}`,
    `止损：${valueOrDash(report.plan.stopLoss)}`,
    `止盈：${report.plan.takeProfit ? report.plan.takeProfit.map(money).join(" / ") : "—"}`,
    `风险收益比：${report.plan.riskReward ? report.plan.riskReward.map((value) => `1:${value}`).join(" / ") : "—"}`
  ];

  if (report.plan.waitTriggers) {
    const trigger = report.plan.waitTriggers;
    lines.push(
      `待触发计划：${trigger.side} / ${trigger.type}`,
      `观察区：${money(trigger.entryZone[0])} – ${money(trigger.entryZone[1])}`,
      `确认价：${money(trigger.triggerPrice)}；失效价：${money(trigger.invalidationPrice)}`,
      `有效期至：${trigger.expiresAt}`
    );
  }

  if (report.riskGates.length) {
    lines.push("", "硬性风险闸门", ...report.riskGates.map((item) => `- ${item}`));
  }
  if (report.strategy?.softWarnings?.length) {
    lines.push("", "风险降级提示", ...report.strategy.softWarnings.map((item) => `- ${item}`));
  }

  lines.push("", "多周期");
  for (const [label, item] of Object.entries(report.timeframes)) {
    lines.push(`${label}：分数 ${item.score}，RSI ${item.rsi14}，ADX ${item.adx14}，EMA20/50 ${money(item.ema20)}/${money(item.ema50)}，量比 ${item.volumeRatio}`);
  }

  const deriv = report.derivatives;
  lines.push(
    "",
    "衍生品与微观结构",
    `Funding：${deriv.fundingRatePct}%（历史分位 ${valueOrDash(deriv.fundingPercentile, "%")}）`,
    `OI：${money(deriv.oiUsd)} USD，约 24h ${valueOrDash(deriv.oiDelta24Pct, "%")}`,
    `精英多空比：账户 ${valueOrDash(deriv.eliteAccountRatio)} / 仓位 ${valueOrDash(deriv.elitePositionRatio)}`,
    `Mark / Premium / Basis：${money(deriv.markPrice)} / ${valueOrDash(deriv.premiumPct, "%")} / ${valueOrDash(deriv.basisPct, "%")}`,
    `Order Book：前 20 档不平衡 ${valueOrDash(deriv.orderBook.top20ImbalancePct, "%")}，点差 ${valueOrDash(deriv.orderBook.spreadPct, "%")}`,
    `清算样本：${deriv.liquidations.eventCount} 条，约 ${money(deriv.liquidations.sampleTotalUsd)} USD，多头占 ${valueOrDash(deriv.liquidations.longSharePct, "%")}`,
    `衍生品拥挤度：${valueOrDash(deriv.pressureScore)} / 100（${deriv.pressureLabel}），挤压风险 ${deriv.squeezeRisk}`,
    "",
    "看多理由",
    ...(report.bullishReasons.length ? report.bullishReasons.map((item) => `- ${item}`) : ["- 暂无明确看多证据"]),
    "",
    "看空理由",
    ...(report.bearishReasons.length ? report.bearishReasons.map((item) => `- ${item}`) : ["- 暂无明确看空证据"]),
    "",
    "数据限制",
    ...report.dataCoverage.limitations.map((item) => `- ${item}`),
    "",
    "安全：无 API Key、无私有接口、无交易模块、所有交易所写操作关闭。",
    report.disclaimer
  );
  return lines.join("\n");
}
