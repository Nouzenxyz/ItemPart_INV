type Role = 'admin' | 'staff' | 'viewer';
interface User { id: number; username: string; full_name: string; role: Role; active?: number }
interface Loc { id: number; name: string }
interface StockRow {
  id: number; model: string; part_code: string; description: string;
  location_id: number | null; location: string | null; quantity: number; min_stock: number;
  lead_time_days: number | null; safety_stock: number | null; target_coverage_days: number | null;
}
interface SearchItem { id: number; model: string; part_code: string; description: string; quantity: number; location: string | null }
interface MoveRow {
  key: string; created_at: string; transaction_no: string; type: string; line_count: number; units: number;
  reference: string; technician: string; repair_job_no: string | null; user: string | null;
}
interface PartRow { id: number; model: string; part_code: string; description: string; total_quantity: number }
interface RepairJob { id: number; job_no: string; appliance_model: string; serial_no: string; technician: string; status: 'OPEN' | 'COMPLETED'; opened_at: string; closed_at: string | null; repair_outcome: string; part_lines: number; qty_issued: number }
interface Summary { lines: number; units: number; debt_lines: number; debt_units: number }
interface ImportResult {
  total: number; created: number; matched: number; stockChanges: number; newLocations: string[]; notInFile: number;
  debtLines: number; debtUnits: number; notes: string[]; errors: { row: number; message: string }[]; dryRun: boolean; applied: boolean;
}
interface Field {
  name: string; label: string; type?: 'text' | 'number' | 'password' | 'select'; signed?: boolean;
  options?: { value: string | number; label: string }[]; value?: string | number | null; required?: boolean; hint?: string;
}
type ApiError = Error & { debt?: boolean };

/** What the supervisor calls a negative quantity. Change this one word to rename it everywhere in the screens. */
const DEBT = 'Parts debt';
const PAGE_SIZE = 100;
const PARTS_PAGE_SIZE = 100;
const TYPE_LABEL: Record<string, string> = {
  IN: 'Stock In', OUT: 'Stock Out', RETURN: 'Return', ADJUST: 'Adjustment', OPENING: 'Opening quantity',
  EDIT: 'Details edited', TRANSFER_IN: 'Moved in', TRANSFER_OUT: 'Moved out',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const num = (n: number) => n.toLocaleString('en-US');

let me: User;
let locations: Loc[] = [];
let stockRows: StockRow[] = [];
let stockPage = 1;
let movePage = 1;
let partsPage = 1;
let importFile: File | null = null;

/* ---------- helpers ---------- */

async function api<T = any>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/login') showLogin();
    const err: ApiError = new Error(data.error || 'Something went wrong.');
    err.debt = !!data.debt;
    throw err;
  }
  return data as T;
}
const post = (url: string, body: unknown, method = 'POST') => api(url, { method, body: JSON.stringify(body) });

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3600);
}

function openDialog(title: string, fields: Field[], submitLabel: string, onSubmit: (v: Record<string, string>) => Promise<unknown>) {
  const dlg = $<HTMLDialogElement>('dlg');
  const form = $<HTMLFormElement>('dlgForm');
  const input = (f: Field) =>
    f.type === 'select'
      ? `<select name="${f.name}">${(f.options || [])
          .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`)
          .join('')}</select>`
      : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"${f.required ? ' required' : ''}${f.type === 'number' ? `${f.signed ? '' : ' min="0"'} step="1" inputmode="numeric"` : ''}>`;
  form.innerHTML =
    `<h3>${esc(title)}</h3>` +
    fields.map((f) => `<label>${esc(f.label)}${input(f)}${f.hint ? `<small class="field-hint">${esc(f.hint)}</small>` : ''}</label>`).join('') +
    `<p class="err" id="dlgErr"></p><div class="row"><button type="button" class="ghost" id="dlgCancel">Cancel</button><button>${esc(submitLabel)}</button></div>`;
  $('dlgCancel').onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const values: Record<string, string> = {};
    new FormData(form).forEach((v, k) => (values[k] = String(v)));
    try {
      await onSubmit(values);
      dlg.close();
    } catch (err) {
      $('dlgErr').textContent = (err as Error).message;
    }
  };
  dlg.showModal();
  (form.querySelector('input,select') as HTMLElement | null)?.focus();
}

/** "Showing 1 to 100 of 10,432" with First / Previous / Next / Last buttons. */
function renderPager(el: HTMLElement, page: number, total: number, go: (p: number) => void, pageSize = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const b = (p: number, label: string, off: boolean) => `<button class="small ghost" data-p="${p}"${off ? ' disabled' : ''}>${label}</button>`;
  el.innerHTML =
    `<span>Showing ${num(from)} to ${num(to)} of ${num(total)}</span>` +
    (pages > 1
      ? `<span class="btns">${b(1, 'First', page === 1)}${b(page - 1, 'Previous', page === 1)}<span class="page-no">Page ${num(page)} of ${num(pages)}</span>${b(page + 1, 'Next', page === pages)}${b(pages, 'Last', page === pages)}</span>`
      : '');
  el.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.disabled) return;
    go(Number(btn.dataset.p));
    el.parentElement?.querySelector('.scroll')?.scrollTo({ top: 0 });
  };
}

const locOptions = (withNone: boolean, exceptId?: number | null) => [
  ...(withNone ? [{ value: '', label: 'No location' }] : []),
  ...locations.filter((l) => l.id !== exceptId).map((l) => ({ value: l.id, label: l.name })),
];
const canEdit = () => me.role !== 'viewer';
const lineName = (r: StockRow) => `${r.part_code}${r.model ? ' · ' + r.model : ''}`;

/* ---------- login / app shell ---------- */

function showLogin() {
  $('appView').hidden = true;
  $('loginView').hidden = false;
}

async function showApp(user: User) {
  me = user;
  $('loginView').hidden = true;
  $('appView').hidden = false;
  closeSidebar();
  $('whoName').textContent = `${user.full_name || user.username} (${user.role})`;
  $('tabUsers').hidden = user.role !== 'admin';
  $('tabBackups').hidden = user.role !== 'admin';
  $('helpBackupCard').hidden = user.role !== 'admin';
  $('helpCountCard').hidden = !canEdit();
  document.querySelectorAll<HTMLElement>('.edit-only').forEach((e) => (e.hidden = !canEdit()));
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((e) => (e.hidden = user.role !== 'admin'));
  await loadLocations();
  $('usageLocation').innerHTML = `<option value="0">All locations</option>` + locations.map((location) => `<option value="${location.id}">${esc(location.name)}</option>`).join('');
  $('countLocation').innerHTML = `<option value="0">All locations</option>` + locations.map((location) => `<option value="${location.id}">${esc(location.name)}</option>`).join('');
  await Promise.all([loadSummary(), loadStock(1)]);
  switchTab('parts');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const user = await post('/login', { username: $<HTMLInputElement>('loginUser').value, password: $<HTMLInputElement>('loginPass').value });
    $<HTMLInputElement>('loginPass').value = '';
    await showApp(user as User);
  } catch (err) {
    $('loginErr').textContent = (err as Error).message;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => undefined);
  showLogin();
});

function setSidebarOpen(open: boolean) {
  $('appShell').classList.toggle('sidebar-open', open);
  const toggle = $<HTMLButtonElement>('sidebarToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}
function closeSidebar() { setSidebarOpen(false); }

$('sidebarToggle').addEventListener('click', () => {
  setSidebarOpen(!$('appShell').classList.contains('sidebar-open'));
});

$('appMain').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('#sidebarToggle')) return;
  if ($('appShell').classList.contains('sidebar-open')) closeSidebar();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('appShell').classList.contains('sidebar-open')) closeSidebar();
});

$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) {
    if (b.dataset.tab) switchTab(b.dataset.tab);
    closeSidebar();
  }
});

$('appView').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-help-tab]');
  if (button?.dataset.helpTab) {
    $<HTMLDialogElement>('helpDialog').close();
    switchTab(button.dataset.helpTab);
  }
});

$('helpFab').addEventListener('click', () => $<HTMLDialogElement>('helpDialog').showModal());
$('helpClose').addEventListener('click', () => $<HTMLDialogElement>('helpDialog').close());

function switchTab(tab: string) {
  document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>('.page').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  if (tab === 'stock') void Promise.all([loadSummary(), loadStock()]);
  if (tab === 'counts') void loadCountLines();
  if (tab === 'backups') void loadBackups();
  if (tab === 'movements') void loadMovements();
  if (tab === 'repairs') void loadRepairs();
  if (tab === 'parts') void loadParts();
  if (tab === 'reports') {
    document.querySelectorAll<HTMLButtonElement>('[data-report-view]').forEach((b) => b.classList.toggle('on', b.dataset.reportView === activeReportView));
    document.querySelectorAll<HTMLElement>('.report-view').forEach((view) => { view.hidden = view.id !== `report-${activeReportView}`; });
    if (activeReportView === 'overview') void loadReportOverview();
    if (activeReportView === 'usage') void loadUsageReport();
    if (activeReportView === 'restock') void loadRestockPriorities();
    if (activeReportView === 'setup') void loadRestockProfiles();
    if (activeReportView === 'repairs') void loadRepairReport();
  }
  if (tab === 'users') void loadUsers();
}

/* ---------- stock tab ---------- */

async function loadLocations() {
  locations = await api<Loc[]>('/locations');
  const sel = $<HTMLSelectElement>('locFilter');
  const current = sel.value;
  sel.innerHTML = `<option value="0">All locations</option>` + locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = current || '0';
}

