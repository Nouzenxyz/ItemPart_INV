import crypto from 'crypto';
import { db } from './db';

/** Thrown for any problem the user can fix (bad input, not enough stock). Shown as-is in the UI. */
export class StockError extends Error {}

/**
 * Thrown when an issue would take a line below zero. A quantity below zero is a "parts debt":
 * it is allowed, but only after the user has confirmed it.
 */
export class DebtWarning extends StockError {
  constructor(message: string, public balance: number) {
    super(message);
  }
}

export type MovementType =
  | 'IN' | 'OUT' | 'RETURN' | 'ADJUST' | 'OPENING' | 'EDIT' | 'TRANSFER_IN' | 'TRANSFER_OUT';

export interface MovementInput {
  itemId: number;
  change: number; // positive adds stock (or pays back a parts debt), negative removes it
  type: MovementType;
  reference?: string;
  destination?: string;
  technician?: string;
  note?: string;
  transferGroup?: string | null;
  transactionId?: number | null;
  userId: number | null;
  allowDebt?: boolean;
}

interface Line {
  quantity: number;
  location_id: number | null;
}

const getLine = db.prepare('SELECT quantity, location_id FROM items WHERE id = ?');
const setQty = db.prepare('UPDATE items SET quantity = ? WHERE id = ?');
const insertMovement = db.prepare(`
  INSERT INTO movements
    (item_id, location_id, qty_change, balance_after, type, reference, destination, technician, note, transfer_group, user_id, transaction_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Changes one line's quantity and writes the movement record in one transaction.
 * Safe to call inside a bigger transaction (it becomes a savepoint).
 */
export const applyMovement = db.transaction((m: MovementInput): number => {
  if (!Number.isInteger(m.change) || m.change === 0) {
    throw new StockError('Quantity must be a whole number greater than zero.');
  }
  const line = getLine.get(m.itemId) as Line | undefined;
  if (!line) throw new StockError('That item does not exist.');
  const balance = line.quantity + m.change;
  if (m.change < 0 && balance < 0 && !m.allowDebt) {
    const msg =
      line.quantity > 0
        ? `Only ${line.quantity} on hand. Issuing ${-m.change} would put ${-balance} into parts debt.`
        : line.quantity === 0
          ? `None on hand. Issuing ${-m.change} would put ${-balance} into parts debt.`
          : `This line already has a parts debt of ${-line.quantity}. Issuing ${-m.change} more would make it ${-balance}.`;
    throw new DebtWarning(msg, balance);
  }
  setQty.run(balance, m.itemId);
  insertMovement.run(
    m.itemId, line.location_id, m.change, balance, m.type,
    m.reference ?? '', m.destination ?? '', m.technician ?? '', m.note ?? '', m.transferGroup ?? null, m.userId, m.transactionId ?? null
  );
  return balance;
});

/**
 * Sets a line to an exact quantity (used by Excel import and opening quantities). The target may be
 * negative, because the inventory sheet records parts debts as negative numbers. Returns true if the
 * quantity changed.
 */
export const setQuantity = db.transaction(
  (itemId: number, target: number, userId: number | null, type: MovementType, note: string): boolean => {
    const line = getLine.get(itemId) as Line | undefined;
    if (!line) throw new StockError('That item does not exist.');
    const diff = target - line.quantity;
    if (diff === 0) return false;
    setQty.run(target, itemId);
    insertMovement.run(itemId, line.location_id, diff, target, type, '', '', '', note, null, userId, null);
    return true;
  }
);

/** Physical count: records the difference between the system quantity and the counted quantity. */
export const countStock = db.transaction(
  (itemId: number, counted: number, userId: number | null, note: string): number => {
    if (!Number.isInteger(counted) || counted < 0) {
      throw new StockError('Counted quantity must be a whole number, zero or more.');
    }
    const line = getLine.get(itemId) as Line | undefined;
    if (!line) throw new StockError('That item does not exist.');
    setQuantity(itemId, counted, userId, 'ADJUST', note || `Physical count: system had ${line.quantity}, counted ${counted}`);
    return counted;
  }
);

export interface PhysicalCountLine {
  itemId: number;
  expected: number;
  counted: number;
  note: string;
}

/** Posts a reviewed physical count as one database transaction. */
export const countStockBatch = db.transaction(
  (lines: PhysicalCountLine[], userId: number | null) => {
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
      throw new StockError('A stock line can only be counted once per submission.');
    }
    return lines.map((line) => {
      if (!Number.isInteger(line.counted) || line.counted < 0) {
        throw new StockError('Every counted quantity must be a whole number, zero or more.');
      }
      if (!Number.isInteger(line.note.length) || line.note.length > 500) {
        throw new StockError('Count reason must be 500 characters or fewer.');
      }
      const current = getLine.get(line.itemId) as Line | undefined;
      if (!current) throw new StockError('That item does not exist.');
      if (!Number.isInteger(line.expected) || current.quantity !== line.expected) {
        throw new StockError('Stock changed while this count was being prepared. Refresh the count page and check the line again.');
      }
      if (current.quantity !== line.counted && !line.note) {
        throw new StockError('Add a short reason for every count that differs from the system quantity.');
      }

      const change = line.counted - current.quantity;
      if (change !== 0) {
        setQty.run(line.counted, line.itemId);
        insertMovement.run(
          line.itemId,
          current.location_id,
          change,
          line.counted,
          'ADJUST',
          '',
          '',
          '',
          line.note || `Physical count: system had ${current.quantity}, counted ${line.counted}`,
          null,
          userId,
          null
        );
      }
      return { itemId: line.itemId, previousQuantity: current.quantity, countedQuantity: line.counted, change };
    });
  }
);

/** Writes a note in History when a line's details (model, part code, description, location) are edited. */
export function logEdit(itemId: number, userId: number | null, note: string) {
  const line = getLine.get(itemId) as Line | undefined;
  if (!line) return;
  insertMovement.run(itemId, line.location_id, 0, line.quantity, 'EDIT', '', '', '', note, null, userId, null);
}

const findDestination = db.prepare(
  `SELECT id FROM items
    WHERE model = ? COLLATE NOCASE AND part_code = ? AND description = ? COLLATE NOCASE AND location_id = ?
    ORDER BY archived, id LIMIT 1`
);
const insertLine = db.prepare(
  'INSERT INTO items (model, part_code, description, location_id, quantity, min_stock) VALUES (?, ?, ?, ?, 0, ?)'
);

/**
 * Moves stock from one line to the same model, part code and description in another location.
 * The destination line is created if it does not exist yet. Parts debts cannot be moved.
 */
export const transferStock = db.transaction(
  (itemId: number, toLocationId: number, qty: number, userId: number | null, note: string) => {
    if (!Number.isInteger(qty) || qty <= 0) throw new StockError('Quantity must be a whole number greater than zero.');
    const src = db
      .prepare('SELECT model, part_code, description, location_id, quantity, min_stock FROM items WHERE id = ? AND archived = 0')
      .get(itemId) as
      | { model: string; part_code: string; description: string; location_id: number | null; quantity: number; min_stock: number }
      | undefined;
    if (!src) throw new StockError('That item does not exist.');
    if (src.location_id === toLocationId) throw new StockError('Choose a different location.');
    if (src.quantity < qty) throw new StockError(`Only ${Math.max(src.quantity, 0)} on hand here, so ${qty} cannot be moved.`);

    let dest = findDestination.get(src.model, src.part_code, src.description, toLocationId) as { id: number } | undefined;
    if (!dest) {
      dest = { id: Number(insertLine.run(src.model, src.part_code, src.description, toLocationId, src.min_stock).lastInsertRowid) };
    } else {
      db.prepare('UPDATE items SET archived = 0 WHERE id = ?').run(dest.id);
    }
    const group = crypto.randomUUID();
    applyMovement({ itemId, change: -qty, type: 'TRANSFER_OUT', note, transferGroup: group, userId });
    applyMovement({ itemId: dest.id, change: qty, type: 'TRANSFER_IN', note, transferGroup: group, userId });
  }
);
