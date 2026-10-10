import ExcelJS from 'exceljs';
import { db } from './db';
import { lineRows } from './queries';
import { setQuantity, StockError } from './stock';

/* ---------- small helpers ---------- */

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('text' in o) return String(o.text);
    return '';
  }
  return String(v);
}

/** Trims and collapses repeated spaces. Nothing else about the text is changed. */
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

function asOf(): string {
  const d = new Date();
  return `As of ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

/* ---------- export: same layout as the inventory sheet ---------- */

interface SheetLine { model: string; part: string; desc: string; loc: string; qty: number }

/**
 * Title in row 1, "As of ..." in row 2, headers in row 3, a blank row 4, data from row 5.
 * This is the same layout as the inventory sheet, so an exported file can be imported again.
 */
async function inventoryWorkbook(title: string, lines: SheetLine[], help: string[] = [], includeDate = true): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('inventory');
  ws.columns = [{ width: 16 }, { width: 16 }, { width: 52 }, { width: 20 }, { width: 12 }];
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  if (includeDate) ws.getCell('A2').value = asOf();
  const head = ws.getRow(3);
  head.values = ['PART CODE', 'MODEL', 'DESCRIPTION', 'LOCATION', 'PARTS\nQTY'];
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle' };
  lines.forEach((l, i) => {
    ws.getRow(5 + i).values = [l.part, l.model, l.desc, l.loc, l.qty];
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  if (help.length) {
    const h = wb.addWorksheet('How to use');
    h.getColumn(1).width = 110;
    help.forEach((t) => h.addRow([t]));
  }
  return toBuffer(wb);
}

export async function exportInventory(debtOnly: boolean): Promise<Buffer> {
  const rows = lineRows('', 0, debtOnly ? 'debt' : '', -1, 0);
  return inventoryWorkbook(
    debtOnly ? 'IMARFLEX SPARE PARTS: PARTS DEBT' : 'IMARFLEX SPARE PARTS INVENTORY',
    rows.map((r) => ({ model: r.model, part: r.part_code, desc: r.description, loc: r.location ?? '', qty: r.quantity }))
  );
}

export async function templateInventory(): Promise<Buffer> {
  return inventoryWorkbook('IMARFLEX SPARE PARTS INVENTORY', [], [
    'This is the same layout as your inventory sheet. Fill in one row per line: PART CODE, MODEL, DESCRIPTION, LOCATION and PARTS QTY.',
    'You can also drop your own inventory sheet in directly. The title rows and the blank row under the headers are fine.',
    'A negative PARTS QTY is a parts debt and is kept as it is.',
    'Rows are matched to existing lines by MODEL, PART CODE, DESCRIPTION and LOCATION. A match only has its quantity updated. Anything else is added as a new line. Nothing is ever deleted by an import.',
    'New locations are created automatically. The check shows them first so you can spot typing mistakes.',
  ], false);
}

export async function exportMovements(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('History');
  ws.columns = [
    { header: 'Date', key: 'date', width: 20 },
    { header: 'PartCode', key: 'part', width: 16 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Description', key: 'desc', width: 40 },
    { header: 'Location', key: 'loc', width: 18 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Change', key: 'chg', width: 10 },
    { header: 'BalanceAfter', key: 'bal', width: 14 },
    { header: 'Reference', key: 'ref', width: 20 },
    { header: 'Destination', key: 'dest', width: 20 },
    { header: 'Technician', key: 'tech', width: 18 },
    { header: 'User', key: 'user', width: 14 },
    { header: 'Note', key: 'note', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const rows = db
    .prepare(
      `SELECT m.created_at, i.model, i.part_code, i.description, l.name AS location, m.type, m.qty_change, m.balance_after,
              m.reference, m.destination, m.technician, u.username AS user, m.note
         FROM movements m
         JOIN items i ON i.id = m.item_id
         LEFT JOIN locations l ON l.id = m.location_id
         LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.id DESC`
    )
    .all() as any[];
  for (const r of rows) {
    ws.addRow({ date: r.created_at, model: r.model, part: r.part_code, desc: r.description, loc: r.location ?? '', type: r.type, chg: r.qty_change, bal: r.balance_after, ref: r.reference, dest: r.destination, tech: r.technician, user: r.user ?? '', note: r.note });
  }
  return toBuffer(wb);
}

export async function exportReport(sheetName:string,headers:string[],rows:unknown[][]):Promise<Buffer> {
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet(sheetName.slice(0,31));
  ws.addRow(headers).font={bold:true,color:{argb:'FFFFFFFF'}};
  ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF075FA8'}};
  ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};
  for(const row of rows) ws.addRow(row as ExcelJS.CellValue[]);
  headers.forEach((header,index)=>{ws.getColumn(index+1).width=Math.min(42,Math.max(14,header.length+3));});
  return toBuffer(wb);
}

/* ---------- import: reading the sheet ---------- */

export interface SheetRow {
  rowNum: number;
  model: string;
  part: string;
  desc: string;
  loc: string;
  qty: string;
  min: string;
}

// Column headers are compared with letters only, lower case, so "PARTS\nQTY" becomes "partsqty".
const HEADERS: Record<'model' | 'part' | 'desc' | 'loc' | 'qty' | 'min', string[]> = {
  model: ['model', 'modelid'],
  part: ['partcode', 'partno', 'partnumber', 'code'],
  desc: ['description', 'desc'],
  loc: ['location', 'loc'],
  qty: ['partsqty', 'quantity', 'qty', 'partsquantity'],
  min: ['minstock'],
};

/**
 * Finds the inventory table in the file. It looks for a header row (PART CODE, LOCATION and a quantity
 * column) in the first 25 rows, so title rows above the table are fine. A sheet named "inventory" is
 * tried first, then the other sheets.
 */
export async function readInventorySheet(buf: Buffer): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new StockError('This file could not be read. Please use an .xlsx file.');
  }
  const sheets = [...wb.worksheets].sort(
    (a, b) => Number(b.name.toLowerCase() === 'inventory') - Number(a.name.toLowerCase() === 'inventory')
  );
  for (const ws of sheets) {
    for (let r = 1; r <= Math.min(25, ws.rowCount); r++) {
      const cols: Partial<Record<keyof typeof HEADERS, number>> = {};
      ws.getRow(r).eachCell((cell, col) => {
        const h = cellText(cell.value).toLowerCase().replace(/[^a-z]/g, '');
        for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
          if (cols[key] === undefined && HEADERS[key].includes(h)) cols[key] = col;
        }
      });
      if (!cols.part || !cols.loc || !cols.qty) continue;
      const get = (row: ExcelJS.Row, col?: number) => (col ? tidy(cellText(row.getCell(col).value)) : '');
      const rows: SheetRow[] = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
        if (rowNum <= r) return;
        // Some inventory sheets merge the header cells vertically across the header and next row.
        // ExcelJS may expose those merged cells as values in the next row, so don't import that row as data.
        const mergedHeaderContinuation = [cols.part, cols.loc, cols.qty].every((col) => {
          const cell = ws.getCell(rowNum, col!);
          return cell.isMerged && cell.master.row === String(r);
        });
        if (mergedHeaderContinuation) return;
        const item: SheetRow = {
          rowNum,
          model: get(row, cols.model),
          part: get(row, cols.part),
          desc: get(row, cols.desc),
          loc: get(row, cols.loc),
          qty: get(row, cols.qty),
          min: get(row, cols.min),
        };
        if (!item.model && !item.part && !item.desc && !item.loc && !item.qty) return; // blank row
        rows.push(item);
      });
      return rows;
    }
  }
  throw new StockError('Could not find the inventory table. The file needs the columns PART CODE, LOCATION and PARTS QTY (and normally MODEL and DESCRIPTION).');
}

/* ---------- import: applying the rows ---------- */

export interface ImportResult {
  total: number;
  created: number; // new lines added
  matched: number; // lines already in the system that were found in the file
  stockChanges: number; // lines whose quantity changed
  newLocations: string[];
  notInFile: number; // lines in the system that this file did not mention (left unchanged)
  debtLines: number; // rows in the file with a negative quantity
  debtUnits: number;
  notes: string[];
  errors: { row: number; message: string }[];
  dryRun: boolean;
  applied: boolean;
}

class Rollback extends Error {}

/**
 * Runs the import inside one transaction. If there is any error, or this is only a preview,
 * everything is rolled back, so nothing is ever half-imported.
 */
function runImport(dryRun: boolean, total: number, work: (r: ImportResult) => void): ImportResult {
  const r: ImportResult = {
    total, created: 0, matched: 0, stockChanges: 0, newLocations: [], notInFile: 0,
    debtLines: 0, debtUnits: 0, notes: [], errors: [], dryRun, applied: false,
  };
  try {
    db.transaction(() => {
      work(r);
      if (dryRun || r.errors.length > 0) throw new Rollback();
    })();
    r.applied = true;
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return r;
}

const lineKey = (model: string, part: string, desc: string, loc: string) =>
  [model, part, desc, loc].map((s) => s.toUpperCase()).join('\u0001');

const rowList = (rows: number[]) => rows.slice(0, 5).join(', ') + (rows.length > 5 ? ` and ${rows.length - 5} more` : '');

/**
 * Every row of the file is one inventory line. A row is matched to an existing line by model, part code,
 * description and location (rows that repeat the same four values match one existing line each, in order).
 * A matched line only has its quantity set to the number in the file. A row with no match becomes a new line.
 * Nothing is deleted, merged or renamed, and negative quantities (parts debts) are kept as they are.
 */
export function importInventoryRows(rows: SheetRow[], dryRun: boolean, userId: number): ImportResult {
  return runImport(dryRun, rows.length, (r) => {
    const existing = db
      .prepare(
        `SELECT i.id, i.archived, i.model, i.part_code, i.description, i.quantity, l.name AS loc
           FROM items i LEFT JOIN locations l ON l.id = i.location_id ORDER BY i.id`
      )
      .all() as { id: number; archived: number; model: string; part_code: string; description: string; quantity:number; loc: string | null }[];
    const byKey = new Map<string, { id: number; archived: number; quantity:number }[]>();
    for (const e of existing) {
      const k = lineKey(e.model, e.part_code, e.description, e.loc ?? '');
      const list = byKey.get(k);
      if (list) list.push({ id: e.id, archived: e.archived, quantity:e.quantity });
      else byKey.set(k, [{ id: e.id, archived: e.archived, quantity:e.quantity }]);
    }

    const fileRowsByKey = new Map<string, number[]>();
    for (const row of rows) {
      const key=lineKey(row.model,row.part,row.desc,row.loc), seen=fileRowsByKey.get(key) || [];
      seen.push(row.rowNum); fileRowsByKey.set(key,seen);
    }
    const duplicates=[...fileRowsByKey.values()].filter((seen) => seen.length>1).map((seen) => seen.join(', '));
    if (duplicates.length) r.notes.push(`Possible duplicate inventory rows share the same model, part, description, and location (rows ${duplicates.slice(0,8).join('; ')}${duplicates.length>8?'; and more':''}). Check these rows before saving.`);

    const locations = new Map<string, number>();
    for (const l of db.prepare('SELECT id, name FROM locations').all() as { id: number; name: string }[]) {
      locations.set(l.name.toUpperCase(), l.id);
    }
    const insertLocation = db.prepare('INSERT INTO locations (name) VALUES (?)');
    const insertLine = db.prepare('INSERT INTO items (model, part_code, description, location_id, quantity, min_stock) VALUES (?, ?, ?, ?, 0, ?)');
    const touch = db.prepare('UPDATE items SET archived = 0, min_stock = COALESCE(?, min_stock) WHERE id = ?');

    const blankQty: number[] = [];
    const noLocation: number[] = [];
    const unusualChanges: string[] = [];

    for (const row of rows) {
      const fail = (message: string) => r.errors.push({ row: row.rowNum, message });
      if (!row.part) { fail('PART CODE is empty.'); continue; }

      let qty = 0;
      if (row.qty === '') {
        blankQty.push(row.rowNum);
      } else {
        qty = Number(row.qty);
        if (!Number.isInteger(qty)) { fail(`PARTS QTY "${row.qty}" must be a whole number (a negative number is a parts debt).`); continue; }
      }
      let min: number | null = null;
      if (row.min) {
        min = Number(row.min);
        if (!Number.isInteger(min) || min < 0) { fail(`MinStock "${row.min}" must be a whole number, zero or more.`); continue; }
      }

      let locationId: number | null = null;
      if (row.loc) {
        const lk = row.loc.toUpperCase();
        let id = locations.get(lk);
        if (id === undefined) {
          id = Number(insertLocation.run(row.loc).lastInsertRowid);
          locations.set(lk, id);
          r.newLocations.push(row.loc);
        }
        locationId = id;
      } else {
        noLocation.push(row.rowNum);
      }

      const hit = byKey.get(lineKey(row.model, row.part, row.desc, row.loc))?.shift();
      let id: number;
      if (hit) {
        id = hit.id;
        r.matched++;
        if (Math.abs(qty-hit.quantity)>Math.max(50,Math.abs(hit.quantity)*2)) unusualChanges.push(`row ${row.rowNum}: ${hit.quantity} to ${qty}`);
        if (hit.archived || min !== null) touch.run(min, id);
      } else {
        id = Number(insertLine.run(row.model, row.part, row.desc, locationId, min ?? 0).lastInsertRowid);
        r.created++;
        if (Math.abs(qty)>=10000) unusualChanges.push(`row ${row.rowNum}: new line quantity ${qty}`);
      }
      const changed = setQuantity(
        id, qty, userId, hit ? 'ADJUST' : 'OPENING',
        hit ? 'Excel import: quantity set from file' : 'Excel import: opening quantity'
      );
      if (changed) r.stockChanges++;
      if (qty < 0) { r.debtLines++; r.debtUnits += qty; }
    }

    for (const list of byKey.values()) r.notInFile += list.filter((x) => !x.archived).length;
    if (blankQty.length) r.notes.push(`${blankQty.length} row(s) have no quantity and are imported as 0 (rows ${rowList(blankQty)}).`);
    if (noLocation.length) r.notes.push(`${noLocation.length} row(s) have no location and are imported without one (rows ${rowList(noLocation)}).`);
    if (unusualChanges.length) r.notes.push(`Large quantity changes to review (${unusualChanges.slice(0,8).join('; ')}${unusualChanges.length>8?'; and more':''}). These are warnings, not errors.`);
  });
}

export async function importInventory(buf: Buffer, dryRun: boolean, userId: number): Promise<ImportResult> {
  const rows = await readInventorySheet(buf);
  if (rows.length === 0) throw new StockError('The inventory table in this file has no rows.');
  return importInventoryRows(rows, dryRun, userId);
}