let expandedPartToken = 0;
let partsLoadToken = 0;
async function loadParts(page: number = partsPage) {
  partsPage = page;
  const token = ++partsLoadToken;
  expandedPartToken++;
  const q = encodeURIComponent($<HTMLInputElement>('partsSearch').value.trim());
  const data = await api<{ rows: PartRow[]; total: number }>(`/parts?search=${q}&limit=${PARTS_PAGE_SIZE}&offset=${(page - 1) * PARTS_PAGE_SIZE}`);
  if (token !== partsLoadToken) return;
  const pages = Math.max(1, Math.ceil(data.total / PARTS_PAGE_SIZE));
  if (page > pages) return loadParts(pages);
  renderPager($('partsPager'), page, data.total, (nextPage) => void loadParts(nextPage), PARTS_PAGE_SIZE);
  $('partsBody').innerHTML = data.rows.map((r) => `<tr class="part-row"><td><button class="small ghost expand-part" data-part-id="${r.id}" aria-expanded="false" aria-label="Show locations for ${esc(r.part_code)}">＋</button></td><td class="code">${esc(r.part_code)}</td><td>${esc(r.model)}</td><td>${esc(r.description)}</td><td class="num">${num(r.total_quantity)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No matching parts.</td></tr>';
}
let partsTimer: number | undefined;
$('partsSearch').addEventListener('input', () => { clearTimeout(partsTimer); partsTimer = window.setTimeout(() => void loadParts(1), 250); });
$('partsBody').addEventListener('click', async (event) => {
  const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr.part-row');
  if (!row) return;
  const button = row.querySelector<HTMLButtonElement>('[data-part-id]');
  if (!button) return;
  const next = row.nextElementSibling;
  if (next?.classList.contains('part-locations')) { expandedPartToken++; next.remove(); button.textContent = '＋'; button.setAttribute('aria-expanded','false'); return; }
  $('partsBody').querySelectorAll('.part-locations').forEach((detail) => detail.remove());
  $('partsBody').querySelectorAll<HTMLButtonElement>('[data-part-id]').forEach((partButton) => { partButton.textContent = '＋'; partButton.setAttribute('aria-expanded','false'); });
  const token = ++expandedPartToken;
  button.textContent = '…';
  button.setAttribute('aria-expanded','true');
  try {
    const locationsByPart = await api<{ location: string | null; quantity: number; lines: number }[]>(`/parts/${button.dataset.partId}/locations`);
    if (token !== expandedPartToken || !row.isConnected) return;
    const detail = document.createElement('tr'); detail.className = 'part-locations';
    detail.innerHTML = `<td colspan="5"><div class="location-breakdown"><strong>Combined quantity for this part code by location</strong><table><thead><tr><th>Location</th><th class="num">Quantity</th><th class="num">Stock entries</th></tr></thead><tbody>${locationsByPart.map((l) => `<tr><td>${esc(l.location ?? 'No location')}</td><td class="num">${num(l.quantity)}</td><td class="num">${num(l.lines)}</td></tr>`).join('')}</tbody></table></div></td>`;
    row.after(detail); button.textContent = '−';
  } catch (error) { if (token === expandedPartToken) { button.textContent = '＋'; button.setAttribute('aria-expanded','false'); toast((error as Error).message); } }
});

$('stockInBtn').addEventListener('click', () => openTransaction('IN'));
$('stockOutBtn').addEventListener('click', () => openTransaction('OUT'));
$('partsCountBtn').addEventListener('click', () => switchTab('counts'));
$('addItemBtnParts').addEventListener('click', () => $('addItemBtn').click());
$('addLocBtnParts').addEventListener('click', () => $('addLocBtn').click());

let activeReportView = 'overview';
const RESTOCK_PAGE_SIZE = 50;
let restockPage = 1;
let usagePage = 1;
const selectedRestockLines=new Map<number,{item_id:number;suggested_qty:number;order_qty:number}>();
async function loadReportOverview() {
  try {
    const data = await api<any>('/report/overview'), k = data.kpis;
    $('reportKpis').innerHTML = `<article><span>Repair jobs this month</span><strong>${num(k.repairs_this_month)}</strong></article><article><span>Open repair jobs</span><strong>${num(k.open_repairs)}</strong></article><article><span>Parts issued this month</span><strong>${num(k.parts_issued_this_month)}</strong></article><article><span>Parts returned this month</span><strong>${num(k.parts_returned_this_month)}</strong></article>`;
    const monthName = (key: string) => new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' });
    const monthly = data.monthly as {month:string;jobs:number}[];
    const filled = Array.from({length:12}, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 11 + i); const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; return {month:key,jobs: monthly.find((m) => m.month===key)?.jobs ?? 0}; });
    const max = Math.max(1, ...filled.map((m) => Number(m.jobs)));
    $('repairTrendChart').innerHTML = `<div class="bar-chart">${filled.map((m) => `<div class="bar-column" title="${esc(m.month)}: ${num(m.jobs)} jobs"><span>${num(m.jobs)}</span><i style="height:${Math.max(3, Number(m.jobs) / max * 100)}%"></i><small>${monthName(m.month)}</small></div>`).join('')}</div>`;
    const models = data.models as {model:string;jobs:number}[], modelMax = Math.max(1,...models.map((m) => Number(m.jobs)));
    $('repairModelChart').innerHTML = models.length ? `<div class="model-bars">${models.map((m) => `<div><span title="${esc(m.model)}">${esc(m.model)}</span><i><b style="width:${Number(m.jobs)/modelMax*100}%"></b></i><strong>${num(m.jobs)}</strong></div>`).join('')}</div>` : '<p class="empty">Repair jobs will appear here as they are recorded.</p>';
    const conditions = (data.returns as any[]).map((r) => `${esc(r.condition)}: <strong>${num(r.quantity)}</strong>`).join(' · ');
    const alerts = [`<span><strong>${num(k.debt_lines)}</strong> stock lines currently in debt</span>`, `<span><strong>${num(k.open_repairs)}</strong> repair jobs still open</span>`, `<span><strong>${num(k.restock_profiles_missing)}</strong> lines need complete restock profiles <button type="button" class="link" data-open-report="setup">Review</button></span>`, conditions ? `<span>Repair return conditions, last 12 months: ${conditions}</span>` : '<span>No repair return records in the last 12 months.</span>'];
    $('reportAttention').innerHTML = alerts.map((a) => `<div>${a}</div>`).join('');
  } catch (error) { toast((error as Error).message); }
}
async function loadRestockPriorities(page: number = restockPage) {
  try {
    const search = encodeURIComponent($<HTMLInputElement>('restockSearch').value.trim());
    const data = await api<{rows:any[];total:number}>(`/restock-priorities?search=${search}&limit=${RESTOCK_PAGE_SIZE}&offset=${(page - 1) * RESTOCK_PAGE_SIZE}`);
    const pages = Math.max(1, Math.ceil(data.total / RESTOCK_PAGE_SIZE));
    if (page > pages) return loadRestockPriorities(pages);
    restockPage = page;
    renderPager($('restockPager'), page, data.total, (nextPage) => void loadRestockPriorities(nextPage), RESTOCK_PAGE_SIZE);
    $('restockBody').innerHTML = data.rows.map((r) => {
      const selected=selectedRestockLines.get(r.id);
      return `<tr class="${r.quantity < 0 ? 'debt' : r.suggested_order > 0 ? 'low' : ''}"><td>${canEdit()?`<input type="checkbox" aria-label="Select ${esc(r.part_code)} for draft order" data-order-check="${r.id}"${selected?' checked':''}>`:''}</td><td><strong>#${r.priority}</strong></td><td><strong>${esc(r.part_code)}</strong><small class="tx-part-desc">${esc([r.model,r.description].filter(Boolean).join(' · '))}</small></td><td>${esc(r.location || 'No location')}</td><td class="num">${num(r.quantity)}</td><td class="num">${num(r.used_90)}</td><td>${esc(r.reason)}</td><td class="num"><strong>${r.suggested_order > 0 ? num(r.suggested_order) : 'Review'}</strong></td><td>${canEdit()?`<input class="order-qty" type="number" min="1" step="1" aria-label="Order quantity for ${esc(r.part_code)}" data-order-qty="${r.id}" data-suggested="${r.suggested_order??0}" value="${selected?.order_qty ?? (r.suggested_order>0?r.suggested_order:'')}">`:''}</td><td><button class="small ghost" data-find-stock="${esc(r.part_code)}">Find line</button></td></tr>`;
    }).join('') || '<tr><td colspan="10" class="empty">No stock lines currently meet a restock priority rule.</td></tr>';
  } catch (error) { toast((error as Error).message); }
}
async function loadUsageReport(page: number = usagePage) {
  try {
    const period = $<HTMLSelectElement>('usagePeriod').value;
    const location = $<HTMLSelectElement>('usageLocation').value || '0';
    const searchValue=$<HTMLInputElement>('usageSearch').value.trim();
    const search = encodeURIComponent(searchValue);
    $('exportUsageBtn').setAttribute('href',`/api/export/usage-report?period=${period}&locationId=${location}&search=${search}`);
    const data = await api<any>(`/usage-report?period=${period}&locationId=${location}&search=${search}&limit=${RESTOCK_PAGE_SIZE}&offset=${(page - 1) * RESTOCK_PAGE_SIZE}`);
    const pages = Math.max(1, Math.ceil(data.total / RESTOCK_PAGE_SIZE));
    if (page > pages) return loadUsageReport(pages);
    usagePage = page;
    const s = data.summary;
    const avgMonth = Number(s.net_used) / (period === '12m' ? 12 : 3);
    $('usageKpis').innerHTML = `<article><span>Units issued</span><strong>${num(s.issued)}</strong></article><article><span>Units returned</span><strong>${num(s.returned)}</strong></article><article><span>Net units used</span><strong>${num(s.net_used)}</strong></article><article><span>Average net use / month</span><strong>${avgMonth.toFixed(1)}</strong></article>`;
    const monthLabel = (key: string) => new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined,{month:'short'});
    const trend = data.trend as {month:string;issued:number;returned:number}[];
    const filled = Array.from({length:12},(_,i) => { const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-11+i); const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; return trend.find((x) => x.month===key) || {month:key,issued:0,returned:0}; });
    const max = Math.max(1,...filled.flatMap((m) => [Number(m.issued),Number(m.returned)]));
    $('usageTrendChart').innerHTML = `<div class="usage-trend">${filled.map((m) => `<div class="usage-month" title="${esc(m.month)} · issued ${num(m.issued)} · returned ${num(m.returned)}"><span>${num(m.issued-m.returned)}</span><div class="usage-bars"><i class="issued" style="height:${Math.max(3,Number(m.issued)/max*100)}%"></i><i class="returned" style="height:${Math.max(3,Number(m.returned)/max*100)}%"></i></div><small>${monthLabel(m.month)}</small></div>`).join('')}</div>`;
    const top = data.top as any[], topMax = Math.max(1,...top.map((r) => Number(r.net_used)));
    $('usageTopChart').innerHTML = top.length ? `<div class="model-bars">${top.map((r) => `<div><span title="${esc([r.model,r.part_code,r.location].filter(Boolean).join(' · '))}">${esc([r.part_code,r.model].filter(Boolean).join(' · '))}</span><i><b style="width:${Number(r.net_used)/topMax*100}%"></b></i><strong>${num(r.net_used)}</strong></div>`).join('')}</div>` : '<p class="empty">No net usage in this period.</p>';
    $('usageBody').innerHTML = (data.rows as any[]).map((r) => `<tr><td><strong>${esc(r.part_code)}</strong><small class="tx-part-desc">${esc([r.model,r.description].filter(Boolean).join(' · '))}</small></td><td>${esc(r.location || 'No location')}</td><td class="num">${num(r.quantity)}</td><td class="num">${num(r.issued)}</td><td class="num">${num(r.returned)}</td><td class="num ${r.net_used < 0 ? 'neg' : ''}">${num(r.net_used)}</td><td class="num">${Number(r.avg_monthly).toFixed(1)}</td><td class="num">${r.days_cover === null ? '—' : `${Math.round(r.days_cover)} days`}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No stock movement usage found for these filters.</td></tr>';
    renderPager($('usagePager'),page,data.total,(nextPage) => void loadUsageReport(nextPage),RESTOCK_PAGE_SIZE);
  } catch (error) { toast((error as Error).message); }
}
async function loadRestockOrders() {
  try {
    const orders=await api<any[]>('/restock-orders');
    $('ordersBody').innerHTML=orders.map((o)=>`<tr><td><button type="button" class="link transaction-link" data-order-id="${o.id}">${esc(o.order_no)}</button></td><td>${esc(o.created_at)}</td><td>${esc(o.supplier||'Not set')}</td><td><span class="order-status ${String(o.status).toLowerCase()}">${esc(o.status)}</span></td><td class="num">${num(o.line_count)}</td><td class="num">${num(o.order_units)}</td><td class="num">${num(o.received_units)}</td><td><button type="button" class="small ghost" data-order-id="${o.id}">Details</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty">No purchase orders yet. Select parts in Restock priorities to create a draft.</td></tr>';
  } catch(error){toast((error as Error).message);}
}
async function loadBackups() {
  try {
    const backups=await api<{filename:string;size:number;createdAt:string}[]>('/backups');
    $('backupBody').innerHTML=backups.map((backup)=>`<tr><td>${esc(backup.filename)}</td><td>${esc(new Date(backup.createdAt).toLocaleString())}</td><td class="num">${(backup.size/1024/1024).toFixed(2)} MB</td><td><a class="btn ghost small" href="/api/backups/${encodeURIComponent(backup.filename)}">Download</a></td></tr>`).join('')||'<tr><td colspan="4" class="empty">No backups found yet. Create one now or wait for the automatic backup.</td></tr>';
  }catch(error){toast((error as Error).message);}
}
$('backupNowBtn').addEventListener('click',async()=>{
  const button=$<HTMLButtonElement>('backupNowBtn');button.disabled=true;
  try{const backup=await post('/backups',{}) as {filename:string};toast(`Backup created: ${backup.filename}`);await loadBackups();}
  catch(error){toast((error as Error).message);}
  finally{button.disabled=false;}
});
$('refreshBackupsBtn').addEventListener('click',()=>void loadBackups());
async function showRestockOrder(id:number) {
  try {
    const data=await api<any>(`/restock-orders/${id}`),o=data.order,lines=data.lines;
    const dlg=$<HTMLDialogElement>('dlg'),form=$<HTMLFormElement>('dlgForm');
    const orderActions=canEdit()&&o.status==='DRAFT'?'<button type="button" data-order-action="ordered">Mark as ordered</button><button type="button" class="danger" data-order-action="cancel">Cancel draft</button>':'';
    const receiveAction=canEdit()&&['ORDERED','PARTIAL'].includes(o.status)?'<button type="button" data-order-action="receive">Receive stock</button>':'';
    form.innerHTML=`<div class="repair-detail"><header class="repair-detail-head"><div><span class="tx-kicker">PURCHASE ORDER</span><h2>${esc(o.order_no)}</h2><p>${esc(o.supplier||'Supplier not set')}</p></div><span class="order-status ${String(o.status).toLowerCase()}">${esc(o.status)}</span></header><div class="scroll"><table><thead><tr><th>Part</th><th>Location</th><th class="num">Suggested</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Remaining</th></tr></thead><tbody>${lines.map((l:any)=>`<tr><td>${esc([l.part_code,l.model,l.description].filter(Boolean).join(' · '))}</td><td>${esc(l.location||'No location')}</td><td class="num">${num(l.suggested_qty)}</td><td class="num">${num(l.order_qty)}</td><td class="num">${num(l.received_qty)}</td><td class="num">${num(l.order_qty-l.received_qty)}</td></tr>`).join('')}</tbody></table></div></div><p class="err" id="dlgErr"></p><div class="row">${orderActions}${receiveAction}<button type="button" class="ghost" id="dlgCancel">Close</button></div>`;
    form.onsubmit=(event)=>event.preventDefault();$('dlgCancel').onclick=()=>dlg.close();
    form.querySelectorAll<HTMLButtonElement>('[data-order-action]').forEach((button)=>button.onclick=()=>{
      const action=button.dataset.orderAction;dlg.close();
      if(action==='ordered') openDialog(`Mark ${o.order_no} as ordered`,[{name:'supplier',label:'Supplier',required:true,value:o.supplier,hint:'Enter the supplier you placed this order with.'}],'Confirm order',async(values)=>{await post(`/restock-orders/${id}`,{...values,status:'ORDERED'},'PUT');toast(`${o.order_no} marked as ordered.`);await loadRestockOrders();});
      if(action==='cancel'&&confirm(`Cancel draft ${o.order_no}?`)) void post(`/restock-orders/${id}`,{supplier:o.supplier,status:'CANCELLED'},'PUT').then(()=>{toast('Draft cancelled.');void loadRestockOrders();}).catch((error)=>toast((error as Error).message));
      if(action==='receive'){
        const initial=lines.filter((l:any)=>l.order_qty>l.received_qty).map((l:any)=>({id:l.item_id,model:l.model,part_code:l.part_code,description:l.description,quantity:l.quantity,location:l.location,receive_quantity:l.order_qty-l.received_qty}));
        void openTransaction('IN',initial,undefined,{id:o.id,orderNo:o.order_no,supplier:o.supplier});
      }
    });
    dlg.showModal();
  }catch(error){toast((error as Error).message);}
}
document.querySelector<HTMLButtonElement>('#createOrderBtn')?.addEventListener('click',()=>{
  const lines=[...selectedRestockLines.values()];
  if(!lines.length){toast('Select at least one stock line first.');return;}
  if(lines.some((line)=>!Number.isInteger(line.order_qty)||line.order_qty<1)){toast('Enter an order quantity greater than zero for every selected part.');return;}
  openDialog('Create purchase order draft',[{name:'supplier',label:'Supplier (optional for a draft)',hint:'You can add the supplier when the order is placed.'}],'Create draft',async(values)=>{
    const result=await post('/restock-orders',{supplier:values.supplier,lines}) as {id:number;orderNo:string};
    selectedRestockLines.clear();toast(`Draft ${result.orderNo} created.`);
    document.querySelector<HTMLButtonElement>('[data-report-view="orders"]')?.click();
  });
});
$('restockBody').addEventListener('change',(event)=>{
  const el=event.target as HTMLInputElement;
  if(!el.dataset.orderCheck) return;
  const id=Number(el.dataset.orderCheck),qty=$('restockBody').querySelector<HTMLInputElement>(`[data-order-qty="${id}"]`)!,suggested=Number(qty.dataset.suggested||0);
  if(el.checked) selectedRestockLines.set(id,{item_id:id,suggested_qty:suggested,order_qty:Number(qty.value)||0}); else selectedRestockLines.delete(id);
});
$('restockBody').addEventListener('input',(event)=>{
  const el=event.target as HTMLInputElement;
  if(!el.dataset.orderQty) return;
  const id=Number(el.dataset.orderQty),suggested=Number(el.dataset.suggested||0),orderQty=Number(el.value)||0;
  if(el.value){selectedRestockLines.set(id,{item_id:id,suggested_qty:suggested,order_qty:orderQty});const check=$('restockBody').querySelector<HTMLInputElement>(`[data-order-check="${id}"]`);if(check)check.checked=true;}
  else if(selectedRestockLines.has(id)) selectedRestockLines.set(id,{item_id:id,suggested_qty:suggested,order_qty:0});
});
$('ordersBody').addEventListener('click',(event)=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-order-id]');if(button)void showRestockOrder(Number(button.dataset.orderId));});
$('refreshOrders').addEventListener('click',()=>void loadRestockOrders());
let profileSetupPage = 1;
async function loadRestockProfiles(page: number = profileSetupPage) {
  try {
    const data = await api<{rows:any[];total:number}>(`/restock-profiles?limit=${RESTOCK_PAGE_SIZE}&offset=${(page - 1) * RESTOCK_PAGE_SIZE}`);
    const pages = Math.max(1, Math.ceil(data.total / RESTOCK_PAGE_SIZE));
    if (page > pages) return loadRestockProfiles(pages);
    profileSetupPage = page;
    renderPager($('profileSetupPager'),page,data.total,(nextPage) => void loadRestockProfiles(nextPage),RESTOCK_PAGE_SIZE);
    $('profileSetupBody').innerHTML = data.rows.map((r) => {
      const missing = [r.lead_time_days === null && 'Lead time',r.safety_stock === null && 'Safety stock',r.target_coverage_days === null && 'Target coverage'].filter(Boolean).join(', ');
      return `<tr><td><strong>${esc(r.part_code)}</strong><small class="tx-part-desc">${esc([r.model,r.description].filter(Boolean).join(' · '))}</small></td><td>${esc(r.location || 'No location')}</td><td class="num">${num(r.quantity)}</td><td>${r.lead_time_days === null ? 'Not set' : `${num(r.lead_time_days)} days`}</td><td>${r.safety_stock === null ? 'Not set' : num(r.safety_stock)}</td><td>${r.target_coverage_days === null ? 'Not set' : `${num(r.target_coverage_days)} days`}</td><td>${esc(missing)}</td><td><button class="small" data-configure-profile="${r.id}">Configure</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">All active stock lines have complete restock profiles.</td></tr>';
    $('profileSetupBody').querySelectorAll<HTMLButtonElement>('[data-configure-profile]').forEach((button,index) => button.onclick = () => {
      const r = data.rows[index];
      openDialog(`Restock profile · ${r.part_code}`,[
        {name:'lead_time_days',label:'Supplier lead time in days',type:'number',required:true,value:r.lead_time_days,hint:'How many days it usually takes for this part to arrive after ordering.'},
        {name:'safety_stock',label:'Safety stock units',type:'number',required:true,value:r.safety_stock,hint:'Extra units to keep available in case use is higher than expected or delivery is delayed.'},
        {name:'target_coverage_days',label:'Target coverage after ordering in days',type:'number',required:true,value:r.target_coverage_days,hint:'How many days of expected use you want the new order to cover.'},
      ],'Save profile',async (values) => {
        await post(`/items/${r.id}/restock-profile`,values,'PUT');
        toast(`Restock profile saved for ${r.part_code}.`);
        await Promise.all([loadRestockProfiles(profileSetupPage),loadRestockPriorities(1)]);
      });
    });
  } catch (error) { toast((error as Error).message); }
}
document.querySelector('.report-tabs')?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-report-view]');
  if (!button) return;
  activeReportView = button.dataset.reportView || 'overview';
  document.querySelectorAll<HTMLButtonElement>('[data-report-view]').forEach((b) => b.classList.toggle('on', b === button));
  document.querySelectorAll<HTMLElement>('.report-view').forEach((view) => { view.hidden = view.id !== `report-${activeReportView}`; });
    if (activeReportView === 'overview') void loadReportOverview();
    if (activeReportView === 'usage') void loadUsageReport();
    if (activeReportView === 'restock') void loadRestockPriorities();
    if (activeReportView === 'orders') void loadRestockOrders();
    if (activeReportView === 'setup') void loadRestockProfiles();
    if (activeReportView === 'repairs') void loadRepairReport();
});
$('usagePeriod').addEventListener('change', () => void loadUsageReport(1));
$('usageLocation').addEventListener('change', () => void loadUsageReport(1));
let usageSearchTimer: number | undefined;
$('usageSearch').addEventListener('input', () => { clearTimeout(usageSearchTimer); usageSearchTimer = window.setTimeout(() => void loadUsageReport(1),250); });
$('refreshRestock').addEventListener('click', () => void loadRestockPriorities(1));
let restockSearchTimer: number | undefined;
$('restockSearch').addEventListener('input', () => { clearTimeout(restockSearchTimer); restockSearchTimer = window.setTimeout(() => void loadRestockPriorities(1), 250); });
$('refreshProfiles').addEventListener('click', () => void loadRestockProfiles(1));
$('reportAttention').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('[data-open-report="setup"]')) {
    activeReportView = 'setup';
    document.querySelector<HTMLButtonElement>('[data-report-view="setup"]')?.click();
  }
});
$('restockBody').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-find-stock]');
  if (!button) return;
  $<HTMLInputElement>('search').value = button.dataset.findStock || '';
  $<HTMLSelectElement>('locFilter').value = '0';
  $<HTMLSelectElement>('statusFilter').value = '';
  stockPage = 1;
  switchTab('stock');
});

async function loadRepairs() {
  const q = encodeURIComponent($<HTMLInputElement>('repairsSearch').value.trim());
  const status = encodeURIComponent($<HTMLSelectElement>('repairsStatus').value);
  const rows = await api<RepairJob[]>(`/repairs?search=${q}&status=${status}`);
  const open = rows.filter((job) => job.status === 'OPEN').length;
  $('repairsSummary').innerHTML = `<span class="chip"><b>${num(rows.length)}</b> jobs shown</span><span class="chip"><b>${num(open)}</b> open</span>`;
  $('repairsBody').innerHTML = rows.map((job) => `<tr><td><button type="button" class="link repair-job-link" data-job-id="${job.id}">${esc(job.job_no)}</button></td><td>${esc(job.opened_at)}</td><td>${esc(job.appliance_model)}</td><td>${esc(job.serial_no)}</td><td>${esc(job.technician)}</td><td><span class="job-status ${job.status === 'COMPLETED' ? 'complete' : ''}">${job.status === 'OPEN' ? 'Open' : 'Completed'}</span></td><td class="num">${num(job.part_lines)}</td><td class="num">${num(job.qty_issued)}</td><td>${esc(job.repair_outcome)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No repair jobs match your search.</td></tr>';
}
let repairTimer: number | undefined;
$('repairsSearch').addEventListener('input', () => { clearTimeout(repairTimer); repairTimer = window.setTimeout(() => void loadRepairs(), 250); });
$('repairsStatus').addEventListener('change', () => void loadRepairs());
$('repairsBody').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-job-id]');
  if (button) void showRepair(Number(button.dataset.jobId));
});
$('addRepairBtn').addEventListener('click', () => openDialog('New repair / service job', [
  { name: 'appliance_model', label: 'Appliance model being repaired', required: true },
  { name: 'serial_no', label: 'Appliance serial number (optional)' },
  { name: 'technician', label: 'Technician' },
  { name: 'complaint', label: 'Reported problem' },
  { name: 'failure_code', label: 'Failure code (optional)' },
], 'Create job', async (values) => {
  const result = await post('/repairs', values) as { id: number; jobNo: string };
  toast(`Repair job ${result.jobNo} created.`);
  await loadRepairs();
  window.setTimeout(() => void showRepair(result.id), 50);
}));

async function showRepair(id: number) {
  try {
    const data = await api<{ job: any; parts: any[]; returns: any[] }>(`/repairs/${id}`);
    const j = data.job, dlg = $<HTMLDialogElement>('dlg'), form = $<HTMLFormElement>('dlgForm');
    form.innerHTML = `<div class="repair-detail"><header class="repair-detail-head"><div><span class="tx-kicker">REPAIR / SERVICE CASE</span><h2>${esc(j.job_no)}</h2><p>${esc(j.appliance_model)}${j.serial_no ? ` · Serial ${esc(j.serial_no)}` : ''}</p></div><span class="job-status ${j.status === 'COMPLETED' ? 'complete' : ''}">${j.status === 'OPEN' ? 'Open' : 'Completed'}</span></header>
      <div class="repair-facts"><div><span>Technician</span><strong>${esc(j.technician || '—')}</strong></div><div><span>Opened</span><strong>${esc(j.opened_at)}</strong></div><div><span>Closed</span><strong>${esc(j.closed_at || '—')}</strong></div><div><span>Failure code</span><strong>${esc(j.failure_code || '—')}</strong></div><div class="wide"><span>Reported problem</span><strong>${esc(j.complaint || '—')}</strong></div><div class="wide"><span>Repair outcome</span><strong>${esc(j.repair_outcome || 'Not recorded')}</strong></div></div>
      <section class="repair-detail-section"><h3>Parts issued for this repair</h3><p class="hint">Issued quantities come from linked Stock Out transactions. Record actual installed quantities when the repair is complete.</p>
        <div class="scroll repair-lines"><table><thead><tr><th>Part</th><th>Location</th><th class="num">Issued</th><th class="num">Installed</th><th>Stock Out No.</th><th></th></tr></thead><tbody>${data.parts.map((p) => `<tr><td><strong>${esc(p.part_code)}</strong><small class="tx-part-desc">${esc([p.part_model,p.description].filter(Boolean).join(' · '))}</small></td><td>${esc(p.location ?? 'No location')}</td><td class="num">${num(p.qty_issued)}</td><td class="num">${p.qty_used === null ? '<span class="hint">Not recorded</span>' : num(p.qty_used)}</td><td>${esc(p.transaction_no)}</td><td>${canEdit() ? `<button type="button" class="small ghost" data-edit-job-part="${p.id}" data-issued="${p.qty_issued}" data-used="${p.qty_used ?? ''}" data-code="${esc(p.part_code)}">Record use</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No parts issued yet. Use Stock Out for this repair to link the parts.</td></tr>'}</tbody></table></div></section>
      <section class="repair-detail-section"><h3>Returned parts</h3><p class="hint">Return entries are for repair analysis and do not change inventory. Reusable stock must be processed separately through Stock In.</p>
        <div class="scroll repair-lines"><table><thead><tr><th>Part</th><th class="num">Qty</th><th>Condition</th><th>Reason</th><th>Recorded</th></tr></thead><tbody>${data.returns.map((r) => `<tr><td class="code">${esc(r.part_code)}</td><td class="num">${num(r.qty_returned)}</td><td>${esc(r.returned_condition)}</td><td>${esc(r.return_reason)}</td><td>${esc(r.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No returned parts recorded.</td></tr>'}</tbody></table></div></section></div>
      <p class="err" id="dlgErr"></p><div class="row repair-actions">${canEdit() ? `<button type="button" class="ghost" data-repair-action="edit">Edit job</button><button type="button" class="ghost" data-repair-action="return" ${j.status !== 'OPEN' ? 'disabled' : ''}>Record returned part</button><button type="button" data-repair-action="issue" ${j.status !== 'OPEN' ? 'disabled' : ''}>Stock Out for repair</button>` : ''}<button type="button" class="ghost" id="dlgCancel">Close</button></div>`;
    form.onsubmit = (event) => event.preventDefault();
    $('dlgCancel').onclick = () => dlg.close();
    form.querySelectorAll<HTMLButtonElement>('[data-edit-job-part]').forEach((button) => button.onclick = () => {
      dlg.close();
      openDialog(`Installed quantity · ${button.dataset.code}`, [
        { name: 'qty_used', label: `Quantity installed (issued: ${button.dataset.issued})`, type: 'number', required: true, value: button.dataset.used },
      ], 'Save installed quantity', async (values) => {
        await post(`/repairs/${id}/parts/${button.dataset.editJobPart}`, values, 'PUT');
        toast('Installed quantity recorded.'); await loadRepairs(); window.setTimeout(() => void showRepair(id), 50);
      });
    });
    form.querySelectorAll<HTMLButtonElement>('[data-repair-action]').forEach((button) => button.onclick = () => {
      const action = button.dataset.repairAction;
      dlg.close();
      if (action === 'issue') void openTransaction('OUT', undefined, id);
      if (action === 'edit') openDialog(`Edit repair job · ${j.job_no}`, [
        { name: 'appliance_model', label: 'Appliance model being repaired', required: true, value: j.appliance_model },
        { name: 'serial_no', label: 'Appliance serial number', value: j.serial_no },
        { name: 'technician', label: 'Technician', value: j.technician },
        { name: 'complaint', label: 'Reported problem', value: j.complaint },
        { name: 'failure_code', label: 'Failure code', value: j.failure_code },
        { name: 'status', label: 'Status', type: 'select', value: j.status, options: [{ value: 'OPEN', label: 'Open' }, { value: 'COMPLETED', label: 'Completed' }] },
        { name: 'repair_outcome', label: 'Repair outcome (required to complete)', value: j.repair_outcome },
      ], 'Save repair job', async (values) => {
        await post(`/repairs/${id}`, values, 'PUT'); toast('Repair job updated.'); await loadRepairs(); window.setTimeout(() => void showRepair(id), 50);
      });
      if (action === 'return') void recordRepairReturn(id);
    });
    dlg.showModal();
  } catch (error) { toast((error as Error).message); }
}

async function recordRepairReturn(jobId: number) {
  const dlg = $<HTMLDialogElement>('dlg'), form = $<HTMLFormElement>('dlgForm');
  form.innerHTML = `<h3>Find returned part</h3><p class="hint">This records a returned part for repair analysis. It does not add stock.</p><label>Search model, part code or description<input id="returnPartSearch" autocomplete="off"></label><div class="tx-matches" id="returnPartMatches"></div><p class="err" id="dlgErr"></p><div class="row"><button type="button" class="ghost" id="dlgCancel">Cancel</button></div>`;
  form.onsubmit = (event) => event.preventDefault();
  $('dlgCancel').onclick = () => dlg.close();
  const search = $<HTMLInputElement>('returnPartSearch'); let timer: number | undefined;
  search.oninput = () => { clearTimeout(timer); timer = window.setTimeout(async () => {
    if (search.value.trim().length < 2) { $('returnPartMatches').innerHTML = ''; return; }
    try {
      const items = await api<SearchItem[]>(`/item-search?q=${encodeURIComponent(search.value.trim())}`);
      $('returnPartMatches').innerHTML = items.map((item) => `<button type="button" class="ghost tx-match" data-return-item="${item.id}">${esc([item.part_code,item.model,item.description,item.location ?? 'No location'].filter(Boolean).join(' · '))}</button>`).join('') || '<span class="hint">No matching parts.</span>';
      $('returnPartMatches').querySelectorAll<HTMLButtonElement>('[data-return-item]').forEach((button,index) => button.onclick = () => {
        const item = items[index]; dlg.close();
        openDialog(`Record returned part · ${item.part_code}`, [
          { name: 'quantity', label: 'Returned quantity', type: 'number', required: true },
          { name: 'returned_condition', label: 'Condition', type: 'select', required: true, value: 'Defective', options: [{value:'Defective',label:'Defective'}, {value:'Warranty claim',label:'Warranty claim'}, {value:'Reusable',label:'Reusable'}, {value:'Other',label:'Other'}] },
          { name: 'return_reason', label: 'Return reason / failure observed', required: true },
        ], 'Save return record', async (values) => {
          await post(`/repairs/${jobId}/returns`, { ...values, item_id: item.id }); toast('Returned part recorded for analysis.'); await loadRepairs(); window.setTimeout(() => void showRepair(jobId), 50);
        });
      });
    } catch (error) { $('dlgErr').textContent = (error as Error).message; }
  }, 220); };
  dlg.showModal(); search.focus();
}

async function loadRepairReport() {
  const q = encodeURIComponent($<HTMLInputElement>('repairReportSearch').value.trim());
  const from = encodeURIComponent($<HTMLInputElement>('repairDateFrom').value);
  const to = encodeURIComponent($<HTMLInputElement>('repairDateTo').value);
  const rows = await api<any[]>(`/repair-report?search=${q}&from=${from}&to=${to}`);
  $('repairReportBody').innerHTML = rows.map((r) => `<tr><td class="code">${esc(r.part_code)}</td><td>${esc(r.appliance_model)}</td><td>${esc(r.description)}</td><td>${esc(r.job_numbers || '—')}</td><td class="num">${num(r.repair_jobs)}</td><td class="num">${num(r.repeat_appliances)}</td><td class="num">${num(r.qty_issued)}</td><td class="num">${Number(r.usage_records) ? num(r.qty_used) : '<span class="hint">Not recorded</span>'}</td><td class="num">${num(r.qty_returned)}</td><td class="num">${num(r.defective_returns)}</td><td class="num">${r.avg_days_to_close === null ? '—' : Number(r.avg_days_to_close).toFixed(1)}</td><td>${esc(r.return_reasons || '—')}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">No linked repair parts yet. Create a repair job and link Stock Out or return records to it.</td></tr>';
}
let repairReportTimer: number | undefined;
$('repairReportSearch').addEventListener('input', () => { clearTimeout(repairReportTimer); repairReportTimer = window.setTimeout(() => void loadRepairReport(), 250); });
$('repairDateFrom').addEventListener('change', () => void loadRepairReport());
$('repairDateTo').addEventListener('change', () => void loadRepairReport());

async function loadSummary() {
  const s = await api<Summary>('/summary');
  const markup = `<span class="chip"><b>${num(s.lines)}</b> stock entries</span><span class="chip"><b>${num(s.units)}</b> units on hand</span>`;
  $('summary').innerHTML = markup;
  $('partsSummary').innerHTML = markup;
}

async function loadStock(page: number = stockPage): Promise<void> {
  stockPage = page;
  const q = encodeURIComponent($<HTMLInputElement>('search').value.trim());
  const loc = $<HTMLSelectElement>('locFilter').value;
  const status = $<HTMLSelectElement>('statusFilter').value;
  const d = await api<{ rows: StockRow[]; total: number }>(`/stock?search=${q}&locationId=${loc}&status=${status}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`);
  const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
  if (page > pages) return loadStock(pages); // e.g. the last line on the last page was removed
  stockRows = d.rows;
  renderPager($('stockPager'), page, d.total, (p) => void loadStock(p));
  if (!d.rows.length) {
    $('stockBody').innerHTML = `<tr><td colspan="6" class="empty">No lines found.${canEdit() ? ' Use Add item, or drop your inventory file on the Excel tab.' : ''}</td></tr>`;
    return;
  }
  $('stockBody').innerHTML = d.rows
    .map((r, i) => {
      const debt = r.quantity < 0;
      const low = !debt && r.min_stock > 0 && r.quantity <= r.min_stock;
      const btn = (act: string, label: string) => `<button class="small ghost" data-act="${act}" data-i="${i}">${label}</button>`;
      const actions = (canEdit() ? btn('IN', 'Stock In') + btn('OUT', 'Stock Out') : '') + btn('MORE', 'More');
      const qty = debt ? num(r.quantity) : `${num(r.quantity)}${low ? ` (min ${num(r.min_stock)})` : ''}`;
      return `<tr class="${debt ? 'debt' : low ? 'low' : ''}"><td class="code">${esc(r.part_code)}</td><td>${esc(r.model)}</td><td>${esc(r.description)}</td><td>${esc(r.location ?? 'No location')}</td><td class="num">${qty}</td><td class="actions">${actions}</td></tr>`;
    })
    .join('');
}

let searchTimer: number | undefined;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadStock(1), 250);
});
$('locFilter').addEventListener('change', () => void loadStock(1));
$('statusFilter').addEventListener('change', () => void loadStock(1));

$('stockBody').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const row = stockRows[Number(b.dataset.i)];
  if (!row) return;
  if (b.dataset.act === 'MORE') openMore(row);
  else rowAction(b.dataset.act as string, row);
});

