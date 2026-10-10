import * as db from './db.js';
import { parseReceipt, checkTotals, canonicalStore, storeKey, KNOWN_STORES, round2 } from './parse.js';
import { redactText, classifyLine } from './pii.js';
import { newReceipt, newItem, summarize, itemBreakdown, matchReturn, applyReturn, unapplyReturn, toCSV, STATUS, uid } from './model.js';
import { loadPhotos, inspectMetadata, redactedCopy, toCleanJpeg, blobToBase64 } from './image.js';
import { fromBuildJson, newOnly } from './bob.js';

// ---- tiny DOM helper --------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed under the CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const $ = (sel) => document.querySelector(sel);
const money = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const fmtDate = (d) => {
  if (!d) return 'No date';
  const [y, m, day] = d.split('-').map(Number);
  if (!day) return d;
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const STATUS_LABEL = { consumed: 'Consumed', return: 'To return', returned: 'Returned' };

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

// ---- state ------------------------------------------------------------------

const defaultSettings = () => ({ keepImage: true, withTax: false, apiKey: '', claude: false });

const state = {
  receipts: [],
  settings: defaultSettings(),
  draft: null, // in-progress capture (memory only)
};

async function load() {
  state.receipts = (await db.getAll()) || [];
  for (const k of Object.keys(state.settings)) {
    const v = await db.getSetting(k);
    if (v !== undefined) state.settings[k] = v;
  }
}
const purchases = () => state.receipts.filter((r) => r.kind === 'purchase');
const byId = (id) => state.receipts.find((r) => r.id === id);
async function save(...rs) {
  await db.putMany(rs);
  for (const r of rs) {
    const i = state.receipts.findIndex((x) => x.id === r.id);
    if (i >= 0) state.receipts[i] = r;
    else state.receipts.push(r);
  }
}
async function setSetting(k, v) {
  state.settings[k] = v;
  await db.setSetting(k, v);
}

// ---- routing ----------------------------------------------------------------

const routes = [
  [/^#?\/?$/, viewSummary],
  [/^#\/receipts(?:\?shop=([\w-]+))?$/, viewReceipts],
  [/^#\/r\/([\w-]+)$/, viewReceipt],
  [/^#\/add\/(purchase|return)(?:\?shop=([\w-]+))?$/, viewAdd],
  [/^#\/todo$/, viewTodo],
  [/^#\/settings$/, viewSettings],
];

// Re-rendering removes the focused input, whose blur can fire another
// change event mid-render; coalesce renders into one per task.
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderNow(); });
}

function renderNow() {
  const hash = location.hash || '#/';
  const main = $('#main');
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      main.replaceChildren(view(...m.slice(1)));
      for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', hash.startsWith(a.getAttribute('href')) && (a.getAttribute('href') !== '#/' || hash === '#/'));
      const pending = purchases().reduce((n, r) => n + r.items.filter((i) => i.status === STATUS.return).length, 0);
      const badge = $('#todo-badge');
      badge.textContent = pending || '';
      badge.hidden = !pending;
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/add')) state.draft = null;
  render();
  window.scrollTo(0, 0);
});

// ---- summary ----------------------------------------------------------------

function bar(s) {
  const total = s.spent || 1;
  const seg = (cls, v, label) => (v > 0 ? h('span', { class: `seg ${cls}`, style: `width:${(v / total) * 100}%`, title: `${label} ${money(v)}` }) : null);
  return h('div', { class: 'bar', role: 'img', 'aria-label': `Consumed ${money(s.consumed)}, to return ${money(s.pending)}, returned ${money(s.returned)}` },
    seg('consumed', s.consumed, 'Consumed'), seg('pending', s.pending, 'To return'), seg('returned', s.returned, 'Returned'));
}

function viewSummary() {
  const { shops, totals } = summarize(state.receipts, { withTax: state.settings.withTax });
  const wrap = h('section', { class: 'view' });
  wrap.append(h('div', { class: 'view-head' },
    h('h1', {}, 'Returns for BOB'),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: state.settings.withTax, onchange: async (e) => { await setSetting('withTax', e.target.checked); render(); } }),
      h('span', {}, 'Include tax'))));

  if (!state.receipts.length) {
    wrap.append(h('div', { class: 'empty card' },
      h('p', {}, 'No receipts yet. Snap a purchase receipt to start, or pull in the receipts already logged in the BOB repo.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: '#/add/purchase' }, 'Add a receipt'),
        h('button', { class: 'btn', onclick: importBob }, 'Import BOB receipts'))));
    return wrap;
  }

  wrap.append(h('div', { class: 'kpis' },
    kpi('Spent', totals.spent, ''),
    kpi('Consumed', totals.consumed, 'consumed'),
    kpi('To return', totals.pending, 'pending', `${totals.pendingCount || 0} item${totals.pendingCount === 1 ? '' : 's'}`),
    kpi('Refunded', totals.refunded, 'returned', `${totals.verified || 0} verified · ${totals.unverified || 0} not`),
    kpi('Net cost', totals.net, 'net')));
  wrap.append(h('p', { class: 'legend' },
    h('span', { class: 'dot consumed' }), 'Consumed ', h('span', { class: 'dot pending' }), 'To return ', h('span', { class: 'dot returned' }), 'Returned',
    h('span', { class: 'muted' }, state.settings.withTax ? ' · with each receipt’s tax' : ' · pre-tax item prices')));

  const list = h('div', { class: 'shops' });
  for (const s of shops) {
    list.append(h('a', { class: 'card shop', href: `#/receipts?shop=${s.key}` },
      h('div', { class: 'shop-head' },
        h('h2', {}, s.name),
        h('span', { class: 'muted' }, `${s.receipts} receipt${s.receipts === 1 ? '' : 's'}${s.returns ? ` · ${s.returns} return${s.returns === 1 ? '' : 's'}` : ''}`)),
      bar(s),
      h('dl', { class: 'figs' },
        fig('Spent', s.spent), fig('Consumed', s.consumed, 'consumed'), fig('To return', s.pending, 'pending'), fig('Returned', s.returned, 'returned'), fig('Refunded', s.refunded), fig('Net', s.net, 'net')),
      h('div', { class: 'badges' },
        s.pendingCount ? h('span', { class: 'badge pending' }, `${s.pendingCount} to take back`) : null,
        s.verified ? h('span', { class: 'badge ok' }, `✓ ${s.verified} verified`) : null,
        s.unverified ? h('span', { class: 'badge warn' }, `${s.unverified} not verified`) : null)));
  }
  wrap.append(list);
  return wrap;
}
const kpi = (label, v, cls, sub) => h('div', { class: `kpi ${cls}` }, h('span', { class: 'kpi-label' }, label), h('strong', {}, money(v)), sub ? h('span', { class: 'kpi-sub' }, sub) : null);
const fig = (label, v, cls = '') => h('div', { class: cls }, h('dt', {}, label), h('dd', {}, money(v)));

