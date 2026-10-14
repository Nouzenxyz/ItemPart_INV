import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = path.join(DATA_DIR, 'inventory.db');

/**
 * Version 1 of this program kept one row per part code. Version 2 keeps one row per line of the
 * inventory sheet (the same part code can appear under several models, descriptions and locations).
 * If an old database is found, it is kept aside as a backup and its users are carried over.
 */
function setAsideOldDatabase(): string | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const probe = new Database(DB_PATH);
  let isOld = false;
  try {
    const cols = probe.prepare('PRAGMA table_info(items)').all() as { name: string }[];
    isOld = cols.length > 0 && !cols.some((c) => c.name === 'location_id');
  } finally {
    probe.close();
  }
  if (!isOld) return null;
  const backup = path.join(DATA_DIR, `inventory-before-v2-${Date.now()}.db`);
  fs.renameSync(DB_PATH, backup);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + ext)) fs.renameSync(DB_PATH + ext, backup + ext);
  }
  console.log(`Old database kept as ${path.basename(backup)}. Starting the new layout.`);
  return backup;
}

const oldDatabase = setAsideOldDatabase();

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin','staff','viewer')),
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

-- One row per line of the inventory sheet: model, part code, description, location and quantity.
-- The same part code can appear on many lines. A quantity below zero is a parts debt.
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  model       TEXT NOT NULL DEFAULT '',
  part_code   TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  location_id INTEGER REFERENCES locations(id),
  quantity    INTEGER NOT NULL DEFAULT 0,
  min_stock   INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  safety_stock INTEGER CHECK (safety_stock IS NULL OR safety_stock >= 0),
  target_coverage_days INTEGER CHECK (target_coverage_days IS NULL OR target_coverage_days >= 0),
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_items_part ON items(part_code);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);