let countPage=1;
let countRows:StockRow[]=[];
const countDraft=new Map<number,{row:StockRow;counted:number|null;note:string}>();
async function loadCountLines(page:number=countPage) {
  countPage=page;
  const search=encodeURIComponent($<HTMLInputElement>('countSearch').value.trim());
  const location=$<HTMLSelectElement>('countLocation').value||'0';
  const data=await api<{rows:StockRow[];total:number}>(`/stock?search=${search}&locationId=${location}&status=&limit=${RESTOCK_PAGE_SIZE}&offset=${(page-1)*RESTOCK_PAGE_SIZE}`);
  const pages=Math.max(1,Math.ceil(data.total/RESTOCK_PAGE_SIZE));
  if(page>pages) return loadCountLines(pages);
  countPage=page; countRows=data.rows;
  renderPager($('countPager'),page,data.total,(nextPage)=>void loadCountLines(nextPage),RESTOCK_PAGE_SIZE);
  $('countBody').innerHTML=data.rows.map((row) => {
    const draft=countDraft.get(row.id), counted=draft?.counted;
    const variance=counted===null||counted===undefined?'—':String(counted-row.quantity);
    return `<tr><td class="code">${esc(row.part_code)}</td><td>${esc(row.model)}</td><td>${esc(row.description)}</td><td>${esc(row.location||'No location')}</td><td class="num">${num(row.quantity)}</td><td><input type="number" min="0" step="1" inputmode="numeric" placeholder="Enter count" aria-label="Count ${esc(row.part_code)}" data-count-qty="${row.id}" value="${counted??''}"></td><td class="num" data-count-variance="${row.id}">${variance}</td><td><input type="text" placeholder="Required if different" aria-label="Reason for ${esc(row.part_code)} count" data-count-note="${row.id}" value="${esc(draft?.note||'')}"></td></tr>`;
  }).join('')||'<tr><td colspan="8" class="empty">No stock lines match. Try another search or location.</td></tr>';
}
function updateCountDraft(id:number,field:'counted'|'note',value:string) {
  const row=countRows.find((candidate)=>candidate.id===id);
  if(!row) return;
  const prior=countDraft.get(id)||{row,counted:null,note:''};
  const next={...prior,row,[field]:field==='counted'?(value===''?null:Number(value)):value};
  if(next.counted===null&&!next.note.trim()) countDraft.delete(id); else countDraft.set(id,next);
  const variance=document.querySelector<HTMLElement>(`[data-count-variance="${id}"]`);
  if(variance) variance.textContent=next.counted===null?'—':String(next.counted-row.quantity);
}
$('countBody').addEventListener('input',(event)=>{
  const el=event.target as HTMLInputElement;
  if(el.dataset.countQty) updateCountDraft(Number(el.dataset.countQty),'counted',el.value);
  if(el.dataset.countNote) updateCountDraft(Number(el.dataset.countNote),'note',el.value);
});
let countSearchTimer:number|undefined;
$('countSearch').addEventListener('input',()=>{clearTimeout(countSearchTimer);countSearchTimer=window.setTimeout(()=>void loadCountLines(1),250);});
$('countLocation').addEventListener('change',()=>void loadCountLines(1));
$('reviewCountBtn').addEventListener('click',()=>{
  const entries=[...countDraft.values()].filter((entry)=>entry.counted!==null);
  if(!entries.length){toast('Enter at least one counted quantity first.');return;}
  if(entries.length>200){toast('Review and post no more than 200 counted lines at a time.');return;}
  const missingReason=entries.find((entry)=>entry.counted!==entry.row.quantity&&!entry.note.trim());
  if(missingReason){toast(`Add a reason for the difference on ${missingReason.row.part_code}.`);return;}
  $('countReview').innerHTML=`<div class="panel-heading"><div><h2>Review counted quantities</h2><p class="hint">${num(entries.length)} lines ready. Differences will be recorded in Transactions.</p></div></div><div class="scroll short"><table><thead><tr><th>Part</th><th>Location</th><th class="num">System</th><th class="num">Counted</th><th class="num">Difference</th><th>Reason</th></tr></thead><tbody>${entries.map((e)=>`<tr><td>${esc([e.row.part_code,e.row.model].filter(Boolean).join(' · '))}</td><td>${esc(e.row.location||'No location')}</td><td class="num">${num(e.row.quantity)}</td><td class="num">${num(e.counted!)}</td><td class="num ${e.counted!<e.row.quantity?'neg':e.counted!>e.row.quantity?'pos':''}">${e.counted!-e.row.quantity>0?'+':''}${num(e.counted!-e.row.quantity)}</td><td>${esc(e.note||'No change')}</td></tr>`).join('')}</tbody></table></div><p class="row count-review-actions"><button type="button" class="ghost" data-count-back>Back to counts</button><button type="button" data-count-post>Confirm and post adjustments</button></p>`;
  $('countControls').hidden=true;$('countWorksheet').hidden=true;$('countReview').hidden=false;
  $('countReview').querySelector('[data-count-back]')!.addEventListener('click',()=>{ $('countReview').hidden=true;$('countControls').hidden=false;$('countWorksheet').hidden=false; });
  $('countReview').querySelector('[data-count-post]')!.addEventListener('click',async()=>{
    try {
      const result=await post('/counts/batch',{lines:entries.map((e)=>({item_id:e.row.id,expected_quantity:e.row.quantity,counted_quantity:e.counted,note:e.note}))}) as {adjusted:number;lines:{itemId:number;previousQuantity:number;countedQuantity:number;change:number}[]};
      entries.forEach((e)=>countDraft.delete(e.row.id));
      $('countReview').innerHTML=`<h2>Count saved</h2><p>${num(result.adjusted)} stock adjustment(s) posted. No-change counts were recorded without an adjustment.</p><div class="scroll short"><table><thead><tr><th>Inventory line</th><th class="num">Previous</th><th class="num">Counted</th><th class="num">Difference</th></tr></thead><tbody>${result.lines.map((line)=>{const entry=entries.find((e)=>e.row.id===line.itemId);return `<tr><td>${esc(entry?lineName(entry.row):'Stock line')}</td><td class="num">${num(line.previousQuantity)}</td><td class="num">${num(line.countedQuantity)}</td><td class="num">${line.change>0?'+':''}${num(line.change)}</td></tr>`;}).join('')}</tbody></table></div><p class="row count-review-actions"><button type="button" id="countDone">Done</button></p>`;
      $('countDone').addEventListener('click',()=>{ $('countReview').hidden=true;$('countControls').hidden=false;$('countWorksheet').hidden=false;void loadCountLines(); });
    } catch(error) { toast((error as Error).message); }
  });
});