// ---- receipts list ----------------------------------------------------------

function viewReceipts(shop) {
  const wrap = h('section', { class: 'view' });
  const all = [...state.receipts].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt));
  const shopNames = new Map(all.map((r) => [storeKey(r.store), canonicalStore(r.store) || 'Unknown shop']));
  const shown = shop ? all.filter((r) => storeKey(r.store) === shop) : all;
  wrap.append(h('div', { class: 'view-head' }, h('h1', {}, shop ? shopNames.get(shop) || 'Receipts' : 'Receipts'),
    h('a', { class: 'btn small', href: shop ? `#/add/purchase?shop=${shop}` : '#/add/purchase' }, '+ Add')));
  wrap.append(h('div', { class: 'chips' },
    h('a', { class: `chip ${shop ? '' : 'on'}`, href: '#/receipts' }, 'All'),
    [...shopNames].map(([k, n]) => h('a', { class: `chip ${k === shop ? 'on' : ''}`, href: `#/receipts?shop=${k}` }, n))));
  if (!shown.length) wrap.append(h('p', { class: 'empty' }, 'No receipts here yet.'));
  const list = h('div', { class: 'list' });
  for (const r of shown) {
    const counts = { consumed: 0, return: 0, returned: 0 };
    for (const it of r.items) counts[it.status]++;
    const amount = r.kind === 'return' ? r.lines.reduce((s, l) => s + Math.abs(Number(l.amount) || 0), 0) : r.items.reduce((s, i) => s + i.total, 0);
    const matched = r.kind === 'return' ? r.lines.filter((l) => l.match).length : 0;
    list.append(h('a', { class: 'card row-link', href: `#/r/${r.id}` },
      h('div', {},
        h('div', { class: 'title' }, canonicalStore(r.store) || 'Unknown shop', ' ', r.kind === 'return' ? h('span', { class: 'badge returned' }, 'Return receipt') : null, r.source === 'bob' ? h('span', { class: 'badge' }, 'BOB') : null),
        h('div', { class: 'muted' }, fmtDate(r.date), ' · ', r.kind === 'return'
          ? `${r.lines.length} line${r.lines.length === 1 ? '' : 's'}, ${matched} matched`
          : `${r.items.length} item${r.items.length === 1 ? '' : 's'}`)),
      h('div', { class: 'right' },
        h('strong', {}, (r.kind === 'return' ? '−' : '') + money(amount)),
        r.kind === 'purchase' ? h('div', { class: 'mini' },
          counts.return ? h('span', { class: 'dot pending', title: 'To return' }, counts.return) : null,
          counts.returned ? h('span', { class: 'dot returned', title: 'Returned' }, counts.returned) : null) : null)));
  }
  wrap.append(list);
  return wrap;
}

// ---- to-return checklist ----------------------------------------------------

