import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { authenticate, createSession, destroySession, requireRole } from './auth';
import { createManualBackup, listBackups, resolveBackup, startBackups } from './backup';
import { db } from './db';
import * as xl from './excel';
import { buildPartSearch, lineCount, lineRows, parseStatus, summary } from './queries';
import { applyMovement, countStock, countStockBatch, DebtWarning, logEdit, setQuantity, StockError, transferStock } from './stock';

const PORT = Number(process.env.PORT) || 3000;

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();
const tidy = (v: unknown) => str(v).replace(/\s+/g, ' ');
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};
const stamp = () => new Date().toISOString().slice(0, 10);
const handle =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function sendXlsx(res: Response, buf: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

function checkItem(itemId: number) {
  if (!db.prepare('SELECT 1 FROM items WHERE id = ? AND archived = 0').get(itemId)) {
    throw new StockError('That item does not exist or was removed.');
  }
}

/** An optional location: empty means no location. */
function readLocation(v: unknown): number | null {
  if (v === '' || v === null || v === undefined || Number(v) === 0) return null;
  const id = int(v);
  if (Number.isNaN(id) || !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) throw new StockError('Choose a valid location.');
  return id;
}

function readItemBody(body: any) {
  const part = tidy(body?.part_code);
  if (!part) throw new StockError('Part code is required.');
  const min = body?.min_stock === '' || body?.min_stock === undefined ? 0 : int(body.min_stock);
  if (Number.isNaN(min) || min < 0) throw new StockError('Minimum stock must be a whole number, zero or more.');
  const quantity = body?.quantity === '' || body?.quantity === undefined ? 0 : int(body.quantity);
  if (Number.isNaN(quantity)) throw new StockError('Quantity must be a whole number (a negative number is a parts debt).');
  const optionalNonnegative = (value: unknown, label: string): number | null => {
    if (value === '' || value === null || value === undefined) return null;
    const n = int(value);
    if (Number.isNaN(n) || n < 0) throw new StockError(`${label} must be a whole number, zero or more.`);
    return n;
  };
  return {
    model: tidy(body?.model), part, description: tidy(body?.description), min, quantity,
    locationId: readLocation(body?.location_id),
    leadTimeDays: optionalNonnegative(body?.lead_time_days, 'Supplier lead time'),
    safetyStock: optionalNonnegative(body?.safety_stock, 'Safety stock'),
    targetCoverageDays: optionalNonnegative(body?.target_coverage_days, 'Target coverage'),
  };
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.resolve(process.cwd(), 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const api = express.Router();

/* ---------- login ---------- */

api.post('/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(str(req.body?.username)) as
    | { id: number; username: string; full_name: string; role: string; password_hash: string }
    | undefined;
  if (!user || !bcrypt.compareSync(str(req.body?.password), user.password_hash)) {
    res.status(401).json({ error: 'Wrong username or password.' });
    return;
  }
  res.cookie('sid', createSession(user.id), { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role });
});

api.use(authenticate);

api.post('/logout', (req, res) => {
  destroySession(req.cookies?.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

api.get('/me', (req, res) => {
  res.json(req.user);
});

/* ---------- locations ---------- */

api.get('/locations', (_req, res) => {
  res.json(db.prepare('SELECT id, name FROM locations ORDER BY name').all());
});

api.post('/locations', requireRole('admin'), (req, res) => {
  const name = tidy(req.body?.name);
  if (!name) throw new StockError('Location name is required.');
  try {
    db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new StockError('That location already exists.');
    throw e;
  }
  res.json({ ok: true });
});

/* ---------- inventory lines ---------- */

api.get('/summary', (_req, res) => {
  res.json(summary());
});

api.get('/parts', (req, res) => {
  const search = str(req.query.search);
  const matches = buildPartSearch(search, 'matched', 'matched_location');
  const totals = buildPartSearch(search);
  const requestedLimit = int(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 500;
  const requestedOffset = int(req.query.offset);
  const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
  const rows = db.prepare(`SELECT MIN(i.id) AS id,
      (SELECT group_concat(model,char(31)) FROM (SELECT DISTINCT NULLIF(TRIM(m.model),'') AS model FROM items m WHERE m.archived=0 AND m.part_code=i.part_code COLLATE NOCASE AND NULLIF(TRIM(m.model),'') IS NOT NULL ORDER BY model)) AS model,
      MIN(i.part_code) AS part_code,
      (SELECT group_concat(description,char(31)) FROM (SELECT DISTINCT NULLIF(TRIM(d.description),'') AS description FROM items d WHERE d.archived=0 AND d.part_code=i.part_code COLLATE NOCASE AND NULLIF(TRIM(d.description),'') IS NOT NULL ORDER BY description)) AS description,
      SUM(i.quantity) AS total_quantity, SUM(i.min_stock) AS total_min_stock
    FROM items i
    WHERE i.archived=0 AND EXISTS (
      SELECT 1 FROM items matched LEFT JOIN locations matched_location ON matched_location.id=matched.location_id
      WHERE matched.archived=0 AND matched.part_code=i.part_code COLLATE NOCASE
        AND (${matches.clause})
    )
      GROUP BY i.part_code COLLATE NOCASE ORDER BY part_code COLLATE NOCASE LIMIT @limit OFFSET @offset`).all({ ...matches.params, limit, offset });
  const total = (db.prepare(`SELECT COUNT(DISTINCT i.part_code COLLATE NOCASE) AS n
    FROM items i LEFT JOIN locations l ON l.id=i.location_id
      WHERE i.archived=0 AND (${totals.clause})`)
    .get(totals.params) as { n: number }).n;
  res.json({ rows, total });
});

api.get('/parts/:id/locations', (req, res) => {
  const id = int(req.params.id);
  const exemplar = db.prepare('SELECT part_code FROM items WHERE id=? AND archived=0').get(id) as
    { part_code: string } | undefined;
  if (!exemplar) throw new StockError('That part is no longer available.');
  res.json(db.prepare(`SELECT i.location_id,l.name AS location,i.model,i.description,SUM(i.quantity) AS quantity,COUNT(*) AS lines
    FROM items i LEFT JOIN locations l ON l.id=i.location_id
    WHERE i.archived=0 AND i.part_code=? COLLATE NOCASE
    GROUP BY i.location_id,i.model,i.description ORDER BY l.name,i.model,i.description`).all(exemplar.part_code));
});

api.get('/consumption', (_req, res) => {
  // Net consumption is Stock Out minus Returns; transfers and adjustments are excluded.
  const rows = db.prepare(`SELECT m.item_id,i.model,i.part_code,i.description,i.quantity,i.lead_time_days,i.safety_stock,i.target_coverage_days,l.name AS location,
      COALESCE(SUM(CASE WHEN m.type='OUT' AND date(m.created_at)>=date('now','-90 days') THEN -m.qty_change
                        WHEN m.type='RETURN' AND date(m.created_at)>=date('now','-90 days') THEN -m.qty_change ELSE 0 END),0) AS used_90,
      COALESCE(SUM(CASE WHEN m.type='OUT' AND date(m.created_at)>=date('now','-365 days') THEN -m.qty_change
                        WHEN m.type='RETURN' AND date(m.created_at)>=date('now','-365 days') THEN -m.qty_change ELSE 0 END),0) AS used_365
    FROM items i LEFT JOIN movements m ON m.item_id=i.id LEFT JOIN locations l ON l.id=i.location_id WHERE i.archived=0
    GROUP BY i.id ORDER BY i.model,i.part_code`).all() as any[];
  res.json(rows.map((r) => {
    const daily = Math.max(0, Number(r.used_90)) / 90;
    const configured = r.lead_time_days !== null && r.safety_stock !== null && r.target_coverage_days !== null;
    const reorderPoint = configured ? daily * Number(r.lead_time_days) + Number(r.safety_stock) : null;
    const suggested = configured ? Math.max(0, Math.ceil(daily * (Number(r.lead_time_days) + Number(r.target_coverage_days)) + Number(r.safety_stock) - Number(r.quantity))) : null;
    return { ...r, avg_monthly_3: Number(r.used_90) / 3, avg_monthly_year: Number(r.used_365) / 12, reorder_point: reorderPoint, suggested_order: suggested,
      restock_now: configured && daily > 0 && Number(r.quantity) <= Number(reorderPoint) };
  }));
});

// Compact report endpoints: the browser only receives summary data and the top 30 priorities.
api.get('/report/overview', (_req, res) => {
  const kpis = db.prepare(`SELECT
    (SELECT COUNT(*) FROM service_jobs WHERE date(opened_at)>=date('now','localtime','start of month')) AS repairs_this_month,
    (SELECT COUNT(*) FROM service_jobs WHERE status='OPEN') AS open_repairs,
    (SELECT COALESCE(SUM(-m.qty_change),0) FROM movements m WHERE m.type='OUT' AND date(m.created_at)>=date('now','localtime','start of month')) AS parts_issued_this_month,
    (SELECT COALESCE(SUM(r.qty_returned),0) FROM service_job_returns r WHERE date(r.created_at)>=date('now','localtime','start of month')) AS parts_returned_this_month,
    (SELECT COUNT(*) FROM items WHERE archived=0 AND quantity<0) AS debt_lines,
    (SELECT COUNT(*) FROM items WHERE archived=0 AND (lead_time_days IS NULL OR safety_stock IS NULL OR target_coverage_days IS NULL)) AS restock_profiles_missing`).get();
  const monthly = db.prepare(`SELECT strftime('%Y-%m',opened_at) AS month,COUNT(*) AS jobs FROM service_jobs
    WHERE date(opened_at)>=date('now','localtime','start of month','-11 months') GROUP BY strftime('%Y-%m',opened_at) ORDER BY month`).all();
  const models = db.prepare(`SELECT appliance_model AS model,COUNT(*) AS jobs FROM service_jobs
    WHERE date(opened_at)>=date('now','localtime','start of month','-11 months') GROUP BY appliance_model ORDER BY jobs DESC,model LIMIT 6`).all();
  const returns = db.prepare(`SELECT returned_condition AS condition,SUM(qty_returned) AS quantity FROM service_job_returns
    WHERE date(created_at)>=date('now','localtime','start of month','-11 months') GROUP BY returned_condition ORDER BY quantity DESC LIMIT 5`).all();
  res.json({ kpis, monthly, models, returns });
});

api.get('/usage-report', (req, res) => {
  const periodKey = str(req.query.period) === '12m' ? '12m' : '3m';
  const days = periodKey === '12m' ? 365 : 90;
  const months = periodKey === '12m' ? 12 : 3;
  const modifier = `-${days} days`;
  const limit = Math.min(Math.max(int(req.query.limit) || 50, 1), 500);
  const offset = Math.max(int(req.query.offset) || 0, 0);
  const search = str(req.query.search);
  const q = `%${search}%`;
  const locationId = Math.max(int(req.query.locationId) || 0, 0);
  if (locationId && !db.prepare('SELECT 1 FROM locations WHERE id=?').get(locationId)) throw new StockError('Choose a valid location.');
  const rows = db.prepare(`WITH usage AS (
      SELECT item_id,SUM(CASE WHEN type='OUT' THEN -qty_change ELSE 0 END) AS issued,
        SUM(CASE WHEN type='RETURN' THEN qty_change ELSE 0 END) AS returned
      FROM movements WHERE type IN ('OUT','RETURN') AND date(created_at)>=date('now','localtime',?) GROUP BY item_id
    )
    SELECT i.id,i.model,i.part_code,i.description,i.quantity,l.name AS location,
      COALESCE(u.issued,0) AS issued,COALESCE(u.returned,0) AS returned,
      COALESCE(u.issued,0)-COALESCE(u.returned,0) AS net_used
    FROM items i LEFT JOIN locations l ON l.id=i.location_id LEFT JOIN usage u ON u.item_id=i.id
    WHERE i.archived=0 AND (COALESCE(u.issued,0)>0 OR COALESCE(u.returned,0)>0)
      AND (?=0 OR i.location_id=?) AND (i.model LIKE ? OR i.part_code LIKE ? OR i.description LIKE ? OR COALESCE(l.name,'') LIKE ?)
    ORDER BY net_used DESC,issued DESC,i.model,i.part_code`).all(modifier,locationId,locationId,q,q,q,q) as any[];
  const normalized = rows.map((r) => {
    const issued = Number(r.issued), returned = Number(r.returned), netUsed = Number(r.net_used);
    const daily = netUsed / days;
    return { ...r, issued, returned, net_used: netUsed, avg_monthly: netUsed / months,
      days_cover: daily > 0 && Number(r.quantity) > 0 ? Number(r.quantity) / daily : null };
  });
  const summary = normalized.reduce((acc,r) => ({ lines: acc.lines + 1, issued: acc.issued + r.issued, returned: acc.returned + r.returned, net_used: acc.net_used + r.net_used }),
    { lines: 0, issued: 0, returned: 0, net_used: 0 });
  const trend = db.prepare(`SELECT strftime('%Y-%m',m.created_at) AS month,
      SUM(CASE WHEN m.type='OUT' THEN -m.qty_change ELSE 0 END) AS issued,
      SUM(CASE WHEN m.type='RETURN' THEN m.qty_change ELSE 0 END) AS returned
    FROM movements m JOIN items i ON i.id=m.item_id LEFT JOIN locations l ON l.id=i.location_id
    WHERE i.archived=0 AND m.type IN ('OUT','RETURN') AND date(m.created_at)>=date('now','localtime','start of month','-11 months')
      AND (?=0 OR i.location_id=?) AND (i.model LIKE ? OR i.part_code LIKE ? OR i.description LIKE ? OR COALESCE(l.name,'') LIKE ?)
    GROUP BY strftime('%Y-%m',m.created_at) ORDER BY month`).all(locationId,locationId,q,q,q,q);
  res.json({ period: periodKey, summary, top: normalized.filter((r) => r.net_used > 0).slice(0,8), trend,
    rows: normalized.slice(offset,offset+limit), total: normalized.length, limit, offset });
});

api.get('/restock-orders', (_req, res) => {
  res.json(db.prepare(`SELECT o.id,o.order_no,o.supplier,o.status,o.created_at,o.ordered_at,u.username AS created_by,
      COUNT(l.id) AS line_count,COALESCE(SUM(l.order_qty),0) AS order_units,COALESCE(SUM(l.received_qty),0) AS received_units
    FROM restock_orders o LEFT JOIN restock_order_lines l ON l.restock_order_id=o.id LEFT JOIN users u ON u.id=o.created_by
    GROUP BY o.id ORDER BY o.id DESC LIMIT 500`).all());
});
api.get('/restock-orders/:id', (req, res) => {
  const id = int(req.params.id);
  const order = db.prepare('SELECT * FROM restock_orders WHERE id=?').get(id);
  if (!order) throw new StockError('Restock order not found.');
  const lines = db.prepare(`SELECT l.id,l.item_id,l.suggested_qty,l.order_qty,l.received_qty,i.model,i.part_code,i.description,i.quantity,i.location_id,loc.name AS location
    FROM restock_order_lines l JOIN items i ON i.id=l.item_id LEFT JOIN locations loc ON loc.id=i.location_id WHERE l.restock_order_id=? ORDER BY i.model,i.part_code`).all(id);
  res.json({order,lines});
});
api.post('/restock-orders', requireRole('admin','staff'), (req,res) => {
  const supplier = str(req.body?.supplier);
  const lines = req.body?.lines;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 200) throw new StockError('Select between 1 and 200 parts for the draft order.');
  const normalized = lines.map((line:any) => {
    const itemId=int(line.item_id), orderQty=int(line.order_qty), suggestedQty=int(line.suggested_qty ?? 0);
    checkItem(itemId);
    if (!Number.isInteger(orderQty) || orderQty < 1) throw new StockError('Each order quantity must be a whole number greater than zero.');
    if (!Number.isInteger(suggestedQty) || suggestedQty < 0) throw new StockError('Suggested quantities must be zero or more.');
    return {itemId,orderQty,suggestedQty};
  });
  if (new Set(normalized.map((l) => l.itemId)).size !== normalized.length) throw new StockError('A part line can only appear once in an order.');
  const result = db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO restock_orders (order_no,supplier,created_by) VALUES (?,?,?)").run(`PENDING-${crypto.randomUUID()}`,supplier,req.user!.id).lastInsertRowid);
    const orderNo = `PO-${new Date().getFullYear()}-${String(id).padStart(6,'0')}`;
    db.prepare('UPDATE restock_orders SET order_no=? WHERE id=?').run(orderNo,id);
    const insert = db.prepare('INSERT INTO restock_order_lines (restock_order_id,item_id,suggested_qty,order_qty) VALUES (?,?,?,?)');
    for (const line of normalized) insert.run(id,line.itemId,line.suggestedQty,line.orderQty);
    return {id,orderNo};
  })();
  res.json(result);
});
api.put('/restock-orders/:id', requireRole('admin','staff'), (req,res) => {
  const id=int(req.params.id), status=str(req.body?.status), supplier=str(req.body?.supplier);
  if (!['ORDERED','CANCELLED'].includes(status)) throw new StockError('Choose Ordered or Cancelled.');
  const current=db.prepare('SELECT status FROM restock_orders WHERE id=?').get(id) as {status:string}|undefined;
  if (!current) throw new StockError('Restock order not found.');
  if (current.status!=='DRAFT') throw new StockError('Only a draft can be changed to Ordered or Cancelled.');
  db.prepare(`UPDATE restock_orders SET supplier=?,status=?,ordered_at=CASE WHEN ?='ORDERED' THEN datetime('now','localtime') ELSE NULL END,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(supplier,status,status,id);
  res.json({ok:true});
});

function calculateRestockPriorities() {
  const rows = db.prepare(`SELECT i.id,i.model,i.part_code,i.description,i.quantity,i.min_stock,i.lead_time_days,i.safety_stock,i.target_coverage_days,
      l.name AS location,COALESCE(u.used_90,0) AS used_90
    FROM items i LEFT JOIN locations l ON l.id=i.location_id
    LEFT JOIN (SELECT item_id,SUM(CASE WHEN type='OUT' THEN -qty_change WHEN type='RETURN' THEN -qty_change ELSE 0 END) AS used_90
      FROM movements WHERE type IN ('OUT','RETURN') AND date(created_at)>=date('now','localtime','-90 days') GROUP BY item_id) u ON u.item_id=i.id
    WHERE i.archived=0`).all() as any[];
  const prioritized = rows.map((r) => {
    const used = Math.max(0, Number(r.used_90));
    const daily = used / 90;
    const configured = r.lead_time_days !== null && r.safety_stock !== null && r.target_coverage_days !== null;
    const reorderPoint = configured ? daily * Number(r.lead_time_days) + Number(r.safety_stock) : Number(r.min_stock);
    const suggested: number | null = configured
      ? Math.max(0, Math.ceil(daily * (Number(r.lead_time_days) + Number(r.target_coverage_days)) + Number(r.safety_stock) - Number(r.quantity)))
      : Math.max(0, Number(r.min_stock) - Number(r.quantity));
    const debt = Number(r.quantity) < 0;
    const belowReorder = Number(r.quantity) <= reorderPoint && (daily > 0 || Number(r.min_stock) > 0 || debt);
    const missingProfileDemand = !configured && daily > 0 && Number(r.quantity) <= used / 3;
    const reason = debt ? 'Negative stock' : configured && belowReorder ? 'At or below reorder point' : Number(r.min_stock) > 0 && Number(r.quantity) <= Number(r.min_stock) ? 'At or below minimum' : configured && suggested > 0 ? 'Below target coverage' : missingProfileDemand ? 'Set restock profile' : '';
    return { ...r, used_90: used, suggested_order: suggested, priority_score: (debt ? 1000000 : 0) + (belowReorder ? 100000 : 0) + Math.max(0, reorderPoint - Number(r.quantity)) * 100 + daily * 10, reason };
  }).filter((r) => r.reason)
    .sort((a,b) => b.priority_score-a.priority_score || (b.suggested_order ?? 0)-(a.suggested_order ?? 0) || a.model.localeCompare(b.model) || a.part_code.localeCompare(b.part_code));
  return prioritized.map((r,i)=>({...r,priority:i+1}));
}
api.get('/restock-priorities', (req, res) => {
  const limit = Math.min(Math.max(int(req.query.limit) || 50, 1), 500);
  const offset = Math.max(int(req.query.offset) || 0, 0);
  const q = str(req.query.search).trim().toLocaleLowerCase();
  const prioritized=calculateRestockPriorities();
  const filtered = q ? prioritized.filter((r) => [r.part_code, r.model, r.description, r.location ?? ''].some((value) => String(value).toLocaleLowerCase().includes(q))) : prioritized;
  res.json({ rows: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
});

api.get('/restock-profiles', (req, res) => {
  const limit = Math.min(Math.max(int(req.query.limit) || 50, 1), 500);
  const offset = Math.max(int(req.query.offset) || 0, 0);
  const where = 'archived=0 AND (lead_time_days IS NULL OR safety_stock IS NULL OR target_coverage_days IS NULL)';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where}`).get() as {n:number}).n;
  const rows = db.prepare(`SELECT i.id,i.model,i.part_code,i.description,i.quantity,i.min_stock,i.lead_time_days,i.safety_stock,i.target_coverage_days,l.name AS location
    FROM items i LEFT JOIN locations l ON l.id=i.location_id WHERE i.archived=0 AND (i.lead_time_days IS NULL OR i.safety_stock IS NULL OR i.target_coverage_days IS NULL)
    ORDER BY i.model,i.part_code,l.name LIMIT ? OFFSET ?`).all(limit,offset);
  res.json({ rows, total, limit, offset });
});

api.get('/stock', (req, res) => {
  const search = str(req.query.search);
  const loc = int(req.query.locationId) || 0;
  const status = parseStatus(req.query.status);
  const limit = Math.min(int(req.query.limit) || 100, 1000);
  const offset = Math.max(int(req.query.offset) || 0, 0);
  res.json({ rows: lineRows(search, loc, status, limit, offset), total: lineCount(search, loc, status) });
});

api.get('/item-search', (req, res) => {
  const matches = buildPartSearch(str(req.query.q));
  res.json(db.prepare(`SELECT i.id, i.model, i.part_code, i.description, i.quantity, l.name AS location
    FROM items i LEFT JOIN locations l ON l.id=i.location_id
    WHERE i.archived=0 AND (${matches.clause})
    ORDER BY i.model,i.part_code,l.name LIMIT -1`).all(matches.params));
});

/* ---------- repair / service cases ---------- */

api.get('/repairs', (req, res) => {
  const q = `%${str(req.query.search)}%`;
  const status = str(req.query.status);
  const rows = db.prepare(`SELECT j.id,j.job_no,j.appliance_model,j.serial_no,j.technician,j.status,j.opened_at,j.closed_at,j.repair_outcome,
      COUNT(DISTINCT p.id) AS part_lines,COALESCE(SUM(p.qty_issued),0) AS qty_issued
    FROM service_jobs j LEFT JOIN service_job_parts p ON p.service_job_id=j.id
    WHERE (j.job_no LIKE @q OR j.appliance_model LIKE @q OR j.serial_no LIKE @q OR j.technician LIKE @q OR j.complaint LIKE @q)
      AND (@status='' OR j.status=@status)
    GROUP BY j.id ORDER BY j.opened_at DESC,j.id DESC LIMIT 500`).all({ q, status });
  res.json(rows);
});

api.post('/repairs', requireRole('admin', 'staff'), (req, res) => {
  const b = req.body ?? {};
  const text = (value: unknown, label: string, required = false) => {
    const result = str(value);
    if (required && !result) throw new StockError(`${label} is required.`);
    if (result.length > 500) throw new StockError(`${label} must be 500 characters or fewer.`);
    return result;
  };
  const requestedJobNo = text(b.job_no, 'Job number');
  const applianceModel = text(b.appliance_model, 'Appliance model', true);
  try {
    const created = db.transaction(() => {
      const temporaryNo = requestedJobNo || `PENDING-${crypto.randomUUID()}`;
      const result = db.prepare(`INSERT INTO service_jobs (job_no,appliance_model,serial_no,technician,complaint,failure_code,created_by)
        VALUES (?,?,?,?,?,?,?)`).run(temporaryNo, applianceModel, text(b.serial_no, 'Serial number'), text(b.technician, 'Technician'),
        text(b.complaint, 'Reported problem'), text(b.failure_code, 'Failure code'), req.user!.id);
      const id = Number(result.lastInsertRowid);
      const jobNo = requestedJobNo || `JOB-${new Date().getFullYear()}-${String(id).padStart(6,'0')}`;
      db.prepare('UPDATE service_jobs SET job_no=? WHERE id=?').run(jobNo,id);
      return { id, jobNo };
    })();
    res.json(created);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new StockError('That job number already exists.');
    throw error;
  }
});

api.get('/repairs/:id', (req, res) => {
  const id = int(req.params.id);
  const job = db.prepare(`SELECT j.*,u.username AS created_by_name FROM service_jobs j LEFT JOIN users u ON u.id=j.created_by WHERE j.id=?`).get(id);
  if (!job) throw new StockError('Repair job not found.');
  const parts = db.prepare(`SELECT p.id,p.qty_issued,p.qty_used,
      i.id AS item_id,i.model AS part_model,i.part_code,i.description,l.name AS location,t.transaction_no
    FROM service_job_parts p JOIN items i ON i.id=p.item_id LEFT JOIN locations l ON l.id=i.location_id
    LEFT JOIN stock_transactions t ON t.id=p.transaction_id WHERE p.service_job_id=? ORDER BY p.id`).all(id);
  const returns = db.prepare(`SELECT r.id,r.qty_returned,r.returned_condition,r.return_reason,r.created_at,
      i.id AS item_id,i.model AS part_model,i.part_code,i.description,l.name AS location,u.username AS recorded_by_name
    FROM service_job_returns r JOIN items i ON i.id=r.item_id LEFT JOIN locations l ON l.id=i.location_id
    LEFT JOIN users u ON u.id=r.recorded_by WHERE r.service_job_id=? ORDER BY r.id DESC`).all(id);
  res.json({ job, parts, returns });
});

api.put('/repairs/:id', requireRole('admin', 'staff'), (req, res) => {
  const id = int(req.params.id), b = req.body ?? {};
  const current = db.prepare('SELECT id,job_no FROM service_jobs WHERE id=?').get(id) as { id: number; job_no: string } | undefined;
  if (!current) throw new StockError('Repair job not found.');
  const jobNo = str(b.job_no) || current.job_no, applianceModel = str(b.appliance_model), status = str(b.status);
  if (!applianceModel) throw new StockError('Appliance model is required.');
  if (!['OPEN', 'COMPLETED'].includes(status)) throw new StockError('Choose Open or Completed.');
  const text = (value: unknown, label: string) => { const result = str(value); if (result.length > 500) throw new StockError(`${label} must be 500 characters or fewer.`); return result; };
  const outcome = text(b.repair_outcome,'Repair outcome');
  if (status === 'COMPLETED' && !outcome) throw new StockError('Record the repair outcome before completing the job.');
  try {
    db.prepare(`UPDATE service_jobs SET job_no=?,appliance_model=?,serial_no=?,technician=?,complaint=?,failure_code=?,status=?,repair_outcome=?,
      closed_at=CASE WHEN ?='COMPLETED' THEN COALESCE(closed_at,datetime('now','localtime')) ELSE NULL END WHERE id=?`)
      .run(jobNo, applianceModel, text(b.serial_no,'Serial number'), text(b.technician,'Technician'), text(b.complaint,'Reported problem'),
        text(b.failure_code,'Failure code'),status,outcome,status,id);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new StockError('That job number already exists.');
    throw error;
  }
  res.json({ ok: true });
});

api.put('/repairs/:id/parts/:partId', requireRole('admin', 'staff'), (req, res) => {
  const jobId = int(req.params.id), partId = int(req.params.partId), b = req.body ?? {};
  const part = db.prepare('SELECT qty_issued FROM service_job_parts WHERE id=? AND service_job_id=?').get(partId, jobId) as { qty_issued: number } | undefined;
  if (!part) throw new StockError('That part line is not attached to this repair.');
  const qtyUsed = int(b.qty_used);
  if (!Number.isInteger(qtyUsed) || qtyUsed < 0) throw new StockError('Used quantity must be a whole number, zero or more.');
  if (qtyUsed > part.qty_issued) throw new StockError('Used quantity cannot exceed the quantity issued.');
  db.prepare('UPDATE service_job_parts SET qty_used=? WHERE id=?').run(qtyUsed,partId);
  res.json({ ok: true });
});

api.post('/repairs/:id/returns', requireRole('admin', 'staff'), (req, res) => {
  const jobId = int(req.params.id), b = req.body ?? {}, itemId = int(b.item_id), quantity = int(b.quantity);
  const job = db.prepare("SELECT id FROM service_jobs WHERE id=? AND status='OPEN'").get(jobId);
  if (!job) throw new StockError('Choose an open repair job.');
  checkItem(itemId);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new StockError('Returned quantity must be a whole number greater than zero.');
  const condition = str(b.returned_condition), reason = str(b.return_reason);
  if (!condition) throw new StockError('Choose the returned part condition.');
  if (!reason) throw new StockError('Enter the return reason or failure observed.');
  if (condition.length > 100 || reason.length > 500) throw new StockError('Return details are too long.');
  db.prepare(`INSERT INTO service_job_returns (service_job_id,item_id,qty_returned,returned_condition,return_reason,recorded_by)
    VALUES (?,?,?,?,?,?)`).run(jobId,itemId,quantity,condition,reason,req.user!.id);
  res.json({ ok: true });
});

api.get('/repair-report', (req, res) => {
  const q = `%${str(req.query.search)}%`;
  const from = str(req.query.from), to = str(req.query.to);
  const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) throw new StockError('Choose a valid repair report date range.');
  const rows = db.prepare(`WITH issued AS (
      SELECT service_job_id,item_id,SUM(qty_issued) AS qty_issued,SUM(COALESCE(qty_used,0)) AS qty_used,COUNT(qty_used) AS usage_records
      FROM service_job_parts GROUP BY service_job_id,item_id
    ), returned AS (
      SELECT service_job_id,item_id,SUM(qty_returned) AS qty_returned,
        SUM(CASE WHEN lower(returned_condition) LIKE '%defect%' OR lower(returned_condition) LIKE '%warranty%' THEN qty_returned ELSE 0 END) AS defective_returns,
        GROUP_CONCAT(DISTINCT NULLIF(return_reason,'')) AS return_reasons
      FROM service_job_returns GROUP BY service_job_id,item_id
    ), job_items AS (
      SELECT service_job_id,item_id FROM issued UNION SELECT service_job_id,item_id FROM returned
    ), repeat_appliances AS (
      SELECT appliance_model,part_code,description,COUNT(*) AS repeat_count FROM (
        SELECT j.appliance_model,i.part_code,i.description,j.serial_no
        FROM job_items ji JOIN service_jobs j ON j.id=ji.service_job_id JOIN items i ON i.id=ji.item_id
        WHERE j.serial_no<>'' AND (@from='' OR date(j.opened_at)>=date(@from)) AND (@to='' OR date(j.opened_at)<=date(@to))
        GROUP BY j.appliance_model,i.part_code,i.description,j.serial_no HAVING COUNT(DISTINCT j.id)>1
      ) GROUP BY appliance_model,part_code,description
    )
    SELECT j.appliance_model,i.part_code,i.description,GROUP_CONCAT(DISTINCT j.job_no) AS job_numbers,
      COUNT(DISTINCT j.id) AS repair_jobs,COUNT(DISTINCT CASE WHEN j.status='COMPLETED' THEN j.id END) AS completed_jobs,
      SUM(COALESCE(issued.qty_issued,0)) AS qty_issued,SUM(COALESCE(issued.qty_used,0)) AS qty_used,SUM(COALESCE(issued.usage_records,0)) AS usage_records,
      SUM(COALESCE(returned.qty_returned,0)) AS qty_returned,SUM(COALESCE(returned.defective_returns,0)) AS defective_returns,
      GROUP_CONCAT(DISTINCT NULLIF(returned.return_reasons,'')) AS return_reasons,
      MAX(COALESCE(ra.repeat_count,0)) AS repeat_appliances,
      ROUND(AVG(CASE WHEN j.closed_at IS NOT NULL THEN julianday(j.closed_at)-julianday(j.opened_at) END),1) AS avg_days_to_close
    FROM job_items ji JOIN service_jobs j ON j.id=ji.service_job_id JOIN items i ON i.id=ji.item_id
      LEFT JOIN issued ON issued.service_job_id=ji.service_job_id AND issued.item_id=ji.item_id
      LEFT JOIN returned ON returned.service_job_id=ji.service_job_id AND returned.item_id=ji.item_id
      LEFT JOIN repeat_appliances ra ON ra.appliance_model=j.appliance_model AND ra.part_code=i.part_code AND ra.description=i.description
    WHERE (j.appliance_model LIKE @q OR i.part_code LIKE @q OR i.description LIKE @q OR j.job_no LIKE @q)
      AND (@from='' OR date(j.opened_at)>=date(@from)) AND (@to='' OR date(j.opened_at)<=date(@to))
    GROUP BY j.appliance_model,i.part_code,i.description ORDER BY repair_jobs DESC,j.appliance_model,i.part_code LIMIT 1000`).all({ q, from, to });
  res.json(rows);
});

api.post('/items', requireRole('admin', 'staff'), (req, res) => {
  const b = readItemBody(req.body);
  const same = db
    .prepare(
      `SELECT 1 FROM items
        WHERE archived = 0 AND model = ? COLLATE NOCASE AND part_code = ? AND description = ? COLLATE NOCASE AND location_id IS ?`
    )
    .get(b.model, b.part, b.description, b.locationId);
  if (same) {
    throw new StockError('A line with the same model, part code, description and location already exists. Use Receive on that line instead.');
  }
  db.transaction(() => {
    const r = db
      .prepare('INSERT INTO items (model, part_code, description, location_id, quantity, min_stock, lead_time_days, safety_stock, target_coverage_days) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)')
      .run(b.model, b.part, b.description, b.locationId, b.min, b.leadTimeDays, b.safetyStock, b.targetCoverageDays);
    if (b.quantity !== 0) setQuantity(Number(r.lastInsertRowid), b.quantity, req.user!.id, 'OPENING', 'Opening quantity when the item was added');
  })();
  res.json({ ok: true });
});

api.put('/items/:id', requireRole('admin', 'staff'), (req, res) => {
  const id = int(req.params.id);
  const b = readItemBody(req.body);
  db.transaction(() => {
    const old = db
      .prepare(
        `SELECT i.model, i.part_code, i.description, i.location_id, l.name AS loc, i.min_stock,
                i.lead_time_days, i.safety_stock, i.target_coverage_days
           FROM items i LEFT JOIN locations l ON l.id = i.location_id WHERE i.id = ? AND i.archived = 0`
      )
      .get(id) as {
        model: string; part_code: string; description: string; location_id: number | null; loc: string | null; min_stock: number;
        lead_time_days: number | null; safety_stock: number | null; target_coverage_days: number | null;
      } | undefined;
    if (!old) throw new StockError('That item does not exist.');
    const newLoc = b.locationId === null ? '' : (db.prepare('SELECT name FROM locations WHERE id = ?').get(b.locationId) as { name: string }).name;
    const changes: string[] = [];
    if (old.model !== b.model) changes.push(`model "${old.model}" to "${b.model}"`);
    if (old.part_code !== b.part) changes.push(`part code "${old.part_code}" to "${b.part}"`);
    if (old.description !== b.description) changes.push(`description "${old.description}" to "${b.description}"`);
    if (old.location_id !== b.locationId) changes.push(`location "${old.loc ?? ''}" to "${newLoc}"`);
    if (old.min_stock !== b.min) changes.push(`minimum stock ${old.min_stock} to ${b.min}`);
    if (old.lead_time_days !== b.leadTimeDays) changes.push(`supplier lead time ${old.lead_time_days ?? 'not set'} to ${b.leadTimeDays ?? 'not set'} days`);
    if (old.safety_stock !== b.safetyStock) changes.push(`safety stock ${old.safety_stock ?? 'not set'} to ${b.safetyStock ?? 'not set'}`);
    if (old.target_coverage_days !== b.targetCoverageDays) changes.push(`target coverage ${old.target_coverage_days ?? 'not set'} to ${b.targetCoverageDays ?? 'not set'} days`);
    db.prepare('UPDATE items SET model = ?, part_code = ?, description = ?, location_id = ?, min_stock = ?, lead_time_days = ?, safety_stock = ?, target_coverage_days = ? WHERE id = ?').run(
      b.model, b.part, b.description, b.locationId, b.min, b.leadTimeDays, b.safetyStock, b.targetCoverageDays, id
    );
    if (changes.length) logEdit(id, req.user!.id, `Details edited: ${changes.join('; ')}`);
  })();
  res.json({ ok: true });
});

api.put('/items/:id/restock-profile', requireRole('admin', 'staff'), (req, res) => {
  const id = int(req.params.id);
  const parseProfileValue = (value: unknown, label: string) => {
    const parsed = int(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new StockError(`${label} must be a whole number, zero or more.`);
    return parsed;
  };
  const lead = parseProfileValue(req.body?.lead_time_days, 'Supplier lead time');
  const safety = parseProfileValue(req.body?.safety_stock, 'Safety stock');
  const coverage = parseProfileValue(req.body?.target_coverage_days, 'Target coverage');
  const item = db.prepare('SELECT part_code,lead_time_days,safety_stock,target_coverage_days FROM items WHERE id=? AND archived=0').get(id) as
    {part_code:string;lead_time_days:number|null;safety_stock:number|null;target_coverage_days:number|null}|undefined;
  if (!item) throw new StockError('That inventory line does not exist.');
  const changes = [
    item.lead_time_days !== lead ? `supplier lead time ${item.lead_time_days ?? 'not set'} to ${lead} days` : '',
    item.safety_stock !== safety ? `safety stock ${item.safety_stock ?? 'not set'} to ${safety}` : '',
    item.target_coverage_days !== coverage ? `target coverage ${item.target_coverage_days ?? 'not set'} to ${coverage} days` : '',
  ].filter(Boolean);
  db.transaction(() => {
    db.prepare('UPDATE items SET lead_time_days=?,safety_stock=?,target_coverage_days=? WHERE id=?').run(lead,safety,coverage,id);
    if (changes.length) logEdit(id,req.user!.id,`Restock profile updated: ${changes.join('; ')}`);
  })();
  res.json({ ok: true });
});

api.delete('/items/:id', requireRole('admin'), (req, res) => {
  const id = int(req.params.id);
  const item = db.prepare('SELECT part_code, quantity FROM items WHERE id = ? AND archived = 0').get(id) as
    | { part_code: string; quantity: number }
    | undefined;
  if (!item) throw new StockError('That item does not exist.');
  if (item.quantity > 0) {
    throw new StockError(`${item.part_code} still has ${item.quantity} in stock. Issue it or count it down to zero before removing it.`);
  }
  if (item.quantity < 0) {
    throw new StockError(`${item.part_code} has a parts debt of ${-item.quantity}. Receive stock to clear the debt before removing it.`);
  }
  if (db.prepare('SELECT 1 FROM movements WHERE item_id = ? LIMIT 1').get(id)) {
    // It has history, so keep the history and just hide the line.
    db.prepare('UPDATE items SET archived = 1 WHERE id = ?').run(id);
    res.json({ archived: true });
    return;
  }
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  res.json({ deleted: true });
});

/* ---------- stock changes ---------- */

api.get('/transaction-drafts', requireRole('admin', 'staff'), (req, res) => {
  const rows = db.prepare(`SELECT id,kind,created_at,updated_at,payload_json FROM stock_transaction_drafts
    WHERE created_by=? ORDER BY updated_at DESC,id DESC`).all(req.user!.id) as {id:number;kind:string;created_at:string;updated_at:string;payload_json:string}[];
  res.json(rows.map((row) => {
    let payload: any = {};
    try { payload = JSON.parse(row.payload_json); } catch { /* Ignore malformed legacy draft content. */ }
    return { id:row.id,kind:row.kind,created_at:row.created_at,updated_at:row.updated_at,line_count:Array.isArray(payload.lines)?payload.lines.length:0 };
  }));
});

api.get('/transaction-drafts/:id', requireRole('admin', 'staff'), (req, res) => {
  const id=int(req.params.id);
  const row=db.prepare('SELECT id,kind,payload_json FROM stock_transaction_drafts WHERE id=? AND created_by=?').get(id,req.user!.id) as {id:number;kind:'IN'|'OUT';payload_json:string}|undefined;
  if(!row) throw new StockError('Saved transaction draft not found.');
  let payload: any;
  try { payload=JSON.parse(row.payload_json); } catch { throw new StockError('This saved draft could not be read.'); }
  const lines=(Array.isArray(payload.lines)?payload.lines:[]).map((line:any)=>{
    const item=db.prepare(`SELECT i.id,i.model,i.part_code,i.description,i.quantity,l.name AS location
    FROM items i LEFT JOIN locations l ON l.id=i.location_id WHERE i.id=? AND i.archived=0`).get(int(line.item_id)) as {id:number;model:string;part_code:string;description:string;quantity:number;location:string|null}|undefined;
    if(!item) throw new StockError('A part in this draft is no longer available.');
    return {item,quantity:int(line.quantity)};
  });
  const fields=payload.fields && typeof payload.fields==='object' ? payload.fields : {};
  const purchaseOrderId=fields.purchase_order_id?int(fields.purchase_order_id):null;
  const order=purchaseOrderId===null?undefined:db.prepare('SELECT id,order_no,supplier FROM restock_orders WHERE id=?').get(purchaseOrderId) as {id:number;order_no:string;supplier:string}|undefined;
  res.json({id:row.id,kind:row.kind,fields,lines,purchaseOrder:order?{id:order.id,orderNo:order.order_no,supplier:order.supplier}:null});
});

api.post('/transaction-drafts', requireRole('admin', 'staff'), (req, res) => {
  const body=req.body??{}, kind=str(body.kind);
  if(!['IN','OUT'].includes(kind)) throw new StockError('Choose Stock In or Stock Out for this draft.');
  if(!Array.isArray(body.lines)||body.lines.length>200) throw new StockError('A draft can contain up to 200 item lines.');
  const lines=body.lines.map((line:any)=>{
    const itemId=int(line?.item_id),quantity=int(line?.quantity);
    checkItem(itemId);
    if(!Number.isInteger(quantity)||quantity<0) throw new StockError('Draft quantities must be whole numbers, zero or more.');
    return {item_id:itemId,quantity};
  });
  if(new Set(lines.map((line:{item_id:number})=>line.item_id)).size!==lines.length) throw new StockError('Each inventory line can only appear once in a draft.');
  const allowed=kind==='IN'?['stock_type','supplier','ss_no','packing_list','note','purchase_order_id']:['service_job_id','stock_type','stock_type_other','technician','batch_no','packing_list','note'];
  const fields:Record<string,string>={};
  for(const key of allowed){
    if(body.fields?.[key]!==undefined){
      const value=str(body.fields[key]);
      if(value.length>500) throw new StockError(`${key} must be 500 characters or fewer.`);
      fields[key]=value;
    }
  }
  const data=JSON.stringify({fields,lines});
  const id=body.id?int(body.id):null;
  if(id!==null){
    const result=db.prepare(`UPDATE stock_transaction_drafts SET kind=?,payload_json=?,updated_at=datetime('now','localtime') WHERE id=? AND created_by=?`).run(kind,data,id,req.user!.id);
    if(!result.changes) throw new StockError('Saved transaction draft not found.');
    res.json({id});
  }else{
    const result=db.prepare('INSERT INTO stock_transaction_drafts (kind,payload_json,created_by) VALUES (?,?,?)').run(kind,data,req.user!.id);
    res.json({id:Number(result.lastInsertRowid)});
  }
});

api.delete('/transaction-drafts/:id', requireRole('admin', 'staff'), (req, res) => {
  const result=db.prepare('DELETE FROM stock_transaction_drafts WHERE id=? AND created_by=?').run(int(req.params.id),req.user!.id);
  if(!result.changes) throw new StockError('Saved transaction draft not found.');
  res.json({deleted:true});
});

api.post('/transactions', requireRole('admin', 'staff'), (req, res) => {
  const b = req.body ?? {};
  const kind = str(b.kind);
  if (!['IN', 'OUT'].includes(kind)) throw new StockError('Choose Stock In or Stock Out.');
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) throw new StockError('Add between 1 and 200 item lines.');
  const lines = b.lines.map((line: any) => {
    const itemId = int(line?.item_id), quantity = int(line?.quantity);
    checkItem(itemId);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new StockError('Every quantity must be a whole number greater than zero.');
    if (kind === 'OUT') {
      const current = db.prepare('SELECT quantity FROM items WHERE id=? AND archived=0').get(itemId) as { quantity: number } | undefined;
      if (!current || current.quantity <= 0) throw new StockError('Parts with no stock available cannot be issued.');
    }
    return { itemId, quantity };
  });
  if (new Set(lines.map((line: { itemId: number }) => line.itemId)).size !== lines.length) throw new StockError('Each inventory line can only appear once in a transaction.');
  const serviceJobId = b.service_job_id ? int(b.service_job_id) : null;
  let linkedJobNo = '';
  if (serviceJobId !== null) {
    if (kind !== 'OUT') throw new StockError('A repair job can only be linked to a Stock Out.');
    const job = db.prepare("SELECT id,job_no FROM service_jobs WHERE id=? AND status='OPEN'").get(serviceJobId) as { id: number; job_no: string } | undefined;
    if (!job) throw new StockError('Choose an open repair job.');
    linkedJobNo = job.job_no;
  }
  const purchaseOrderId = b.purchase_order_id ? int(b.purchase_order_id) : null;
  if (purchaseOrderId !== null) {
    if (kind !== 'IN') throw new StockError('A purchase order can only be linked to Stock In.');
    const order = db.prepare("SELECT id FROM restock_orders WHERE id=? AND status IN ('ORDERED','PARTIAL')").get(purchaseOrderId);
    if (!order) throw new StockError('Choose an ordered purchase order that still has stock to receive.');
  }
  const textField = (v: unknown, label: string) => {
    const value = String(v ?? '').trim();
    if (value.length > 500) throw new StockError(`${label} must be 500 characters or fewer.`);
    return value;
  };
  const selectedStockType = textField(b.stock_type, 'Transaction type');
  let stockType = selectedStockType;
  if (kind === 'OUT') {
    if (!['RTV', 'JO', 'OTHERS'].includes(selectedStockType)) throw new StockError('Choose RTV, JO, or Others for Stock Out.');
    if (selectedStockType === 'OTHERS') {
      stockType = textField(b.stock_type_other, 'Other Stock Out type');
      if (!stockType) throw new StockError('Specify the Stock Out type.');
    }
  }
  const data = {
    stock_type: stockType, supplier: textField(b.supplier, 'Supplier'),
    ss_no: textField(b.ss_no, 'SS number'), packing_list: textField(b.packing_list, 'Packing list'),
    batch_no: textField(b.batch_no, 'Batch number'), requisition_no: textField(b.requisition_no, 'Requisition number'),
    document_ref: textField(b.document_ref, 'RT/JO/INV/PS reference'), technician: textField(b.technician, 'Technician'),
    note: textField(b.note, 'Note'),
  };
  const allowDebt = b.allow_debt === true;
  if (purchaseOrderId !== null) {
    const remaining = db.prepare('SELECT item_id,order_qty-received_qty AS remaining FROM restock_order_lines WHERE restock_order_id=?').all(purchaseOrderId) as {item_id:number;remaining:number}[];
    const limits = new Map(remaining.map((r) => [r.item_id,r.remaining]));
    for (const line of lines) {
      const available = limits.get(line.itemId);
      if (available === undefined) throw new StockError('Every received part must belong to the linked purchase order.');
      if (line.quantity > available) throw new StockError(`You can receive only ${available} more of part line ${line.itemId} on this order.`);
    }
  }
  const result = db.transaction(() => {
    const created = db.prepare(`INSERT INTO stock_transactions
      (kind,stock_type,supplier,ss_no,packing_list,batch_no,requisition_no,document_ref,technician,note,service_job_id,purchase_order_id,created_by)
      VALUES (@kind,@stock_type,@supplier,@ss_no,@packing_list,@batch_no,@requisition_no,@document_ref,@technician,@note,@serviceJobId,@purchaseOrderId,@userId)`)
      .run({ kind, ...data, serviceJobId, purchaseOrderId, userId: req.user!.id });
    const id = Number(created.lastInsertRowid);
    const transactionNo = `${kind === 'IN' ? 'STIN' : 'STOUT'}-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`;
    const requisitionNo = kind === 'OUT' ? '' : data.requisition_no;
    db.prepare('UPDATE stock_transactions SET transaction_no=?,requisition_no=? WHERE id=?').run(transactionNo,requisitionNo,id);
    const balances: number[] = [];
    const changes: {itemId:number;previousQuantity:number;newQuantity:number;change:number}[] = [];
    for (const line of lines) {
      const previousQuantity = (db.prepare('SELECT quantity FROM items WHERE id=?').get(line.itemId) as {quantity:number}).quantity;
      const newQuantity = applyMovement({
        itemId: line.itemId, change: kind === 'OUT' ? -line.quantity : line.quantity,
        type: kind as 'IN' | 'OUT', reference: kind === 'IN' ? [data.stock_type, data.supplier, data.ss_no && `SS No ${data.ss_no}`, data.packing_list && `Packing list ${data.packing_list}`].filter(Boolean).join(' / ') : data.stock_type,
        destination: kind === 'OUT' ? data.batch_no : '', technician: data.technician, note: data.note,
        transactionId: id, userId: req.user!.id, allowDebt,
      });
      balances.push(newQuantity);
      changes.push({itemId:line.itemId,previousQuantity,newQuantity,change:newQuantity-previousQuantity});
      if (serviceJobId !== null) db.prepare(`INSERT INTO service_job_parts (service_job_id,transaction_id,item_id,qty_issued)
        VALUES (?,?,?,?)`).run(serviceJobId,id,line.itemId,line.quantity);
      if (purchaseOrderId !== null) db.prepare('UPDATE restock_order_lines SET received_qty=received_qty+? WHERE restock_order_id=? AND item_id=?').run(line.quantity,purchaseOrderId,line.itemId);
    }
    if (purchaseOrderId !== null) {
      const remaining = (db.prepare('SELECT COUNT(*) AS n FROM restock_order_lines WHERE restock_order_id=? AND received_qty<order_qty').get(purchaseOrderId) as {n:number}).n;
      db.prepare("UPDATE restock_orders SET status=?,updated_at=datetime('now','localtime') WHERE id=?").run(remaining ? 'PARTIAL' : 'RECEIVED',purchaseOrderId);
    }
    if (b.draft_id) db.prepare('DELETE FROM stock_transaction_drafts WHERE id=? AND created_by=?').run(int(b.draft_id),req.user!.id);
    return { transactionId:id, transactionNo, requisitionNo, balances, changes };
  })();
  res.json(result);
});

api.post('/movements', requireRole('admin', 'staff'), (req, res) => {
  const b = req.body ?? {};
  const itemId = int(b.item_id);
  const qty = int(b.quantity);
  const type = str(b.type);
  checkItem(itemId);
  if (!['IN', 'OUT', 'RETURN'].includes(type)) throw new StockError('Unknown movement type.');
  if (Number.isNaN(qty) || qty <= 0) throw new StockError('Quantity must be a whole number greater than zero.');
  const balance = applyMovement({
    itemId,
    change: type === 'OUT' ? -qty : qty,
    type: type as 'IN' | 'OUT' | 'RETURN',
    reference: str(b.reference),
    destination: str(b.destination),
    technician: str(b.technician),
    note: str(b.note),
    userId: req.user!.id,
    allowDebt: b.allow_debt === true,
  });
  res.json({ balance });
});

api.post('/counts', requireRole('admin', 'staff'), (req, res) => {
  const b = req.body ?? {};
  const itemId = int(b.item_id);
  checkItem(itemId);
  res.json({ balance: countStock(itemId, int(b.quantity), req.user!.id, str(b.note)) });
});

api.post('/counts/batch', requireRole('admin','staff'), (req,res) => {
  const input=req.body?.lines;
  if (!Array.isArray(input) || input.length<1 || input.length>200) throw new StockError('Review between 1 and 200 counted lines at a time.');
  const lines=input.map((line:any) => {
    const itemId=int(line.item_id);
    checkItem(itemId);
    return {itemId, counted:int(line.counted_quantity), expected:int(line.expected_quantity), note:str(line.note)};
  });
  const result=countStockBatch(lines,req.user!.id);
  res.json({lines:result,adjusted:result.filter((line) => line.change!==0).length});
});

api.post('/transfers', requireRole('admin', 'staff'), (req, res) => {
  const b = req.body ?? {};
  const itemId = int(b.item_id);
  checkItem(itemId);
  const to = readLocation(b.to_location_id);
  if (to === null) throw new StockError('Choose the location to move the stock to.');
  transferStock(itemId, to, int(b.quantity), req.user!.id, str(b.note));
  res.json({ ok: true });
});

api.get('/movements', (req, res) => {
  const q = `%${str(req.query.search)}%`;
  const from = str(req.query.from);
  const to = str(req.query.to);
  const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to)) throw new StockError('Choose valid history dates.');
  if (from && to && from > to) throw new StockError('The start date must be on or before the end date.');
  const limit = Math.min(int(req.query.limit) || 100, 500);
  const offset = Math.max(int(req.query.offset) || 0, 0);
  const where = `WHERE (i.part_code LIKE ? OR i.model LIKE ? OR m.reference LIKE ?)
                   AND (? = '' OR date(m.created_at) >= date(?))
                   AND (? = '' OR date(m.created_at) <= date(?))`;
  const rows = db
    .prepare(
      `SELECT m.id, m.created_at, t.transaction_no, i.model, i.part_code, i.description, l.name AS location, m.type, m.qty_change, m.balance_after,
              m.reference, m.destination, m.technician, m.note, u.username AS user
         FROM movements m
         JOIN items i ON i.id = m.item_id
         LEFT JOIN stock_transactions t ON t.id = m.transaction_id
         LEFT JOIN locations l ON l.id = m.location_id
         LEFT JOIN users u ON u.id = m.user_id
        ${where}
        ORDER BY m.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(q, q, q, from, from, to, to, limit, offset);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM movements m JOIN items i ON i.id = m.item_id ${where}`).get(q, q, q, from, from, to, to) as { n: number }
  ).n;
  res.json({ rows, total });
});