/** The "More" menu: every other action for a line, kept out of the table so it stays clean. */
function openMore(r: StockRow) {
  const dlg = $<HTMLDialogElement>('dlg');
  const form = $<HTMLFormElement>('dlgForm');
  const items: [string, string, boolean][] = canEdit()
    ? [['RETURN', 'Return stock', false], ['COUNT', 'Physical count', false], ['TRANSFER', 'Move stock', false], ['EDIT', 'Edit details', false], ['HISTORY', 'View history', false]]
    : [['HISTORY', 'View history', false]];
  if (me.role === 'admin') items.push(['REMOVE', 'Remove line', true]);
  form.innerHTML =
    `<h3>${esc(lineName(r))}</h3><p class="info">${esc([r.description, r.location].filter(Boolean).join(' - '))}</p>` +
    `<div class="menu">${items.map(([a, l, danger]) => `<button type="button" class="${danger ? 'danger' : 'ghost'}" data-act="${a}">${l}</button>`).join('')}</div>` +
    `<div class="row"><button type="button" class="ghost" id="dlgCancel">Close</button></div>`;
  form.onsubmit = (e) => e.preventDefault();
  $('dlgCancel').onclick = () => dlg.close();
  form.querySelector('.menu')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    dlg.close();
    rowAction(b.dataset.act as string, r);
  });
  dlg.showModal();
}