function viewTodo() {
  const wrap = h('section', { class: 'view' });
  wrap.append(h('div', { class: 'view-head' }, h('h1', {}, 'To take back')));
  const groups = new Map();
  for (const r of purchases()) for (const it of r.items) {
    if (it.status !== STATUS.return) continue;
    const k = storeKey(r.store);
    if (!groups.has(k)) groups.set(k, { name: canonicalStore(r.store) || 'Unknown shop', rows: [] });
    groups.get(k).rows.push({ r, it });
  }
  if (!groups.size) {
    wrap.append(h('p', { class: 'empty card' }, 'Nothing marked to return. Open a receipt and set leftover items to “To return”.'));
    return wrap;
  }
  for (const [k, g] of groups) {
    const total = g.rows.reduce((s, x) => s + itemBreakdown(x.it).pending, 0);
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'shop-head' }, h('h2', {}, g.name), h('strong', { class: 'pending-text' }, money(total))),
      h('ul', { class: 'todo' }, g.rows.map(({ r, it }) => h('li', {},
        h('div', {}, h('div', { class: 'title' }, it.desc || 'Item'), h('div', { class: 'muted' }, `${Math.min(it.returnQty, it.qty)} of ${it.qty} · bought ${fmtDate(r.date)}`, it.sku ? ` · #${it.sku}` : '')),
        h('div', { class: 'right' },
          h('strong', {}, money(itemBreakdown(it).pending)),
          h('a', { class: 'link', href: `#/r/${r.id}` }, 'receipt'))))),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: `#/add/return?shop=${k}` }, 'Verify with return receipt'),
        h('button', { class: 'btn', onclick: async () => {
          if (!confirm(`Mark all ${g.rows.length} item(s) at ${g.name} as returned without a return receipt?`)) return;
          const touched = new Set();
          for (const { r, it } of g.rows) { it.status = STATUS.returned; touched.add(r); }
          await save(...touched);
          render();
        } }, 'Mark returned (no receipt)'))));
  }
  return wrap;
}

// ---- item editor (shared by new and saved purchase receipts) -----------------

function statusControl(it, onChange) {
  return h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': 'Status' },
    Object.values(STATUS).map((s) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(it.status === s), class: `s-${s} ${it.status === s ? 'on' : ''}`,
      onclick: () => {
        if (it.status === s) return;
        if (it.verifiedQty > 0 && s !== STATUS.returned && !confirm('This item was verified by a return receipt. Change it anyway?')) return;
        it.status = s;
        if (s !== STATUS.consumed && !(it.returnQty > 0)) it.returnQty = it.qty;
        onChange();
      },
    }, STATUS_LABEL[s])));
}