-- Repair cases describe the appliance being serviced, separate from the part catalog model.
CREATE TABLE IF NOT EXISTS service_jobs (
  id             INTEGER PRIMARY KEY,
  job_no         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  appliance_model TEXT NOT NULL,
  serial_no      TEXT NOT NULL DEFAULT '',
  technician     TEXT NOT NULL DEFAULT '',
  complaint      TEXT NOT NULL DEFAULT '',
  failure_code   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED')),
  repair_outcome TEXT NOT NULL DEFAULT '',
  opened_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at      TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_service_jobs_model ON service_jobs(appliance_model, opened_at);

-- Draft and ordered replenishment plans created from the restock-priority report.
CREATE TABLE IF NOT EXISTS restock_orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
  supplier TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ORDERED','PARTIAL','RECEIVED','CANCELLED')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ordered_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS restock_order_lines (
  id INTEGER PRIMARY KEY,
  restock_order_id INTEGER NOT NULL REFERENCES restock_orders(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  suggested_qty INTEGER NOT NULL DEFAULT 0 CHECK (suggested_qty >= 0),
  order_qty INTEGER NOT NULL CHECK (order_qty > 0),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  UNIQUE(restock_order_id,item_id)
);
CREATE INDEX IF NOT EXISTS idx_restock_order_lines_order ON restock_order_lines(restock_order_id);

-- Header fields shared by every line in a stock-in or stock-out transaction.
CREATE TABLE IF NOT EXISTS stock_transactions (
  id             INTEGER PRIMARY KEY,
  transaction_no TEXT UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('IN','OUT','RETURN')),
  stock_type     TEXT NOT NULL DEFAULT '',
  supplier       TEXT NOT NULL DEFAULT '',
  ss_no          TEXT NOT NULL DEFAULT '',
  packing_list   TEXT NOT NULL DEFAULT '',
  batch_no       TEXT NOT NULL DEFAULT '',
  requisition_no TEXT NOT NULL DEFAULT '',
  document_ref   TEXT NOT NULL DEFAULT '',
  technician     TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  service_job_id INTEGER REFERENCES service_jobs(id),
  purchase_order_id INTEGER REFERENCES restock_orders(id),
  status         TEXT NOT NULL DEFAULT 'POSTED',
  created_by     INTEGER REFERENCES users(id),
  approved_by    INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Unposted Stock In/Out forms are saved per account and never affect inventory until posted.
CREATE TABLE IF NOT EXISTS stock_transaction_drafts (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('IN','OUT')),
  payload_json TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stock_transaction_drafts_user ON stock_transaction_drafts(created_by,updated_at DESC);

-- Every change to a line is recorded here. Never edited, never deleted.
CREATE TABLE IF NOT EXISTS movements (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER REFERENCES stock_transactions(id),
  item_id        INTEGER NOT NULL REFERENCES items(id),
  location_id    INTEGER REFERENCES locations(id),
  qty_change     INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  type           TEXT NOT NULL,
  reference      TEXT NOT NULL DEFAULT '',
  destination    TEXT NOT NULL DEFAULT '',
  technician     TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  transfer_group TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_movements_item ON movements(item_id, id DESC);

-- Stock issued against a repair. Actual installed quantities are completed later.
CREATE TABLE IF NOT EXISTS service_job_parts (
  id                INTEGER PRIMARY KEY,
  service_job_id    INTEGER NOT NULL REFERENCES service_jobs(id),
  transaction_id    INTEGER NOT NULL REFERENCES stock_transactions(id),
  item_id           INTEGER NOT NULL REFERENCES items(id),
  qty_issued        INTEGER NOT NULL CHECK (qty_issued > 0),
  qty_used          INTEGER CHECK (qty_used IS NULL OR qty_used >= 0),
  UNIQUE (transaction_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_service_job_parts_job ON service_job_parts(service_job_id);

-- Returned parts are recorded for failure analysis. They do not change stock; reusable stock
-- must separately go through a Stock In transaction so inventory and service reporting stay auditable.
CREATE TABLE IF NOT EXISTS service_job_returns (
  id                 INTEGER PRIMARY KEY,
  service_job_id     INTEGER NOT NULL REFERENCES service_jobs(id),
  item_id            INTEGER NOT NULL REFERENCES items(id),
  qty_returned       INTEGER NOT NULL CHECK (qty_returned > 0),
  returned_condition TEXT NOT NULL DEFAULT '',
  return_reason      TEXT NOT NULL DEFAULT '',
  recorded_by        INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_service_job_returns_job ON service_job_returns(service_job_id);

CREATE TABLE IF NOT EXISTS import_log (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  filename   TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// Add columns introduced after the initial release without replacing or rewriting inventory data.
const ensureColumn = (table: string, name: string, definition: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
};
ensureColumn('items', 'lead_time_days', 'INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0)');
ensureColumn('items', 'safety_stock', 'INTEGER CHECK (safety_stock IS NULL OR safety_stock >= 0)');
ensureColumn('items', 'target_coverage_days', 'INTEGER CHECK (target_coverage_days IS NULL OR target_coverage_days >= 0)');
ensureColumn('movements', 'transaction_id', 'INTEGER REFERENCES stock_transactions(id)');
ensureColumn('stock_transactions', 'service_job_id', 'INTEGER REFERENCES service_jobs(id)');
ensureColumn('stock_transactions', 'purchase_order_id', 'INTEGER REFERENCES restock_orders(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_movements_transaction ON movements(transaction_id, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_stock_transactions_service_job ON stock_transactions(service_job_id)');

if (oldDatabase) {
  try {
    db.prepare('ATTACH DATABASE ? AS old').run(oldDatabase);
    db.exec(
      'INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, active) SELECT id, username, password_hash, full_name, role, active FROM old.users'
    );
    db.exec('DETACH DATABASE old');
    console.log('Users were carried over from the old database.');
  } catch (e) {
    console.error('Could not carry the users over:', e);
  }
}

// First run: create a default admin.
const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (userCount === 0) {
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(
    'admin',
    bcrypt.hashSync('admin123', 10),
    'Administrator',
    'admin'
  );
  console.log('First run: created user "admin" with password "admin123". Change it after logging in.');
}
