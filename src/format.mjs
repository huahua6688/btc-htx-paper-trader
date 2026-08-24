const money = (value) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
  : "—";
const valueOrDash = (value, suffix = "") => value === null || value === undefined ? "—" : `${value}${suffix}`;

export function formatChinese(report) {
  const opportunity = report.opportunities?.[report.candidateDecision];
  const lines = [
    "BTC/USDT 永续动态分析 V1.2（Paper Trading）",
    `时间：${report.generatedAt}`,
    `当前 BTC：${money(report.currentPrice)} USDT`,
    `系统判断：${report.decision}`,
    ...(report.decision === "WAIT" && report.candidateDecision !== "WAIT"
      ? [`当前方向偏好：${report.candidateDecision}，但尚不适合入场`]
      : []),
    `${report.opportunityIndex != null ? "机会指数" : "信号质量分"}：${report.opportunityIndex ?? report.signalQualityScore ?? report.confidencePct}/100（排序指标，不是胜率或成功概率）`,
    `双向机会分：做多 ${report.opportunities?.LONG?.score ?? "—"} / 做空 ${report.opportunities?.SHORT?.score ?? "—"}`,
    `市场状态：${report.strategy?.marketRegime ?? "—"}`,
    "",
    "主要理由",
    ...(report.entryAssessment?.reasons?.slice(0, 5).map((item) => `- ${item}`) ?? ["- 暂无足够证据"]),
    "",
    `是否现在入场：${report.entryAssessment?.enterNow ? "是" : "否"}`,
    `当前选择：${report.entryAssessment?.methodLabel ?? "继续等待"}`
  ];

  if (report.entryAssessment?.enterNow) {
    lines.push(
      `模拟入场价：${money(report.plan.entryPrice)} USDT`,
      `止损：${money(report.plan.stopLoss)} USDT`,
      `止盈：${report.plan.takeProfit?.map(money).join(" / ") ?? "—"} USDT`,
      `净风险收益比：${report.plan.riskReward?.map((value) => `1:${value}`).join(" / ") ?? "—"}`,
      `本次风险比例：${valueOrDash(report.entryAssessment.riskPct * 100, "%")}（实际金额由模拟账户余额计算）`
    );
  } else {
    lines.push(
      "目前缺少的条件：",
      ...(report.entryAssessment?.missingConditions?.map((item) => `- ${item}`) ?? ["- 双向综合优势不足"])
    );
  }

  if (report.riskGates?.length) {
    lines.push("", "数据或账户硬性风控", ...report.riskGates.map((item) => `- ${item}`));
  }
  if (report.strategy?.softWarnings?.length) {
    lines.push("", "风险提示", ...report.strategy.softWarnings.map((item) => `- ${item}`));
  }

  lines.push("", "多周期概览");
  for (const [label, item] of Object.entries(report.timeframes ?? {})) {
    lines.push(`${label}：分数 ${item.score}，RSI ${item.rsi14}，ADX ${item.adx14}，EMA20/50 ${money(item.ema20)}/${money(item.ema50)}，量比 ${item.volumeRatio}`);
  }

  const deriv = report.derivatives;
  lines.push(
    "",
    "衍生品与微观结构",
    `Funding：${valueOrDash(deriv.fundingRatePct, "%")}（历史分位 ${valueOrDash(deriv.fundingPercentile, "%")}）`,
    `OI：${money(deriv.oiUsd)} USD，约 24h ${valueOrDash(deriv.oiDelta24Pct, "%")}`,
    `精英多空比：账户 ${valueOrDash(deriv.eliteAccountRatio)} / 仓位 ${valueOrDash(deriv.elitePositionRatio)}`,
    `Mark / Premium / Basis：${money(deriv.markPrice)} / ${valueOrDash(deriv.premiumPct, "%")} / ${valueOrDash(deriv.basisPct, "%")}`,
    `Order Book：前 20 档不平衡 ${valueOrDash(deriv.orderBook.top20ImbalancePct, "%")}，点差 ${valueOrDash(deriv.orderBook.spreadPct, "%")}`,
    `清算样本：${deriv.liquidations.eventCount} 条，约 ${money(deriv.liquidations.sampleTotalUsd)} USD，多头占 ${valueOrDash(deriv.liquidations.longSharePct, "%")}`,
    `拥挤压力：${valueOrDash(deriv.pressureScore)} / 100（${deriv.pressureLabel}），挤压风险 ${deriv.squeezeRisk}`,
    "",
    `当前${report.candidateDecision === "SHORT" ? "做空" : "做多"}支持因素`,
    ...(opportunity?.supportingReasons?.slice(0, 5).map((item) => `- ${item}`) ?? ["- 暂无明确优势"]),
    "",
    "主要反对因素",
    ...(opportunity?.opposingReasons?.slice(0, 5).map((item) => `- ${item}`) ?? ["- 暂无"]),
    "",
    "数据限制",
    ...(report.dataCoverage?.limitations?.map((item) => `- ${item}`) ?? []),
    "",
    "安全：无 API Key、无私有接口、无真实交易模块；只记录本地模拟交易。",
    report.disclaimer
  );
  return lines.join("\n");
}