function numInput(value, onInput, attrs = {}) {
  return h('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: value ?? '', ...attrs, onchange: (e) => { if (e.target.isConnected) onInput(e.target.value === '' ? null : Number(e.target.value)); } });
}

function itemsEditor(rec, { onChange, isReturn }) {
  const list = h('div', { class: 'items' });
  const rows = isReturn ? rec.lines : rec.items;
  rows.forEach((it, idx) => {
    const del = () => { rows.splice(idx, 1); onChange(true); };
    const card = h('div', { class: `item ${isReturn ? '' : `st-${it.status}`}` },
      h('div', { class: 'item-main' },
        h('input', { class: 'desc', value: it.desc, placeholder: 'Description', 'aria-label': 'Description', oninput: (e) => { it.desc = e.target.value; onChange(false); } }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove line', title: 'Remove line', onclick: del }, '×')),
      h('div', { class: 'item-nums' },
        h('label', {}, 'Qty', numInput(it.qty, (v) => { it.qty = v || 1; if (!isReturn) { it.total = round2(it.qty * it.unitPrice - (it.discount || 0)); it.returnQty = Math.min(it.returnQty, it.qty); } onChange(true); }, { step: '1', min: '1' })),
        isReturn
          ? h('label', {}, 'Refund', numInput(it.amount, (v) => { it.amount = v ?? 0; onChange(false); }))
          : [
            h('label', {}, 'Each', numInput(it.unitPrice, (v) => { it.unitPrice = v ?? 0; it.total = round2(it.qty * it.unitPrice - (it.discount || 0)); onChange(true); })),
            h('label', {}, 'Line total', numInput(it.total, (v) => { it.total = v ?? 0; onChange(false); })),
          ],
        h('label', { class: 'sku' }, 'SKU', h('input', { value: it.sku || '', inputmode: 'numeric', oninput: (e) => { it.sku = e.target.value.trim(); onChange(false); } }))),
      isReturn ? null : h('div', { class: 'item-status' },
        statusControl(it, () => onChange(true)),
        it.status !== STATUS.consumed && it.qty > 1
          ? h('label', { class: 'rq' }, it.status === STATUS.return ? 'Return' : 'Returned',
            numInput(it.returnQty, (v) => { it.returnQty = Math.max(0, Math.min(it.qty, v ?? 0)); onChange(true); }, { step: '1', min: '0', max: String(it.qty) }), `of ${it.qty}`)
          : null,
        it.status === STATUS.returned
          ? (it.verifiedQty > 0
            ? h('span', { class: 'badge ok' }, `✓ verified${it.verifiedQty < Math.min(it.returnQty, it.qty) ? ` ${it.verifiedQty} of ${Math.min(it.returnQty, it.qty)}` : ''}${it.refund != null ? ` · refund ${money(it.refund)}` : ''}`)
            : h('span', { class: 'badge warn' }, 'not verified'))
          : null));
    list.append(card);
  });
  list.append(h('button', { type: 'button', class: 'btn small ghost', onclick: () => {
    if (isReturn) rows.push({ desc: '', sku: '', qty: 1, amount: 0, match: null });
    else rows.push(newItem({}));
    onChange(true);
  } }, '+ Add line'));
  return list;
}

function headerFields(rec, onChange) {
  const dl = h('datalist', { id: 'stores' }, KNOWN_STORES.map(([n]) => h('option', { value: n })));
  return h('div', { class: 'fields' }, dl,
    h('label', { class: 'grow' }, 'Shop', h('input', { value: rec.store, list: 'stores', placeholder: 'e.g. Home Depot', oninput: (e) => { rec.store = e.target.value; onChange(false); }, onchange: (e) => { rec.store = canonicalStore(e.target.value); e.target.value = rec.store; onChange(true); } })),
    h('label', {}, 'Date', h('input', { type: 'date', value: rec.date, onchange: (e) => { rec.date = e.target.value; onChange(false); } })),
    h('label', {}, 'Subtotal', numInput(rec.subtotal, (v) => { rec.subtotal = v; onChange(false); })),
    h('label', {}, 'Tax', numInput(rec.tax, (v) => { rec.tax = v; onChange(false); })),
    h('label', {}, 'Total', numInput(rec.total, (v) => { rec.total = v; onChange(false); })));
}

function warningsBox(rec) {
  const box = h('div', { class: 'warnings', 'aria-live': 'polite' });
  const update = () => {
    const w = rec.kind === 'purchase' ? checkTotals(rec) : [];
    box.replaceChildren(...w.map((t) => h('p', {}, '⚠ ', t)));
  };
  update();
  box.update = update;
  return box;
}

function breakdownLine(rec) {
  const t = { consumed: 0, pending: 0, returned: 0 };
  for (const it of rec.items) { const b = itemBreakdown(it); t.consumed += b.consumed; t.pending += b.pending; t.returned += b.returned; }
  return h('p', { class: 'breakdown' },
    h('span', { class: 'dot consumed' }), `Consumed ${money(t.consumed)}  `,
    h('span', { class: 'dot pending' }), `To return ${money(t.pending)}  `,
    h('span', { class: 'dot returned' }), `Returned ${money(t.returned)}`);
}

// ---- return matching UI -----------------------------------------------------

function matchEditor(rec, matches, onChange) {
  const pool = purchases().filter((r) => !rec.store || storeKey(r.store) === storeKey(rec.store));
  const options = [];
  for (const r of pool) for (const it of r.items) options.push({ r, it, label: `${it.desc} — ${money(it.qty ? it.total / it.qty : 0)} ea · ${fmtDate(r.date)}` });
  const wrap = h('div', { class: 'matches' });
  if (!pool.length) {
    wrap.append(h('p', { class: 'warnings' }, `⚠ No purchase receipts${rec.store ? ` from ${canonicalStore(rec.store)}` : ''} to verify against yet. Add the original purchase receipt first, or check the shop name.`));
    return wrap;
  }
  matches.forEach((m, i) => {
    const line = rec.lines[i];
    if (!line) return;
    const sel = h('select', { 'aria-label': `Purchase item for ${line.desc}`, onchange: (e) => {
      const [rid, iid] = e.target.value.split('|');
      const o = options.find((x) => x.r.id === rid && x.it.id === iid);
      Object.assign(m, rid ? { receiptId: rid, itemId: iid, expected: round2((o.it.total / o.it.qty) * (Number(line.qty) || 1)) } : { receiptId: null, itemId: null, expected: null });
      m.delta = m.expected == null ? null : round2(Math.abs(Number(line.amount) || 0) - m.expected);
      onChange();
    } },
    h('option', { value: '' }, '— not matched —'),
    options.map((o) => h('option', { value: `${o.r.id}|${o.it.id}`, selected: m.itemId === o.it.id }, o.label)));
    let verdict;
    if (!m.itemId) verdict = h('span', { class: 'badge warn' }, 'No matching purchase');
    else if (Math.abs(m.delta) <= 0.02) verdict = h('span', { class: 'badge ok' }, `✓ refund matches ${money(m.expected)}`);
    else if (m.delta < 0) verdict = h('span', { class: 'badge warn' }, `Refund ${money(Math.abs(m.delta))} less than paid (${money(m.expected)})`);
    else verdict = h('span', { class: 'badge' }, `Refund includes ${money(m.delta)} more than item price (tax?)`);
    wrap.append(h('div', { class: 'match' },
      h('div', { class: 'title' }, `${line.qty || 1} × ${line.desc || 'Line'} `, h('strong', {}, `−${money(Math.abs(Number(line.amount) || 0))}`)),
      sel, verdict));
  });
  return wrap;
}

// ---- add / capture flow -----------------------------------------------------

function viewAdd(kind, shop) {
  const wrap = h('section', { class: 'view' });
  const shopName = shop ? canonicalStore(state.receipts.find((r) => storeKey(r.store) === shop)?.store || '') : '';
  if (!state.draft || state.draft.kind !== kind) state.draft = { kind, step: 'choose', shop: shopName };
  const d = state.draft;
  wrap.append(h('div', { class: 'view-head' }, h('h1', {}, kind === 'return' ? 'Return receipt' : 'Purchase receipt')));

  if (d.step === 'choose') {
    const pick = (capture) => h('input', { type: 'file', accept: 'image/*', ...(capture ? { capture: 'environment' } : { multiple: true }), hidden: true, onchange: (e) => e.target.files.length && processPhotos([...e.target.files]) });
    const cam = pick(true), up = pick(false);
    wrap.append(
      h('p', { class: 'muted' }, kind === 'return'
        ? 'Scan the refund receipt from the shop. Its lines are matched against your purchase receipts to verify each return.'
        : 'Take a photo of the whole receipt. For a long receipt, upload several photos top to bottom.'),
      h('div', { class: 'capture' },
        h('button', { class: 'btn primary big', onclick: () => cam.click() }, '📷 Take photo'),
        h('button', { class: 'btn big', onclick: () => up.click() }, '🖼 Upload photo(s)'),
        h('button', { class: 'btn ghost', onclick: () => startManual() }, 'Type it in instead'), cam, up),
      privacyNote());
    return wrap;
  }

  if (d.step === 'working') {
    wrap.append(h('div', { class: 'card working' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { id: 'work-msg' }, d.message || 'Working…'),
      h('progress', { id: 'work-progress', max: '1', value: d.progress ?? '' })));
    return wrap;
  }

  // review
  const rec = d.receipt;
  const rerender = (full) => {
    if (full) return render();
    warn.update?.();
  };
  const warn = warningsBox(rec);
  if (d.canvas) wrap.append(previewPanel(d));
  wrap.append(h('div', { class: 'card' },
    headerFields(rec, (full) => { if (full && kind === 'return') d.matches = matchReturn(rec, purchases()); rerender(full); }),
    warn,
    kind === 'purchase' ? breakdownLine(rec) : null,
    h('h3', {}, kind === 'return' ? 'Refunded lines' : 'Line items'),
    itemsEditor(rec, { isReturn: kind === 'return', onChange: (full) => { if (kind === 'return') d.matches = matchReturn(rec, purchases()); rerender(full); } })));
  if (kind === 'return') {
    d.matches ||= matchReturn(rec, purchases());
    wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Verify against purchases'), matchEditor(rec, d.matches, () => render())));
  }
  if (d.ocrText) wrap.append(h('details', { class: 'card' }, h('summary', {}, 'Text read from the photo (after redaction)'), h('pre', {}, d.ocrText)));
  wrap.append(h('div', { class: 'actions sticky' },
    h('button', { class: 'btn', onclick: () => { state.draft = null; location.hash = kind === 'return' ? '#/todo' : '#/receipts'; } }, 'Cancel'),
    state.settings.claude && state.settings.apiKey && d.canvas ? h('button', { class: 'btn', disabled: d.busy, onclick: enhance }, d.busy ? 'Reading with Claude…' : '✨ Re-read with Claude') : null,
    h('button', { class: 'btn primary', disabled: d.busy, onclick: saveDraft }, kind === 'return' ? 'Save & verify' : 'Save receipt')));
  return wrap;
}

function privacyNote() {
  return h('div', { class: 'card privacy' },
    h('h3', {}, '🔒 What happens to the photo'),
    h('ul', {},
      h('li', {}, 'It is redrawn on this device, which strips EXIF/GPS, device and other metadata.'),
      h('li', {}, 'Text is read on this device. Lines with card numbers, auth codes, addresses, phone numbers, emails, names and loyalty IDs are dropped and blacked out.'),
      h('li', {}, 'Only the line items, totals and (if you keep it) the redacted image are saved, in this browser only.'),
      h('li', {}, state.settings.claude && state.settings.apiKey ? 'Claude extraction is on: the redacted image is sent to the Anthropic API to read items.' : 'Nothing is uploaded anywhere.')));
}

function previewPanel(d) {
  const canvas = h('canvas', { class: 'preview', 'aria-label': 'Redacted receipt preview. Drag to black out more.' });
  const draw = () => {
    const red = redactedCopy(d.canvas, d.boxes);
    const s = Math.min(1, 900 / red.width);
    canvas.width = Math.round(red.width * s);
    canvas.height = Math.round(red.height * s);
    canvas.getContext('2d').drawImage(red, 0, 0, canvas.width, canvas.height);
    canvas.scale = s;
  };
  draw();
  // Drag to add a redaction box.
  let start = null;
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width / canvas.scale, y: ((e.clientY - r.top) / r.height) * canvas.height / canvas.scale };
  };
  canvas.addEventListener('pointerdown', (e) => { start = pt(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', (e) => {
    if (!start) return;
    const end = pt(e);
    if (Math.abs(end.x - start.x) > 8 && Math.abs(end.y - start.y) > 4) {
      d.boxes.push({ x0: start.x, y0: start.y, x1: end.x, y1: end.y, manual: true });
      draw();
      undo.disabled = false;
    }
    start = null;
  });
  const undo = h('button', { class: 'btn small', disabled: !d.boxes.some((b) => b.manual), onclick: () => {
    const i = d.boxes.map((b) => b.manual).lastIndexOf(true);
    if (i >= 0) d.boxes.splice(i, 1);
    undo.disabled = !d.boxes.some((b) => b.manual);
    draw();
  } }, 'Undo box');
  const reasons = [...new Set(d.flagged.flatMap((f) => f.reasons))];
  return h('div', { class: 'card preview-card' },
    h('div', { class: 'privacy-chips' },
      h('span', { class: 'badge ok' }, d.metadata.length ? `✓ Removed metadata: ${d.metadata.join(', ')}` : '✓ No metadata kept'),
      h('span', { class: `badge ${d.flagged.length ? 'ok' : ''}` }, d.flagged.length ? `✓ Redacted ${d.flagged.length} line${d.flagged.length === 1 ? '' : 's'}: ${reasons.join(', ')}` : 'No PII lines detected')),
    h('div', { class: 'preview-wrap' }, canvas),
    h('div', { class: 'row' },
      h('span', { class: 'muted small' }, 'Drag on the image to black out anything else.'), undo,
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: d.keepImage, onchange: (e) => { d.keepImage = e.target.checked; } }), h('span', {}, 'Keep redacted image'))));
}

