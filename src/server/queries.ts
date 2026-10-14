import { db } from './db';

export interface LineRow {
  id: number;
  model: string;
  part_code: string;
  description: string;
  location_id: number | null;
  location: string | null;
  quantity: number;
  min_stock: number;
  lead_time_days: number | null;
  safety_stock: number | null;
  target_coverage_days: number | null;
}

export type StatusFilter = '' | 'debt' | 'zero' | 'low';

export function buildPartSearch(search: string, itemAlias = 'i', locationAlias = 'l') {
  const terms = search.split(',').map((term) => term.trim()).filter(Boolean).slice(0, 20);
  const params: Record<string, string> = {};
  const clause = terms.map((term, index) => {
    const key = `q${index}`;
    params[key] = `%${term}%`;
    return `(${itemAlias}.part_code LIKE @${key} OR ${itemAlias}.description LIKE @${key} OR ${itemAlias}.model LIKE @${key} OR ${locationAlias}.name LIKE @${key})`;
  }).join(' OR ') || '1=1';
  return { clause, params };
}

const fromWhere = (searchClause: string) => `
  FROM items i
  LEFT JOIN locations l ON l.id = i.location_id
  WHERE i.archived = 0
    AND (${searchClause})
    AND (@loc = 0 OR i.location_id = @loc)
    AND (@status = ''
         OR (@status = 'debt' AND i.quantity < 0)
         OR (@status = 'zero' AND i.quantity = 0)
         OR (@status = 'low'  AND i.min_stock > 0 AND i.quantity <= i.min_stock))
`;

export function parseStatus(v: unknown): StatusFilter {
  return v === 'debt' || v === 'zero' || v === 'low' ? v : '';
}

/** One row per inventory line, in the same order as the inventory sheet (model, then part code). Pass limit -1 for all rows. */
export function lineRows(search: string, locationId: number, status: StatusFilter, limit: number, offset: number): LineRow[] {
  const searchSql = buildPartSearch(search);
  return db
    .prepare(
      `SELECT i.id, i.model, i.part_code, i.description, i.location_id, l.name AS location, i.quantity, i.min_stock,
              i.lead_time_days, i.safety_stock, i.target_coverage_days
       ${fromWhere(searchSql.clause)}
       ORDER BY i.model, i.part_code, l.name, i.id
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...searchSql.params, loc: locationId, status, limit, offset }) as LineRow[];
}

export function lineCount(search: string, locationId: number, status: StatusFilter): number {
  const searchSql = buildPartSearch(search);
  const r = db.prepare(`SELECT COUNT(*) AS n ${fromWhere(searchSql.clause)}`).get({ ...searchSql.params, loc: locationId, status }) as { n: number };
  return r.n;
}

export function summary() {
  return db
    .prepare(
      `SELECT COUNT(*) AS lines,
              COALESCE(SUM(CASE WHEN quantity > 0 THEN quantity END), 0) AS units,
              COALESCE(SUM(CASE WHEN quantity < 0 THEN 1 END), 0) AS debt_lines,
              COALESCE(SUM(CASE WHEN quantity < 0 THEN quantity END), 0) AS debt_units
         FROM items WHERE archived = 0`
    )
    .get() as { lines: number; units: number; debt_lines: number; debt_units: number };
}