api.get('/transactions', (req, res) => {
  const q = `%${str(req.query.search)}%`, from = str(req.query.from), to = str(req.query.to);
  const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) throw new StockError('Choose a valid date range.');
  const limit = Math.min(int(req.query.limit) || 100, 500), offset = Math.max(int(req.query.offset) || 0, 0);
  const rows = db.prepare(`WITH register AS (
      SELECT 'T:'||t.id AS key,t.transaction_no,t.kind AS type,t.created_at,COUNT(m.id) AS line_count,
        COALESCE(SUM(ABS(m.qty_change)),0) AS units,t.stock_type,t.supplier,t.ss_no,t.packing_list,t.batch_no,
        t.requisition_no,t.document_ref,t.technician,t.note,COALESCE(GROUP_CONCAT(DISTINCT i.part_code),'') AS part_codes,
        t.created_by AS user_id,'' AS legacy_reference,j.job_no AS repair_job_no
      FROM stock_transactions t LEFT JOIN movements m ON m.transaction_id=t.id LEFT JOIN items i ON i.id=m.item_id
      LEFT JOIN service_jobs j ON j.id=t.service_job_id
      GROUP BY t.id
      UNION ALL
      SELECT 'M:'||m.id,'LEGACY-'||m.id,m.type,m.created_at,1,ABS(m.qty_change),'','','',m.reference,m.destination,'','',m.technician,m.note,i.part_code,m.user_id,m.reference,''
      FROM movements m JOIN items i ON i.id=m.item_id WHERE m.transaction_id IS NULL
    )
    SELECT r.*,u.username AS user,
      CASE WHEN r.key LIKE 'M:%' THEN r.legacy_reference
           WHEN r.type='IN' THEN TRIM(r.stock_type||' '||r.supplier||' '||r.ss_no||' '||r.packing_list)
           ELSE TRIM(r.stock_type||' '||r.requisition_no||' '||r.packing_list||' '||r.document_ref||' '||r.batch_no) END AS reference
    FROM register r LEFT JOIN users u ON u.id=r.user_id
    WHERE (r.transaction_no LIKE @q OR r.type LIKE @q OR r.stock_type LIKE @q OR r.part_codes LIKE @q OR r.technician LIKE @q OR r.supplier LIKE @q OR r.requisition_no LIKE @q OR r.packing_list LIKE @q OR r.batch_no LIKE @q OR r.document_ref LIKE @q OR r.legacy_reference LIKE @q OR r.repair_job_no LIKE @q)
      AND (@from='' OR date(r.created_at)>=date(@from)) AND (@to='' OR date(r.created_at)<=date(@to))
    ORDER BY r.created_at DESC,r.key DESC LIMIT @limit OFFSET @offset`).all({ q, from, to, limit, offset });
  const total = (db.prepare(`WITH register AS (
      SELECT 'T:'||t.id AS key,t.transaction_no,t.kind AS type,t.created_at,t.stock_type,t.supplier,t.requisition_no,t.technician,COALESCE(GROUP_CONCAT(DISTINCT i.part_code),'') AS part_codes,t.packing_list,t.batch_no,t.document_ref,'' AS legacy_reference,j.job_no AS repair_job_no
      FROM stock_transactions t LEFT JOIN movements m ON m.transaction_id=t.id LEFT JOIN items i ON i.id=m.item_id LEFT JOIN service_jobs j ON j.id=t.service_job_id GROUP BY t.id
      UNION ALL SELECT 'M:'||m.id,'LEGACY-'||m.id,m.type,m.created_at,'','','',m.technician,i.part_code,'',m.destination,'',m.reference,'' FROM movements m JOIN items i ON i.id=m.item_id WHERE m.transaction_id IS NULL
    ) SELECT COUNT(*) AS n FROM register r WHERE (r.transaction_no LIKE @q OR r.type LIKE @q OR r.stock_type LIKE @q OR r.part_codes LIKE @q OR r.technician LIKE @q OR r.supplier LIKE @q OR r.requisition_no LIKE @q OR r.packing_list LIKE @q OR r.batch_no LIKE @q OR r.document_ref LIKE @q OR r.legacy_reference LIKE @q OR r.repair_job_no LIKE @q)
      AND (@from='' OR date(r.created_at)>=date(@from)) AND (@to='' OR date(r.created_at)<=date(@to))`).get({ q, from, to }) as { n: number }).n;
  res.json({ rows, total });
});