function setWork(message, progress) {
  const d = state.draft;
  if (!d) return; // the user left the scan screen
  d.message = message;
  d.progress = progress;
  const m = $('#work-msg'), p = $('#work-progress');
  if (m) m.textContent = message;
  if (p) { if (progress == null) p.removeAttribute('value'); else p.value = progress; }
}

function startManual() {
  const d = state.draft;
  d.receipt = newReceipt({ kind: d.kind, store: d.shop, date: new Date().toISOString().slice(0, 10) });
  if (d.kind === 'return') d.receipt.lines = [{ desc: '', sku: '', qty: 1, amount: 0, match: null }];
  else d.receipt.items = [newItem({})];
  d.flagged = [];
  d.step = 'review';
  render();
}

function fromParsed(d, parsed, source) {
  const fields = { kind: d.kind, store: parsed.store || d.shop, date: parsed.date, subtotal: parsed.subtotal, tax: parsed.tax, total: parsed.total, source, redactions: d.flagged.length };
  const rec = newReceipt(fields);
  if (d.kind === 'return') rec.lines = parsed.items.map((i) => ({ desc: i.desc, sku: i.sku, qty: i.qty, amount: i.total, match: null }));
  else rec.items = parsed.items.map(newItem);
  return rec;
}

// Thrown when the user navigates away while a scan is still running.
class Abandoned extends Error {}

