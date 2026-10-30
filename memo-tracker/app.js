// Memo Tracker: matters, files, memo versions, deadlines, fees and a citation checker.
// All data lives in this browser's IndexedDB; nothing is sent anywhere.
'use strict';

const STAGES = ['Intake', 'Research', 'Drafting', 'Internal review', 'Sent to client', 'Revisions', 'Closed'];
const FILE_CATS = {
  original: 'Original documents',
  redacted: 'Redacted documents',
  supporting: 'Supporting files',
  correspondence: 'Correspondence',
};

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

// ---------- storage ----------
let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('memo-tracker', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('matters', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' }).createIndex('matterId', 'matterId');
      d.createObjectStore('cases', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
const put = (store, obj) => tx(store, 'readwrite', (s) => s.put(obj));
const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
const filesFor = (matterId) => tx('files', 'readonly', (s) => s.index('matterId').getAll(matterId));

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (+n || 0).toLocaleString(undefined, { style: 'currency', currency: 'CAD' });
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T00:00' : '')).toLocaleDateString() : '—');
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');

function daysLeft(deadline) {
  if (!deadline) return null;
  return Math.round((new Date(deadline + 'T00:00') - new Date(today() + 'T00:00')) / 86400000);
}
function deadlineBadge(m) {
  if (m.stage === 'Closed') return '<span class="badge b-muted">Closed</span>';
  const d = daysLeft(m.deadline);
  if (d == null) return '<span class="badge b-muted">No deadline</span>';
  if (d < 0) return `<span class="badge b-bad">${-d} day${d === -1 ? '' : 's'} overdue</span>`;
  if (d === 0) return '<span class="badge b-bad">Due today</span>';
  return `<span class="badge ${d <= 7 ? 'b-warn' : 'b-ok'}">${d} day${d === 1 ? '' : 's'} left</span>`;
}
function paidOf(m) {
  return (m.payments || []).reduce((t, p) => t + (+p.amount || 0), 0);
}
function payStatus(m) {
  const fee = +m.fee || 0, paid = paidOf(m);
  if (!fee) return paid ? 'paid' : 'no-fee';
  if (paid >= fee) return 'paid';
  return paid > 0 ? 'partial' : 'unpaid';
}
function payBadge(m) {
  const s = payStatus(m);
  return {
    paid: '<span class="badge b-ok">Paid</span>',
    partial: `<span class="badge b-warn">Part paid (${money(paidOf(m))} of ${money(m.fee)})</span>`,
    unpaid: `<span class="badge b-bad">Unpaid ${money(m.fee)}</span>`,
    'no-fee': '<span class="badge b-muted">No fee set</span>',
  }[s];
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// A small modal form. `fields` is HTML; resolves with FormData values, or null on cancel.
function ask(title, fields, okLabel = 'Save') {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="form">${fields}</div>
    <div class="row" style="margin-top:14px;flex-direction:row-reverse">
      <button value="ok" class="primary">${esc(okLabel)}</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? Object.fromEntries(new FormData($('form', dlg))) : null);
  });
}
function showDialog(html) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog">${html}<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="primary">Close</button></div></form>`;
  dlg.onclose = null;
  dlg.showModal();
}