api.get('/transactions/:key', (req, res) => {
  const key = str(req.params.key);
  if (key.startsWith('T:')) {
    const id = int(key.slice(2));
    const transaction = db.prepare(`SELECT t.*,COALESCE(NULLIF(u.full_name,''),u.username) AS created_by_name,COALESCE(NULLIF(au.full_name,''),au.username) AS approved_by_name,j.job_no AS repair_job_no,po.order_no AS purchase_order_no
      FROM stock_transactions t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users au ON au.id=t.approved_by
      LEFT JOIN service_jobs j ON j.id=t.service_job_id LEFT JOIN restock_orders po ON po.id=t.purchase_order_id WHERE t.id=?`).get(id);
    if (!transaction) throw new StockError('Transaction not found.');
    const lines = db.prepare(`SELECT m.id,m.qty_change,m.balance_after,m.balance_after-m.qty_change AS previous_quantity,m.balance_after AS new_quantity,m.created_at,i.model,i.part_code,i.description,l.name AS location
      FROM movements m JOIN items i ON i.id=m.item_id LEFT JOIN locations l ON l.id=m.location_id
      WHERE m.transaction_id=? ORDER BY m.id`).all(id);
    res.json({ transaction, lines });
    return;
  }
  if (key.startsWith('M:')) {
    const id = int(key.slice(2));
    const row = db.prepare(`SELECT m.id,m.type,m.created_at,m.qty_change,m.balance_after,m.reference,m.destination,m.technician,m.note,
      i.model,i.part_code,i.description,l.name AS location,COALESCE(NULLIF(u.full_name,''),u.username) AS created_by_name
      FROM movements m JOIN items i ON i.id=m.item_id LEFT JOIN locations l ON l.id=m.location_id LEFT JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.transaction_id IS NULL`).get(id) as any;
    if (!row) throw new StockError('History record not found.');
    res.json({ transaction: { transaction_no: `LEGACY-${id}`, kind: row.type, created_at: row.created_at, reference: row.reference,
      batch_no: row.destination, technician: row.technician, note: row.note, created_by_name: row.created_by_name },
      lines: [{ ...row, qty_change: row.qty_change, previous_quantity: row.balance_after-row.qty_change, new_quantity: row.balance_after }] });
    return;
  }
  throw new StockError('Invalid transaction number.');
});