async function processPhotos(files) {
  const d = state.draft;
  const live = () => { if (state.draft !== d) throw new Abandoned(); };
  d.step = 'working';
  render();
  try {
    setWork('Removing photo metadata…');
    d.metadata = [...new Set((await Promise.all(files.map(inspectMetadata))).flat())];
    d.canvas = await loadPhotos(files);
    live();
    setWork('Reading text on this device… (first run loads the OCR model)', null);
    const { recognize } = await import('./ocr.js');
    const ocr = await recognize(d.canvas, (m) => {
      if (m.status === 'recognizing text') setWork(`Reading text on this device… ${Math.round(m.progress * 100)}%`, m.progress);
      else if (m.status && /load|init/i.test(m.status)) setWork(`Preparing OCR: ${m.status}…`, m.progress ?? null);
    });
    live();
    setWork('Removing personal information…');
    const raw = ocr.lines.map((l) => l.text).join('\n');
    const red = redactText(raw);
    d.flagged = red.flagged;
    d.boxes = red.flagged.map((f) => ocr.lines[f.index].bbox);
    d.keepImage = state.settings.keepImage;
    d.ocrText = red.text;
    const parsed = parseReceipt(red.text);
    if (d.shop && !parsed.store) parsed.store = d.shop;
    if (parsed.isReturn && d.kind === 'purchase') toast('This looks like a return receipt. Switch with “Return receipt” on the Returns tab if needed.');
    d.receipt = fromParsed(d, parsed, 'ocr');
    d.step = 'review';
    if (!parsed.items.length) toast('No line items found. Try a flatter, brighter photo, use Claude, or type them in.', 'warn');
    if (state.settings.claude && state.settings.apiKey) {
      render();
      await enhance();
      return;
    }
  } catch (e) {
    if (e instanceof Abandoned || state.draft !== d) return;
    console.error(e);
    toast(`Couldn’t read the photo: ${e.message}`, 'error');
    d.step = d.canvas ? 'review' : 'choose';
    if (!d.receipt && d.canvas) { d.flagged = d.flagged || []; d.boxes = d.boxes || []; d.metadata ||= []; d.receipt = newReceipt({ kind: d.kind, store: d.shop }); }
  }
  render();
}