/** Basket transaction: every selected inventory line retains its own location. */
async function openTransaction(kind: 'IN' | 'OUT', initial?: (StockRow | SearchItem | (SearchItem & {receive_quantity?:number})) | (StockRow | SearchItem | (SearchItem & {receive_quantity?:number}))[], repairJobId?: number, purchaseOrder?:{id:number;orderNo:string;supplier:string}) {
  const dlg = $<HTMLDialogElement>('dlg'), form = $<HTMLFormElement>('dlgForm');
  const initialItems=initial?(Array.isArray(initial)?initial:[initial]):[];
  const basket: { item: SearchItem; quantity: number }[] = initialItems.map((item:any)=>({item,quantity:Number(item.receive_quantity)||1}));
  let openJobs: RepairJob[] = [];
  if (kind === 'OUT') {
    try { openJobs = await api<RepairJob[]>('/repairs?status=OPEN'); } catch { /* Stock Out remains available if repair lookup fails. */ }
  }
  const fields = kind === 'IN'
    ? `${purchaseOrder?`<input type="hidden" name="purchase_order_id" value="${purchaseOrder.id}"><label>Purchase order<input value="${esc(purchaseOrder.orderNo)}" disabled></label>`:''}<label>Transaction type<select name="stock_type"><option>Purchase</option><option>Shipment</option><option>Knock Down</option><option>Total Knock Down</option></select></label>
       <label>Supplier<input name="supplier" value="${esc(purchaseOrder?.supplier||'')}"><small class="field-hint">Company or person the stock came from.</small></label><label>SS No<input name="ss_no"></label><label>Packing list<input name="packing_list"></label>`
    : `<label>Repair job (optional)<select name="service_job_id" id="txRepairJob"><option value="">No repair job</option>${openJobs.map((job) => `<option value="${job.id}" data-technician="${esc(job.technician)}"${job.id === repairJobId ? ' selected' : ''}>${esc(job.job_no)} · ${esc(job.appliance_model)}${job.serial_no ? ` · ${esc(job.serial_no)}` : ''}</option>`).join('')}</select><small class="field-hint">Link the issued parts to an open repair job.</small></label>
       <label>Technician name<input name="technician"><small class="field-hint">Selecting a repair job fills in its technician when available.</small></label><label>Batch no.<input name="batch_no"></label>
       <label>Requisition number<input name="requisition_no" placeholder="Generated on save if blank"><small class="field-hint">Leave blank to generate one automatically.</small></label><label>RT/JO/INV/PS<input name="document_ref"><small class="field-hint">Enter the related reference exactly as it appears on your document.</small></label><label>Packing list<input name="packing_list"></label>`;
  const action = kind === 'IN' ? 'Stock In' : 'Stock Out';
  form.innerHTML = `<header class="tx-heading ${kind === 'IN' ? 'tx-heading-in' : 'tx-heading-out'}"><div><span class="tx-kicker">INVENTORY TRANSACTION</span><h3>${action}</h3><p>${kind === 'IN' ? 'Add stock received from a supplier or shipment.' : 'Record parts issued to a technician, job, or location.'}</p></div><span class="tx-kind">${kind}</span></header>
    <section class="tx-section" id="txSelectSection"><div class="tx-section-title"><span>1</span><div><strong>Select parts</strong><small>Search, then add each part and quantity. You can include parts from different locations.</small></div></div>
      <label class="tx-search">Search the parts list<input id="txSearch" placeholder="Model, part code, description or location" autocomplete="off"></label>
      <div id="txMatches" class="tx-matches"></div><div id="txBasket" class="tx-basket"></div><div id="txBasketSummary" class="tx-basket-summary"></div>
    </section>
    <section class="tx-section" id="txDetailsSection"><div class="tx-section-title"><span>2</span><div><strong>Transaction details</strong><small>Reference fields accept letters, numbers and symbols.</small></div></div><div class="transaction-fields">${fields}</div>${kind === 'OUT' ? '<p class="hint">Leave requisition number blank to generate one automatically. Linking a repair job uses its job number as the requisition reference.</p>' : ''}</section>
    <label class="tx-note" id="txNoteLabel">Note (optional)<input name="note" placeholder="Add context for this transaction"></label><section id="txReview" class="tx-review" hidden></section><p class="err" id="dlgErr"></p>
    <div class="row tx-actions"><button type="button" class="ghost" id="dlgCancel">Cancel</button><button type="button" class="ghost" id="txEditReview" hidden>Edit transaction</button><button class="tx-submit">Review ${action}</button></div>`;
  const redraw = () => {
    $('txBasket').innerHTML = basket.length ? `<table><thead><tr><th>Part</th><th class="num">On hand</th><th>Quantity ${kind === 'OUT' ? 'to issue' : 'to receive'}</th><th></th></tr></thead><tbody>${basket.map((entry, i) => `<tr><td><strong>${esc([entry.item.part_code, entry.item.model].filter(Boolean).join(' · '))}</strong><small class="tx-part-desc">${esc(entry.item.description)}</small><span class="location-pill">${esc(entry.item.location ?? 'No location')}</span></td><td class="num">${num(entry.item.quantity)}</td><td><input aria-label="Quantity for ${esc(entry.item.part_code)}" type="number" min="1" step="1" data-qty="${i}" value="${entry.quantity}" required></td><td><button type="button" class="small ghost" data-remove="${i}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="tx-empty"><strong>No parts added yet</strong><span>Search above to add parts to this transaction.</span></div>';
    const totalQuantity = basket.reduce((total, entry) => total + (Number.isFinite(entry.quantity) ? entry.quantity : 0), 0);
    $('txBasketSummary').innerHTML = basket.length ? `<span>${num(basket.length)} ${basket.length === 1 ? 'part line' : 'part lines'} selected</span><strong>${num(totalQuantity)} total units</strong>` : '';
  };
  redraw();
  let timer: number | undefined;
  const search = $<HTMLInputElement>('txSearch');
  const repairSelect = form.querySelector<HTMLSelectElement>('#txRepairJob');
  if (repairSelect) {
    const syncTechnician = () => {
      const selected = repairSelect.selectedOptions[0];
      const tech = form.elements.namedItem('technician') as HTMLInputElement | null;
      if (tech && selected?.dataset.technician) tech.value = selected.dataset.technician;
    };
    repairSelect.addEventListener('change', syncTechnician);
    if (repairJobId) syncTechnician();
  }
  search.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) { $('txMatches').innerHTML = ''; return; }
      try {
        const rows = await api<SearchItem[]>(`/item-search?q=${encodeURIComponent(q)}`);
        $('txMatches').innerHTML = rows.map((x) => `<button type="button" class="ghost tx-match" data-item="${x.id}">${esc([x.part_code, x.model, x.description, x.location ?? 'No location'].filter(Boolean).join(' · '))} <small>(on hand ${num(x.quantity)})</small></button>`).join('') || '<span class="hint">No matching lines.</span>';
        $('txMatches').querySelectorAll<HTMLButtonElement>('[data-item]').forEach((button, i) => button.onclick = () => {
          const item = rows[i];
          if (basket.some((entry) => entry.item.id === item.id)) { $('dlgErr').textContent = 'That exact part and location is already in the list.'; return; }
          $('dlgErr').textContent = '';
          basket.push({ item, quantity: 1 }); redraw();
        });
      } catch (error) { $('dlgErr').textContent = (error as Error).message; }
    }, 220);
  };
  $('txBasket').onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (button) { basket.splice(Number(button.dataset.remove), 1); redraw(); }
  };
  $('txBasket').oninput = (event) => {
    const input = (event.target as HTMLInputElement).closest<HTMLInputElement>('[data-qty]');
    if (input) {
      basket[Number(input.dataset.qty)].quantity = Number(input.value);
      const total = basket.reduce((sum, entry) => sum + (Number.isFinite(entry.quantity) ? entry.quantity : 0), 0);
      $('txBasketSummary').innerHTML = `<span>${num(basket.length)} ${basket.length === 1 ? 'part line' : 'part lines'} selected</span><strong>${num(total)} total units</strong>`;
    }
  };
  $('dlgCancel').onclick = () => dlg.close();
  let reviewMode = false;
  $('txEditReview').onclick = () => {
    reviewMode = false;
    $('txReview').hidden = true;
    $('txSelectSection').hidden = false;
    $('txDetailsSection').hidden = false;
    $('txNoteLabel').hidden = false;
    $('txEditReview').hidden = true;
    form.querySelector<HTMLButtonElement>('.tx-submit')!.textContent = `Review ${action}`;
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!basket.length) { $('dlgErr').textContent = 'Add at least one item line.'; return; }
    if (!reviewMode) {
      const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]'))
        .filter((field) => field.name !== 'txSearch' && field.name !== 'purchase_order_id' && field.value.trim())
        .map((field) => {
          const label = field.closest('label');
          const title = Array.from(label?.childNodes ?? []).find((node) => node.nodeType === Node.TEXT_NODE)?.textContent?.trim() || field.name;
          const value = field instanceof HTMLSelectElement ? field.selectedOptions[0]?.textContent?.trim() : field.value.trim();
          return `<div><dt>${esc(title)}</dt><dd>${esc(value)}</dd></div>`;
        }).join('');
      const lineRows = basket.map(({item,quantity}) => `<tr><td>${esc([item.part_code,item.model].filter(Boolean).join(' · '))}<small>${esc(item.description)} · ${esc(item.location || 'No location')}</small></td><td class="num">${num(item.quantity)}</td><td class="num">${num(quantity)}</td></tr>`).join('');
      const lineTotal = basket.reduce((sum, entry) => sum + entry.quantity, 0);
      const requisitionElement = form.elements.namedItem('requisition_no') as HTMLInputElement | null;
      const linkedJobName = form.querySelector<HTMLSelectElement>('#txRepairJob')?.selectedOptions[0]?.textContent?.trim();
      const generatedRequisition = kind === 'OUT' && !requisitionElement?.value.trim() && `<div><dt>Requisition number</dt><dd>${linkedJobName && !linkedJobName.startsWith('No repair job') ? `Uses ${esc(linkedJobName)} as the reference` : 'Generated automatically after saving'}</dd></div>`;
      const systemFields = `<div><dt>${kind === 'IN' ? 'Stock In number' : 'Stock Out number'}</dt><dd>Generated automatically after saving</dd></div>${purchaseOrder?`<div><dt>Purchase order</dt><dd>${esc(purchaseOrder.orderNo)}</dd></div>`:''}`;
      $('txReview').innerHTML = `<div class="tx-review-title"><div><span class="tx-kicker">CHECK BEFORE SAVING</span><h3>Review ${action.toLowerCase()}</h3><p>${num(basket.length)} ${basket.length === 1 ? 'part line' : 'part lines'} · ${num(lineTotal)} total units</p></div><span class="tx-review-mark">✓</span></div><div class="tx-basket"><table><thead><tr><th>Part and location</th><th class="num">On hand</th><th class="num">${kind === 'IN' ? 'To receive' : 'To issue'}</th></tr></thead><tbody>${lineRows}</tbody></table></div><dl class="receipt-meta">${systemFields}${fields}${generatedRequisition || ''}</dl><p class="hint">Check the parts, quantities, and reference details. Select Edit transaction to make changes.</p>`;
      $('txReview').hidden = false;
      $('txSelectSection').hidden = true;
      $('txDetailsSection').hidden = true;
      $('txNoteLabel').hidden = true;
      $('txEditReview').hidden = false;
      form.querySelector<HTMLButtonElement>('.tx-submit')!.textContent = `Confirm & Save ${action}`;
      reviewMode = true;
      return;
    }
    const send = (allow: boolean) => {
      const data: Record<string, string> = {};
      new FormData(form).forEach((value, key) => { if (key !== 'txSearch') data[key] = String(value); });
      return post('/transactions', { ...data, kind, lines: basket.map(({ item, quantity }) => ({ item_id: item.id, quantity })), allow_debt: allow });
    };
    try {
      const result = await send(false) as { transactionId:number; transactionNo: string; requisitionNo: string; changes:{previousQuantity:number;newQuantity:number}[] };
      dlg.close(); toast(kind === 'IN' ? `Saved Stock In No. ${result.transactionNo}.` : `Saved Stock Out No. ${result.transactionNo} · Requisition ${result.requisitionNo}.`); await Promise.all([loadSummary(), loadStock(), loadParts()]);
      if(purchaseOrder) await loadRestockOrders();
      await showReceipt(`T:${result.transactionId}`);
    } catch (error) {
      const err = error as ApiError;
      if (err.debt && confirm(`${err.message}\n\nRecord the shortage as ${DEBT.toLowerCase()}?`)) {
        try { const result = await send(true) as { transactionId:number; transactionNo: string; requisitionNo: string; changes:{previousQuantity:number;newQuantity:number}[] }; dlg.close(); toast(kind === 'IN' ? `Saved Stock In No. ${result.transactionNo}.` : `Saved Stock Out No. ${result.transactionNo} · Requisition ${result.requisitionNo}.`); await Promise.all([loadSummary(), loadStock(), loadParts()]); if(purchaseOrder) await loadRestockOrders(); await showReceipt(`T:${result.transactionId}`); }
        catch (retryError) { $('dlgErr').textContent = (retryError as Error).message; }
      } else $('dlgErr').textContent = err.message;
    }
  };
  dlg.showModal(); search.focus();
}