// ---------- navigation ----------
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ({ dashboard: renderDashboard, matters: renderMatterList, library: renderLibrary, checker: renderCheckerPicker })[view]?.();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------- dashboard ----------
async function renderDashboard() {
  const [matters, files] = await Promise.all([all('matters'), all('files')]);
  const open = matters.filter((m) => m.stage !== 'Closed');
  const owing = matters.reduce((t, m) => t + Math.max(0, (+m.fee || 0) - paidOf(m)), 0);
  const dueSoon = open.filter((m) => { const d = daysLeft(m.deadline); return d != null && d >= 0 && d <= 7; });
  const overdue = open.filter((m) => daysLeft(m.deadline) < 0);
  const redactedOf = new Set(files.filter((f) => f.category === 'redacted').map((f) => f.redactedOf));
  const needRedaction = files.filter((f) => f.category === 'original' && !redactedOf.has(f.id) && !f.noRedaction);
  $('#stats').innerHTML = [
    ['Open matters', open.length],
    ['Due in 7 days', dueSoon.length],
    ['Overdue', overdue.length],
    ['Fees outstanding', money(owing)],
    ['Awaiting redaction', needRedaction.length],
  ].map(([k, v]) => `<div class="stat"><span class="muted">${k}</span><b>${v}</b></div>`).join('');

  const latest = {};
  for (const f of files) if (f.category === 'memo' && (!latest[f.matterId] || f.version > latest[f.matterId])) latest[f.matterId] = f.version;
  const rows = [...matters].sort((a, b) => (a.stage === 'Closed') - (b.stage === 'Closed') || (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  $('#deadline-table').innerHTML = `<tr><th>Matter</th><th>Client</th><th>Stage</th><th>Deadline</th><th></th><th>Memo</th><th>Payment</th></tr>` +
    (rows.length ? rows.map((m) => `<tr class="click" data-id="${m.id}"><td>${esc(m.title)}</td><td>${esc(m.client)}</td><td>${esc(m.stage)}</td>
      <td>${fmtDate(m.deadline)}</td><td>${deadlineBadge(m)}</td><td>${latest[m.id] ? 'v' + latest[m.id] : '<span class="muted">none</span>'}</td><td>${payBadge(m)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted">No matters yet. Go to Matters → New.</td></tr>');
  document.querySelectorAll('#deadline-table tr.click').forEach((tr) => (tr.onclick = () => { show('matters'); openMatter(tr.dataset.id); }));
}

// ---------- matters ----------
let currentMatter = null;
$('#matter-search').oninput = renderMatterList;
$('#matter-filter').onchange = renderMatterList;
$('#new-matter').onclick = async () => {
  const m = { id: uid(), title: 'New memorandum', client: '', fileNo: '', forum: '', stage: 'Intake', deadline: '', fee: '',
    invoiceNo: '', notes: '', payments: [], tasks: [], created: new Date().toISOString() };
  await put('matters', m);
  await renderMatterList();
  openMatter(m.id);
};

async function renderMatterList() {
  const q = $('#matter-search').value.toLowerCase();
  const filter = $('#matter-filter').value;
  const matters = (await all('matters')).filter((m) => {
    if (filter === 'open' && m.stage === 'Closed') return false;
    if (filter === 'closed' && m.stage !== 'Closed') return false;
    if (filter === 'unpaid' && !['unpaid', 'partial'].includes(payStatus(m))) return false;
    return !q || [m.title, m.client, m.fileNo, m.forum].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  $('#matter-list').innerHTML = matters.map((m) => `<li data-id="${m.id}" class="${m.id === currentMatter ? 'sel' : ''}">
    <div>${esc(m.title)}</div><div class="sub">${esc(m.client || 'No client')} · ${deadlineBadge(m)}</div></li>`).join('') ||
    '<li class="muted">Nothing here.</li>';
  document.querySelectorAll('#matter-list li[data-id]').forEach((li) => (li.onclick = () => openMatter(li.dataset.id)));
}

async function openMatter(id) {
  currentMatter = id;
  const [m, files] = await Promise.all([get('matters', id), filesFor(id)]);
  if (!m) return;
  document.querySelectorAll('#matter-list li').forEach((li) => li.classList.toggle('sel', li.dataset.id === id));
  const memos = files.filter((f) => f.category === 'memo').sort((a, b) => b.version - a.version);
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  const redactedOf = new Set(files.filter((f) => f.category === 'redacted').map((f) => f.redactedOf));
  const el = $('#matter-detail');

  el.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${esc(m.title)}</h2>
      <div class="row" style="margin:0">${deadlineBadge(m)} ${payBadge(m)}</div>
    </div>
    <form id="matter-form" class="form">
      <label>Title<input name="title" value="${esc(m.title)}" required></label>
      <label>Client<input name="client" value="${esc(m.client)}"></label>
      <label>File number<input name="fileNo" value="${esc(m.fileNo)}"></label>
      <label>Court / tribunal<input name="forum" value="${esc(m.forum)}"></label>
      <label>Stage<select name="stage">${STAGES.map((s) => `<option ${s === m.stage ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Deadline<input type="date" name="deadline" value="${esc(m.deadline)}"></label>
      <label>Fee (CAD)<input type="number" step="0.01" min="0" name="fee" value="${esc(m.fee)}"></label>
      <label>Invoice no.<input name="invoiceNo" value="${esc(m.invoiceNo)}"></label>
      <label class="wide">Notes<textarea name="notes">${esc(m.notes)}</textarea></label>
      <div class="row wide"><button class="primary">Save details</button><button type="button" id="del-matter" class="danger">Delete matter</button></div>
    </form>

    <h3>Memo versions</h3>
    <div class="row"><label class="filebtn primary">Upload new version<input type="file" id="up-memo" accept=".docx,.doc,.pdf"></label></div>
    <table class="grid">${memos.length ? `<tr><th>Version</th><th>File</th><th>Uploaded</th><th>Note</th><th></th></tr>` +
      memos.map((f, i) => `<tr><td><b>v${f.version}</b></td><td>${esc(f.name)}</td><td>${fmtDate(f.added)}</td><td>${esc(f.note)}</td>
        <td class="row" style="margin:0">
          <button data-dl="${f.id}">Download</button>
          ${f.name.endsWith('.docx') ? `<button data-check="${f.id}">Check citations</button>` : ''}
          ${memos[i + 1] && f.name.endsWith('.docx') && memos[i + 1].name.endsWith('.docx') ? `<button data-diff="${f.id}" data-prev="${memos[i + 1].id}">Compare with v${memos[i + 1].version}</button>` : ''}
          <button data-rm="${f.id}" class="danger">✕</button></td></tr>`).join('')
      : '<tr><td class="muted">No versions yet.</td></tr>'}</table>

    ${Object.entries(FILE_CATS).map(([cat, label]) => {
      const list = files.filter((f) => f.category === cat);
      return `<h3>${label}</h3>
      <div class="row"><label class="filebtn">Add files<input type="file" data-up="${cat}" multiple></label></div>
      ${list.length ? `<table class="grid">${list.map((f) => `<tr><td>${esc(f.name)}</td><td class="muted">${kb(f.size)} · ${fmtDate(f.added)}</td>
        <td>${cat === 'original' ? (redactedOf.has(f.id) ? '<span class="badge b-ok">Redacted copy saved</span>'
          : f.noRedaction ? '<span class="badge b-muted">No redaction needed</span>'
          : `<span class="badge b-warn">Needs redaction</span> <button data-nored="${f.id}">Not needed</button>`) : ''}
          ${cat === 'redacted' ? (byId[f.redactedOf] ? `<span class="muted">of ${esc(byId[f.redactedOf].name)}</span>` : '') : ''}</td>
        <td class="row" style="margin:0"><button data-dl="${f.id}">Download</button><button data-rm="${f.id}" class="danger">✕</button></td></tr>`).join('')}</table>` : ''}`;
    }).join('')}

    <h3>Tasks</h3>
    <ul class="list tasks">${(m.tasks || []).map((t, i) => `<li class="${t.done ? 'done' : ''}"><input type="checkbox" data-task="${i}" ${t.done ? 'checked' : ''}>
      <span>${esc(t.text)}</span><button data-rmtask="${i}" class="danger">✕</button></li>`).join('')}</ul>
    <form id="task-form" class="row"><input name="text" placeholder="Add a task (e.g. confirm pinpoints, send to client)" style="flex:1"><button>Add</button></form>

    <h3>Payments</h3>
    <table class="grid">${(m.payments || []).length ? `<tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr>` +
      m.payments.map((p, i) => `<tr><td>${fmtDate(p.date)}</td><td>${money(p.amount)}</td><td>${esc(p.note)}</td><td><button data-rmpay="${i}" class="danger">✕</button></td></tr>`).join('') +
      `<tr><th>Received</th><th>${money(paidOf(m))}</th><th colspan="2">Balance ${money(Math.max(0, (+m.fee || 0) - paidOf(m)))}</th></tr>`
      : '<tr><td class="muted">No payments recorded.</td></tr>'}</table>
    <div class="row" style="margin-top:8px"><button id="add-pay">Record a payment</button></div>`;

  const save = async (changes) => { Object.assign(m, changes, { updated: new Date().toISOString() }); await put('matters', m); await renderMatterList(); openMatter(id); };

  $('#matter-form', el).onsubmit = (e) => { e.preventDefault(); save(Object.fromEntries(new FormData(e.target))); };
  $('#del-matter', el).onclick = async () => {
    if (!confirm(`Delete "${m.title}" and all ${files.length} of its files? This cannot be undone.`)) return;
    for (const f of files) await del('files', f.id);
    await del('matters', id);
    currentMatter = null;
    el.innerHTML = '<p class="muted">Matter deleted.</p>';
    renderMatterList();
  };
  $('#task-form', el).onsubmit = (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (text) save({ tasks: [...(m.tasks || []), { text, done: false }] });
  };
  el.querySelectorAll('[data-task]').forEach((cb) => (cb.onchange = () => { m.tasks[cb.dataset.task].done = cb.checked; save({}); }));
  el.querySelectorAll('[data-rmtask]').forEach((b) => (b.onclick = () => { m.tasks.splice(b.dataset.rmtask, 1); save({}); }));
  el.querySelectorAll('[data-rmpay]').forEach((b) => (b.onclick = () => { m.payments.splice(b.dataset.rmpay, 1); save({}); }));
  $('#add-pay', el).onclick = async () => {
    const owing = Math.max(0, (+m.fee || 0) - paidOf(m));
    const r = await ask('Record a payment', `<label>Date<input type="date" name="date" value="${today()}" required></label>
      <label>Amount (CAD)<input type="number" step="0.01" min="0" name="amount" value="${owing || ''}" required></label>
      <label class="wide">Note<input name="note" placeholder="e-transfer, cheque no., invoice…"></label>`);
    if (r) save({ payments: [...(m.payments || []), r] });
  };

  $('#up-memo', el).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const version = (memos[0]?.version || 0) + 1;
    const r = await ask(`Save as v${version}`, `<label class="wide">What changed in this version?<input name="note" placeholder="e.g. draft for review, final sent to client"></label>`);
    if (!r) return;
    await put('files', { id: uid(), matterId: id, category: 'memo', version, note: r.note, name: file.name, type: file.type, size: file.size, blob: file, added: today() });
    openMatter(id);
  };
  el.querySelectorAll('[data-up]').forEach((inp) => (inp.onchange = async () => {
    const cat = inp.dataset.up;
    const originals = files.filter((f) => f.category === 'original');
    for (const file of inp.files) {
      let redactedOfId = null;
      if (cat === 'redacted' && originals.length) {
        const r = await ask(`Which original is "${file.name}" a redacted copy of?`, `<label class="wide">Original<select name="of">
          <option value="">(not linked)</option>${originals.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label>`);
        if (!r) continue;
        redactedOfId = r.of || null;
      }
      await put('files', { id: uid(), matterId: id, category: cat, name: file.name, type: file.type, size: file.size, blob: file, added: today(), redactedOf: redactedOfId });
    }
    openMatter(id);
  }));
  el.querySelectorAll('[data-nored]').forEach((b) => (b.onclick = async () => { const f = byId[b.dataset.nored]; f.noRedaction = true; await put('files', f); openMatter(id); }));
  el.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => { const f = byId[b.dataset.dl]; download(f.blob, f.name); }));
  el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!confirm(`Delete ${byId[b.dataset.rm].name}?`)) return;
    await del('files', b.dataset.rm);
    openMatter(id);
  }));
  el.querySelectorAll('[data-check]').forEach((b) => (b.onclick = () => { show('checker'); checkMemo(byId[b.dataset.check].blob, byId[b.dataset.check].name); }));
  el.querySelectorAll('[data-diff]').forEach((b) => (b.onclick = () => compareVersions(byId[b.dataset.prev], byId[b.dataset.diff])));
}

// Paragraph-level comparison of two .docx memo versions.
async function compareVersions(older, newer) {
  const text = async (f) => (await mammoth.extractRawText({ arrayBuffer: await f.blob.arrayBuffer() })).value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const [a, b] = await Promise.all([text(older), text(newer)]);
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0, changes = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`<div class="same">${esc(a[i])}</div>`); i++; j++; }
    else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) { out.push(`<ins>${esc(b[j++])}</ins>`); changes++; }
    else { out.push(`<del>${esc(a[i++])}</del>`); changes++; }
  }
  showDialog(`<h2>v${older.version} → v${newer.version}</h2><p class="muted">${changes} paragraph${changes === 1 ? '' : 's'} changed.
    Green = added in v${newer.version}, red = removed.</p><div class="diff">${out.join('')}</div>`);
}

// ---------- case library ----------
async function libraryMap() {
  return Object.fromEntries((await all('cases')).map((c) => [c.key, c]));
}

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  if (name.endsWith('.pdf')) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : '');
      text += '\n';
    }
    return text;
  }
  return file.text();
}

async function addCase(text, source, defaults = {}) {
  const paras = Citations.splitParagraphs(text);
  const r = await ask('Add decision to library', `
    <label>Neutral citation<input name="citation" value="${esc(defaults.citation || Citations.detectOwnCitation(text))}" placeholder="2019 SCC 65" required></label>
    <label>Case name<input name="name" value="${esc(defaults.name || source.replace(/\.[^.]+$/, ''))}" placeholder="Canada (MCI) v Vavilov"></label>
    <p class="wide ${Object.keys(paras).length ? 'muted' : 'danger'}">${Object.keys(paras).length} numbered paragraphs found in ${esc(source)}.
    ${Object.keys(paras).length ? '' : 'Pinpoints cannot be checked against this decision. Paragraph numbers should look like “[12]” or “12.” at the start of a line.'}</p>`, 'Add');
  if (!r) return;
  const m = r.citation.trim().match(/^((?:19|20)\d{2})\s+(.+)$/);
  if (!m) return alert('That does not look like a neutral citation (e.g. 2019 SCC 65).');
  const key = Citations.normalizeKey(m[1], m[2]);
  const existing = (await all('cases')).find((c) => c.key === key);
  await put('cases', { id: existing?.id || uid(), key, citation: r.citation.trim(), name: r.name.trim(), text, paras, source, added: today() });
}

$('#case-files').onchange = async (e) => {
  for (const file of e.target.files) {
    try { await addCase(await extractText(file), file.name); }
    catch (err) { alert(`Could not read ${file.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderLibrary();
};
$('#paste-case').onclick = async () => {
  const r = await ask('Paste a decision', `<label class="wide">Full text of the decision (with paragraph numbers)<textarea name="text" style="min-height:260px" required></textarea></label>`, 'Next');
  if (r) { await addCase(r.text, 'pasted text'); renderLibrary(); }
};
$('#export-library').onclick = async () => {
  const cases = (await all('cases')).map(({ key, citation, name, paras }) => ({ key, citation, name, paras }));
  download(new Blob([JSON.stringify({ format: 'memo-tracker-library', version: 1, cases })], { type: 'application/json' }), 'case-library.json');
};

async function renderLibrary() {
  const cases = (await all('cases')).sort((a, b) => a.key.localeCompare(b.key));
  $('#case-table').innerHTML = `<tr><th>Citation</th><th>Case</th><th>Paragraphs</th><th>Source</th><th></th></tr>` +
    (cases.length ? cases.map((c) => `<tr><td><b>${esc(c.citation)}</b></td><td>${esc(c.name)}</td>
      <td>${Object.keys(c.paras).length || '<span class="badge b-bad">none found</span>'}</td><td class="muted">${esc(c.source)}</td>
      <td class="row" style="margin:0"><button data-view-case="${c.id}">View</button><button data-rm-case="${c.id}" class="danger">✕</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">No decisions yet. Add the cases your memos cite.</td></tr>');
  document.querySelectorAll('[data-rm-case]').forEach((b) => (b.onclick = async () => { if (confirm('Remove this decision?')) { await del('cases', b.dataset.rmCase); renderLibrary(); } }));
  document.querySelectorAll('[data-view-case]').forEach((b) => (b.onclick = () => {
    const c = cases.find((x) => x.id === b.dataset.viewCase);
    showDialog(`<h2>${esc(c.name)}, ${esc(c.citation)}</h2><div class="diff">${Object.entries(c.paras).map(([n, t]) => `<p><span class="pn">[${n}]</span> ${esc(t)}</p>`).join('')}</div>`);
  }));
}

// ---------- citation checker ----------
async function renderCheckerPicker() {
  const [matters, files] = await Promise.all([all('matters'), all('files')]);
  const titles = Object.fromEntries(matters.map((m) => [m.id, m.title]));
  const memos = files.filter((f) => f.category === 'memo' && f.name.endsWith('.docx')).sort((a, b) => (a.added < b.added ? 1 : -1));
  $('#checker-version').innerHTML = '<option value="">…or pick a saved memo version</option>' +
    memos.map((f) => `<option value="${f.id}">${esc(titles[f.matterId] || '?')} · v${f.version} · ${esc(f.name)}</option>`).join('');
  $('#checker-version').onchange = async (e) => { const f = memos.find((x) => x.id === e.target.value); if (f) checkMemo(f.blob, f.name); };
}
$('#checker-file').onchange = (e) => { const f = e.target.files[0]; if (f) checkMemo(f, f.name); e.target.value = ''; };

let checkResults = [];
async function checkMemo(blob, name) {
  const docEl = $('#checker-doc');
  docEl.innerHTML = '<p class="muted">Reading…</p>';
  const [{ value: html }, library] = await Promise.all([mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() }), libraryMap()]);
  docEl.innerHTML = html;
  docEl.querySelectorAll('a[href]').forEach((a) => { if (!/^https?:|^#/i.test(a.getAttribute('href'))) a.removeAttribute('href'); });

  // Join every text node (with a separator no citation can span) so "Ibid" can look back across paragraphs.
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = '';
  while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: full.length }); full += walker.currentNode.data + '\u0000'; }
  const hits = Citations.findCitations(full);
  checkResults = hits.map((h, i) => ({ ...h, n: i, result: Citations.check(h, library) }));

  for (const h of [...checkResults].reverse()) {
    const owner = nodes.findLast((x) => x.start <= h.index);
    const offset = h.index - owner.start;
    if (offset + h.text.length > owner.node.data.length) continue;
    const range = document.createRange();
    range.setStart(owner.node, offset);
    range.setEnd(owner.node, offset + h.text.length);
    const span = document.createElement('span');
    span.className = 'cite ' + h.result.status;
    span.dataset.n = h.n;
    range.surroundContents(span);
  }
  renderReport(name);
}

function renderReport(name) {
  const counts = {};
  for (const r of checkResults) counts[r.result.status] = (counts[r.result.status] || 0) + 1;
  const missing = [...new Set(checkResults.filter((r) => r.result.status === 'missing').map((r) => r.key))];
  const cls = { ok: 'b-ok', 'no-pinpoint': 'b-warn', 'bad-pinpoint': 'b-warn', missing: 'b-bad' };
  $('#checker-report').innerHTML = `<h2 style="margin-top:0">${esc(name)}</h2>
    <p>${checkResults.length} citation${checkResults.length === 1 ? '' : 's'} found.</p>
    <div class="row">${Object.entries(Citations.STATUS_LABEL).map(([s, l]) => counts[s] ? `<span class="badge ${cls[s]}">${counts[s]} · ${l}</span>` : '').join('')}</div>
    ${missing.length ? `<h3>Not in your library</h3><p class="muted">Add these decisions to check their pinpoints:</p><ul>${missing.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
    <h3>All citations</h3>
    <ul class="list">${checkResults.map((r) => `<li data-goto="${r.n}"><span class="badge ${cls[r.result.status]}">${esc(Citations.STATUS_LABEL[r.result.status])}</span>
      <div>${esc(r.text)}${r.ibid ? ` <span class="muted">→ ${esc(r.key)}</span>` : ''}</div></li>`).join('')}</ul>
    <p class="muted" style="font-size:12px">Short forms like “Vavilov at para 99” are not detected yet; check those by hand.</p>`;
  document.querySelectorAll('[data-goto]').forEach((li) => (li.onclick = () => {
    const span = $(`.cite[data-n="${li.dataset.goto}"]`);
    if (!span) return;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    span.classList.add('flash');
    setTimeout(() => span.classList.remove('flash'), 1500);
  }));
}

// Hover popover showing the cited paragraph(s).
const pop = $('#popover');
let hideTimer;
document.addEventListener('mouseover', (e) => {
  const span = e.target.closest('.cite');
  if (e.target.closest('#popover')) return clearTimeout(hideTimer);
  if (!span) { hideTimer = setTimeout(() => pop.classList.add('hidden'), 250); return; }
  clearTimeout(hideTimer);
  const r = checkResults[span.dataset.n];
  const c = r.result.case;
  let body;
  if (r.result.status === 'missing') body = `<p><b>${esc(r.key)}</b> is not in your case library, so this citation can't be checked. Add the decision under Case library.</p>`;
  else if (r.result.status === 'no-pinpoint') body = `<p>No paragraph pinpoint in this citation. The decision has ${Object.keys(c.paras).length} numbered paragraphs.</p>`;
  else if (r.result.status === 'bad-pinpoint') body = `<p>Paragraph ${r.from}${r.to !== r.from ? '–' + r.to : ''} does not exist in this decision (it has ${Object.keys(c.paras).length} numbered paragraphs). Check the pinpoint.</p>`;
  else body = r.result.paras.map((p) => `<p><span class="pn">[${p.n}]</span>${esc(p.text)}</p>`).join('') +
    (r.to - r.from > 9 ? '<p class="muted">Showing the first 10 paragraphs of the range.</p>' : '');
  pop.innerHTML = `<div class="src">${c ? `<b>${esc(c.name)}</b>, ${esc(c.citation)}` : esc(r.text)}${r.ibid ? ' (ibid)' : ''}</div>${body}`;
  pop.classList.remove('hidden');
  const rect = span.getBoundingClientRect();
  const top = rect.bottom + 8 + pop.offsetHeight > innerHeight ? Math.max(8, rect.top - pop.offsetHeight - 8) : rect.bottom + 8;
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - pop.offsetWidth - 8)) + 'px';
});

// ---------- backup ----------
const toDataURL = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
$('#export-all').onclick = async () => {
  const [matters, files, cases] = await Promise.all([all('matters'), all('files'), all('cases')]);
  const packed = await Promise.all(files.map(async (f) => ({ ...f, blob: await toDataURL(f.blob) })));
  download(new Blob([JSON.stringify({ format: 'memo-tracker-backup', version: 1, exported: new Date().toISOString(), matters, files: packed, cases })]), `memo-tracker-backup-${today()}.json`);
};
$('#import-all').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  if (data.format !== 'memo-tracker-backup') return alert('That is not a Memo Tracker backup.');
  if (!confirm(`Restore ${data.matters.length} matters, ${data.files.length} files and ${data.cases.length} decisions? Records with the same ID are overwritten.`)) return;
  for (const m of data.matters) await put('matters', m);
  for (const f of data.files) await put('files', { ...f, blob: await (await fetch(f.blob)).blob() });
  for (const c of data.cases) await put('cases', c);
  alert('Restored.');
  e.target.value = '';
  show('dashboard');
};

show('dashboard');