async function enhance() {
  const d = state.draft;
  if (!d?.canvas || d.busy) return;
  d.busy = true;
  render();
  toast('Sending the redacted image to Claude…');
  try {
    const { extractWithClaude } = await import('./claude.js');
    const jpeg = await toCleanJpeg(redactedCopy(d.canvas, d.boxes), 1800, 0.85);
    const parsed = await extractWithClaude(state.settings.apiKey, await blobToBase64(jpeg));
    if (state.draft !== d) return; // the user left the scan screen
    if (!parsed.items.length) throw new Error('Claude found no line items.');
    const prev = d.receipt;
    d.receipt = fromParsed(d, { ...parsed, store: parsed.store || prev.store, date: parsed.date || prev.date }, 'claude');
    d.receipt.id = prev.id;
    d.matches = null;
    toast(`Claude read ${parsed.items.length} line${parsed.items.length === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    if (state.draft !== d) return;
    const { describeError } = await import('./claude.js').catch(() => ({ describeError: (x) => x.message }));
    toast(describeError(e), 'error');
  } finally {
    d.busy = false;
  }
  if (state.draft === d) render();
}

async function saveDraft() {
  const d = state.draft;
  if (!d || d.busy) return;
  const rec = d.receipt;
  rec.store = canonicalStore(rec.store);
  if (!rec.store) { toast('Add the shop name first.', 'warn'); return; }
  // Last line of defense: no PII in any stored string.
  for (const it of rec.kind === 'return' ? rec.lines : rec.items) if (classifyLine(it.desc, { item: true }).length) it.desc = '[redacted]';
  if (d.canvas && d.keepImage) rec.image = await toCleanJpeg(redactedCopy(d.canvas, d.boxes));
  rec.redactions = (d.flagged?.length || 0) + (d.boxes?.filter((b) => b.manual).length || 0);
  if (rec.kind === 'return') {
    const matches = d.matches || matchReturn(rec, purchases());
    const touched = applyReturn(rec, matches, purchases());
    await save(rec, ...touched);
    const n = matches.filter((m) => m.itemId).length;
    toast(`Verified ${n} of ${rec.lines.length} returned line${rec.lines.length === 1 ? '' : 's'}.`, n === rec.lines.length ? 'ok' : 'warn');
  } else {
    await save(rec);
    toast('Receipt saved.', 'ok');
  }
  state.draft = null;
  location.hash = `#/r/${rec.id}`;
}

// ---- saved receipt ----------------------------------------------------------

function viewReceipt(id) {
  const rec = byId(id);
  const wrap = h('section', { class: 'view' });
  if (!rec) { wrap.append(h('p', { class: 'empty' }, 'Receipt not found.'), h('a', { class: 'btn', href: '#/receipts' }, 'Back')); return wrap; }
  let dirty = false;
  const persist = debounce(async () => {
    if (deletedIds.has(rec.id)) return; // deleted while a save was pending
    await save(rec);
    dirty = false;
  }, 400);
  const changed = (full) => { dirty = true; persist(); if (full) { render(); } else warn.update(); };
  const warn = warningsBox(rec);
  wrap.append(h('div', { class: 'view-head' },
    h('h1', {}, canonicalStore(rec.store) || 'Receipt', rec.kind === 'return' ? h('span', { class: 'badge returned' }, 'Return') : null),
    h('a', { class: 'btn small', href: `#/receipts?shop=${storeKey(rec.store)}` }, 'All from shop')));
  if (rec.notes) wrap.append(h('p', { class: 'warnings' }, rec.notes));

  if (rec.kind === 'return') {
    wrap.append(h('div', { class: 'card' },
      h('p', { class: 'muted' }, fmtDate(rec.date), ' · ', `${rec.lines.length} lines · refund ${money(rec.lines.reduce((s, l) => s + Math.abs(Number(l.amount) || 0), 0))}`, rec.total != null ? ` (receipt total ${money(rec.total)})` : ''),
      h('ul', { class: 'todo' }, rec.lines.map((l) => {
        const p = l.match && byId(l.match.receiptId);
        const it = p?.items.find((i) => i.id === l.match.itemId);
        return h('li', {},
          h('div', {}, h('div', { class: 'title' }, `${l.qty || 1} × ${l.desc}`),
            it ? h('a', { class: 'muted link', href: `#/r/${p.id}` }, `✓ ${it.desc} · bought ${fmtDate(p.date)}`) : h('span', { class: 'badge warn' }, 'not matched')),
          h('strong', {}, `−${money(Math.abs(Number(l.amount) || 0))}`));
      })),
      h('p', { class: 'muted small' }, 'To change matches, delete this return receipt and scan it again.')));
  } else {
    wrap.append(h('div', { class: 'card' },
      headerFields(rec, changed),
      warn,
      breakdownLine(rec),
      h('h3', {}, 'Line items'),
      itemsEditor(rec, { isReturn: false, onChange: changed })));
  }
  if (rec.image) {
    const url = URL.createObjectURL(rec.image);
    wrap.append(h('details', { class: 'card' }, h('summary', {}, `Redacted photo${rec.redactions ? ` (${rec.redactions} redaction${rec.redactions === 1 ? '' : 's'})` : ''}`),
      h('img', { class: 'preview', src: url, alt: 'Redacted receipt photo', onload: () => setTimeout(() => URL.revokeObjectURL(url), 1000) }),
      h('button', { class: 'btn small', onclick: async () => { rec.image = null; await save(rec); render(); } }, 'Delete photo')));
  }
  wrap.append(h('div', { class: 'actions' },
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm(rec.kind === 'return' ? 'Delete this return receipt? Items it verified go back to “To return”.' : 'Delete this receipt and its items?')) return;
      if (rec.kind === 'return') await save(...unapplyReturn(rec, purchases()));
      deletedIds.add(rec.id);
      dirty = false;
      await db.remove(rec.id);
      state.receipts = state.receipts.filter((r) => r.id !== rec.id);
      location.hash = '#/receipts';
    } }, 'Delete receipt'),
    rec.kind === 'purchase' && rec.items.some((i) => i.status === STATUS.return) ? h('a', { class: 'btn primary', href: `#/add/return?shop=${storeKey(rec.store)}` }, 'Verify with return receipt') : null));
  window.onbeforeunload = () => (dirty ? true : undefined);
  return wrap;
}