function rowAction(act: string, r: StockRow) {
  const done = async (msg: string) => { toast(msg); await Promise.all([loadSummary(), loadStock(), loadParts()]); };
  const name = lineName(r);

  if (act === 'IN' || act === 'OUT') {
    openTransaction(act, r);
  } else if (act === 'RETURN') {
    const title = 'Return stock';
    const fields: Field[] = [
      { name: 'quantity', label: 'Quantity', type: 'number', required: true },
      { name: 'reference', label: 'Requisition or packing list' },
    ];
    fields.push({ name: 'note', label: 'Note (optional)' });
    const info = r.quantity < 0 ? ` (${DEBT.toLowerCase()} ${num(-r.quantity)})` : ` (on hand ${num(r.quantity)})`;
    openDialog(`${title}: ${name}${info}`, fields, title, async (v) => {
      const send = (allow: boolean) => post('/movements', { ...v, item_id: r.id, type: act, allow_debt: allow });
      let res: { balance: number };
      try {
        res = await send(false);
      } catch (e) {
        const err = e as ApiError;
        if (err.debt && confirm(`${err.message}\n\nRecord the shortage as ${DEBT.toLowerCase()}?`)) res = await send(true);
        else throw e;
      }
      await done(res.balance < 0 ? `Saved. ${DEBT} is now ${num(-res.balance)}.` : r.quantity < 0 ? `Saved. The ${DEBT.toLowerCase()} is cleared.` : 'Saved.');
    });
  } else if (act === 'COUNT') {
    openDialog(`Physical count: ${name}`, [
      { name: 'quantity', label: 'Quantity you counted', type: 'number', required: true },
      { name: 'note', label: 'Note (optional)' },
    ], 'Save count', async (v) => {
      await post('/counts', { ...v, item_id: r.id });
      await done('Count saved. The difference is in History.');
    });
  } else if (act === 'TRANSFER') {
    openDialog(`Move stock: ${name}`, [
      { name: 'to_location_id', label: `Move to (from ${r.location ?? 'no location'})`, type: 'select', options: locOptions(false, r.location_id) },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true },
      { name: 'note', label: 'Note (optional)' },
    ], 'Move stock', async (v) => {
      await post('/transfers', { ...v, item_id: r.id });
      await done('Stock moved.');
    });
  } else if (act === 'EDIT') {
    openDialog(`Edit line: ${name}`, [
      { name: 'part_code', label: 'Part code', value: r.part_code, required: true },
      { name: 'model', label: 'Model', value: r.model },
      { name: 'description', label: 'Description', value: r.description },
      { name: 'location_id', label: 'Location', type: 'select', options: locOptions(true), value: r.location_id ?? '' },
      { name: 'min_stock', label: 'Minimum stock (highlights the line when reached)', type: 'number', value: r.min_stock },
      { name: 'lead_time_days', label: 'Supplier lead time (days, optional)', type: 'number', value: r.lead_time_days ?? '' },
      { name: 'safety_stock', label: 'Safety stock (optional)', type: 'number', value: r.safety_stock ?? '' },
      { name: 'target_coverage_days', label: 'Target coverage after ordering (days, optional)', type: 'number', value: r.target_coverage_days ?? '' },
    ], 'Save changes', async (v) => {
      await post(`/items/${r.id}`, v, 'PUT');
      await done('Line updated. The change is in History.');
    });
  } else if (act === 'REMOVE') {
    if (!confirm(`Remove ${name} (${r.location ?? 'no location'}) from the inventory?\n\nIts quantity must be exactly zero. Its history is kept.`)) return;
    api<{ archived?: boolean }>(`/items/${r.id}`, { method: 'DELETE' })
      .then((d) => done(d.archived ? 'Removed. Its history is kept.' : 'Removed.'))
      .catch((e) => alert((e as Error).message));
  } else if (act === 'HISTORY') {
    $<HTMLInputElement>('moveSearch').value = r.part_code;
    movePage = 1;
    switchTab('movements');
  }
}

