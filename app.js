/* Travel Expenses - offline-first receipt capture.
 * Storage: IndexedDB on the phone (always), Supabase (database + private image bucket) when online and signed in.
 */
(() => {
  'use strict';

  const CFG = Object.assign({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '', BUCKET: 'receipts' }, window.APP_CONFIG || {});
  const DEFAULTS = {
    categories: ['Food - Breakfast', 'Food - Lunch', 'Food - Dinner', 'Baggage', 'Transportation', 'Gas'],
    currencies: ['JMD', 'USD', 'CAD', 'GBP', 'EUR'],
    payments: ['Personal card', 'Cash', 'Company card']
  };

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const newId = () =>
    (crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      }));

  function todayStr() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const slug = (s) => String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- settings ----------
  function loadJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
  }
  let settings = Object.assign({}, DEFAULTS, loadJSON('tec.settings', {}));
  let sticky = loadJSON('tec.sticky', {}); // last trip / currency / payment used

  // ---------- IndexedDB ----------
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('tec', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('expenses', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function tx(mode, fn) {
    return dbPromise.then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('expenses', mode);
      const out = fn(t.objectStore('expenses'));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const idbAll = () => tx('readonly', (s) => s.getAll());
  const idbGet = (id) => tx('readonly', (s) => s.get(id));
  const idbPut = (rec) => tx('readwrite', (s) => s.put(rec));
  const idbDelete = (id) => tx('readwrite', (s) => s.delete(id));
  const idbClear = () => tx('readwrite', (s) => s.clear());

  // ---------- Supabase ----------
  const cloudConfigured = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
  const sb = cloudConfigured
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    })
    : null;
  let session = null;
  let syncing = false;
  let lastSyncError = '';

  // ---------- photos ----------
  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
        img.src = url;
      });
    }
  }

  async function compress(file, maxDim = 2000, quality = 0.82) {
    const bmp = await loadBitmap(file);
    const w0 = bmp.width, h0 = bmp.height;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Compression failed'))), 'image/jpeg', quality));
  }

  const urlCache = new Map();
  async function photoURL(p) {
    if (p.blob) {
      let u = urlCache.get(p.id);
      if (!u) { u = URL.createObjectURL(p.blob); urlCache.set(p.id, u); }
      return u;
    }
    if (p.path && sb && session && navigator.onLine) {
      const key = 's:' + p.path;
      if (urlCache.has(key)) return urlCache.get(key);
      const { data } = await sb.storage.from(CFG.BUCKET).createSignedUrl(p.path, 3600);
      if (data && data.signedUrl) { urlCache.set(key, data.signedUrl); return data.signedUrl; }
    }
    return null;
  }

  async function photoBlob(p) {
    if (p.blob) return p.blob;
    if (p.path && sb && session && navigator.onLine) {
      const { data, error } = await sb.storage.from(CFG.BUCKET).download(p.path);
      if (!error && data) return data;
    }
    return null;
  }

  function thumbImg(p, cls) {
    const holder = h('div', { class: cls }, h('div', { class: 'ph', text: '🧾' }));
    photoURL(p).then((u) => {
      if (u) { holder.replaceChildren(h('img', { src: u, alt: 'Receipt', loading: 'lazy' })); }
    }).catch(() => { /* keep placeholder */ });
    return holder;
  }

  // ---------- capture form ----------
  let formPhotos = [];   // {id, blob, path}
  let formRemoved = [];  // storage paths removed while editing
  let editingId = null;

  function fillSelect(sel, values, placeholder) {
    const keep = sel.value;
    sel.replaceChildren();
    if (placeholder) sel.append(h('option', { value: '', text: placeholder }));
    for (const v of values) sel.append(h('option', { value: v, text: v }));
    if (keep && values.includes(keep)) sel.value = keep;
  }

  function refreshFormLists() {
    fillSelect($('#category'), settings.categories, 'Select a category');
    const cur = $('#currency');
    const keep = cur.value;
    fillSelect(cur, settings.currencies);
    cur.append(h('option', { value: '__other', text: 'Other…' }));
    cur.value = keep && [...cur.options].some((o) => o.value === keep) ? keep : (sticky.currency || settings.currencies[0] || '');
    fillSelect($('#payment'), settings.payments);
    if (sticky.payment && settings.payments.includes(sticky.payment)) $('#payment').value = sticky.payment;
    syncCurrencyOther();
  }

  async function refreshTripList() {
    const trips = new Set();
    (await idbAll()).forEach((r) => { if (!r.deleted && r.trip) trips.add(r.trip); });
    $('#tripList').replaceChildren(...[...trips].sort().map((t) => h('option', { value: t })));
  }

  function syncCurrencyOther() {
    const other = $('#currency').value === '__other';
    $('#currencyOtherWrap').hidden = !other;
    $('#currencyOther').required = other;
  }

  function renderFormPhotos() {
    const box = $('#formPhotos');
    box.replaceChildren(...formPhotos.map((p, i) => {
      const el = thumbImg(p, 'thumb');
      el.append(h('button', {
        class: 'x', type: 'button', 'aria-label': 'Remove photo',
        onclick: () => {
          const [gone] = formPhotos.splice(i, 1);
          if (gone.path) formRemoved.push(gone.path);
          renderFormPhotos();
        }
      }, '✕'));
      el.addEventListener('click', (e) => { if (!e.target.classList.contains('x')) openViewer([p], 'Receipt'); });
      return el;
    }));
    $('#photoHint').textContent = formPhotos.length
      ? `${formPhotos.length} photo${formPhotos.length > 1 ? 's' : ''} attached.`
      : 'Add one or more photos of the receipt.';
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    toast('Processing photo…');
    for (const f of files) {
      try {
        const blob = await compress(f);
        formPhotos.push({ id: newId().slice(0, 8), blob, path: null });
      } catch (err) {
        toast('Could not read that photo');
      }
    }
    renderFormPhotos();
  }

  function resetForm(keepSticky = true) {
    editingId = null;
    formPhotos = [];
    formRemoved = [];
    $('#expenseForm').reset();
    $('#date').value = keepSticky && sticky.date ? sticky.date : todayStr();
    $('#trip').value = keepSticky ? (sticky.trip || '') : '';
    refreshFormLists();
    $('#formTitle').textContent = 'New expense';
    $('#saveBtn').textContent = 'Save expense';
    $('#cancelEdit').hidden = true;
    renderFormPhotos();
  }

  async function startEdit(id) {
    const rec = await idbGet(id);
    if (!rec) return;
    editingId = id;
    formPhotos = rec.photos.map((p) => ({ id: p.id, blob: p.blob || null, path: p.path || null }));
    formRemoved = [];
    $('#date').value = rec.date;
    $('#amount').value = String(rec.amount);
    refreshFormLists();
    if (!settings.currencies.includes(rec.currency)) {
      $('#currency').value = '__other';
      $('#currencyOther').value = rec.currency;
    } else {
      $('#currency').value = rec.currency;
    }
    syncCurrencyOther();
    if (rec.category && !settings.categories.includes(rec.category)) {
      $('#category').append(h('option', { value: rec.category, text: rec.category }));
    }
    $('#category').value = rec.category;
    $('#trip').value = rec.trip || '';
    $('#purpose').value = rec.purpose;
    if (rec.payment && !settings.payments.includes(rec.payment)) {
      $('#payment').append(h('option', { value: rec.payment, text: rec.payment }));
    }
    $('#payment').value = rec.payment || '';
    $('#notes').value = rec.notes || '';
    $('#formTitle').textContent = 'Edit expense';
    $('#saveBtn').textContent = 'Update expense';
    $('#cancelEdit').hidden = false;
    renderFormPhotos();
    showTab('capture');
    window.scrollTo({ top: 0 });
  }

  async function onSave(e) {
    e.preventDefault();
    const amount = parseFloat(String($('#amount').value).replace(/,/g, ''));
    if (!(amount > 0)) { toast('Enter a valid amount'); return; }
    let currency = $('#currency').value;
    if (currency === '__other') currency = $('#currencyOther').value.trim().toUpperCase();
    if (!currency) { toast('Enter a currency'); return; }
    if (!formPhotos.length && !confirm('No receipt photo attached. Save anyway?')) return;

    const now = new Date().toISOString();
    let rec = editingId ? await idbGet(editingId) : null;
    if (!rec) rec = { id: newId(), createdAt: now, status: 'Draft', removedPaths: [] };
    Object.assign(rec, {
      date: $('#date').value,
      amount: Math.round(amount * 100) / 100,
      currency,
      category: $('#category').value,
      trip: $('#trip').value.trim(),
      purpose: $('#purpose').value.trim(),
      payment: $('#payment').value,
      notes: $('#notes').value.trim(),
      photos: formPhotos.map((p) => ({ id: p.id, blob: p.blob || null, path: p.path || null })),
      removedPaths: [...(rec.removedPaths || []), ...formRemoved],
      updatedAt: now,
      dirty: true,
      deleted: false
    });
    try {
      await idbPut(rec);
    } catch (err) {
      toast('Could not save on this device. Storage may be full.');
      return;
    }
    sticky = { trip: rec.trip, currency: $('#currency').value, payment: rec.payment, date: rec.date };
    saveJSON('tec.sticky', sticky);
    const wasEdit = Boolean(editingId);
    resetForm(true);
    toast(wasEdit ? 'Expense updated' : 'Expense saved');
    await refreshTripList();
    await renderList();
    updateSyncStatus();
    sync();
  }

  // ---------- list / review ----------
  const selected = new Set();

  async function visibleRecords() {
    const trip = $('#filterTrip').value;
    const status = $('#filterStatus').value;
    return (await idbAll())
      .filter((r) => !r.deleted)
      .filter((r) => (trip === '' ? true : trip === '__none' ? !r.trip : r.trip === trip))
      .filter((r) => (status ? r.status === status : true))
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  }

  async function renderFilters() {
    const recs = (await idbAll()).filter((r) => !r.deleted);
    const trips = [...new Set(recs.map((r) => r.trip).filter(Boolean))].sort();
    const sel = $('#filterTrip');
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '', text: 'All trips' }),
      ...trips.map((t) => h('option', { value: t, text: t })));
    if (recs.some((r) => !r.trip)) sel.append(h('option', { value: '__none', text: '(no trip)' }));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  }

  function totalsText(recs) {
    const by = {};
    recs.forEach((r) => { by[r.currency] = (by[r.currency] || 0) + r.amount; });
    return Object.entries(by).map(([c, v]) => `${c} ${money(v)}`).join('  ·  ');
  }

  async function renderList() {
    await renderFilters();
    const recs = await visibleRecords();
    for (const id of [...selected]) if (!recs.some((r) => r.id === id)) selected.delete(id);

    const list = $('#list');
    if (!recs.length) {
      list.replaceChildren(h('div', { class: 'empty', text: 'No expenses yet. Capture one on the first tab.' }));
    } else {
      const groups = new Map();
      recs.forEach((r) => {
        const k = r.trip || '(no trip)';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      const nodes = [];
      for (const [trip, items] of groups) {
        nodes.push(h('div', { class: 'group-title', text: `${trip} · ${totalsText(items)}` }));
        items.forEach((r) => nodes.push(itemNode(r)));
      }
      list.replaceChildren(...nodes);
    }
    $('#totals').textContent = recs.length ? `Shown: ${totalsText(recs)}` : '';
    updateSelInfo(recs);
  }

  function itemNode(r) {
    const cb = h('input', {
      type: 'checkbox', 'aria-label': 'Select expense',
      onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); updateSelInfo(); }
    });
    cb.checked = selected.has(r.id);
    cb.dataset.id = r.id;

    const first = r.photos[0];
    const pic = h('button', { class: 'pic', type: 'button', 'aria-label': 'View receipt', onclick: () => r.photos.length && openViewer(r.photos, fileLabel(r)) });
    if (first) {
      const inner = thumbImg(first, 'pic-inner');
      inner.style.cssText = 'width:100%;height:100%';
      pic.append(inner);
      if (r.photos.length > 1) pic.append(h('span', { class: 'count', text: `×${r.photos.length}` }));
    } else {
      pic.append(h('div', { class: 'ph', text: '—' }));
    }

    return h('div', { class: 'item' },
      cb, pic,
      h('div', {},
        h('div', { class: 'l1' }, h('span', { text: r.category }), h('span', { text: `${r.currency} ${money(r.amount)}` })),
        h('div', { class: 'l2', text: `${r.date} · ${r.payment || 'no payment method'}` }),
        h('div', { class: 'l3', text: r.purpose }),
        r.notes ? h('div', { class: 'l2', text: r.notes }) : null,
        h('div', { class: 'row' },
          h('span', { class: 'badge ' + (r.status === 'Exported' ? 'exported' : ''), text: r.status }),
          r.dirty ? h('span', { class: 'badge pending', text: 'not backed up' }) : null,
          h('button', { class: 'btn small', type: 'button', onclick: () => startEdit(r.id) }, 'Edit'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteExpense(r.id) }, 'Delete')
        )
      )
    );
  }

  async function updateSelInfo(recs) {
    const all = recs || await visibleRecords();
    const chosen = all.filter((r) => selected.has(r.id));
    $('#selInfo').textContent = chosen.length ? `${chosen.length} selected · ${totalsText(chosen)}` : 'None selected';
    $$('#list input[type=checkbox]').forEach((c) => { c.checked = selected.has(c.dataset.id); });
  }

  async function deleteExpense(id) {
    if (!confirm('Delete this expense and its receipt photos?')) return;
    const rec = await idbGet(id);
    if (!rec) return;
    rec.deleted = true;
    rec.dirty = true;
    rec.updatedAt = new Date().toISOString();
    rec.removedPaths = [...(rec.removedPaths || []), ...rec.photos.filter((p) => p.path).map((p) => p.path)];
    rec.photos = [];
    await idbPut(rec);
    selected.delete(id);
    toast('Deleted');
    await refreshTripList();
    await renderList();
    updateSyncStatus();
    sync();
  }

  function openViewer(photos, title) {
    const dlg = $('#viewer');
    const body = h('div', { class: 'viewer-body' });
    dlg.replaceChildren(
      h('div', { class: 'viewer-head' }, h('strong', { text: title || 'Receipt' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => dlg.close() }, 'Close')),
      body
    );
    photos.forEach((p, i) => {
      const slot = h('div', {}, h('p', { class: 'hint', text: 'Loading…' }));
      body.append(slot);
      photoURL(p).then((u) => {
        if (!u) { slot.replaceChildren(h('p', { class: 'hint', text: 'Photo is in the cloud. Connect to the internet to view it.' })); return; }
        const name = `${slug(title)}_${i + 1}.jpg`;
        slot.replaceChildren(h('img', { src: u, alt: 'Receipt photo' }), h('a', { href: u, download: name, text: 'Save this image' }));
      });
    });
    dlg.showModal();
  }

  // ---------- export ----------
  function fileLabel(r) {
    return `${r.date}_${slug(r.category)}_${r.currency}${r.amount.toFixed(2)}`;
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async function chosenRecords() {
    const recs = (await visibleRecords()).filter((r) => selected.has(r.id));
    if (!recs.length) toast('Select at least one expense');
    return recs.sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportName(recs, ext) {
    const trips = [...new Set(recs.map((r) => r.trip).filter(Boolean))];
    const base = trips.length === 1 ? slug(trips[0]) : 'expenses';
    return `${base}_${todayStr()}.${ext}`;
  }

  async function buildCsv(recs, fileMap) {
    const header = ['Date', 'Category', 'Trip/Project', 'Amount', 'Currency', 'Payment Method', 'Purpose', 'Notes', 'Receipt Files', 'Status'];
    const rows = recs.map((r) => [
      r.date, r.category, r.trip, r.amount.toFixed(2), r.currency, r.payment, r.purpose, r.notes,
      (fileMap.get(r.id) || []).join(' | '), r.status
    ]);
    return '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  async function exportCsv() {
    const recs = await chosenRecords();
    if (!recs.length) return;
    const map = new Map(recs.map((r) => [r.id, r.photos.map((p, i) => photoName(r, i + 1, r.photos.length))]));
    download(new Blob([await buildCsv(recs, map)], { type: 'text/csv;charset=utf-8' }), exportName(recs, 'csv'));
    offerMarkExported(recs);
  }

  function photoName(r, n, total) {
    return `${fileLabel(r)}${total > 1 ? '_' + n : ''}.jpg`;
  }

  async function exportZip() {
    const recs = await chosenRecords();
    if (!recs.length) return;
    if (typeof JSZip === 'undefined') { toast('ZIP library missing'); return; }
    toast('Building ZIP…');
    const zip = new JSZip();
    const folder = zip.folder('receipts');
    const used = new Set();
    const fileMap = new Map();
    let missing = 0;
    for (const r of recs) {
      const names = [];
      let n = 0;
      for (const p of r.photos) {
        n++;
        const blob = await photoBlob(p);
        if (!blob) { missing++; continue; }
        let name = photoName(r, n, r.photos.length);
        while (used.has(name)) name = name.replace(/\.jpg$/, `-${newId().slice(0, 4)}.jpg`);
        used.add(name);
        folder.file(name, blob);
        names.push('receipts/' + name);
      }
      fileMap.set(r.id, names);
    }
    zip.file('expenses.csv', await buildCsv(recs, fileMap));
    const blob = await zip.generateAsync({ type: 'blob' });
    download(blob, exportName(recs, 'zip'));
    if (missing) toast(`${missing} photo(s) could not be loaded (go online and retry)`);
    offerMarkExported(recs);
  }

  async function offerMarkExported(recs) {
    const drafts = recs.filter((r) => r.status !== 'Exported');
    if (!drafts.length) return;
    setTimeout(async () => {
      if (confirm(`Mark ${drafts.length} expense(s) as Exported?`)) await setStatus(drafts, 'Exported');
    }, 600);
  }

  async function setStatus(recs, status) {
    const now = new Date().toISOString();
    for (const r of recs) {
      const cur = await idbGet(r.id);
      if (!cur) continue;
      cur.status = status;
      cur.updatedAt = now;
      cur.dirty = true;
      await idbPut(cur);
    }
    await renderList();
    updateSyncStatus();
    sync();
  }

  // ---------- sync ----------
  function toRow(rec, userId) {
    return {
      id: rec.id,
      user_id: userId,
      expense_date: rec.date,
      amount: rec.amount,
      currency: rec.currency,
      category: rec.category,
      trip: rec.trip || null,
      purpose: rec.purpose,
      payment_method: rec.payment || null,
      notes: rec.notes || null,
      status: rec.status,
      photo_paths: rec.photos.filter((p) => p.path).map((p) => p.path),
      deleted: Boolean(rec.deleted),
      created_at: rec.createdAt,
      updated_at: rec.updatedAt
    };
  }

  function fromRow(row, local) {
    const blobsByPath = new Map();
    (local ? local.photos : []).forEach((p) => { if (p.path && p.blob) blobsByPath.set(p.path, p.blob); });
    return {
      id: row.id,
      date: row.expense_date,
      amount: Number(row.amount),
      currency: row.currency,
      category: row.category,
      trip: row.trip || '',
      purpose: row.purpose,
      payment: row.payment_method || '',
      notes: row.notes || '',
      status: row.status,
      photos: (row.photo_paths || []).map((path) => ({
        id: (path.split('/').pop() || '').replace(/\.jpg$/, ''),
        path,
        blob: blobsByPath.get(path) || null
      })),
      removedPaths: [],
      deleted: false,
      dirty: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async function sync() {
    if (!sb || !session || syncing || !navigator.onLine) return;
    syncing = true;
    lastSyncError = '';
    setStatusText('Syncing…');
    try {
      const userId = session.user.id;
      const bucket = sb.storage.from(CFG.BUCKET);

      // push local changes
      for (const rec of await idbAll()) {
        if (!rec.dirty) continue;
        const uploaded = new Map();
        for (const p of rec.photos) {
          if (!p.path && p.blob) {
            const path = `${userId}/${rec.id}/${p.id}.jpg`;
            const { error } = await bucket.upload(path, p.blob, { contentType: 'image/jpeg', upsert: true });
            if (error) throw error;
            uploaded.set(p.id, path);
            p.path = path;
          }
        }
        const { error } = await sb.from('expenses').upsert(toRow(rec, userId));
        if (error) throw error;

        const removed = [...new Set(rec.removedPaths || [])];
        if (removed.length) await bucket.remove(removed); // best effort

        const cur = await idbGet(rec.id);
        if (!cur) continue;
        cur.photos.forEach((p) => { if (!p.path && uploaded.has(p.id)) p.path = uploaded.get(p.id); });
        cur.removedPaths = (cur.removedPaths || []).filter((x) => !removed.includes(x));
        if (cur.updatedAt === rec.updatedAt) {
          cur.dirty = false;
          if (cur.deleted) { await idbDelete(cur.id); continue; }
        }
        await idbPut(cur);
      }

      // pull remote changes
      const { data, error } = await sb.from('expenses').select('*');
      if (error) throw error;
      for (const row of data || []) {
        const local = await idbGet(row.id);
        if (row.deleted) { if (local && !local.dirty) await idbDelete(row.id); continue; }
        if (!local) await idbPut(fromRow(row, null));
        else if (!local.dirty && new Date(row.updated_at) > new Date(local.updatedAt)) await idbPut(fromRow(row, local));
      }
    } catch (err) {
      lastSyncError = (err && err.message) || 'Sync failed';
    } finally {
      syncing = false;
      await refreshTripList();
      await renderList();
      updateSyncStatus();
    }
  }

  function setStatusText(t) { $('#syncStatus').textContent = t; }

  async function updateSyncStatus() {
    const pending = (await idbAll()).filter((r) => r.dirty).length;
    let text;
    if (!cloudConfigured) text = 'Local only';
    else if (!session) text = pending ? `Sign in to back up (${pending})` : 'Not signed in';
    else if (lastSyncError) text = 'Sync error · tap for details';
    else if (!navigator.onLine) text = pending ? `Offline · ${pending} waiting` : 'Offline';
    else text = pending ? `${pending} waiting to sync` : '✓ Backed up';
    setStatusText(text);
    renderSettingsInfo(pending);
  }

  // ---------- auth ----------
  // The expenses stored on this phone belong to one account at a time (tec.owner).
  // If a different account signs in, the previous account's local copy is removed first
  // so one person's receipts can never be uploaded under another person's login.
  const getOwner = () => { try { return localStorage.getItem('tec.owner'); } catch { return null; } };
  const setOwner = (id) => { try { id ? localStorage.setItem('tec.owner', id) : localStorage.removeItem('tec.owner'); } catch { /* ignore */ } };

  async function clearLocal() {
    await idbClear();
    selected.clear();
    sticky = {};
    saveJSON('tec.sticky', sticky);
    urlCache.clear();
    resetForm(false);
    await refreshTripList();
    await renderList();
  }

  async function claimOwnership(userId) {
    const owner = getOwner();
    if (!owner) { setOwner(userId); return true; }       // first account on this phone keeps anything captured before signing in
    if (owner === userId) return true;
    const dirty = (await idbAll()).filter((r) => r.dirty).length;
    const warn = dirty
      ? `Another account has ${dirty} expense(s) on this phone that were never backed up. Signing in will delete them from this phone. Continue?`
      : 'Another account was using this phone. Its expenses are safe in the cloud and will be removed from this phone. Continue?';
    if (!confirm(warn)) { await sb.auth.signOut(); return false; }
    await clearLocal();
    setOwner(userId);
    return true;
  }

  async function onSignedIn(s) {
    session = s;
    if (!(await claimOwnership(s.user.id))) { session = null; await updateSyncStatus(); return; }
    await updateSyncStatus();
    sync();
  }

  async function initAuth() {
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    if (data.session) await onSignedIn(data.session);
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt === 'SIGNED_IN' && s && (!session || session.user.id !== s.user.id)) setTimeout(() => onSignedIn(s), 0);
      else if (evt === 'SIGNED_OUT') { session = null; setTimeout(updateSyncStatus, 0); }
      else if (s) { session = s; }
    });
  }

  async function signIn() {
    if (!sb) { toast('Cloud is not configured yet (see config.js)'); return; }
    if (!navigator.onLine) { toast('You need internet to sign in'); return; }
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: location.origin + location.pathname }
    });
    if (error) toast(error.message);
  }

  function readEmailForm() {
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    if (!email || !email.includes('@')) { toast('Enter your email address'); return null; }
    if (password.length < 8) { toast('Password must be at least 8 characters'); return null; }
    return { email, password };
  }

  async function emailSignIn(e) {
    if (e) e.preventDefault();
    if (!sb) { toast('Cloud is not configured yet (see config.js)'); return; }
    if (!navigator.onLine) { toast('You need internet to sign in'); return; }
    const creds = readEmailForm();
    if (!creds) return;
    const { error } = await sb.auth.signInWithPassword(creds);
    if (error) toast(error.message); else { $('#authPassword').value = ''; toast('Signed in'); }
  }

  async function emailSignUp() {
    if (!sb) { toast('Cloud is not configured yet (see config.js)'); return; }
    if (!navigator.onLine) { toast('You need internet to create an account'); return; }
    const creds = readEmailForm();
    if (!creds) return;
    const { data, error } = await sb.auth.signUp({
      ...creds,
      options: { emailRedirectTo: location.origin + location.pathname }
    });
    if (error) { toast(error.message); return; }
    $('#authPassword').value = '';
    if (data.session) toast('Account created and signed in');
    else toast('Check your email and tap the confirmation link, then sign in');
  }

  async function signOut() {
    if (!sb) return;
    if (session && navigator.onLine) await sync();
    const dirty = (await idbAll()).filter((r) => r.dirty).length;
    if (dirty && !confirm(`${dirty} expense(s) are not backed up yet and will stay only on this phone. Sign out anyway?`)) return;
    await sb.auth.signOut();
    session = null;
    if (!dirty && confirm('Also remove this account\'s expenses from this phone? They stay safe in the cloud.')) {
      await clearLocal();
      setOwner(null);
    }
    updateSyncStatus();
  }

  // ---------- settings tab ----------
  async function renderSettingsInfo(pending) {
    const all = (await idbAll()).filter((r) => !r.deleted);
    const photos = all.reduce((n, r) => n + r.photos.length, 0);
    let who;
    if (!cloudConfigured) who = 'Cloud backup is not configured. Add your Supabase URL and key to config.js.';
    else if (session) {
      const meta = session.user.user_metadata || {};
      who = `Signed in as ${meta.user_name || meta.preferred_username || session.user.email || 'your GitHub account'}.`;
    } else who = 'Not signed in. Sign in once while online to back up your expenses.';
    if (lastSyncError) who += ` Last sync problem: ${lastSyncError}`;
    $('#authInfo').textContent = who;
    $('#signedOutBox').hidden = !cloudConfigured || Boolean(session);
    $('#signOut').hidden = !session;
    $('#syncNow').hidden = !session;
    $('#deviceInfo').textContent =
      `${all.length} expense(s) and ${photos} photo(s) stored on this device. ${pending ?? 0} not yet backed up.`;
  }

  function loadSettingsForm() {
    $('#setCategories').value = settings.categories.join('\n');
    $('#setCurrencies').value = settings.currencies.join('\n');
    $('#setPayments').value = settings.payments.join('\n');
  }

  function parseLines(text, upper) {
    const out = [];
    text.split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const v = upper ? s.toUpperCase() : s;
      if (!out.includes(v)) out.push(v);
    });
    return out;
  }

  function onSaveSettings(e) {
    e.preventDefault();
    const categories = parseLines($('#setCategories').value);
    const currencies = parseLines($('#setCurrencies').value, true);
    const payments = parseLines($('#setPayments').value);
    if (!categories.length || !currencies.length) { toast('Keep at least one category and one currency'); return; }
    settings = { categories, currencies, payments };
    saveJSON('tec.settings', settings);
    refreshFormLists();
    toast('Lists saved');
  }

  // ---------- tabs ----------
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'list') renderList();
    if (name === 'settings') updateSyncStatus();
    window.scrollTo({ top: 0 });
  }

  // ---------- init ----------
  async function init() {
    $('#date').value = todayStr();
    refreshFormLists();
    loadSettingsForm();
    renderFormPhotos();

    $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#currency').addEventListener('change', syncCurrencyOther);
    $('#inputCamera').addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
    $('#inputLibrary').addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
    $('#expenseForm').addEventListener('submit', onSave);
    $('#cancelEdit').addEventListener('click', () => resetForm(true));
    $('#filterTrip').addEventListener('change', renderList);
    $('#filterStatus').addEventListener('change', renderList);
    $('#selAll').addEventListener('click', async () => { (await visibleRecords()).forEach((r) => selected.add(r.id)); updateSelInfo(); });
    $('#selNone').addEventListener('click', () => { selected.clear(); updateSelInfo(); });
    $('#exportZip').addEventListener('click', exportZip);
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#markExported').addEventListener('click', async () => { const r = await chosenRecords(); if (r.length) { await setStatus(r, 'Exported'); toast('Marked exported'); } });
    $('#markDraft').addEventListener('click', async () => { const r = await chosenRecords(); if (r.length) { await setStatus(r, 'Draft'); toast('Marked draft'); } });
    $('#settingsForm').addEventListener('submit', onSaveSettings);
    $('#signIn').addEventListener('click', signIn);
    $('#emailForm').addEventListener('submit', emailSignIn);
    $('#emailSignUp').addEventListener('click', emailSignUp);
    $('#signOut').addEventListener('click', signOut);
    $('#syncNow').addEventListener('click', async () => { await sync(); toast(lastSyncError ? 'Sync problem: ' + lastSyncError : 'Sync finished'); });
    $('#syncStatus').addEventListener('click', () => {
      if (lastSyncError) toast(lastSyncError);
      else if (!session && cloudConfigured) showTab('settings');
      else sync();
    });

    window.addEventListener('online', () => { updateSyncStatus(); sync(); });
    window.addEventListener('offline', updateSyncStatus);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    await refreshTripList();
    await renderList();
    await updateSyncStatus();
    await initAuth();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init().catch((err) => {
    console.error(err);
    toast('Startup problem: ' + (err && err.message));
  });
})();