/* ---------- Excel ---------- */

api.get('/backups',requireRole('admin'),(_req,res)=>res.json(listBackups()));
api.post('/backups',requireRole('admin'),handle(async(_req,res)=>{
  const backup=await createManualBackup();
  res.json({filename:backup.filename,size:backup.size,createdAt:backup.createdAt});
}));
api.get('/backups/:filename',requireRole('admin'),(req,res,next)=>{
  const filename=str(req.params.filename),file=resolveBackup(filename);
  if(!file) throw new StockError('Backup file not found.');
  res.download(file,filename,(error)=>{if(error) next(error);});
});

api.get('/export/inventory', handle(async (_req, res) => sendXlsx(res, await xl.exportInventory(false), `inventory_${stamp()}.xlsx`)));
api.get('/export/debt', handle(async (_req, res) => sendXlsx(res, await xl.exportInventory(true), `parts_debt_${stamp()}.xlsx`)));
api.get('/export/movements', handle(async (_req, res) => sendXlsx(res, await xl.exportMovements(), `history_${stamp()}.xlsx`)));
api.get('/export/restock-priorities',handle(async(_req,res)=>{
  const rows=calculateRestockPriorities();
  const buffer=await xl.exportReport('Restock priorities',['Priority','Part code','Model','Description','Location','On hand','90-day use','Reason','Suggested quantity'],rows.map((r:any)=>[r.priority,r.part_code,r.model,r.description,r.location||'',r.quantity,r.used_90,r.reason,r.suggested_order??'Set restock profile']));
  sendXlsx(res,buffer,`restock_priorities_${stamp()}.xlsx`);
}));
api.get('/export/usage-report',handle(async(req,res)=>{
  const period=str(req.query.period)==='12m'?'12m':'3m',days=period==='12m'?365:90,months=period==='12m'?12:3;
  const locationId=Math.max(int(req.query.locationId)||0,0),search=`%${str(req.query.search)}%`;
  if(locationId&&!db.prepare('SELECT 1 FROM locations WHERE id=?').get(locationId)) throw new StockError('Choose a valid location.');
  const rows=db.prepare(`WITH usage AS (SELECT item_id,SUM(CASE WHEN type='OUT' THEN -qty_change ELSE 0 END) AS issued,SUM(CASE WHEN type='RETURN' THEN qty_change ELSE 0 END) AS returned
      FROM movements WHERE type IN ('OUT','RETURN') AND date(created_at)>=date('now','localtime',?) GROUP BY item_id)
    SELECT i.model,i.part_code,i.description,l.name AS location,i.quantity,COALESCE(u.issued,0) AS issued,COALESCE(u.returned,0) AS returned,COALESCE(u.issued,0)-COALESCE(u.returned,0) AS net_used
    FROM items i LEFT JOIN locations l ON l.id=i.location_id LEFT JOIN usage u ON u.item_id=i.id
    WHERE i.archived=0 AND (COALESCE(u.issued,0)>0 OR COALESCE(u.returned,0)>0) AND (?=0 OR i.location_id=?)
      AND (i.model LIKE ? OR i.part_code LIKE ? OR i.description LIKE ? OR COALESCE(l.name,'') LIKE ?)
    ORDER BY net_used DESC,issued DESC,i.model,i.part_code`).all(`-${days} days`,locationId,locationId,search,search,search,search) as any[];
  const buffer=await xl.exportReport(`Usage ${period}`,['Part code','Model','Description','Location','On hand','Units issued','Units returned','Net used','Average per month','Estimated days in stock'],rows.map((r)=>{
    const net=Number(r.net_used),daysCover=net>0&&r.quantity>0?Number(r.quantity)/(net/days):'';
    return [r.part_code,r.model,r.description,r.location||'',r.quantity,r.issued,r.returned,net,(net/months).toFixed(1),daysCover===''?'':Math.round(daysCover)];
  }));
  sendXlsx(res,buffer,`part_usage_${period}_${stamp()}.xlsx`);
}));
api.get('/template/inventory', handle(async (_req, res) => sendXlsx(res, await xl.templateInventory(), 'inventory_template.xlsx')));

