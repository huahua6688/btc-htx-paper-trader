import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PAPER_CONFIG, RUNTIME_SETTINGS_DEFAULTS } from "./config.mjs";
import { RUNTIME_SETTING_KEYS, validateCompleteRuntimeSettings } from "./runtime-settings.mjs";
import {
  FEATURE_REGISTRY_SEEDS,
  assertLayerEffectAllowed
} from "./feature-registry.mjs";

const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const hydrateSetup = (row) => row ? {
  ...row,
  plan: parseJson(row.plan_json, {}),
  reasons: parseJson(row.reasons_json, []),
  warnings: parseJson(row.warnings_json, [])
} : null;
const hydratePosition = (row) => row ? {
  ...row,
  openingReasons: parseJson(row.opening_reasons_json, []),
  exchangeConstraints: parseJson(row.exchange_constraints_json, {}),
  portfolioAfter: parseJson(row.portfolio_after_json, {}),
  management: parseJson(row.management_json, {})
} : null;

function runtimeFromRow(row) {
  return row ? {
    riskProfile: row.risk_profile,
    riskPerTradePct: Number(row.risk_per_trade_pct),
    maxMarginUsagePct: Number(row.max_margin_usage_pct),
    userMaxLeverage: Number(row.user_max_leverage),
    maxTotalNotionalMultiple: Number(row.max_total_notional_multiple),
    allowPyramiding: Boolean(row.allow_pyramiding),
    maxOpenPositions: Number(row.max_open_positions),
    maxTotalRiskPct: Number(row.max_total_risk_pct),
    maxDailyLossPct: Number(row.max_daily_loss_pct),
    maxConsecutiveLosses: Number(row.max_consecutive_losses),
    newEntriesPaused: Boolean(row.new_entries_paused),
    revision: Number(row.revision ?? 0),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  } : null;
}

function runtimeValues(settings) {
  return [
    settings.riskProfile,
    settings.riskPerTradePct,
    settings.maxMarginUsagePct,
    settings.userMaxLeverage,
    settings.maxTotalNotionalMultiple,
    settings.allowPyramiding ? 1 : 0,
    settings.maxOpenPositions,
    settings.maxTotalRiskPct,
    settings.maxDailyLossPct,
    settings.maxConsecutiveLosses,
    settings.newEntriesPaused ? 1 : 0
  ];
}