const deletedIds = new Set();

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- settings ---------------------------------------------------------------

async function importBob() {
  let json;
  try {
    const res = await fetch('data/bob-receipts.json', { cache: 'no-cache' });
    json = await res.json();
  } catch {
    toast('Could not load the BOB receipts.', 'error');
    return;
  }
  const fresh = newOnly(fromBuildJson(json), state.receipts);
  if (!fresh.length) { toast('BOB receipts are already imported.'); return; }
  await save(...fresh);
  toast(`Imported ${fresh.length} BOB receipt${fresh.length === 1 ? '' : 's'}. Mark leftovers as “To return”.`, 'ok');
  render();
}

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function viewSettings() {
  const s = state.settings;
  const wrap = h('section', { class: 'view' });
  wrap.append(h('div', { class: 'view-head' }, h('h1', {}, 'Settings')));
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'BOB'),
    h('p', { class: 'muted' }, 'Pull in the receipts already logged in the BOB repo’s build file (Home Depot, Lowe’s, Amazon).'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: importBob }, 'Import BOB receipts'),
      h('label', { class: 'btn' }, 'Import a build.json…', h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const fresh = newOnly(fromBuildJson(JSON.parse(await f.text())), state.receipts);
          await save(...fresh);
          toast(`Imported ${fresh.length} receipt${fresh.length === 1 ? '' : 's'}.`, 'ok');
        } catch (err) { toast(`Not a build.json: ${err.message}`, 'error'); }
      } })))));

  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Privacy'),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: s.keepImage, onchange: (e) => setSetting('keepImage', e.target.checked) }), h('span', {}, 'Keep a redacted copy of each photo by default')),
    privacyNote()));

  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…', value: s.apiKey, 'aria-label': 'Anthropic API key' });
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Better extraction with Claude (optional)'),
    h('p', { class: 'muted' }, 'On-device OCR struggles with crumpled or faded receipts. With your own Anthropic API key, the app can send the redacted, metadata-free image to Claude to read the items. The key is stored only in this browser.'),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: s.claude, onchange: (e) => setSetting('claude', e.target.checked) }), h('span', {}, 'Use Claude after on-device redaction')),
    h('div', { class: 'row' }, key, h('button', { class: 'btn', onclick: async () => { await setSetting('apiKey', key.value.trim()); toast('Saved.', 'ok'); } }, 'Save key'))));

  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Your data'),
    h('p', { class: 'muted' }, `${state.receipts.length} receipts stored in this browser.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => download(`returns-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', toCSV(state.receipts)) }, 'Export CSV'),
      h('button', { class: 'btn', onclick: () => download(`receipts-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify({ app: 'receipts', version: 1, receipts: state.receipts.map(({ image, ...r }) => r) }, null, 1)) }, 'Back up (JSON)'),
      h('label', { class: 'btn' }, 'Restore…', h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (!Array.isArray(data.receipts)) throw new Error('missing receipts');
          const recs = data.receipts.map((r) => ({ ...newReceipt(r), ...r, id: r.id || uid(), image: byId(r.id)?.image ?? null }));
          await save(...recs);
          toast(`Restored ${recs.length} receipts.`, 'ok');
          render();
        } catch (err) { toast(`Restore failed: ${err.message}`, 'error'); }
      } })),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete every receipt, photo and setting on this device?')) return;
        await db.clearAll();
        await db.clearSettings();
        state.settings = defaultSettings(); // drop the API key from memory too
        state.receipts = [];
        toast('All data deleted.');
        location.hash = '#/';
        render();
      } }, 'Delete everything'))));
  return wrap;
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  try {
    await load();
  } catch (e) {
    $('#main').replaceChildren(h('p', { class: 'empty' }, `Storage is unavailable (${e.message}). Private browsing can block it.`));
    return;
  }
  render();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}
boot();
