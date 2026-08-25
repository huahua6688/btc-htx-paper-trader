import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PAPER_CONFIG, RUNTIME_SETTINGS_DEFAULTS } from "./config.mjs";
import {
  RUNTIME_SETTING_KEYS,
  expandLegacyRuntimePatch,
  validateCompleteRuntimeSettings
} from "./runtime-settings.mjs";
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
const hydratePositionGroup = (row, positions = []) => row ? {
  ...row,
  metadata: parseJson(row.metadata_json, {}),
  positions
} : null;

export const POSITION_GROUP_MIGRATION_VERSION = "2026-08-23-position-groups-v2";

export function positionGroupBackupPath(path) {
  return path === ":memory:" ? null : `${path}.${POSITION_GROUP_MIGRATION_VERSION}.bak`;
}

function backupDatabaseBeforePositionGroupMigration(path) {
  if (path === ":memory:" || !existsSync(path) || statSync(path).size === 0) return null;
  const backupPath = positionGroupBackupPath(path);
  if (!existsSync(backupPath)) {
    copyFileSync(path, backupPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${backupPath}${suffix}`);
    }
  }
  return backupPath;
}

const RUNTIME_FIELDS = Object.freeze([
  ["positionMode", "position_mode", "text"],
  ["riskProfile", "risk_profile", "text"],
  ["riskMode", "risk_mode", "text"], ["riskMinPct", "risk_min_pct"], ["riskMaxPct", "risk_max_pct"], ["riskManualPct", "risk_manual_pct"], ["riskPerTradePct", "risk_per_trade_pct"],
  ["marginMode", "margin_mode", "text"], ["marginMinUsagePct", "margin_min_usage_pct"], ["marginMaxUsagePct", "margin_max_usage_pct"], ["marginManualUsagePct", "margin_manual_usage_pct"], ["maxMarginUsagePct", "max_margin_usage_pct"],
  ["leverageMode", "leverage_mode", "text"], ["leverageMin", "leverage_min"], ["leverageMax", "leverage_max"], ["leverageManual", "leverage_manual"], ["userMaxLeverage", "user_max_leverage"],
  ["notionalMode", "notional_mode", "text"], ["notionalMinMultiple", "notional_min_multiple"], ["notionalMaxMultiple", "notional_max_multiple"], ["notionalManualMultiple", "notional_manual_multiple"], ["maxTotalNotionalMultiple", "max_total_notional_multiple"],
  ["allowPyramiding", "allow_pyramiding", "boolean"],
  ["positionLimitMode", "position_limit_mode", "text"], ["positionLimitMin", "position_limit_min"], ["positionLimitMax", "position_limit_max"], ["positionLimitManual", "position_limit_manual"], ["maxOpenPositions", "max_open_positions"],
  ["totalRiskMode", "total_risk_mode", "text"], ["totalRiskMinPct", "total_risk_min_pct"], ["totalRiskMaxPct", "total_risk_max_pct"], ["totalRiskManualPct", "total_risk_manual_pct"], ["maxTotalRiskPct", "max_total_risk_pct"],
  ["dailyLossMode", "daily_loss_mode", "text"], ["dailyLossMinPct", "daily_loss_min_pct"], ["dailyLossMaxPct", "daily_loss_max_pct"], ["dailyLossManualPct", "daily_loss_manual_pct"], ["maxDailyLossPct", "max_daily_loss_pct"],
  ["lossStreakMode", "loss_streak_mode", "text"], ["lossStreakMin", "loss_streak_min"], ["lossStreakMax", "loss_streak_max"], ["lossStreakManual", "loss_streak_manual"], ["maxConsecutiveLosses", "max_consecutive_losses"],
  ["newEntriesPaused", "new_entries_paused", "boolean"],
  ["indicatorProfile", "indicator_profile", "text"],
  ["monitorIntervalMinutes", "monitor_interval_minutes"],
  ["dataPolicyMode", "data_policy_mode", "text"]
]);

function runtimeFromRow(row) {
  if (!row) return null;
  const settings = Object.fromEntries(RUNTIME_FIELDS.map(([key, column, type]) => [key,
    type === "boolean" ? Boolean(row[column]) : type === "text" ? row[column] : Number(row[column])
  ]));
  return {
    ...settings,
    revision: Number(row.revision ?? 0),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

function runtimeValues(settings) {
  return RUNTIME_FIELDS.map(([key, , type]) => type === "boolean" ? (settings[key] ? 1 : 0) : settings[key]);
}

export class PaperDatabase {
  constructor(path = PAPER_CONFIG.databasePath, config = PAPER_CONFIG, { readOnly = false } = {}) {
    this.path = path;
    this.pathSource = config.databasePathSource ?? (path === ":memory:" ? "MEMORY" : "EXPLICIT");
    this.config = config;
    this.readOnly = readOnly;
    this.transactionDepth = 0;
    this.savepointCounter = 0;
    if (path !== ":memory:" && !readOnly) mkdirSync(dirname(path), { recursive: true });
    this.positionGroupMigrationBackup = readOnly ? null : backupDatabaseBeforePositionGroupMigration(path);
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
      return true;
    }
    return false;
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

      CREATE TABLE IF NOT EXISTS strategy_signal_claims (
        signal_key TEXT PRIMARY KEY,
        strategy_version TEXT NOT NULL,
        signal_bar_ts INTEGER NOT NULL,
        first_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        claimed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategy_signal_claims_bar_idx
        ON strategy_signal_claims(strategy_version, signal_bar_ts);

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

      CREATE TABLE IF NOT EXISTS position_groups (
        group_id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        created_at TEXT NOT NULL,
        closed_at TEXT,
        migration_source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS position_groups_status_side_idx ON position_groups(status, side);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS position_group_migration_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        migration_version TEXT NOT NULL,
        changed_positions INTEGER NOT NULL,
        created_groups INTEGER NOT NULL,
        repaired_groups INTEGER NOT NULL,
        details_json TEXT NOT NULL
      );

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
        risk_mode TEXT NOT NULL,
        risk_min_pct REAL NOT NULL,
        risk_max_pct REAL NOT NULL,
        risk_manual_pct REAL NOT NULL,
        risk_per_trade_pct REAL NOT NULL,
        margin_mode TEXT NOT NULL,
        margin_min_usage_pct REAL NOT NULL,
        margin_max_usage_pct REAL NOT NULL,
        margin_manual_usage_pct REAL NOT NULL,
        max_margin_usage_pct REAL NOT NULL,
        leverage_mode TEXT NOT NULL,
        leverage_min REAL NOT NULL,
        leverage_max REAL NOT NULL,
        leverage_manual REAL NOT NULL,
        user_max_leverage REAL NOT NULL,
        notional_mode TEXT NOT NULL,
        notional_min_multiple REAL NOT NULL,
        notional_max_multiple REAL NOT NULL,
        notional_manual_multiple REAL NOT NULL,
        max_total_notional_multiple REAL NOT NULL,
        allow_pyramiding INTEGER NOT NULL CHECK (allow_pyramiding IN (0, 1)),
        position_limit_mode TEXT NOT NULL,
        position_limit_min INTEGER NOT NULL,
        position_limit_max INTEGER NOT NULL,
        position_limit_manual INTEGER NOT NULL,
        max_open_positions INTEGER NOT NULL,
        total_risk_mode TEXT NOT NULL,
        total_risk_min_pct REAL NOT NULL,
        total_risk_max_pct REAL NOT NULL,
        total_risk_manual_pct REAL NOT NULL,
        max_total_risk_pct REAL NOT NULL,
        daily_loss_mode TEXT NOT NULL,
        daily_loss_min_pct REAL NOT NULL,
        daily_loss_max_pct REAL NOT NULL,
        daily_loss_manual_pct REAL NOT NULL,
        max_daily_loss_pct REAL NOT NULL,
        loss_streak_mode TEXT NOT NULL,
        loss_streak_min INTEGER NOT NULL,
        loss_streak_max INTEGER NOT NULL,
        loss_streak_manual INTEGER NOT NULL,
        max_consecutive_losses INTEGER NOT NULL,
        new_entries_paused INTEGER NOT NULL CHECK (new_entries_paused IN (0, 1)),
        indicator_profile TEXT NOT NULL DEFAULT 'AUTO',
        monitor_interval_minutes INTEGER NOT NULL DEFAULT 5,
        data_policy_mode TEXT NOT NULL DEFAULT 'FROZEN_V12_STRICT',
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
        availability_status TEXT NOT NULL DEFAULT 'research-only' CHECK (availability_status IN ('enabled', 'research-only', 'disabled', 'blocked')),
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

      CREATE TABLE IF NOT EXISTS strategy_versions (
        version TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('CHAMPION', 'CHALLENGER', 'ARCHIVED')),
        lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('FROZEN', 'CANDIDATE', 'VALIDATING', 'SHADOW', 'REJECTED', 'CHAMPION', 'ROLLED_BACK')),
        strategy_hash TEXT NOT NULL,
        code_sha256 TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        feature_set_json TEXT NOT NULL,
        dataset_manifest_hash TEXT,
        training_range_json TEXT,
        development_range_json TEXT,
        oos_range_json TEXT,
        final_holdout_json TEXT,
        performance_json TEXT NOT NULL,
        promotion_reason TEXT,
        rollback_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_version_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        version TEXT NOT NULL REFERENCES strategy_versions(version),
        old_role TEXT,
        new_role TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'PARTIAL', 'BLOCKED')),
        artifact_path TEXT,
        data_manifest_hash TEXT,
        strategy_version TEXT,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_runs_type_idx ON research_runs(run_type, id);
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
      ["position_group_id", "INTEGER"], ["legacy_contract_math_status", "TEXT NOT NULL DEFAULT 'CURRENT'"],
      ["stop_effective_bar_ts", "INTEGER"]
    ];
    for (const [name, definition] of migrations) this.ensureColumn("positions", name, definition);
    // 老仓位没有这个字段时，止损自入场起生效，与升级前的行为一致。
    this.db.exec("UPDATE positions SET stop_effective_bar_ts = entry_bar_ts WHERE stop_effective_bar_ts IS NULL");
    this.ensureColumn("feature_validation_runs", "validation_stage", "TEXT NOT NULL DEFAULT 'HISTORICAL_OOS'");
    this.ensureColumn("feature_validation_runs", "candidate_version", "TEXT NOT NULL DEFAULT 'unversioned'");
    if (this.ensureColumn("feature_registry", "availability_status", "TEXT NOT NULL DEFAULT 'research-only'")) {
      this.db.exec("UPDATE feature_registry SET availability_status = status");
    }
    this.ensureColumn("runtime_settings", "revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runtime_settings", "position_mode", "TEXT NOT NULL DEFAULT 'NET'");
    this.ensureColumn("runtime_settings", "indicator_profile", "TEXT NOT NULL DEFAULT 'AUTO'");
    this.ensureColumn("runtime_settings", "monitor_interval_minutes", "INTEGER NOT NULL DEFAULT 5");
    // 已部署的库升级后保持冻结 V1.2 严格门禁，不会因为部署新版而改变交易行为。
    this.ensureColumn("runtime_settings", "data_policy_mode", "TEXT NOT NULL DEFAULT 'FROZEN_V12_STRICT'");
    const rangeMigrations = [
      ["risk_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["risk_min_pct", "REAL NOT NULL DEFAULT 0.005"], ["risk_max_pct", "REAL NOT NULL DEFAULT 0.05"], ["risk_manual_pct", "REAL NOT NULL DEFAULT 0.01"],
      ["margin_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["margin_min_usage_pct", "REAL NOT NULL DEFAULT 0.10"], ["margin_max_usage_pct", "REAL NOT NULL DEFAULT 0.80"], ["margin_manual_usage_pct", "REAL NOT NULL DEFAULT 0.25"],
      ["leverage_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["leverage_min", "REAL NOT NULL DEFAULT 1"], ["leverage_max", "REAL NOT NULL DEFAULT 200"], ["leverage_manual", "REAL NOT NULL DEFAULT 5"],
      ["notional_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["notional_min_multiple", "REAL NOT NULL DEFAULT 0.5"], ["notional_max_multiple", "REAL NOT NULL DEFAULT 20"], ["notional_manual_multiple", "REAL NOT NULL DEFAULT 1"],
      ["position_limit_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["position_limit_min", "INTEGER NOT NULL DEFAULT 1"], ["position_limit_max", "INTEGER NOT NULL DEFAULT 5"], ["position_limit_manual", "INTEGER NOT NULL DEFAULT 1"],
      ["total_risk_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["total_risk_min_pct", "REAL NOT NULL DEFAULT 0.02"], ["total_risk_max_pct", "REAL NOT NULL DEFAULT 0.20"], ["total_risk_manual_pct", "REAL NOT NULL DEFAULT 0.02"],
      ["daily_loss_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["daily_loss_min_pct", "REAL NOT NULL DEFAULT 0.03"], ["daily_loss_max_pct", "REAL NOT NULL DEFAULT 0.20"], ["daily_loss_manual_pct", "REAL NOT NULL DEFAULT 0.03"],
      ["loss_streak_mode", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["loss_streak_min", "INTEGER NOT NULL DEFAULT 3"], ["loss_streak_max", "INTEGER NOT NULL DEFAULT 10"], ["loss_streak_manual", "INTEGER NOT NULL DEFAULT 3"]
    ];
    let rangeSchemaAdded = false;
    for (const [name, definition] of rangeMigrations) {
      if (this.ensureColumn("runtime_settings", name, definition)) rangeSchemaAdded = true;
    }
    if (rangeSchemaAdded) {
      this.db.exec(`
        UPDATE runtime_settings SET
          risk_manual_pct = risk_per_trade_pct,
          risk_min_pct = MIN(risk_min_pct, risk_per_trade_pct),
          risk_max_pct = MAX(risk_max_pct, risk_per_trade_pct),
          margin_manual_usage_pct = max_margin_usage_pct,
          margin_min_usage_pct = MIN(margin_min_usage_pct, max_margin_usage_pct),
          margin_max_usage_pct = MAX(margin_max_usage_pct, max_margin_usage_pct),
          leverage_manual = user_max_leverage,
          leverage_min = MIN(leverage_min, user_max_leverage),
          leverage_max = MAX(leverage_max, user_max_leverage),
          notional_manual_multiple = max_total_notional_multiple,
          notional_min_multiple = MIN(notional_min_multiple, max_total_notional_multiple),
          notional_max_multiple = MAX(notional_max_multiple, max_total_notional_multiple),
          position_limit_manual = max_open_positions,
          position_limit_min = MIN(position_limit_min, max_open_positions),
          position_limit_max = MAX(position_limit_max, max_open_positions),
          total_risk_manual_pct = max_total_risk_pct,
          total_risk_min_pct = MIN(total_risk_min_pct, max_total_risk_pct),
          total_risk_max_pct = MAX(total_risk_max_pct, max_total_risk_pct),
          daily_loss_manual_pct = max_daily_loss_pct,
          daily_loss_min_pct = MIN(daily_loss_min_pct, max_daily_loss_pct),
          daily_loss_max_pct = MAX(daily_loss_max_pct, max_daily_loss_pct),
          loss_streak_manual = max_consecutive_losses,
          loss_streak_min = MIN(loss_streak_min, max_consecutive_losses),
          loss_streak_max = MAX(loss_streak_max, max_consecutive_losses),
          risk_mode = 'MANUAL', margin_mode = 'MANUAL', leverage_mode = 'MANUAL',
          notional_mode = 'MANUAL', position_limit_mode = 'MANUAL', total_risk_mode = 'MANUAL',
          daily_loss_mode = 'MANUAL', loss_streak_mode = 'MANUAL'
      `);
    }
    this.repairPositionGroups({ markMigration: true });
    this.db.exec("DROP INDEX IF EXISTS one_open_position_idx;");
    this.db.exec("DROP INDEX IF EXISTS one_entry_per_side_bar_idx;");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_entry_per_side_bar_idx ON positions(side, entry_bar_ts) WHERE status = 'OPEN';");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_open_position_group_per_side_idx ON position_groups(side) WHERE status = 'OPEN';");

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO account_state(id, initial_capital_cny, cash_cny, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(this.config.initialCapitalCny, this.config.initialCapitalCny, now);
    const runtimeColumns = RUNTIME_FIELDS.map(([, column]) => column);
    this.db.prepare(`
      INSERT INTO runtime_settings(id, ${runtimeColumns.join(", ")}, updated_at, updated_by)
      VALUES (1, ${runtimeColumns.map(() => "?").join(", ")}, ?, 'FIRST_START_DEFAULTS')
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
        availability_status, evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_key) DO NOTHING
    `);
    for (const feature of FEATURE_REGISTRY_SEEDS) {
      insertFeature.run(
        feature.key, feature.name, feature.source, feature.layer, feature.currentWeight,
        json(feature.applicableRegimes), feature.historicalCoverageStart, feature.historicalCoverageEnd,
        feature.predictionHorizon, feature.oosIncrementalContribution, feature.recentValidity,
        feature.status, feature.status, json(feature.evidence), now
      );
    }
    this.db.prepare(`
      INSERT INTO strategy_versions(
        version, role, lifecycle_status, strategy_hash, code_sha256, parameters_json,
        feature_set_json, performance_json, promotion_reason, rollback_version, created_at, updated_at
      ) VALUES ('V1.2-FROZEN', 'CHAMPION', 'FROZEN', ?, ?, ?, ?, '{}', ?, NULL, ?, ?)
      ON CONFLICT(version) DO NOTHING
    `).run(
      '9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6',
      '9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6',
      json({ version: 'V1.2', frozen: true, source: 'analysis-engine.mjs' }),
      json(['HTX_PUBLIC_V1_2_FEATURE_SET']),
      'Initial frozen Paper Champion; historical score must not be cosmetically changed.', now, now
    );
  }

  repairPositionGroups({
    markMigration = false,
    occurredAt = new Date().toISOString()
  } = {}) {
    if (this.readOnly) throw new Error("只读数据库不能执行 Position Group 修复");
    return this.transaction(() => {
      const migrationWasApplied = Boolean(this.db.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = ?"
      ).get(POSITION_GROUP_MIGRATION_VERSION));
      const positions = this.db.prepare("SELECT * FROM positions ORDER BY id").all();
      let groups = this.db.prepare("SELECT * FROM position_groups ORDER BY group_id").all();
      let changedPositions = 0;
      let createdGroups = 0;
      let repairedGroups = 0;
      const changes = [];

      const refreshGroups = () => {
        groups = this.db.prepare("SELECT * FROM position_groups ORDER BY group_id").all();
      };
      const createGroup = ({ side, status, createdAt, closedAt = null, preferredId = null, source }) => {
        const preferredFree = preferredId !== null
          && !this.db.prepare("SELECT 1 FROM position_groups WHERE group_id = ?").get(preferredId);
        const statement = preferredFree
          ? this.db.prepare(`
              INSERT INTO position_groups(group_id, symbol, side, status, created_at, closed_at, migration_source, metadata_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
            `)
          : this.db.prepare(`
              INSERT INTO position_groups(symbol, side, status, created_at, closed_at, migration_source, metadata_json)
              VALUES (?, ?, ?, ?, ?, ?, '{}')
            `);
        const args = preferredFree
          ? [preferredId, this.config.symbol, side, status, createdAt, closedAt, source]
          : [this.config.symbol, side, status, createdAt, closedAt, source];
        const result = statement.run(...args);
        createdGroups += 1;
        refreshGroups();
        return preferredFree ? Number(preferredId) : Number(result.lastInsertRowid);
      };

      // 每个方向只允许一个 OPEN group。同方向加仓归入它；另一方向永远使用独立 group。
      for (const side of ["LONG", "SHORT"]) {
        const openPositions = positions.filter((position) => position.status === "OPEN" && position.side === side);
        if (!openPositions.length) continue;
        const linkedValidGroups = [...new Set(openPositions.map((position) => Number(position.position_group_id))
          .filter((id) => Number.isInteger(id) && groups.some((group) => Number(group.group_id) === id && group.side === side)))];
        let canonicalId = linkedValidGroups[0] ?? null;
        if (canonicalId === null) {
          const preferred = openPositions.map((position) => Number(position.position_group_id))
            .find((id) => Number.isInteger(id) && id > 0 && !groups.some((group) => Number(group.group_id) === id));
          canonicalId = createGroup({
            side,
            status: "OPEN",
            createdAt: openPositions.map((position) => position.opened_at).sort()[0] ?? occurredAt,
            preferredId: preferred ?? Number(openPositions[0].id),
            source: "LEGACY_OPEN_POSITION_REPAIR"
          });
        }
        for (const group of groups.filter((item) => item.side === side && item.status === "OPEN" && Number(item.group_id) !== canonicalId)) {
          this.db.prepare("UPDATE position_groups SET status = 'CLOSED', closed_at = COALESCE(closed_at, ?) WHERE group_id = ?")
            .run(occurredAt, group.group_id);
          repairedGroups += 1;
        }
        const canonical = this.db.prepare("SELECT * FROM position_groups WHERE group_id = ?").get(canonicalId);
        if (canonical.status !== "OPEN" || canonical.closed_at !== null) {
          this.db.prepare("UPDATE position_groups SET status = 'OPEN', closed_at = NULL WHERE group_id = ?").run(canonicalId);
          repairedGroups += 1;
        }
        for (const position of openPositions) {
          if (Number(position.position_group_id) !== canonicalId) {
            this.db.prepare("UPDATE positions SET position_group_id = ? WHERE id = ?").run(canonicalId, position.id);
            changedPositions += 1;
            changes.push({ positionId: Number(position.id), oldGroupId: position.position_group_id, newGroupId: canonicalId, side });
          }
        }
        refreshGroups();
      }

      // 历史已平仓腿也必须指向同方向 group；不改价格、数量或盈亏字段。
      for (const position of positions.filter((item) => item.status === "CLOSED")) {
        const linked = groups.find((group) => Number(group.group_id) === Number(position.position_group_id));
        if (linked?.side === position.side) continue;
        const preferred = Number(position.position_group_id);
        const groupId = createGroup({
          side: position.side,
          status: "CLOSED",
          createdAt: position.opened_at ?? occurredAt,
          closedAt: position.closed_at ?? occurredAt,
          preferredId: Number.isInteger(preferred) && preferred > 0 ? preferred : Number(position.id),
          source: "LEGACY_CLOSED_POSITION_REPAIR"
        });
        this.db.prepare("UPDATE positions SET position_group_id = ? WHERE id = ?").run(groupId, position.id);
        changedPositions += 1;
        changes.push({ positionId: Number(position.id), oldGroupId: position.position_group_id, newGroupId: groupId, side: position.side });
      }

      const unknownMath = this.db.prepare(`
        UPDATE positions SET legacy_contract_math_status = 'LEGACY_UNKNOWN'
        WHERE (margin_cny IS NULL OR leverage IS NULL OR liquidation_price_estimate IS NULL)
          AND legacy_contract_math_status <> 'LEGACY_UNKNOWN'
      `).run();

      refreshGroups();
      for (const group of groups) {
        const state = this.db.prepare(`
          SELECT COUNT(*) AS total_count,
                 SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
                 MIN(opened_at) AS first_opened_at,
                 MAX(closed_at) AS last_closed_at
          FROM positions WHERE position_group_id = ? AND side = ?
        `).get(group.group_id, group.side);
        const shouldOpen = Number(state.open_count ?? 0) > 0;
        const nextStatus = shouldOpen ? "OPEN" : "CLOSED";
        const nextClosedAt = shouldOpen ? null : (state.last_closed_at ?? group.closed_at ?? occurredAt);
        const nextCreatedAt = state.first_opened_at ?? group.created_at;
        if (group.status !== nextStatus || group.closed_at !== nextClosedAt || group.created_at !== nextCreatedAt) {
          this.db.prepare("UPDATE position_groups SET status = ?, created_at = ?, closed_at = ? WHERE group_id = ?")
            .run(nextStatus, nextCreatedAt, nextClosedAt, group.group_id);
          repairedGroups += 1;
        }
      }

      if (markMigration && !migrationWasApplied) {
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at, details_json) VALUES (?, ?, ?)")
          .run(POSITION_GROUP_MIGRATION_VERSION, occurredAt, json({
            backupPath: this.positionGroupMigrationBackup,
            changedPositions,
            createdGroups,
            repairedGroups,
            legacyUnknownPositions: Number(unknownMath.changes ?? 0)
          }));
      }
      if (!migrationWasApplied || changedPositions || createdGroups || repairedGroups || Number(unknownMath.changes ?? 0)) {
        this.db.prepare(`
          INSERT INTO position_group_migration_audit(
            occurred_at, migration_version, changed_positions, created_groups, repaired_groups, details_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(occurredAt, POSITION_GROUP_MIGRATION_VERSION, changedPositions, createdGroups, repairedGroups, json({
          backupPath: this.positionGroupMigrationBackup,
          legacyUnknownPositions: Number(unknownMath.changes ?? 0),
          changes
        }));
      }
      return {
        migrationVersion: POSITION_GROUP_MIGRATION_VERSION,
        backupPath: this.positionGroupMigrationBackup,
        changedPositions,
        createdGroups,
        repairedGroups,
        legacyUnknownPositions: Number(unknownMath.changes ?? 0),
        groups: this.db.prepare("SELECT * FROM position_groups ORDER BY group_id").all()
      };
    });
  }

  /**
   * 可安全嵌套的事务。最外层使用 BEGIN IMMEDIATE，内层使用命名 SAVEPOINT：
   * 内层失败只回滚到自己的 savepoint 并把异常继续抛出，绝不会把外层事务一起废掉；
   * 只有最外层才真正 COMMIT 或 ROLLBACK。
   */
  transaction(work) {
    if (this.transactionDepth > 0) {
      const name = `paper_sp_${this.savepointCounter++}`;
      this.db.exec(`SAVEPOINT ${name}`);
      this.transactionDepth += 1;
      try {
        const result = work();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  get inTransaction() { return this.transactionDepth > 0; }

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
      const expandedPatch = expandLegacyRuntimePatch(patch);
      const next = validateCompleteRuntimeSettings({ ...currentValues, ...expandedPatch });
      const changed = RUNTIME_SETTING_KEYS.filter((key) => current[key] !== next[key]);
      if (!changed.length) return { settings: current, changed, duplicate: false, noChange: true };
      const assignments = RUNTIME_FIELDS.map(([, column]) => `${column} = ?`).join(", ");
      this.db.prepare(`
        UPDATE runtime_settings SET
          ${assignments},
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
            recent_validity = ?, status = 'research-only', availability_status = ?, evidence_json = ?, updated_at = ?
          WHERE feature_key = ?
        `).run(
          item.source ?? "UNAVAILABLE", item.historicalCoverageStart ?? null,
          item.historicalCoverageEnd ?? null,
          ["unavailable", "blocked"].includes(item.status) ? "UNAVAILABLE_RELIABLE_SOURCE" : item.dataQuality,
          item.status === "blocked" || item.status === "unavailable" ? "blocked" : "research-only",
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
        UPDATE feature_registry SET status = 'enabled', availability_status = 'enabled', current_weight = ?,
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

  registerStrategyVersion(record) {
    const now = record.updatedAt ?? new Date().toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM strategy_versions WHERE version = ?").get(record.version);
      if (existing && existing.strategy_hash !== record.strategyHash) throw new Error(`策略版本 ${record.version} 已存在且哈希不同，禁止覆盖`);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO strategy_versions(
            version, role, lifecycle_status, strategy_hash, code_sha256, parameters_json,
            feature_set_json, dataset_manifest_hash, training_range_json, development_range_json,
            oos_range_json, final_holdout_json, performance_json, promotion_reason,
            rollback_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.version, record.role ?? "CHALLENGER", record.lifecycleStatus ?? "CANDIDATE",
          record.strategyHash, record.codeSha256 ?? record.strategyHash,
          json(record.parameters ?? {}), json(record.featureSet ?? []), record.dataManifestHash ?? null,
          json(record.trainingRange), json(record.developmentRange), json(record.oosRange),
          json(record.finalHoldout), json(record.performance ?? {}), record.promotionReason ?? null,
          record.rollbackVersion ?? null, record.createdAt ?? now, now
        );
      }
      return this.getStrategyVersion(record.version);
    });
  }

  getStrategyVersion(version) {
    const row = this.db.prepare("SELECT * FROM strategy_versions WHERE version = ?").get(version);
    return row ? {
      ...row, parameters: parseJson(row.parameters_json, {}), featureSet: parseJson(row.feature_set_json, []),
      trainingRange: parseJson(row.training_range_json), developmentRange: parseJson(row.development_range_json),
      oosRange: parseJson(row.oos_range_json), finalHoldout: parseJson(row.final_holdout_json),
      performance: parseJson(row.performance_json, {})
    } : null;
  }

  getStrategyVersions({ limit = 20 } = {}) {
    return this.db.prepare("SELECT version FROM strategy_versions ORDER BY updated_at DESC LIMIT ?").all(limit)
      .map((row) => this.getStrategyVersion(row.version));
  }

  transitionStrategyVersion(version, { role, lifecycleStatus, reason, evidence = {}, occurredAt = new Date().toISOString() }) {
    return this.transaction(() => {
      const current = this.getStrategyVersion(version);
      if (!current) throw new Error(`未知策略版本：${version}`);
      if (current.lifecycle_status === "FROZEN" && (role !== current.role || lifecycleStatus !== current.lifecycle_status)) {
        throw new Error("冻结 Champion 不允许原地修改角色或状态");
      }
      this.db.prepare("UPDATE strategy_versions SET role = ?, lifecycle_status = ?, updated_at = ? WHERE version = ?")
        .run(role, lifecycleStatus, occurredAt, version);
      this.db.prepare(`
        INSERT INTO strategy_version_audit(occurred_at, version, old_role, new_role, old_status, new_status, reason, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(occurredAt, version, current.role, role, current.lifecycle_status, lifecycleStatus, reason, json(evidence));
      return this.getStrategyVersion(version);
    });
  }

  recordResearchRun(record) {
    const result = this.db.prepare(`
      INSERT INTO research_runs(run_type, started_at, finished_at, status, artifact_path, data_manifest_hash, strategy_version, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.runType, record.startedAt, record.finishedAt, record.status, record.artifactPath ?? null,
      record.dataManifestHash ?? null, record.strategyVersion ?? null, json(record.summary ?? {}));
    return Number(result.lastInsertRowid);
  }

  getResearchRuns({ limit = 20, runType = null } = {}) {
    const rows = runType
      ? this.db.prepare("SELECT * FROM research_runs WHERE run_type = ? ORDER BY id DESC LIMIT ?").all(runType, limit)
      : this.db.prepare("SELECT * FROM research_runs ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((row) => ({ ...row, summary: parseJson(row.summary_json, {}) }));
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
      report.signalQualityScore ?? report.confidencePct ?? null,
      report.finalScore ?? null,
      report.derivatives?.fundingRatePct ?? null,
      report.derivatives?.oiUsd ?? null,
      report.derivatives?.pressureScore ?? null,
      json(report.riskGates), json(report)
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * 把入场门禁产生的信息（动态限额、拒绝原因码）合并回当轮快照，
   * 这样 status / Telegram / gate:report 看到的是同一份事实，而不是各算各的。
   */
  updateSnapshotReport(snapshotId, patch) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT report_json FROM snapshots WHERE id = ?").get(snapshotId);
      if (!row) return null;
      const merged = { ...parseJson(row.report_json, {}), ...patch };
      this.db.prepare("UPDATE snapshots SET report_json = ? WHERE id = ?").run(json(merged), snapshotId);
      return merged;
    });
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

  /**
   * Atomically claims one completed strategy signal bar.  The primary key is
   * durable across monitor restarts, preventing the same 4h signal from being
   * re-submitted by every 5-minute Shadow cycle.
   */
  claimStrategySignal({ signalKey, strategyVersion, signalBarTimestamp, snapshotId, claimedAt }) {
    if (!signalKey || !strategyVersion || !Number.isFinite(Number(signalBarTimestamp)) || !Number.isInteger(Number(snapshotId))) {
      throw new Error("Invalid strategy signal claim");
    }
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO strategy_signal_claims(signal_key, strategy_version, signal_bar_ts, first_snapshot_id, claimed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(signal_key) DO NOTHING
      `).run(signalKey, strategyVersion, Number(signalBarTimestamp), Number(snapshotId), claimedAt);
      const claim = this.db.prepare("SELECT * FROM strategy_signal_claims WHERE signal_key = ?").get(signalKey);
      return { claimed: Number(result.changes) === 1, claim };
    });
  }

  getStrategySignalClaim(signalKey) {
    return this.db.prepare("SELECT * FROM strategy_signal_claims WHERE signal_key = ?").get(signalKey) ?? null;
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
  getPositionGroup(groupId) {
    const row = this.db.prepare("SELECT * FROM position_groups WHERE group_id = ?").get(groupId);
    if (!row) return null;
    const positions = this.db.prepare("SELECT * FROM positions WHERE position_group_id = ? ORDER BY id").all(groupId).map(hydratePosition);
    return hydratePositionGroup(row, positions);
  }
  getPositionGroups({ status = null } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM position_groups WHERE status = ? ORDER BY group_id").all(status)
      : this.db.prepare("SELECT * FROM position_groups ORDER BY group_id").all();
    return rows.map((row) => this.getPositionGroup(row.group_id));
  }
  getOpenPositionGroups() { return this.getPositionGroups({ status: "OPEN" }); }
  getPositionGroupMigrationAudit({ limit = 20 } = {}) {
    return this.db.prepare("SELECT * FROM position_group_migration_audit ORDER BY id DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
  }

  openPosition(candidate, snapshotId, { settingsUpdatedAt = null, settingsRevision = null } = {}) {
    return this.transaction(() => {
      const settings = this.getRuntimeSettings();
      if (settingsRevision !== null && settings.revision !== Number(settingsRevision)) throw new Error("运行时设置版本已变化，请下一轮重新计算仓位");
      if (settingsUpdatedAt && settings.updatedAt !== settingsUpdatedAt) throw new Error("运行时设置已变化，请下一轮重新计算仓位");
      const open = this.getOpenPositions();
      const sameSide = open.filter((position) => position.side === candidate.side);
      const oppositeSide = open.filter((position) => position.side !== candidate.side);
      if (sameSide.length && !settings.allowPyramiding) throw new Error("已有模拟仓位（同方向）且加仓已关闭");
      if (open.length >= settings.maxOpenPositions) throw new Error("已达到最大同时仓位数");
      if (settings.positionMode === "NET" && oppositeSide.length) throw new Error("NET 模式不允许同时持有 BTC 相反方向模拟仓位");
      const equity = Number(candidate.accountEquityCny);
      const accountAfter = {
        totalRiskCny: open.reduce((sum, position) => sum + Number(position.expected_loss_cny ?? position.risk_cny), 0)
          + Number(candidate.expectedLossCny ?? candidate.riskCny),
        totalMarginCny: open.reduce((sum, position) => sum + Number(position.margin_cny ?? position.notional_cny), 0)
          + Number(candidate.marginCny ?? candidate.notionalCny),
        totalNotionalCny: open.reduce((sum, position) => sum + Number(position.notional_cny), 0)
          + Number(candidate.notionalCny)
      };
      const groupAfter = candidate.groupAfter ?? candidate.portfolioAfter;
      if (Number.isFinite(equity) && equity > 0) {
        if (accountAfter.totalRiskCny > equity * settings.maxTotalRiskPct + 0.01) throw new Error("开仓后总风险超过上限");
        if (accountAfter.totalMarginCny > equity * settings.maxMarginUsagePct + 0.01) throw new Error("开仓后保证金超过上限");
        if (accountAfter.totalNotionalCny > equity * settings.maxTotalNotionalMultiple + 0.01) throw new Error("开仓后总名义仓位超过上限");
      }
      const entryCost = numberOr(candidate.entryFeeCny) + numberOr(candidate.entrySlippageCny);
      const account = this.getAccount();
      const newBalance = Number(account.cash_cny) - entryCost;
      let groupId = sameSide[0]?.position_group_id ?? null;
      if (groupId !== null) {
        const group = this.db.prepare("SELECT * FROM position_groups WHERE group_id = ?").get(groupId);
        if (!group || group.status !== "OPEN" || group.side !== candidate.side) {
          throw new Error("Position Group 生命周期不一致；请先执行 positions:repair");
        }
      } else {
        const groupResult = this.db.prepare(`
          INSERT INTO position_groups(symbol, side, status, created_at, closed_at, migration_source, metadata_json)
          VALUES (?, ?, 'OPEN', ?, NULL, 'PAPER_OPEN', '{}')
        `).run(candidate.symbol, candidate.side, candidate.openedAt);
        groupId = Number(groupResult.lastInsertRowid);
      }
      const result = this.db.prepare(`
        INSERT INTO positions(
          position_group_id, snapshot_id, symbol, side, status, opened_at, entry_bar_ts, signal_entry_price, entry_price,
          initial_stop_loss, stop_loss, initial_take_profit, take_profit, rr, net_rr, quantity_btc,
          risk_cny, expected_loss_cny, expected_profit_cny, risk_pct, account_equity_cny,
          leverage, margin_cny, margin_usage_pct, notional_cny, stop_distance_pct,
          take_profit_distance_pct, opportunity_score, fee_estimate_cny, funding_estimate_cny,
          slippage_estimate_cny, entry_fee_cny, entry_slippage_cny, liquidation_price_estimate,
          liquidation_distance_pct, liquidation_source, exchange_constraints_json, portfolio_after_json,
          opening_reasons_json, last_funding_at, last_management_bar_ts, management_json, stop_effective_bar_ts
        ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        groupId, snapshotId, candidate.symbol, candidate.side, candidate.openedAt, candidate.entryBarTs,
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
        json(groupAfter ?? {}), json(candidate.openingReasons), candidate.openedAt,
        candidate.entryBarTs, json({ events: [] }), candidate.entryBarTs
      );
      const positionId = Number(result.lastInsertRowid);
      if (sameSide.length && groupAfter) {
        const groupEvent = {
          type: "PORTFOLIO_REBASED",
          at: candidate.openedAt,
          reason: "受控加仓后按净仓位重新计算平均成本、整体止损、整体止盈和账户风险暴露",
          portfolioAfter: groupAfter
        };
        for (const leg of [...sameSide, this.getPosition(positionId)]) {
          const events = [...(leg.management?.events ?? []), groupEvent].slice(-100);
          this.db.prepare(`
            UPDATE positions SET position_group_id = ?, portfolio_after_json = ?, management_json = ?
            WHERE id = ? AND status = 'OPEN'
          `).run(
            groupId, json(groupAfter), json({ events }), leg.id
          );
        }
      }
      if (groupAfter) {
        this.db.prepare("UPDATE position_groups SET metadata_json = ? WHERE group_id = ? AND status = 'OPEN'")
          .run(json({ groupAfter, updatedAt: candidate.openedAt }), groupId);
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
    stopEffectiveBarTs,
    event
  }) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Paper position is not open");
      const management = position.management ?? { events: [] };
      const events = [...(management.events ?? []), ...(event ? [event] : [])].slice(-100);
      this.db.prepare(`
        UPDATE positions SET stop_loss = ?, take_profit = ?, last_management_bar_ts = ?,
          opposite_signal_count = ?, management_json = ?, stop_effective_bar_ts = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(
        stopLoss ?? position.stop_loss,
        takeProfit ?? position.take_profit,
        lastManagementBarTs ?? position.last_management_bar_ts,
        oppositeSignalCount ?? position.opposite_signal_count,
        json({ events }),
        stopEffectiveBarTs ?? position.stop_effective_bar_ts ?? position.entry_bar_ts,
        positionId
      );
      return this.getPosition(positionId);
    });
  }

  getPeakBalanceCny() {
    const row = this.db.prepare("SELECT MAX(balance_after_cny) AS peak FROM account_events").get();
    const account = this.getAccount();
    const initial = Number(account?.initial_capital_cny ?? 0);
    const peak = Number(row?.peak);
    return Number.isFinite(peak) ? Math.max(peak, initial) : initial;
  }

  updatePositionGroupManagement(positionGroupId, managementUpdate) {
    return this.transaction(() => {
      const group = this.db.prepare("SELECT * FROM position_groups WHERE group_id = ?").get(positionGroupId);
      if (!group || group.status !== "OPEN") throw new Error("Paper position group is not open");
      const positions = this.db.prepare(`
        SELECT * FROM positions WHERE position_group_id = ? AND side = ? AND status = 'OPEN' ORDER BY id
      `).all(positionGroupId, group.side).map(hydratePosition);
      if (!positions.length) throw new Error("Paper position group is not open");
      for (const position of positions) {
        const events = [...(position.management?.events ?? []), ...(managementUpdate.event ? [managementUpdate.event] : [])].slice(-100);
        this.db.prepare(`
          UPDATE positions SET stop_loss = ?, take_profit = ?, last_management_bar_ts = ?,
            opposite_signal_count = ?, management_json = ?, stop_effective_bar_ts = ?
          WHERE id = ? AND status = 'OPEN'
        `).run(
          managementUpdate.stopLoss ?? position.stop_loss,
          managementUpdate.takeProfit ?? position.take_profit,
          managementUpdate.lastManagementBarTs ?? position.last_management_bar_ts,
          managementUpdate.oppositeSignalCount ?? position.opposite_signal_count,
          json({ events }),
          managementUpdate.stopEffectiveBarTs ?? position.stop_effective_bar_ts ?? position.entry_bar_ts,
          position.id
        );
      }
      return this.db.prepare(`
        SELECT * FROM positions WHERE position_group_id = ? AND side = ? AND status = 'OPEN' ORDER BY id
      `).all(positionGroupId, group.side).map(hydratePosition);
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
      const remaining = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM positions
        WHERE position_group_id = ? AND status = 'OPEN'
      `).get(position.position_group_id).count);
      if (remaining === 0) {
        this.db.prepare(`
          UPDATE position_groups SET status = 'CLOSED', closed_at = ?
          WHERE group_id = ? AND status = 'OPEN'
        `).run(exit.closedAt, position.position_group_id);
      }
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