api.post(
  '/import',
  requireRole('admin', 'staff'),
  upload.single('file'),
  handle(async (req, res) => {
    if (!req.file) throw new StockError('Choose an Excel file first.');
    const result = await xl.importInventory(req.file.buffer, req.query.dryRun === '1', req.user!.id);
    if (result.applied) {
      db.prepare('INSERT INTO import_log (kind, filename, rows, user_id) VALUES (?,?,?,?)').run(
        'inventory', req.file.originalname, result.total, req.user!.id
      );
    }
    res.json(result);
  })
);

/* ---------- users (admin) ---------- */

api.get('/users', requireRole('admin'), (_req, res) => {
  res.json(db.prepare('SELECT id, username, full_name, role, active FROM users ORDER BY username').all());
});

api.post('/users', requireRole('admin'), (req, res) => {
  const b = req.body ?? {};
  const username = str(b.username);
  const password = str(b.password);
  const role = str(b.role);
  if (!username) throw new StockError('Username is required.');
  if (password.length < 8) throw new StockError('Password must be at least 8 characters.');
  if (!['admin', 'staff', 'viewer'].includes(role)) throw new StockError('Choose a role.');
  try {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(
      username, bcrypt.hashSync(password, 10), str(b.full_name), role
    );
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new StockError('That username is taken.');
    throw e;
  }
  res.json({ ok: true });
});

api.put('/users/:id/password', requireRole('admin'), (req, res) => {
  const password = str(req.body?.password);
  if (password.length < 8) throw new StockError('Password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), int(req.params.id));
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

api.put('/users/:id/active', requireRole('admin'), (req, res) => {
  const id = int(req.params.id);
  if (id === req.user!.id) throw new StockError('You cannot deactivate your own account.');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, id);
  if (!req.body?.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

app.use('/api', api);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DebtWarning) {
    res.status(409).json({ error: err.message, debt: true, balance: err.balance });
    return;
  }
  if (err instanceof StockError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server window for details.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nInventory is running. Open it in a browser:`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  From other PCs:    http://${n.address}:${PORT}`);
    }
  }
  console.log('');
  startBackups();
});
