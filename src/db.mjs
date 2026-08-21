import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PAPER_CONFIG } from "./config.mjs";

const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export class PaperDatabase {
  constructor(path = PAPER_CONFIG.databasePath, config = PAPER_CONFIG, { readOnly = false } = {}) {
    this.path = path;
    this.config = config;
    this.readOnly = readOnly;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (!readOnly) {
      if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.initialize();
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
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        entry_bar_ts INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        rr REAL NOT NULL,
        quantity_btc REAL NOT NULL,
        risk_cny REAL NOT NULL,
        notional_cny REAL NOT NULL,
        entry_fee_cny REAL NOT NULL,
        exit_fee_cny REAL NOT NULL DEFAULT 0,
        funding_cny REAL NOT NULL DEFAULT 0,
        gross_pnl_cny REAL,
        net_pnl_cny REAL,
        exit_price REAL,
        exit_reason TEXT,
        opening_reasons_json TEXT NOT NULL,
        last_funding_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_position_idx ON positions(status) WHERE status = 'OPEN';
      CREATE INDEX IF NOT EXISTS positions_closed_at_idx ON positions(closed_at);

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
    `);

    this.db.prepare(`
      INSERT INTO account_state(id, initial_capital_cny, cash_cny, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(this.config.initialCapitalCny, this.config.initialCapitalCny, new Date().toISOString());
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

  close() {
    this.db.close();
  }

  getAccount() {
    return this.db.prepare("SELECT * FROM account_state WHERE id = 1").get();
  }

  insertSnapshot(report) {
    const result = this.db.prepare(`
      INSERT INTO snapshots(
        captured_at, symbol, price, decision, candidate_decision, confidence_pct,
        final_score, funding_rate_pct, oi_usd, pressure_score, risk_gates_json, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.generatedAt,
      report.symbol,
      report.currentPrice,
      report.decision,
      report.candidateDecision,
      report.confidencePct,
      report.finalScore,
      report.derivatives?.fundingRatePct,
      report.derivatives?.oiUsd,
      report.derivatives?.pressureScore,
      json(report.riskGates),
      json(report)
    );
    return Number(result.lastInsertRowid);
  }

  getLatestSnapshot() {
    const row = this.db.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row, riskGates: parseJson(row.risk_gates_json, []), report: parseJson(row.report_json) } : null;
  }

  countSnapshots() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count);
  }

  getOpenPosition() {
    const row = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row, openingReasons: parseJson(row.opening_reasons_json, []) } : null;
  }

  openPosition(candidate, snapshotId) {
    return this.transaction(() => {
      if (this.getOpenPosition()) throw new Error("Paper position already open");
      const account = this.getAccount();
      const newBalance = Number(account.cash_cny) - candidate.entryFeeCny;
      const result = this.db.prepare(`
        INSERT INTO positions(
          snapshot_id, symbol, side, status, opened_at, entry_bar_ts, entry_price,
          stop_loss, take_profit, rr, quantity_btc, risk_cny, notional_cny,
          entry_fee_cny, opening_reasons_json, last_funding_at
        ) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        candidate.symbol,
        candidate.side,
        candidate.openedAt,
        candidate.entryBarTs,
        candidate.entry,
        candidate.stopLoss,
        candidate.takeProfit,
        candidate.rr,
        candidate.quantityBtc,
        candidate.riskCny,
        candidate.notionalCny,
        candidate.entryFeeCny,
        json(candidate.openingReasons),
        candidate.openedAt
      );
      const positionId = Number(result.lastInsertRowid);
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1")
        .run(newBalance, candidate.openedAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'ENTRY_FEE', ?, ?, ?, ?)
      `).run(candidate.openedAt, -candidate.entryFeeCny, newBalance, positionId, json({ rate: this.config.feeRatePerSide }));
      return this.getPosition(positionId);
    });
  }

  getPosition(id) {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id);
    return row ? { ...row, openingReasons: parseJson(row.opening_reasons_json, []) } : null;
  }

  applyFunding(positionId, cashflowCny, settledAt, details) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Cannot fund a closed paper position");
      const account = this.getAccount();
      const newBalance = Number(account.cash_cny) + cashflowCny;
      this.db.prepare(`
        UPDATE positions
        SET funding_cny = funding_cny + ?, last_funding_at = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(cashflowCny, settledAt, positionId);
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1")
        .run(newBalance, settledAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'FUNDING', ?, ?, ?, ?)
      `).run(settledAt, cashflowCny, newBalance, positionId, json(details));
      return this.getPosition(positionId);
    });
  }

  closePosition(positionId, exit) {
    return this.transaction(() => {
      const position = this.getPosition(positionId);
      if (!position || position.status !== "OPEN") throw new Error("Paper position is not open");
      const netPnl = exit.grossPnlCny + Number(position.funding_cny) - Number(position.entry_fee_cny) - exit.exitFeeCny;
      const account = this.getAccount();
      const cashDelta = exit.grossPnlCny - exit.exitFeeCny;
      const newBalance = Number(account.cash_cny) + cashDelta;
      this.db.prepare(`
        UPDATE positions SET
          status = 'CLOSED', closed_at = ?, exit_price = ?, exit_reason = ?,
          exit_fee_cny = ?, gross_pnl_cny = ?, net_pnl_cny = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(exit.closedAt, exit.exitPrice, exit.exitReason, exit.exitFeeCny, exit.grossPnlCny, netPnl, positionId);
      this.db.prepare("UPDATE account_state SET cash_cny = ?, updated_at = ? WHERE id = 1")
        .run(newBalance, exit.closedAt);
      this.db.prepare(`
        INSERT INTO account_events(occurred_at, event_type, amount_cny, balance_after_cny, position_id, details_json)
        VALUES (?, 'CLOSE', ?, ?, ?, ?)
      `).run(exit.closedAt, cashDelta, newBalance, positionId, json({
        exitPrice: exit.exitPrice,
        exitReason: exit.exitReason,
        grossPnlCny: exit.grossPnlCny,
        exitFeeCny: exit.exitFeeCny,
        netPnlCny: netPnl
      }));
      return this.getPosition(positionId);
    });
  }

  getClosedPositions({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED' AND closed_at >= ? ORDER BY closed_at, id").all(since)
      : this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED' ORDER BY closed_at, id").all();
    return rows.map((row) => ({ ...row, openingReasons: parseJson(row.opening_reasons_json, []) }));
  }

  getAccountEvents({ since = null } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM account_events WHERE occurred_at >= ? ORDER BY id").all(since)
      : this.db.prepare("SELECT * FROM account_events ORDER BY id").all();
    return rows.map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
  }

  recordMonitorRun({ startedAt, finishedAt, status, message, snapshotId = null }) {
    this.db.prepare(`
      INSERT INTO monitor_runs(started_at, finished_at, status, message, snapshot_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(startedAt, finishedAt, status, message, snapshotId);
  }

  getLatestMonitorRun() {
    return this.db.prepare("SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 1").get() ?? null;
  }
}

export function openPaperDatabase(path = PAPER_CONFIG.databasePath, config = PAPER_CONFIG, options = {}) {
  return new PaperDatabase(path, config, options);
}
