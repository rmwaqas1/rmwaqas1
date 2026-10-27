// Word task pane: shows the paragraph a citation points to when the cursor is on it.
// Word does not tell add-ins where the mouse is, so the trigger is the cursor/selection
// (click on a citation) rather than a true hover. The tracker's own checker has real hover.
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CLS = { ok: 'b-ok', 'no-pinpoint': 'b-warn', 'bad-pinpoint': 'b-warn', missing: 'b-bad' };

let library = {};
try { library = JSON.parse(localStorage.getItem('memo-tracker-library') || '{}'); } catch { library = {}; }
showLibraryStatus();

function showLibraryStatus() {
  const n = Object.keys(library).length;
  $('#lib-status').textContent = n
    ? `${n} decision${n === 1 ? '' : 's'} in your library. Export it again from Memo Tracker after adding cases.`
    : 'No case library loaded. In Memo Tracker, open Case library → “Export library for Word add-in”, then load the file here.';
}

$('#lib-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'memo-tracker-library') throw new Error('not a Memo Tracker library export');
    library = Object.fromEntries(data.cases.map((c) => [c.key, c]));
    localStorage.setItem('memo-tracker-library', JSON.stringify(library));
  } catch (err) {
    alert('Could not load that file: ' + err.message);
  }
  e.target.value = '';
  showLibraryStatus();
};

function renderResult(hit) {
  const r = Citations.check(hit, library);
  const c = r.case;
  let body;
  if (r.status === 'missing') body = `<p><b>${esc(hit.key)}</b> is not in your case library, so this citation can't be checked.</p>`;
  else if (r.status === 'no-pinpoint') body = `<p>No paragraph pinpoint. The decision has ${Object.keys(c.paras).length} numbered paragraphs.</p>`;
  else if (r.status === 'bad-pinpoint') body = `<p>Paragraph ${hit.from}${hit.to !== hit.from ? '–' + hit.to : ''} does not exist in this decision (it has ${Object.keys(c.paras).length}). Check the pinpoint.</p>`;
  else body = r.paras.map((p) => `<p><span class="pn">[${p.n}]</span>${esc(p.text)}</p>`).join('');
  $('#current').innerHTML = `<div class="src"><span class="badge ${CLS[r.status]}">${esc(Citations.STATUS_LABEL[r.status])}</span>
    ${c ? `<b>${esc(c.name)}</b>, ${esc(c.citation)}` : esc(hit.text)}${hit.ibid ? ' (ibid)' : ''}</div>${body}`;
}

// Cursor moved: find the citation under (or nearest to) the cursor in the current paragraph.
let pending;
async function onSelectionChanged() {
  clearTimeout(pending);
  pending = setTimeout(() => Word.run(async (ctx) => {
    const sel = ctx.document.getSelection();
    const para = sel.paragraphs.getFirst();
    const before = para.getRange('Start').expandTo(sel.getRange('Start'));
    const docBefore = ctx.document.body.getRange('Start').expandTo(para.getRange('Start'));
    para.load('text');
    before.load('text');
    docBefore.load('text');
    await ctx.sync();

    // Prefix the earlier text so "Ibid" resolves to the last full citation before this paragraph.
    const prefix = docBefore.text + '\u0000';
    const hits = Citations.findCitations(prefix + para.text).filter((h) => h.index >= prefix.length);
    if (!hits.length) return;
    const cursor = prefix.length + before.text.length;
    const under = hits.find((h) => cursor >= h.index && cursor <= h.index + h.text.length);
    const nearest = under || hits.reduce((a, b) => (Math.abs(b.index - cursor) < Math.abs(a.index - cursor) ? b : a));
    renderResult(nearest);
  }).catch((err) => console.error(err)), 150);
}

// Scan the whole document and list every citation with its status.
$('#scan').onclick = () => Word.run(async (ctx) => {
  const body = ctx.document.body;
  body.load('text');
  await ctx.sync();
  const hits = Citations.findCitations(body.text);
  const counts = {};
  const rows = hits.map((h, i) => {
    const status = Citations.check(h, library).status;
    counts[status] = (counts[status] || 0) + 1;
    // Which occurrence of this exact text is it, so a click can select the right one.
    const occurrence = hits.slice(0, i).filter((x) => x.text === h.text).length;
    return { h, status, occurrence };
  });
  $('#summary').innerHTML = `<p>${hits.length} citation${hits.length === 1 ? '' : 's'}.</p><div class="row">` +
    Object.entries(counts).map(([s, n]) => `<span class="badge ${CLS[s]}">${n} · ${esc(Citations.STATUS_LABEL[s])}</span>`).join('') + '</div>';
  $('#hits').innerHTML = rows.map((r, i) => `<li data-i="${i}"><span class="badge ${CLS[r.status]}">${esc(Citations.STATUS_LABEL[r.status])}</span>
    <div>${esc(r.h.text)}${r.h.ibid ? ` <span class="muted">→ ${esc(r.h.key)}</span>` : ''}</div></li>`).join('');
  document.querySelectorAll('#hits li').forEach((li) => (li.onclick = () => Word.run(async (ctx2) => {
    const r = rows[li.dataset.i];
    renderResult(r.h);
    const found = ctx2.document.body.search(r.h.text.slice(0, 255), { matchCase: true });
    found.load('items');
    await ctx2.sync();
    found.items[r.occurrence]?.select();
    await ctx2.sync();
  })));
}).catch((err) => alert('Scan failed: ' + err.message));

Office.onReady((info) => {
  if (info.host !== Office.HostType.Word) return;
  Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, onSelectionChanged);
});