export class PaperDatabase {
  constructor(path = PAPER_CONFIG.databasePath, config = PAPER_CONFIG, { readOnly = false } = {}) {
    this.path = path;
    this.pathSource = config.databasePathSource ?? (path === ":memory:" ? "MEMORY" : "EXPLICIT");
    this.config = config;
    this.readOnly = readOnly;
    if (path !== ":memory:" && !readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (!readOnly) {
      if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.initialize();
    }
  }

  ensureColumn(table, name, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initial_capital_cny REAL NOT NULL,
        cash_cny REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('LONG', 'SHORT', 'WAIT')),
        candidate_decision TEXT NOT NULL,
        confidence_pct REAL NOT NULL,
        final_score REAL NOT NULL,
        funding_rate_pct REAL,
        oi_usd REAL,
        pressure_score REAL,
        risk_gates_json TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_captured_at_idx ON snapshots(captured_at);

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_group_id INTEGER,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        entry_bar_ts INTEGER NOT NULL,
        signal_entry_price REAL,
        entry_price REAL NOT NULL,
        initial_stop_loss REAL,
        stop_loss REAL NOT NULL,
        initial_take_profit REAL,
        take_profit REAL NOT NULL,
        rr REAL NOT NULL,
        net_rr REAL,
        quantity_btc REAL NOT NULL,
        risk_cny REAL NOT NULL,
        expected_loss_cny REAL,
        expected_profit_cny REAL,
        risk_pct REAL,
        account_equity_cny REAL,
        leverage REAL,
        margin_cny REAL,
        margin_usage_pct REAL,
        notional_cny REAL NOT NULL,
        stop_distance_pct REAL,
        take_profit_distance_pct REAL,
        opportunity_score REAL,
        fee_estimate_cny REAL,
        funding_estimate_cny REAL,
        slippage_estimate_cny REAL,
        entry_fee_cny REAL NOT NULL,
        exit_fee_cny REAL NOT NULL DEFAULT 0,
        entry_slippage_cny REAL NOT NULL DEFAULT 0,
        exit_slippage_cny REAL NOT NULL DEFAULT 0,
        funding_cny REAL NOT NULL DEFAULT 0,
        liquidation_price_estimate REAL,
        liquidation_distance_pct REAL,
        liquidation_source TEXT,
        exchange_constraints_json TEXT,
        portfolio_after_json TEXT,
        gross_pnl_cny REAL,
        net_pnl_cny REAL,
        exit_price REAL,
        exit_trigger_price REAL,
        exit_reason TEXT,
        opening_reasons_json TEXT NOT NULL,
        last_funding_at TEXT NOT NULL,
        last_management_bar_ts INTEGER,
        opposite_signal_count INTEGER NOT NULL DEFAULT 0,
        management_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS positions_closed_at_idx ON positions(closed_at);

      CREATE TABLE IF NOT EXISTS trade_setups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
        setup_type TEXT NOT NULL CHECK (setup_type IN ('TREND_PULLBACK', 'BREAKOUT_CONTINUATION')),
        status TEXT NOT NULL CHECK (status IN ('WATCHING', 'ARMED', 'TRIGGERED', 'INVALIDATED', 'EXPIRED', 'BLOCKED', 'CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        armed_at TEXT,
        armed_bar_ts INTEGER,
        finished_at TEXT,
        finish_reason TEXT,
        risk_pct REAL NOT NULL,
        plan_json TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_setup_idx
        ON trade_setups((1)) WHERE status IN ('WATCHING', 'ARMED');
      CREATE INDEX IF NOT EXISTS trade_setups_created_at_idx ON trade_setups(created_at);

      CREATE TABLE IF NOT EXISTS account_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        amount_cny REAL NOT NULL,
        balance_after_cny REAL NOT NULL,
        position_id INTEGER REFERENCES positions(id),
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_events_occurred_at_idx ON account_events(occurred_at);

      CREATE TABLE IF NOT EXISTS monitor_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OK', 'ERROR')),
        message TEXT NOT NULL,
        snapshot_id INTEGER REFERENCES snapshots(id)
      );

      CREATE TABLE IF NOT EXISTS runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        risk_profile TEXT NOT NULL,
        risk_per_trade_pct REAL NOT NULL,
        max_margin_usage_pct REAL NOT NULL,
        user_max_leverage REAL NOT NULL,
        max_total_notional_multiple REAL NOT NULL,
        allow_pyramiding INTEGER NOT NULL CHECK (allow_pyramiding IN (0, 1)),
        max_open_positions INTEGER NOT NULL,
        max_total_risk_pct REAL NOT NULL,
        max_daily_loss_pct REAL NOT NULL,
        max_consecutive_losses INTEGER NOT NULL,
        new_entries_paused INTEGER NOT NULL CHECK (new_entries_paused IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_setting_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        changed_at TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        old_value_json TEXT NOT NULL,
        new_value_json TEXT NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_setting_audit_event_key_idx
        ON runtime_setting_audit(source_event_id, setting_key) WHERE source_event_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS telegram_control_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_update_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_registry (
        feature_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        data_source TEXT NOT NULL,
        time_layer TEXT NOT NULL CHECK (time_layer IN ('LONG_TERM', 'MEDIUM_TERM', 'SHORT_TERM', 'EXECUTION')),
        current_weight REAL NOT NULL,
        applicable_regimes_json TEXT NOT NULL,
        historical_coverage_start TEXT,
        historical_coverage_end TEXT,
        prediction_horizon TEXT NOT NULL,
        oos_incremental_contribution REAL,
        recent_validity TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'research-only', 'disabled')),
        evidence_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_validation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL REFERENCES feature_registry(feature_key),
        evaluated_at TEXT NOT NULL,
        validation_stage TEXT NOT NULL DEFAULT 'HISTORICAL_OOS',
        candidate_version TEXT NOT NULL DEFAULT 'unversioned',
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        evidence_json TEXT NOT NULL,
        failure_reasons_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_promotion_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL REFERENCES feature_registry(feature_key),
        promoted_at TEXT NOT NULL,
        candidate_version TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        proposed_weight REAL NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_data_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        source_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        time_layer TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        provider_updated_at TEXT,
        historical_coverage_start TEXT,
        historical_coverage_end TEXT,
        missing INTEGER NOT NULL CHECK (missing IN (0, 1)),
        rolling_missing_rate REAL NOT NULL,
        quality_status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        UNIQUE(snapshot_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS market_data_quality_source_idx ON market_data_quality(source_key, id);
    `);

    const migrations = [
      ["signal_entry_price", "REAL"], ["initial_stop_loss", "REAL"], ["initial_take_profit", "REAL"],
      ["net_rr", "REAL"], ["expected_loss_cny", "REAL"], ["expected_profit_cny", "REAL"],
      ["risk_pct", "REAL"], ["account_equity_cny", "REAL"], ["leverage", "REAL"], ["margin_cny", "REAL"],
      ["margin_usage_pct", "REAL"], ["stop_distance_pct", "REAL"], ["take_profit_distance_pct", "REAL"],
      ["opportunity_score", "REAL"], ["fee_estimate_cny", "REAL"], ["funding_estimate_cny", "REAL"],
      ["slippage_estimate_cny", "REAL"], ["entry_slippage_cny", "REAL NOT NULL DEFAULT 0"],
      ["exit_slippage_cny", "REAL NOT NULL DEFAULT 0"], ["liquidation_price_estimate", "REAL"],
      ["liquidation_distance_pct", "REAL"], ["liquidation_source", "TEXT"],
      ["exchange_constraints_json", "TEXT"], ["portfolio_after_json", "TEXT"],
      ["exit_trigger_price", "REAL"], ["last_management_bar_ts", "INTEGER"],
      ["opposite_signal_count", "INTEGER NOT NULL DEFAULT 0"], ["management_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["position_group_id", "INTEGER"]
    ];
    for (const [name, definition] of migrations) this.ensureColumn("positions", name, definition);
    this.ensureColumn("feature_validation_runs", "validation_stage", "TEXT NOT NULL DEFAULT 'HISTORICAL_OOS'");
    this.ensureColumn("feature_validation_runs", "candidate_version", "TEXT NOT NULL DEFAULT 'unversioned'");
    this.ensureColumn("runtime_settings", "revision", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("DROP INDEX IF EXISTS one_open_position_idx;");
    this.db.exec("DROP INDEX IF EXISTS one_entry_per_side_bar_idx;");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_entry_per_side_bar_idx ON positions(side, entry_bar_ts) WHERE status = 'OPEN';");

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO account_state(id, initial_capital_cny, cash_cny, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(this.config.initialCapitalCny, this.config.initialCapitalCny, now);
    this.db.prepare(`
      INSERT INTO runtime_settings(
        id, risk_profile, risk_per_trade_pct, max_margin_usage_pct, user_max_leverage,
        max_total_notional_multiple, allow_pyramiding, max_open_positions, max_total_risk_pct,
        max_daily_loss_pct, max_consecutive_losses, new_entries_paused, updated_at, updated_by
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FIRST_START_DEFAULTS')
      ON CONFLICT(id) DO NOTHING
    `).run(...runtimeValues(RUNTIME_SETTINGS_DEFAULTS), now);
    this.db.prepare(`
      INSERT INTO telegram_control_state(id, last_update_id, updated_at)
      VALUES (1, 0, ?) ON CONFLICT(id) DO NOTHING
    `).run(now);
    const insertFeature = this.db.prepare(`
      INSERT INTO feature_registry(
        feature_key, display_name, data_source, time_layer, current_weight,
        applicable_regimes_json, historical_coverage_start, historical_coverage_end,
        prediction_horizon, oos_incremental_contribution, recent_validity, status,
        evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_key) DO NOTHING
    `);
    for (const feature of FEATURE_REGISTRY_SEEDS) {
      insertFeature.run(
        feature.key, feature.name, feature.source, feature.layer, feature.currentWeight,
        json(feature.applicableRegimes), feature.historicalCoverageStart, feature.historicalCoverageEnd,
        feature.predictionHorizon, feature.oosIncrementalContribution, feature.recentValidity,
        feature.status, json(feature.evidence), now
      );
    }
  }

  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }

  getAccount() { return this.db.prepare("SELECT * FROM account_state WHERE id = 1").get(); }

  getRuntimeSettings() {
    return runtimeFromRow(this.db.prepare("SELECT * FROM runtime_settings WHERE id = 1").get());
  }

  updateRuntimeSettings(patch, {
    source = "LOCAL_ADMIN",
    sourceEventId = null,
    updatedAt = new Date().toISOString()
  } = {}) {
    return this.transaction(() => {
      if (sourceEventId) {
        const duplicate = this.db.prepare("SELECT 1 FROM runtime_setting_audit WHERE source_event_id = ? LIMIT 1").get(String(sourceEventId));
        if (duplicate) return { settings: this.getRuntimeSettings(), changed: [], duplicate: true };
      }
      const current = this.getRuntimeSettings();
      const currentValues = Object.fromEntries(RUNTIME_SETTING_KEYS.map((key) => [key, current[key]]));
      const next = validateCompleteRuntimeSettings({ ...currentValues, ...patch });
      const changed = RUNTIME_SETTING_KEYS.filter((key) => current[key] !== next[key]);
      this.db.prepare(`
        UPDATE runtime_settings SET
          risk_profile = ?, risk_per_trade_pct = ?, max_margin_usage_pct = ?, user_max_leverage = ?,
          max_total_notional_multiple = ?, allow_pyramiding = ?, max_open_positions = ?, max_total_risk_pct = ?,
          max_daily_loss_pct = ?, max_consecutive_losses = ?, new_entries_paused = ?,
          revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = 1
      `).run(...runtimeValues(next), updatedAt, source);
      const insertAudit = this.db.prepare(`
        INSERT INTO runtime_setting_audit(
          changed_at, setting_key, old_value_json, new_value_json, source, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const key of changed) {
        insertAudit.run(updatedAt, key, json(current[key]), json(next[key]), source, sourceEventId === null ? null : String(sourceEventId));
      }
      return { settings: this.getRuntimeSettings(), changed, duplicate: false };
    });
  }

  getRuntimeSettingAudit({ limit = 100 } = {}) {
    return this.db.prepare("SELECT * FROM runtime_setting_audit ORDER BY id DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, oldValue: parseJson(row.old_value_json), newValue: parseJson(row.new_value_json) }));
  }

  getTelegramUpdateOffset() {
    return Number(this.db.prepare("SELECT last_update_id FROM telegram_control_state WHERE id = 1").get()?.last_update_id ?? 0) + 1;
  }

  markTelegramUpdateProcessed(updateId, updatedAt = new Date().toISOString()) {
    this.db.prepare(`
      UPDATE telegram_control_state
      SET last_update_id = MAX(last_update_id, ?), updated_at = ?
      WHERE id = 1
    `).run(Number(updateId), updatedAt);
  }

  getFeatureRegistry({ status = null } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM feature_registry WHERE status = ? ORDER BY time_layer, feature_key").all(status)
      : this.db.prepare("SELECT * FROM feature_registry ORDER BY time_layer, feature_key").all();
    return rows.map((row) => ({
      ...row,
      applicableRegimes: parseJson(row.applicable_regimes_json, []),
      evidence: parseJson(row.evidence_json, {})
    }));
  }

  getFeature(featureKey) {
    const row = this.db.prepare("SELECT * FROM feature_registry WHERE feature_key = ?").get(featureKey);
    return row ? {
      ...row,
      applicableRegimes: parseJson(row.applicable_regimes_json, []),
      evidence: parseJson(row.evidence_json, {})
    } : null;
  }

  applyResearchFeatureAudit(features, updatedAt = new Date().toISOString()) {
    return this.transaction(() => {
      const updated = [];
      for (const item of features) {
        const feature = this.getFeature(item.key);
        if (!feature) continue;
        if (feature.status === "enabled" && Number(feature.current_weight) > 0) {
          throw new Error(`禁止用研究数据审计覆盖生产特征 ${item.key}`);
        }
        this.db.prepare(`
          UPDATE feature_registry SET data_source = ?, current_weight = 0,
            historical_coverage_start = ?, historical_coverage_end = ?,
            recent_validity = ?, status = 'research-only', evidence_json = ?, updated_at = ?
          WHERE feature_key = ?
        `).run(
          item.source ?? "UNAVAILABLE", item.historicalCoverageStart ?? null,
          item.historicalCoverageEnd ?? null,
          item.status === "unavailable" ? "UNAVAILABLE_RELIABLE_SOURCE" : item.dataQuality,
          json({
            sourceAuditGeneratedAt: item.updatedAt,
            observations: item.observations,
            missingRate: item.missingRate,
            dataQuality: item.dataQuality,
            reason: item.reason,
            value: item.value ?? null,
            productionWeight: 0,
            productionEnabled: false
          }),
          updatedAt, item.key
        );
        updated.push(this.getFeature(item.key));
      }
      return updated;
    });
  }

  recordFeatureValidation(featureKey, evidence, evaluatedAt = new Date().toISOString()) {
    void featureKey; void evidence; void evaluatedAt;
    throw new Error("recordFeatureValidation 已废弃：验证证据必须由 ValidationEngine 实际运行并生成不可变实验产物，禁止调用者提交声明值");
  }

  recordFeatureShadowValidation(featureKey, evidence, evaluatedAt = new Date().toISOString()) {
    void featureKey; void evidence; void evaluatedAt;
    throw new Error("recordFeatureShadowValidation 已废弃：Shadow 证据必须来自独立 Shadow SQLite 的实际运行统计，禁止调用者提交声明值");
  }

  promoteFeatureToChampion(featureKey, {
    candidateVersion,
    proposedWeight,
    productionEffect,
    productionAdapterTested,
    layerContractTested,
    approvedBy,
    promotedAt = new Date().toISOString()
  }) {
    return this.transaction(() => {
      const feature = this.getFeature(featureKey);
      if (!feature) throw new Error(`Feature Registry 中不存在 ${featureKey}`);
      if (!approvedBy?.trim()) throw new Error("Champion 晋级必须有明确 approvedBy，禁止自动晋级");
      if (!(Number(proposedWeight) > 0)) throw new Error("Champion 权重必须为正数");
      if (productionAdapterTested !== true || layerContractTested !== true) throw new Error("生产适配器和时间层作用边界必须通过测试");
      assertLayerEffectAllowed(feature.time_layer, productionEffect);
      for (const stage of ["HISTORICAL_OOS", "SHADOW_PAPER"]) {
        const passed = this.db.prepare(`
          SELECT 1 FROM feature_validation_runs
          WHERE feature_key = ? AND validation_stage = ? AND candidate_version = ? AND passed = 1 LIMIT 1
        `).get(featureKey, stage, candidateVersion);
        if (!passed) throw new Error(`候选版本缺少已通过的 ${stage} 证据`);
      }
      const evidence = { candidateVersion, productionEffect, productionAdapterTested, layerContractTested };
      this.db.prepare(`
        UPDATE feature_registry SET status = 'enabled', current_weight = ?,
          recent_validity = 'CHAMPION_EXPLICITLY_APPROVED', evidence_json = ?, updated_at = ?
        WHERE feature_key = ?
      `).run(Number(proposedWeight), json(evidence), promotedAt, featureKey);
      this.db.prepare(`
        INSERT INTO feature_promotion_audit(
          feature_key, promoted_at, candidate_version, old_status, new_status,
          approved_by, proposed_weight, evidence_json
        ) VALUES (?, ?, ?, ?, 'enabled', ?, ?, ?)
      `).run(featureKey, promotedAt, candidateVersion, feature.status, approvedBy.trim(), Number(proposedWeight), json(evidence));
      return this.getFeature(featureKey);
    });
  }

  getFeatureValidationRuns(featureKey) {
    return this.db.prepare("SELECT * FROM feature_validation_runs WHERE feature_key = ? ORDER BY id").all(featureKey)
      .map((row) => ({ ...row, evidence: parseJson(row.evidence_json, {}), failureReasons: parseJson(row.failure_reasons_json, []) }));
  }

  getFeaturePromotionAudit(featureKey) {
    return this.db.prepare("SELECT * FROM feature_promotion_audit WHERE feature_key = ? ORDER BY id").all(featureKey)
      .map((row) => ({ ...row, evidence: parseJson(row.evidence_json, {}) }));
  }

  getDataSourceStats(sourceKey) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(missing), 0) AS missing,
        MIN(historical_coverage_start) AS coverage_start,
        MAX(historical_coverage_end) AS coverage_end,
        MAX(collected_at) AS last_collected_at
      FROM market_data_quality WHERE source_key = ?
    `).get(sourceKey);
    const total = Number(row.total);
    const missing = Number(row.missing);
    return {
      total,
      missing,
      missingRate: total ? missing / total : null,
      coverageStart: row.coverage_start,
      coverageEnd: row.coverage_end,
      lastCollectedAt: row.last_collected_at
    };
  }

  recordDataSourceObservations(snapshotId, observations) {
    return this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO market_data_quality(
          snapshot_id, source_key, provider, time_layer, collected_at, provider_updated_at,
          historical_coverage_start, historical_coverage_end, missing, rolling_missing_rate,
          quality_status, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_id, source_key) DO NOTHING
      `);
      for (const item of observations) {
        insert.run(
          snapshotId, item.sourceKey, item.provider, item.layer, item.collectedAt,
          item.providerUpdatedAt ?? null, item.historicalCoverageStart ?? null,
          item.historicalCoverageEnd ?? null, item.missing ? 1 : 0,
          item.rollingMissingRate, item.qualityStatus, json(item.details ?? {})
        );
      }
      return observations.length;
    });
  }

  getLatestDataSourceQuality() {
    return this.db.prepare(`
      SELECT q.* FROM market_data_quality q
      JOIN (SELECT source_key, MAX(id) AS max_id FROM market_data_quality GROUP BY source_key) latest
        ON latest.max_id = q.id
      ORDER BY q.source_key
    `).all().map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
  }

  insertSnapshot(report) {
    const result = this.db.prepare(`
      INSERT INTO snapshots(
        captured_at, symbol, price, decision, candidate_decision, confidence_pct,
        final_score, funding_rate_pct, oi_usd, pressure_score, risk_gates_json, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.generatedAt, report.symbol, report.currentPrice, report.decision, report.candidateDecision,
      report.confidencePct, report.finalScore, report.derivatives?.fundingRatePct,
      report.derivatives?.oiUsd, report.derivatives?.pressureScore, json(report.riskGates), json(report)
    );
    return Number(result.lastInsertRowid);
  }

  getLatestSnapshot() {
    const row = this.db.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row, riskGates: parseJson(row.risk_gates_json, []), report: parseJson(row.report_json) } : null;
  }
  countSnapshots() { return Number(this.db.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count); }
  getSnapshots({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM snapshots WHERE captured_at >= ? ORDER BY id").all(since)
      : this.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
    return rows.map((row) => ({ ...row, riskGates: parseJson(row.risk_gates_json, []), report: parseJson(row.report_json, {}) }));
  }

  createSetup(proposal, snapshotId) {
    return this.transaction(() => {
      if (this.getActiveSetup()) throw new Error("Paper setup already active");
      const status = proposal.armImmediately ? "ARMED" : "WATCHING";
      const result = this.db.prepare(`
        INSERT INTO trade_setups(
          snapshot_id, symbol, side, setup_type, status, created_at, updated_at,
          expires_at, armed_at, armed_bar_ts, risk_pct, plan_json, reasons_json, warnings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId, this.config.symbol, proposal.side, proposal.type, status, proposal.createdAt, proposal.createdAt,
        proposal.expiresAt, proposal.armImmediately ? proposal.createdAt : null,
        proposal.armImmediately ? proposal.basisBarTs : null, proposal.riskPct,
        json(proposal), json(proposal.reasons), json(proposal.warnings)
      );
      return this.getSetup(Number(result.lastInsertRowid));
    });
  }
  getSetup(id) { return hydrateSetup(this.db.prepare("SELECT * FROM trade_setups WHERE id = ?").get(id)); }
  getActiveSetup() {
    return hydrateSetup(this.db.prepare("SELECT * FROM trade_setups WHERE status IN ('WATCHING', 'ARMED') ORDER BY id DESC LIMIT 1").get());
  }
  armSetup(id, armedAt, armedBarTs) {
    this.db.prepare("UPDATE trade_setups SET status = 'ARMED', armed_at = ?, armed_bar_ts = ?, updated_at = ? WHERE id = ? AND status = 'WATCHING'")
      .run(armedAt, armedBarTs, armedAt, id);
    return this.getSetup(id);
  }
  finishSetup(id, status, finishedAt, reason) {
    const allowed = new Set(["TRIGGERED", "INVALIDATED", "EXPIRED", "BLOCKED", "CANCELLED"]);
    if (!allowed.has(status)) throw new Error(`Invalid terminal setup status: ${status}`);
    this.db.prepare(`
      UPDATE trade_setups SET status = ?, finished_at = ?, finish_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('WATCHING', 'ARMED')
    `).run(status, finishedAt, reason, finishedAt, id);
    return this.getSetup(id);
  }
  getSetups({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM trade_setups WHERE created_at >= ? ORDER BY id").all(since)
      : this.db.prepare("SELECT * FROM trade_setups ORDER BY id").all();
    return rows.map(hydrateSetup);
  }

  getOpenPositions() {
    return this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id").all().map(hydratePosition);
  }
  getOpenPosition() { return this.getOpenPositions()[0] ?? null; }
  getPosition(id) { return hydratePosition(this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id)); }

  openPosition(candidate, snapshotId, { settingsUpdatedAt = null, settingsRevision = null } = {}) {
    return this.transaction(() => {
      const settings = this.getRuntimeSettings();
      if (settingsRevision !== null && settings.revision !== Number(settingsRevision)) throw new Error("运行时设置版本已变化，请下一轮重新计算仓位");
      if (settingsUpdatedAt && settings.updatedAt !== settingsUpdatedAt) throw new Error("运行时设置已变化，请下一轮重新计算仓位");
      const open = this.getOpenPositions();
      if (open.length && !settings.allowPyramiding) throw new Error("已有模拟仓位且加仓已关闭");
      if (open.length >= settings.maxOpenPositions) throw new Error("已达到最大同时仓位数");
      if (open.some((position) => position.side !== candidate.side)) throw new Error("不允许同时持有 BTC 相反方向模拟仓位");
      if (candidate.portfolioAfter) {
        const equity = Number(candidate.accountEquityCny);
        if (candidate.portfolioAfter.totalRiskCny > equity * settings.maxTotalRiskPct + 0.01) throw new Error("加仓后总风险超过上限");
        if (candidate.portfolioAfter.totalMarginCny > equity * settings.maxMarginUsagePct + 0.01) throw new Error("加仓后保证金超过上限");
        if (candidate.portfolioAfter.totalNotionalCny > equity * settings.maxTotalNotionalMultiple + 0.01) throw new Error("加仓后总名义仓位超过上限");
      }
      const entryCost = numberOr(candidate.entryFeeCny) + numberOr(candidate.entrySlippageCny);
      const account = this.getAccount();
      const newBalance = Number(account.cash_cny) - entryCost;
      const existingGroupId = open[0]?.position_group_id ?? open[0]?.id ?? null;
      const result = this.db.prepare(`
        INSERT INTO positions(
          position_group_id, snapshot_id, symbol, side, status, opened_at, entry_bar_ts, signal_entry_price, entry_price,
          initial_stop_loss, stop_loss, initial_take_profit, take_profit, rr, net_rr, quantity_btc,
          risk_cny, expected_loss_cny, expected_profit_cny, risk_pct, account_equity_cny,
          leverage, margin_cny, margin_usage_pct, notional_cny, stop_distance_pct,
          take_profit_distance_pct, opportunity_score, fee_estimate_cny, funding_estimate_cny,
          slippage_estimate_cny, entry_fee_cny, entry_slippage_cny, liquidation_price_estimate,
          liquidation_distance_pct, liquidation_source, exchange_constraints_json, portfolio_after_json,
          opening_reasons_json, last_funding_at, last_management_bar_ts, management_json
        ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        existingGroupId, snapshotId, candidate.symbol, candidate.side, candidate.openedAt, candidate.entryBarTs,
        candidate.signalEntryPrice ?? candidate.entry, candidate.entry,
        candidate.stopLoss, candidate.stopLoss, candidate.takeProfit, candidate.takeProfit,
        candidate.netRr ?? candidate.rr, candidate.netRr ?? candidate.rr, candidate.quantityBtc,
        candidate.expectedLossCny ?? candidate.riskCny, candidate.expectedLossCny ?? candidate.riskCny,
        candidate.expectedProfitCny ?? null, candidate.riskPct ?? null, candidate.accountEquityCny ?? Number(account.cash_cny),
        candidate.leverage ?? 1, candidate.marginCny ?? candidate.notionalCny,
        candidate.marginUsagePct ?? null, candidate.notionalCny, candidate.stopDistancePct ?? null,
        candidate.takeProfitDistancePct ?? null, candidate.opportunityScore ?? null,
        candidate.feeEstimateCny ?? candidate.entryFeeCny, candidate.fundingEstimateCny ?? 0,
        candidate.slippageEstimateCny ?? 0, candidate.entryFeeCny, candidate.entrySlippageCny ?? 0,
        candidate.liquidationPriceEstimate ?? null, candidate.liquidationDistancePct ?? null,
        candidate.liquidationSource ?? "UNAVAILABLE", json(candidate.exchangeConstraints ?? {}),
        json(candidate.portfolioAfter ?? {}), json(candidate.openingReasons), candidate.openedAt,
        candidate.entryBarTs, json({ events: [] })
      );
      const positionId = Number(result.lastInsertRowid);
      const groupId = existingGroupId ?? positionId;
      this.db.prepare("UPDATE positions SET position_group_id = ? WHERE id = ?").run(groupId, positionId);
      if (open.length && candidate.portfolioAfter) {
        const groupEvent = {
          type: "PORTFOLIO_REBASED",
          at: candidate.openedAt,
          reason: "受控加仓后按净仓位重新计算平均成本、整体止损、整体止盈和账户风险暴露",
          portfolioAfter: candidate.portfolioAfter
        };
        for (const leg of [...open, this.getPosition(positionId)]) {
          const events = [...(leg.management?.events ?? []), groupEvent].slice(-100);
          this.db.prepare(`
            UPDATE positions SET position_group_id = ?, stop_loss = ?, take_profit = ?,
              liquidation_price_estimate = ?, liquidation_distance_pct = ?, liquidation_source = ?,
              portfolio_after_json = ?, management_json = ? WHERE id = ? AND status = 'OPEN'
          `).run(
            groupId, candidate.portfolioAfter.overallStopLoss, candidate.portfolioAfter.overallTakeProfit,
            candidate.portfolioAfter.liquidationPriceEstimate, candidate.portfolioAfter.liquidationDistancePct,
            candidate.portfolioAfter.liquidationSource,
            json(candidate.portfolioAfter), json({ events }), leg.id
          );
        }
      }
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1").run(newBalance, candidate.openedAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'ENTRY_COST', ?, ?, ?, ?)
      `).run(candidate.openedAt, -entryCost, newBalance, positionId, json({
        entryFeeCny: numberOr(candidate.entryFeeCny),
        entrySlippageCny: numberOr(candidate.entrySlippageCny),
        feeRate: this.config.feeRatePerSide,
        slippageRate: this.config.slippageRate
      }));
      return this.getPosition(positionId);
    });
  }

  updatePositionManagement(positionId, {
    stopLoss,
    takeProfit,
    lastManagementBarTs,
    oppositeSignalCount,
    event
  }) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Paper position is not open");
      const management = position.management ?? { events: [] };
      const events = [...(management.events ?? []), ...(event ? [event] : [])].slice(-100);
      this.db.prepare(`
        UPDATE positions SET stop_loss = ?, take_profit = ?, last_management_bar_ts = ?,
          opposite_signal_count = ?, management_json = ? WHERE id = ? AND status = 'OPEN'
      `).run(
        stopLoss ?? position.stop_loss,
        takeProfit ?? position.take_profit,
        lastManagementBarTs ?? position.last_management_bar_ts,
        oppositeSignalCount ?? position.opposite_signal_count,
        json({ events }),
        positionId
      );
      return this.getPosition(positionId);
    });
  }

  updatePositionGroupManagement(positionGroupId, managementUpdate) {
    return this.transaction(() => {
      const positions = this.db.prepare(`
        SELECT * FROM positions WHERE position_group_id = ? AND status = 'OPEN' ORDER BY id
      `).all(positionGroupId).map(hydratePosition);
      if (!positions.length) throw new Error("Paper position group is not open");
      for (const position of positions) {
        const events = [...(position.management?.events ?? []), ...(managementUpdate.event ? [managementUpdate.event] : [])].slice(-100);
        this.db.prepare(`
          UPDATE positions SET stop_loss = ?, take_profit = ?, last_management_bar_ts = ?,
            opposite_signal_count = ?, management_json = ? WHERE id = ? AND status = 'OPEN'
        `).run(
          managementUpdate.stopLoss ?? position.stop_loss,
          managementUpdate.takeProfit ?? position.take_profit,
          managementUpdate.lastManagementBarTs ?? position.last_management_bar_ts,
          managementUpdate.oppositeSignalCount ?? position.opposite_signal_count,
          json({ events }), position.id
        );
      }
      return this.db.prepare(`
        SELECT * FROM positions WHERE position_group_id = ? AND status = 'OPEN' ORDER BY id
      `).all(positionGroupId).map(hydratePosition);
    });
  }

  applyFunding(positionId, cashflowCny, settledAt, details) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Cannot fund a closed paper position");
      const account = this.getAccount();
      const newBalance = Number(account.cash_cny) + cashflowCny;
      this.db.prepare("UPDATE positions SET funding_cny = funding_cny + ?, last_funding_at = ? WHERE id = ? AND status = 'OPEN'")
        .run(cashflowCny, settledAt, positionId);
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1").run(newBalance, settledAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'FUNDING', ?, ?, ?, ?)
      `).run(settledAt, cashflowCny, newBalance, positionId, json(details));
      return this.getPosition(positionId);
    });
  }

  recordFundingGap(positionId, skippedBoundaries, cursorAt) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Cannot advance funding cursor for a closed paper position");
      this.db.prepare("UPDATE positions SET last_funding_at = ? WHERE id = ? AND status = 'OPEN'").run(cursorAt, positionId);
      const account = this.getAccount();
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'FUNDING_DATA_GAP', 0, ?, ?, ?)
      `).run(cursorAt, Number(account.cash_cny), positionId, json({
        skippedBoundaries,
        reason: "缺少各历史结算点对应的公开 Funding，禁止用当前费率回填历史"
      }));
      return this.getPosition(positionId);
    });
  }

  closePosition(positionId, exit) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Paper position is not open");
      const entryFee = Number(position.entry_fee_cny);
      const entrySlippage = Number(position.entry_slippage_cny ?? 0);
      const exitSlippage = Number(exit.exitSlippageCny ?? 0);
      const entryFeeAdjustment = Number(exit.entryFeeAdjustmentCny ?? 0);
      const netPnl = exit.grossPnlCny + Number(position.funding_cny)
        - entryFee - entryFeeAdjustment - exit.exitFeeCny - entrySlippage - exitSlippage;
      const account = this.getAccount();
      const cashDelta = exit.grossPnlCny - exit.exitFeeCny - exitSlippage - entryFeeAdjustment;
      const newBalance = Number(account.cash_cny) + cashDelta;
      this.db.prepare(`
        UPDATE positions SET status = 'CLOSED', closed_at = ?, exit_price = ?, exit_trigger_price = ?,
          exit_reason = ?, exit_fee_cny = ?, exit_slippage_cny = ?, gross_pnl_cny = ?, net_pnl_cny = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(
        exit.closedAt, exit.exitPrice, exit.exitTriggerPrice ?? exit.exitPrice, exit.exitReason,
        exit.exitFeeCny, exitSlippage, exit.grossPnlCny, netPnl, positionId
      );
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1").run(newBalance, exit.closedAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'CLOSE', ?, ?, ?, ?)
      `).run(exit.closedAt, cashDelta, newBalance, positionId, json({
        exitPrice: exit.exitPrice,
        exitTriggerPrice: exit.exitTriggerPrice ?? exit.exitPrice,
        exitReason: exit.exitReason,
        grossPnlCny: exit.grossPnlCny,
        entryFeeCny: entryFee,
        exitFeeCny: exit.exitFeeCny,
        entrySlippageCny: entrySlippage,
        exitSlippageCny: exitSlippage,
        fundingCny: Number(position.funding_cny),
        netPnlCny: netPnl,
        managementReason: exit.managementReason ?? null
      }));
      return this.getPosition(positionId);
    });
  }

  getClosedPositions({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED' AND closed_at >= ? ORDER BY closed_at, id").all(since)
      : this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED' ORDER BY closed_at, id").all();
    return rows.map(hydratePosition);
  }
  getRecentPositions({ limit = 10 } = {}) {
    return this.db.prepare("SELECT * FROM positions ORDER BY id DESC LIMIT ?").all(limit).map(hydratePosition);
  }
  getAccountEvents({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM account_events WHERE occurred_at >= ? ORDER BY id").all(since)
      : this.db.prepare("SELECT * FROM account_events ORDER BY id").all();
    return rows.map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
  }

  recordMonitorRun({ startedAt, finishedAt, status, message, snapshotId = null }) {
    this.db.prepare("INSERT INTO monitor_runs(started_at, finished_at, status, message, snapshot_id) VALUES (?, ?, ?, ?, ?)")
      .run(startedAt, finishedAt, status, message, snapshotId);
  }
  getLatestMonitorRun() { return this.db.prepare("SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 1").get() ?? null; }
}

export function openPaperDatabase(path = PAPER_CONFIG.databasePath, config = PAPER_CONFIG, options = {}) {
  return new PaperDatabase(path, config, options);
}