$('addItemBtn').addEventListener('click', () =>
  openDialog('Add item', [
    { name: 'part_code', label: 'Part code', required: true },
    { name: 'model', label: 'Model' },
    { name: 'description', label: 'Description' },
    { name: 'location_id', label: 'Location', type: 'select', options: locOptions(true), value: '' },
    { name: 'quantity', label: `Opening quantity (a negative number is a ${DEBT.toLowerCase()})`, type: 'number', signed: true, value: 0 },
    { name: 'min_stock', label: 'Minimum stock (optional)', type: 'number', value: 0 },
    { name: 'lead_time_days', label: 'Supplier lead time (days, optional)', type: 'number' },
    { name: 'safety_stock', label: 'Safety stock (optional)', type: 'number' },
    { name: 'target_coverage_days', label: 'Target coverage after ordering (days, optional)', type: 'number' },
  ], 'Add item', async (v) => {
    await post('/items', v);
    toast('Item added.');
    await Promise.all([loadSummary(), loadStock(), loadParts()]);
  })
);

$('addLocBtn').addEventListener('click', () =>
  openDialog('Add location', [{ name: 'name', label: 'Location name', required: true }], 'Add location', async (v) => {
    await post('/locations', v);
    await loadLocations();
    toast('Location added.');
  })
);

/* ---------- history tab ---------- */

async function loadMovements(page: number = movePage): Promise<void> {
  movePage = page;
  const q = encodeURIComponent($<HTMLInputElement>('moveSearch').value.trim());
  const from = encodeURIComponent($<HTMLInputElement>('moveDateFrom').value);
  const to = encodeURIComponent($<HTMLInputElement>('moveDateTo').value);
  const d = await api<{ rows: MoveRow[]; total: number }>(`/transactions?search=${q}&from=${from}&to=${to}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`);
  const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
  if (page > pages) return loadMovements(pages);
  renderPager($('movePager'), page, d.total, (p) => void loadMovements(p));
  $('moveBody').innerHTML = d.rows.length
    ? d.rows.map((m) => `<tr><td>${esc(m.created_at)}</td><td><button type="button" class="link transaction-link" data-key="${esc(m.key)}">${esc(m.transaction_no)}</button></td><td>${esc(TYPE_LABEL[m.type] ?? m.type)}</td><td class="num">${num(m.line_count)}</td><td class="num">${num(m.units)}</td><td>${esc([m.repair_job_no && `Repair ${m.repair_job_no}`,m.reference,m.technician].filter(Boolean).join(' · '))}</td><td>${esc(m.user)}</td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">No transactions found.</td></tr>`;
}
$('moveBody').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-key]');
  if (button) void showReceipt(button.dataset.key!);
});

async function showReceipt(key: string) {
  try {
    const receipt = await api<{ transaction: any; lines: any[] }>(`/transactions/${encodeURIComponent(key)}`);
    const t = receipt.transaction;
    const fields = ([
      ['Transaction type', t.stock_type], ['Supplier', t.supplier], ['SS No', t.ss_no],
      ['Packing list', t.packing_list], ['Batch no.', t.batch_no], ['Requisition number', t.requisition_no],
      ['RT/JO/INV/PS', t.document_ref], ['Repair job', t.repair_job_no], ['Purchase order',t.purchase_order_no], ['Technician', t.technician], ['Entered by', t.created_by_name], ['Note', t.note],
    ] as [string, unknown][]).filter(([, value]) => Boolean(value));
    const dlg = $<HTMLDialogElement>('dlg'), form = $<HTMLFormElement>('dlgForm');
    form.innerHTML = `<div id="receiptContent" class="receipt"><h2>IMARFLEX SPARE PARTS INVENTORY</h2><h3>${esc(t.kind === 'IN' ? 'STOCK IN RECEIPT' : t.kind === 'OUT' ? 'STOCK OUT RECEIPT' : 'TRANSACTION RECEIPT')}</h3>
      <dl class="receipt-meta"><div><dt>${esc(t.kind === 'IN' ? 'Stock In No.' : t.kind === 'OUT' ? 'Stock Out No.' : 'Record No.')}</dt><dd>${esc(t.transaction_no)}</dd></div><div><dt>Date</dt><dd>${esc(t.created_at)}</dd></div>${fields.map(([label,value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
      <table><thead><tr><th>Part code</th><th>Model</th><th>Description</th><th>Location</th><th class="num">Previous</th><th class="num">Change</th><th class="num">New total</th></tr></thead><tbody>${receipt.lines.map((line) => `<tr><td>${esc(line.part_code)}</td><td>${esc(line.model)}</td><td>${esc(line.description)}</td><td>${esc(line.location ?? 'No location')}</td><td class="num">${num(line.previous_quantity)}</td><td class="num ${line.qty_change < 0 ? 'neg' : 'pos'}">${line.qty_change > 0 ? '+' : ''}${num(line.qty_change)}</td><td class="num"><strong>${num(line.new_quantity)}</strong></td></tr>`).join('')}</tbody></table>
      <p class="receipt-sign">Prepared by: ${esc(t.created_by_name ?? '')} <span>Received / issued by: __________________</span></p></div>
      <p class="err" id="dlgErr"></p><div class="row"><button type="button" class="ghost" id="receiptPrint">Print receipt</button><button type="button" class="ghost" id="dlgCancel">Close</button></div>`;
    form.onsubmit = (e) => e.preventDefault();
    $('dlgCancel').onclick = () => dlg.close();
    $('receiptPrint').onclick = () => { document.body.classList.add('printing-receipt'); window.addEventListener('afterprint', () => document.body.classList.remove('printing-receipt'), { once: true }); window.print(); window.setTimeout(() => document.body.classList.remove('printing-receipt'), 1500); };
    dlg.showModal();
  } catch (error) { toast((error as Error).message); }
}
let moveTimer: number | undefined;
$('moveSearch').addEventListener('input', () => {
  clearTimeout(moveTimer);
  moveTimer = window.setTimeout(() => void loadMovements(1), 250);
});
$('moveDateFrom').addEventListener('change', () => void loadMovements(1));
$('moveDateTo').addEventListener('change', () => void loadMovements(1));

/* ---------- Excel tab: drag and drop import ---------- */

function showImportResult(r: ImportResult) {
  const out = $('impResult');
  const apply = $<HTMLButtonElement>('impApply');
  if (r.errors.length) {
    out.innerHTML = `<p class="err">Nothing was saved. Fix these ${num(r.errors.length)} problem(s) in the file and drop it again:</p><ul>${r.errors.slice(0, 200).map((x) => `<li>Row ${x.row}: ${esc(x.message)}</li>`).join('')}</ul>${r.errors.length > 200 ? '<p class="hint">Showing the first 200 problems.</p>' : ''}`;
    apply.hidden = true;
    return;
  }
  const stat = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const stats =
    `<dl class="stats">` +
    stat('Rows in the file', num(r.total)) +
    stat('New lines', num(r.created)) +
    stat('Lines already in the system', num(r.matched)) +
    stat('Quantities that change', num(r.stockChanges)) +
    stat(`${DEBT} rows in the file`, `${num(r.debtLines)} (${num(r.debtUnits)} units)`) +
    (r.newLocations.length ? stat('New locations', num(r.newLocations.length)) : '') +
    (r.notInFile ? stat('System lines not in the file (left unchanged)', num(r.notInFile)) : '') +
    `</dl>`;
  const notes = r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  const locs = r.newLocations.length ? `<details><summary>Show the ${num(r.newLocations.length)} new locations (check the spelling)</summary><p>${esc(r.newLocations.join(', '))}</p></details>` : '';
  out.innerHTML = `<p class="ok-text">${r.dryRun ? 'The file is ready. Nothing has been saved yet.' : 'Import saved.'}</p>${stats}${notes}${locs}`;
  apply.hidden = !r.dryRun;
}

async function checkImport(dryRun: boolean) {
  const out = $('impResult');
  const apply = $<HTMLButtonElement>('impApply');
  if (!importFile) return;
  const fd = new FormData();
  fd.append('file', importFile);
  apply.disabled = true;
  out.innerHTML = `<p class="hint">${dryRun ? 'Checking the file' : 'Saving the import'}. A large file can take a little while.</p>`;
  try {
    const r = await api<ImportResult>(`/import?dryRun=${dryRun ? 1 : 0}`, { method: 'POST', body: fd });
    showImportResult(r);
    if (r.applied) {
      importFile = null;
      $('fileName').textContent = '';
      await loadLocations();
      await Promise.all([loadSummary(), loadStock(1), loadParts()]);
    }
  } catch (err) {
    out.innerHTML = `<p class="err">${esc((err as Error).message)}</p>`;
    apply.hidden = true;
  } finally {
    apply.disabled = false;
  }
}

function chooseFile(f: File | null) {
  $('impApply').hidden = true;
  $('impResult').innerHTML = '';
  if (f && !/\.xlsx$/i.test(f.name)) {
    importFile = null;
    $('fileName').textContent = '';
    $('impResult').innerHTML = `<p class="err">Please use an Excel .xlsx file.</p>`;
    return;
  }
  importFile = f;
  $('fileName').textContent = f ? f.name : '';
  if (f) void checkImport(true);
}

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => chooseFile((e as DragEvent).dataTransfer?.files[0] ?? null));
$('impFile').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  chooseFile(input.files?.[0] ?? null);
  input.value = ''; // so choosing the same file again re-runs the check
});
$('impApply').addEventListener('click', () => void checkImport(false));
// A file dropped outside the box should not make the browser open it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ---------- users tab ---------- */

async function loadUsers() {
  const users = await api<User[]>('/users');
  $('userBody').innerHTML = users
    .map((u) => `<tr><td class="code">${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td><td>${u.active ? 'Active' : 'Deactivated'}</td><td class="actions"><button class="small ghost" data-act="PW" data-id="${u.id}" data-name="${esc(u.username)}">Reset password</button>${u.id === me.id ? '' : `<button class="small ghost" data-act="ACTIVE" data-id="${u.id}" data-on="${u.active ? 1 : 0}">${u.active ? 'Deactivate' : 'Activate'}</button>`}</td></tr>`)
    .join('');
}

$('userBody').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'PW') {
    openDialog(`New password for ${b.dataset.name}`, [{ name: 'password', label: 'New password (at least 8 characters)', type: 'password', required: true }], 'Save password', async (v) => {
      await post(`/users/${id}/password`, v, 'PUT');
      toast('Password changed.');
    });
  } else if (b.dataset.act === 'ACTIVE') {
    await post(`/users/${id}/active`, { active: b.dataset.on !== '1' }, 'PUT');
    await loadUsers();
  }
});

$('addUserBtn').addEventListener('click', () =>
  openDialog('Add user', [
    { name: 'username', label: 'Username', required: true },
    { name: 'full_name', label: 'Full name' },
    { name: 'password', label: 'Password (at least 8 characters)', type: 'password', required: true },
    { name: 'role', label: 'Role', type: 'select', options: [{ value: 'staff', label: 'Staff: can change stock' }, { value: 'viewer', label: 'Viewer: can only look' }, { value: 'admin', label: 'Admin: everything' }], value: 'staff' },
  ], 'Add user', async (v) => {
    await post('/users', v);
    await loadUsers();
    toast('User added.');
  })
);

/* ---------- start ---------- */

api<User>('/me').then(showApp).catch(showLogin);

export {};
