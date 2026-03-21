// ─────────── State ───────────
let csvHeaders = [];
let csvData = [];       // array of arrays (rows × cols)
let mapping = {
  original: null,
  originalEditable: false,
  idColIndex: null,
  langs: []
};
let rowsPerPage = 1;
let currentRow = 0;
let isModified = false;
let originalFileName = 'translations.csv';
let lastFocusedCellId = null;
let fileHandle = null;
let autoSave = false;
let searchQuery = '';       // current search string
let filteredIndices = null; // null = all rows; array = filtered subset

// ─────────── CSV Parsing ───────────
// RFC-4180 compliant parser that handles multi-line quoted fields
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === ',') { row.push(field); field = ''; i++; }
      else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i += 2;
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i++;
      } else { field += ch; i++; }
    }
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ─────────── CSV Serialization ───────────
function serializeCSV(headers, data) {
  const escapeField = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const rows = [headers, ...data];
  return rows.map(r => r.map(escapeField).join(',')).join('\r\n');
}

// ─────────── Search / Filter ───────────
function getEffectiveTotal() {
  return filteredIndices ? filteredIndices.length : csvData.length;
}

function getDataIndex(visIdx) {
  return filteredIndices ? filteredIndices[visIdx] : visIdx;
}

function onSearchInput(value) {
  searchQuery = value;
  filteredIndices = null;
  currentRow = 0;

  const q = searchQuery.toLowerCase().trim();
  if (q) {
    const cols = [mapping.original, ...mapping.langs.map(l => l.colIndex)];
    filteredIndices = csvData.reduce((acc, row, i) => {
      if (cols.some(ci => (row[ci] || '').toLowerCase().includes(q))) acc.push(i);
      return acc;
    }, []);
  }

  renderRow();
  updateNav();
  updateSearchBadge();
}

function updateSearchBadge() {
  const badge = document.getElementById('search-badge');
  if (!badge) return;
  if (filteredIndices) {
    badge.textContent = filteredIndices.length + ' / ' + csvData.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function clearSearch() {
  const inp = document.getElementById('search-input');
  if (inp) inp.value = '';
  onSearchInput('');
}

// ─────────── File Input ───────────

// Open via File System Access API (gives write handle for auto-save).
// Falls back to the hidden <input type="file"> if FSA not supported.
async function openFilePicker() {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }],
        multiple: false
      });
      fileHandle = handle;
      const file = await handle.getFile();
      loadFile(file);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled
      // FSA failed unexpectedly — fall through to regular picker
    }
  }
  fileHandle = null;
  document.getElementById('file-input').click();
}

document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) { fileHandle = null; loadFile(file); }
  e.target.value = '';
});

const dropZone = document.getElementById('drop-zone');
['dragenter', 'dragover'].forEach(ev => {
  dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
});
['dragleave', 'drop'].forEach(ev => {
  dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
});
dropZone.addEventListener('drop', async e => {
  const item = e.dataTransfer.items?.[0];
  // Try FSA handle for write access (Chrome 86+)
  if (item?.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle?.kind === 'file') {
        fileHandle = handle;
        const file = await handle.getFile();
        loadFile(file);
        return;
      }
    } catch (_) { /* fall through */ }
  }
  fileHandle = null;
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  originalFileName = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const parsed = parseCSV(text);
    if (parsed.length < 2) { showToast('CSV file appears to be empty.', 'error'); return; }

    csvHeaders = parsed[0];
    csvData = parsed.slice(1).filter(r => r.length > 0 && r.some(c => c.trim() !== ''));
    currentRow = 0;
    isModified = false;

    autoDetectMapping();
    buildMappingModal();
    openModal(true);
  };
  reader.readAsText(file, 'UTF-8');
}

function autoDetectMapping() {
  const known = {
    original: ['text', 'source', 'original', 'en', 'english'],
  };

  mapping.original = null;
  mapping.originalEditable = false;
  mapping.idColIndex = null;
  mapping.langs = [];

  const lower = csvHeaders.map(h => h.toLowerCase().trim());

  for (let i = 0; i < lower.length; i++) {
    if (known.original.some(k => lower[i] === k || lower[i].startsWith(k + ' '))) {
      mapping.original = i;
      break;
    }
  }
  if (mapping.original === null) mapping.original = 0;

  // Auto-detect ID column: first column named code/id/key/num/number
  const idKeys = ['code', 'id', 'key', 'num', 'number', 'index', '#'];
  for (let i = 0; i < lower.length; i++) {
    if (idKeys.some(k => lower[i] === k || lower[i].startsWith(k))) {
      mapping.idColIndex = i;
      break;
    }
  }

  const langPatterns = [
    { name: 'Русский (RU)', keys: ['text ru', 'rus', ' ru'] },
    { name: 'Українська (UK)', keys: ['text uk', 'ukr', ' uk'] },
  ];

  for (const lp of langPatterns) {
    for (let i = 0; i < lower.length; i++) {
      if (lp.keys.some(k => lower[i].includes(k))) {
        if (i !== mapping.original && !mapping.langs.find(l => l.colIndex === i)) {
          mapping.langs.push({ name: lp.name, colIndex: i });
          break;
        }
      }
    }
  }

  if (mapping.langs.length === 0) {
    const fallback = mapping.original === 0 ? 1 : 0;
    mapping.langs.push({ name: 'Language 1', colIndex: fallback });
  }
}

// ─────────── Mapping Modal ───────────
function buildMappingModal() {
  const container = document.getElementById('mapping-rows');
  container.innerHTML = '';

  // Original source row
  const origRow = document.createElement('div');
  origRow.className = 'original-row';
  origRow.innerHTML = `
    <div class="original-label">
      <span class="role-dot role-original"></span>
      Original (source)
    </div>
    <select class="col-select" id="orig-select">
      ${csvHeaders.map((h, i) => `<option value="${i}" ${i === mapping.original ? 'selected' : ''}>${h || '(column ' + (i+1) + ')'}</option>`).join('')}
    </select>
    <label class="toggle-wrap" title="Allow editing the original column">
      <input type="checkbox" id="orig-editable-chk" ${mapping.originalEditable ? 'checked' : ''} />
      <span class="toggle"></span>
      Editable
    </label>`;
  container.appendChild(origRow);

  const hr = document.createElement('hr');
  hr.className = 'modal-divider';
  container.appendChild(hr);

  const titleEl = document.createElement('div');
  titleEl.className = 'mapping-section-title';
  titleEl.textContent = 'Translation languages';
  container.appendChild(titleEl);

  const langsWrap = document.createElement('div');
  langsWrap.className = 'lang-rows-wrap';
  langsWrap.id = 'langs-wrap';
  container.appendChild(langsWrap);

  mapping.langs.forEach((lang, idx) => addLangRowEl(langsWrap, idx, lang));

  const addBtn = document.createElement('button');
  addBtn.className = 'add-lang-btn';
  addBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    Add language column`;
  addBtn.addEventListener('click', addLangRow);
  container.appendChild(addBtn);

  // ── Rows per view ──
  const hr2 = document.createElement('hr');
  hr2.className = 'modal-divider';
  container.appendChild(hr2);

  const viewSection = document.createElement('div');
  viewSection.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px';
  viewSection.innerHTML = `
    <div>
      <div class="mapping-section-title" style="margin-bottom:2px">Rows per view</div>
      <div style="font-size:0.78rem;color:var(--text-dim)">Show multiple rows side-by-side for context</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <input type="number" id="rows-per-page-input" min="1" max="${csvData.length}" value="${rowsPerPage}"
        style="width:72px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
               color:var(--text);font-family:inherit;font-size:0.9rem;padding:7px 10px;text-align:center;
               outline:none;transition:border-color var(--transition);"
        onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'" />
      <button class="btn btn-ghost btn-sm" style="white-space:nowrap"
        onclick="document.getElementById('rows-per-page-input').value=${csvData.length}"
        title="Show all rows at once">All ${csvData.length}</button>
    </div>`;
  container.appendChild(viewSection);

  // ── ID column ──
  const hr3 = document.createElement('hr');
  hr3.className = 'modal-divider';
  container.appendChild(hr3);

  const idSection = document.createElement('div');
  idSection.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px';
  idSection.innerHTML = `
    <div>
      <div class="mapping-section-title" style="margin-bottom:2px">ID Column</div>
      <div style="font-size:0.78rem;color:var(--text-dim)">Shown next to row number</div>
    </div>
    <select class="col-select" id="id-col-select" style="width:190px">
      <option value="">— None —</option>
      ${csvHeaders.map((h, i) => `<option value="${i}" ${i === mapping.idColIndex ? 'selected' : ''}>${h || '(column ' + (i+1) + ')'}</option>`).join('')}
    </select>`;
  container.appendChild(idSection);
}

function addLangRowEl(container, idx, lang) {
  const div = document.createElement('div');
  div.className = 'lang-row-item';
  div.dataset.langIdx = idx;
  div.innerHTML = `
    <input class="lang-name-input" placeholder="Language name" value="${lang.name}" />
    <select class="col-select lang-col-select">
      ${csvHeaders.map((h, i) => `<option value="${i}" ${i === lang.colIndex ? 'selected' : ''}>${h || '(column ' + (i+1) + ')'}</option>`).join('')}
    </select>
    <button class="remove-lang-btn" title="Remove">✕</button>`;
  div.querySelector('.remove-lang-btn').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

function addLangRow() {
  const langsWrap = document.getElementById('langs-wrap');
  const usedIndices = new Set([mapping.original]);
  langsWrap.querySelectorAll('[data-lang-idx]').forEach(el => {
    usedIndices.add(parseInt(el.querySelector('.lang-col-select').value));
  });
  let nextCol = 0;
  while (usedIndices.has(nextCol) && nextCol < csvHeaders.length - 1) nextCol++;

  const idx = langsWrap.querySelectorAll('[data-lang-idx]').length;
  addLangRowEl(langsWrap, idx, { name: 'Language ' + (idx + 1), colIndex: nextCol });
}

function applyMapping() {
  const origIdx = parseInt(document.getElementById('orig-select').value);
  const origEditable = document.getElementById('orig-editable-chk').checked;
  const langEls = document.querySelectorAll('#langs-wrap [data-lang-idx]');
  const rpp = parseInt(document.getElementById('rows-per-page-input').value) || 1;

  const newLangs = [];
  langEls.forEach(el => {
    const name = el.querySelector('.lang-name-input').value.trim() || 'Language';
    const colIndex = parseInt(el.querySelector('.lang-col-select').value);
    newLangs.push({ name, colIndex });
  });

  if (newLangs.length === 0) { showToast('Add at least one language column.', 'error'); return; }

  mapping.original = origIdx;
  mapping.originalEditable = origEditable;
  mapping.langs = newLangs;
  rowsPerPage = Math.max(1, rpp);

  const idColVal = document.getElementById('id-col-select').value;
  mapping.idColIndex = idColVal !== '' ? parseInt(idColVal) : null;

  closeModal();
  showEditorScreen();
}

let isFirstLoad = true;
function openModal(firstLoad = false) {
  isFirstLoad = firstLoad;
  if (!firstLoad) buildMappingModal();
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

// ─────────── Editor Screen ───────────
function showEditorScreen() {
  document.getElementById('upload-screen').style.display = 'none';
  const ed = document.getElementById('editor-screen');
  ed.style.display = 'flex';
  ed.classList.add('visible');
  document.getElementById('header-actions').style.display = 'flex';
  document.getElementById('tools-bar').style.display = 'flex';
  document.getElementById('search-wrap').style.display = 'flex';

  // Clear any previous search state
  searchQuery = '';
  filteredIndices = null;
  const si = document.getElementById('search-input');
  if (si) si.value = '';

  updateColLabels();
  renderRow();
  updateNav();
}

function updateColLabels() {
  const strip = document.getElementById('col-labels-strip');
  strip.innerHTML = '';

  const makeLabel = (text, isOrig, color) => {
    const el = document.createElement('span');
    el.className = 'col-label' + (isOrig ? ' is-original' : '');
    el.innerHTML = `<span class="dot" style="background:${color}"></span> ${text}`;
    strip.appendChild(el);
  };

  const origLabel = (csvHeaders[mapping.original] || 'col ' + mapping.original) +
    (mapping.originalEditable ? ' ✎' : '');
  makeLabel('Original — ' + origLabel, true, 'var(--accent)');

  mapping.langs.forEach((l, i) => {
    const colors = ['#34d399', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa'];
    makeLabel(l.name + ' — ' + (csvHeaders[l.colIndex] || 'col ' + l.colIndex), false, colors[i % colors.length]);
  });
}

// Sync all visible cell DOMs back to csvData (no side-effects)
function syncDOMToData() {
  if (csvData.length === 0) return;
  const visible = Math.min(rowsPerPage, getEffectiveTotal() - currentRow);

  for (let offset = 0; offset < visible; offset++) {
    const row = csvData[getDataIndex(currentRow + offset)];

    if (mapping.originalEditable) {
      const el = document.getElementById(`cell-${offset}-original`);
      if (el) row[mapping.original] = el.innerText;
    }

    mapping.langs.forEach((lang, i) => {
      const el = document.getElementById(`cell-${offset}-lang-${i}`);
      if (el) row[lang.colIndex] = el.innerText;
    });
  }
}

// Flush + conditionally auto-save (called on row navigation)
function flushCurrentRow() {
  syncDOMToData();

  if (autoSave && fileHandle && isModified) {
    triggerAutoSave();
  }
}

function renderRow() {
  const effectiveTotal = getEffectiveTotal();

  const area = document.getElementById('cells-area');

  if (csvData.length === 0) return;

  if (effectiveTotal === 0) {
    area.innerHTML = '<div class="no-results">No rows match the search</div>';
    document.getElementById('progress-bar').style.width = '0';
    document.getElementById('row-num').textContent = '0';
    document.getElementById('row-total').textContent = '0';
    return;
  }

  const visible = Math.min(rowsPerPage, effectiveTotal - currentRow);

  document.getElementById('progress-bar').style.width = ((currentRow + 1) / effectiveTotal * 100) + '%';
  document.getElementById('row-num').textContent = currentRow + 1;
  document.getElementById('row-total').textContent = effectiveTotal;
  document.getElementById('jump-input').value = currentRow + 1;

  // ID value in toolbar shows the first visible actual row's ID column
  const firstDataIdx = getDataIndex(currentRow);
  const firstRow = csvData[firstDataIdx];
  const idVal = (mapping.idColIndex !== null && firstRow) ? (firstRow[mapping.idColIndex] || '') : '';
  const idLabelEl = document.getElementById('row-id-val');
  if (idLabelEl) { idLabelEl.textContent = idVal; idLabelEl.style.display = idVal ? '' : 'none'; }

  area.innerHTML = '';

  const cols = 1 + mapping.langs.length;
  const langColors = ['#34d399', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa'];
  const isEditable = mapping.originalEditable;

  // Column headers — show once at the top when more than 1 row
  if (rowsPerPage > 1) {
    const headRow = document.createElement('div');
    headRow.className = 'cell-row col-header-row';
    headRow.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    // Original header
    const badgeClass = isEditable ? 'badge-original-editable' : 'badge-original';
    const badgeText = isEditable ? 'source · editable' : 'source · read-only';
    const hOrig = document.createElement('div');
    hOrig.className = 'cell-col-header';
    hOrig.innerHTML = `<span style="color:var(--accent2)">${csvHeaders[mapping.original] || 'Original'}</span>
      <span class="badge ${badgeClass}">${badgeText}</span>`;
    headRow.appendChild(hOrig);

    mapping.langs.forEach((lang, i) => {
      const color = langColors[i % langColors.length];
      const h = document.createElement('div');
      h.className = 'cell-col-header';
      h.innerHTML = `<span style="color:${color}">${lang.name}</span>
        <span class="badge badge-lang">${csvHeaders[lang.colIndex] || 'col ' + lang.colIndex}</span>`;
      headRow.appendChild(h);
    });

    area.appendChild(headRow);
  }

  for (let offset = 0; offset < visible; offset++) {
    const dataIdx = getDataIndex(currentRow + offset);
    const row = csvData[dataIdx];

    if (rowsPerPage > 1) {
      const sep = document.createElement('div');
      sep.className = 'row-sep';
      const rowIdVal = (mapping.idColIndex !== null && row[mapping.idColIndex])
        ? ' <span class="row-sep-id">' + row[mapping.idColIndex] + '</span>' : '';
      sep.innerHTML = `<span class="row-sep-num">#${dataIdx + 1}${rowIdVal}</span><span class="row-sep-line"></span>`;
      area.appendChild(sep);
    }

    const cellRow = document.createElement('div');
    cellRow.className = 'cell-row';
    cellRow.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    area.appendChild(cellRow);

    // ── Original cell ──
    {
      const wrap = document.createElement('div');
      wrap.className = 'cell-wrap';

      // Single-row mode still shows the label per row
      if (rowsPerPage === 1) {
        const label = document.createElement('div');
        label.className = 'cell-label';
        const badgeClass = isEditable ? 'badge-original-editable' : 'badge-original';
        const badgeText = isEditable ? 'source · editable' : 'source · read-only';
        label.innerHTML = `<span style="color:var(--accent2)">${csvHeaders[mapping.original] || 'Original'}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>`;
        wrap.appendChild(label);
      }

      const cell = document.createElement('div');
      cell.className = 'cell-editable ' + (isEditable ? 'is-original-editable' : 'is-original-readonly');
      cell.id = `cell-${offset}-original`;
      cell.contentEditable = isEditable ? 'true' : 'false';
      cell.spellcheck = isEditable;
      cell.textContent = row[mapping.original] || '';

      const charEl = document.createElement('div');
      charEl.className = 'cell-char-count';
      const updateChar = () => { charEl.textContent = cell.innerText.length + ' chars'; };
      updateChar();

      if (isEditable) {
        cell.addEventListener('focus', () => { lastFocusedCellId = cell.id; });
        cell.addEventListener('input', () => { updateChar(); markModified(); });
        cell.addEventListener('blur',  () => { if (autoSave && fileHandle && isModified) triggerAutoSave(); });
      }

      wrap.appendChild(cell);
      wrap.appendChild(charEl);
      cellRow.appendChild(wrap);
    }

    // ── Language cells ──
    mapping.langs.forEach((lang, i) => {
      const color = langColors[i % langColors.length];
      const wrap = document.createElement('div');
      wrap.className = 'cell-wrap';

      if (rowsPerPage === 1) {
        const label = document.createElement('div');
        label.className = 'cell-label';
        label.innerHTML = `<span style="color:${color}">${lang.name}</span>
          <span class="badge badge-lang">${csvHeaders[lang.colIndex] || 'col ' + lang.colIndex}</span>`;
        wrap.appendChild(label);
      }

      const cell = document.createElement('div');
      cell.className = 'cell-editable';
      cell.id = `cell-${offset}-lang-${i}`;
      cell.contentEditable = 'true';
      cell.spellcheck = true;
      cell.style.borderColor = color + '33';
      cell.textContent = row[lang.colIndex] || '';

      const charEl = document.createElement('div');
      charEl.className = 'cell-char-count';
      const updateChar = () => { charEl.textContent = cell.innerText.length + ' chars'; };
      updateChar();
      cell.addEventListener('focus', () => { lastFocusedCellId = cell.id; });
      cell.addEventListener('input', () => { updateChar(); markModified(); });
      cell.addEventListener('blur',  () => { if (autoSave && fileHandle && isModified) triggerAutoSave(); });

      // Focus first cell of first visible row (unless user is searching)
      if (offset === 0 && i === 0) {
        setTimeout(() => {
          if (document.activeElement === document.getElementById('search-input')) return;
          cell.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(cell);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }, 10);
      }

      wrap.appendChild(cell);
      wrap.appendChild(charEl);
      cellRow.appendChild(wrap);
    });
  }
}

function markModified() {
  if (!isModified) {
    isModified = true;
    document.querySelectorAll('.modified-badge').forEach(el => el.classList.add('visible'));
  }
}

function updateNav() {
  const total = getEffectiveTotal();
  const allVisible = rowsPerPage >= total || total === 0;

  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.style.display = allVisible ? 'none' : '';

  document.getElementById('first-btn').disabled = currentRow === 0;
  document.getElementById('prev-btn').disabled = currentRow === 0;
  document.getElementById('next-btn').disabled = currentRow >= total - 1;
  document.getElementById('last-btn').disabled = currentRow >= total - 1;
  document.getElementById('jump-input').max = total;
}

function goRow(delta) {
  flushCurrentRow();
  const step = delta * rowsPerPage;
  const next = Math.max(0, Math.min(currentRow + step, getEffectiveTotal() - 1));
  currentRow = next;
  renderRow();
  updateNav();
}

function goFirst() { flushCurrentRow(); currentRow = 0; renderRow(); updateNav(); }
function goLast()  { flushCurrentRow(); currentRow = Math.max(0, getEffectiveTotal() - rowsPerPage); renderRow(); updateNav(); }

function jumpTo(val) {
  const n = parseInt(val) - 1;
  if (isNaN(n) || n < 0 || n >= getEffectiveTotal()) return;
  flushCurrentRow();
  currentRow = n;
  renderRow();
  updateNav();
}

// ─────────── Save CSV ───────────
async function saveCSV() {
  flushCurrentRow();
  const csvText = serializeCSV(csvHeaders, csvData);
  const bom = '\uFEFF';

  // Prefer writing via file handle (no download dialog)
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(bom + csvText);
      await writable.close();
      isModified = false;
      document.querySelectorAll('.modified-badge').forEach(el => el.classList.remove('visible'));
      showToast('Saved to ' + originalFileName, 'success');
      return;
    } catch (e) {
      console.warn('FSA write failed, falling back to download', e);
    }
  }

  // Fallback: trigger download
  const blob = new Blob([bom + csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = originalFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  isModified = false;
  document.querySelectorAll('.modified-badge').forEach(el => el.classList.remove('visible'));
  showToast('Saved: ' + originalFileName, 'success');
}

// ─────────── Auto-Save ───────────
let autoSaveTimer = null;

async function triggerAutoSave() {
  // Small debounce to coalesce rapid blur/navigation events
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    syncDOMToData(); // ensure latest cell content is in csvData
    const csvText = serializeCSV(csvHeaders, csvData);
    try {
      const writable = await fileHandle.createWritable();
      await writable.write('\uFEFF' + csvText);
      await writable.close();
      isModified = false;
      document.querySelectorAll('.modified-badge').forEach(el => el.classList.remove('visible'));
      updateAutoSaveStatus(true);
    } catch (e) {
      console.warn('Auto-save failed:', e);
      updateAutoSaveStatus(false);
    }
  }, 300);
}

function updateAutoSaveStatus(ok) {
  const el = document.getElementById('autosave-status');
  if (!el) return;
  const now = new Date();
  const time = now.toTimeString().slice(0, 5);
  el.textContent = ok ? `\u2713 ${time}` : '\u26a0 failed';
  el.className = 'autosave-status ' + (ok ? 'ok' : 'err');
}

function toggleAutoSave() {
  const chk = document.getElementById('autosave-chk');
  autoSave = chk.checked;

  const statusEl = document.getElementById('autosave-status');

  if (autoSave && !fileHandle) {
    // FSA not available (dragged file or fallback browser)
    autoSave = false;
    chk.checked = false;
    showToast('Open the file via Browse button to enable auto-save', 'error');
    return;
  }

  if (statusEl) {
    statusEl.textContent = autoSave ? 'on' : '';
    statusEl.className = 'autosave-status' + (autoSave ? ' ok' : '');
  }
  if (autoSave) {
    showToast('Auto-save enabled — file saved on each row change', 'success');
    if (isModified) triggerAutoSave(); // flush any pending unsaved changes immediately
  }
}

// ─────────── Toast ───────────
let toastTimer;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.className = 'toast ' + type;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─────────── Keyboard shortcuts ───────────
document.addEventListener('keydown', (e) => {
  const modalOpen = document.getElementById('modal-overlay').classList.contains('open');
  const editorVisible = document.getElementById('editor-screen').classList.contains('visible');

  if (modalOpen || !editorVisible) return;

  // Alt + Arrow = navigate rows (works even when inside a cell)
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goRow(1); return; }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goRow(-1); return; }
  if (e.altKey && e.key === 'ArrowDown')  { e.preventDefault(); goRow(1); return; }
  if (e.altKey && e.key === 'ArrowUp')    { e.preventDefault(); goRow(-1); return; }

  // Ctrl/Cmd+S = save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCSV(); return; }
});

// ─────────── Tools: helpers ───────────
function getFocusedCell() {
  if (!lastFocusedCellId) return null;
  const el = document.getElementById(lastFocusedCellId);
  return (el && el.contentEditable === 'true') ? el : null;
}

// ─────────── Tools: Quote replacement ───────────
function replaceQuotesInText(text) {
  // Replace all flavors of double quotes wrapping content with «»
  // Handles: "...", “...”, „...“, <<...>>
  return text
    .replace(/„([^“”]*)“/g,  '«$1»') // German-style lower/upper
    .replace(/„([^“”]*)”/g,  '«$1»')
    .replace(/[“”„]([^\u201c\u201d\u201e"]*)[\u201c\u201d\u201e]/g, '«$1»')
    .replace(/"([^"]*)"/g, '«$1»');       // plain ASCII quotes last
}

function replaceQuotesCurrentCell() {
  const cell = getFocusedCell();
  if (!cell) { showToast('Click an editable cell first', 'error'); return; }

  const before = cell.innerText;
  const after  = replaceQuotesInText(before);
  if (after !== before) {
    cell.innerText = after;
    lastFocusedCellId = cell.id; // innerText reset loses nothing here
    markModified();
    showToast('Quotes replaced in cell', 'success');
  } else {
    showToast('No replaceable quotes found', 'success');
  }
}

// Column picker for bulk quote replacement
function buildColPicker() {
  const panel = document.getElementById('col-picker-panel');
  panel.innerHTML = '';

  const columns = [];
  if (mapping.originalEditable) {
    columns.push({ label: csvHeaders[mapping.original] || 'Original', colIndex: mapping.original });
  }
  mapping.langs.forEach(l => {
    const header = csvHeaders[l.colIndex] || 'col ' + l.colIndex;
    columns.push({ label: `${l.name} — ${header}`, colIndex: l.colIndex });
  });

  if (columns.length === 0) {
    panel.innerHTML = '<div style="padding:10px 12px;font-size:0.8rem;color:var(--text-dim)">No editable columns</div>';
    return;
  }

  columns.forEach(col => {
    const label = document.createElement('label');
    label.className = 'col-picker-item';
    label.innerHTML = `<input type="checkbox" value="${col.colIndex}" checked /> ${col.label}`;
    panel.appendChild(label);
  });
}

function toggleColPicker() {
  const panel = document.getElementById('col-picker-panel');
  const opening = !panel.classList.contains('open');
  if (opening) buildColPicker();
  panel.classList.toggle('open');
}

// Close picker when clicking anywhere else
document.addEventListener('click', () => {
  document.getElementById('col-picker-panel')?.classList.remove('open');
  document.getElementById('add-col-panel')?.classList.remove('open');
  document.getElementById('insert-row-panel')?.classList.remove('open');
});

function replaceQuotesBulk() {
  const checkboxes = document.querySelectorAll('#col-picker-panel input[type=checkbox]:checked');
  const colIndices = Array.from(checkboxes).map(cb => parseInt(cb.value));
  if (colIndices.length === 0) { showToast('Check at least one column first', 'error'); return; }

  flushCurrentRow();
  let count = 0;
  csvData.forEach(row => {
    colIndices.forEach(ci => {
      const original = row[ci] || '';
      const replaced = replaceQuotesInText(original);
      if (replaced !== original) { row[ci] = replaced; count++; }
    });
  });

  if (count > 0) {
    markModified();
    renderRow();
    showToast(`Replaced quotes in ${count} cell${count > 1 ? 's' : ''}`, 'success');
  } else {
    showToast('No replaceable quotes found in selected columns', 'success');
  }
  document.getElementById('col-picker-panel').classList.remove('open');
}

// ─────────── Tools: Capitalization fix ───────────

// Returns the set of likely proper nouns from the source text:
// words that appear MID-SENTENCE in Title Case (not at sentence start).
function extractProperNouns(sourceText) {
  const nouns = new Set();
  if (!sourceText) return nouns;

  // Split into sentences, skip first word of each sentence
  const sentences = sourceText.split(/[.!?…]+\s+|\n+/);
  sentences.forEach(sentence => {
    const words = sentence.trim().split(/\s+/);
    words.slice(1).forEach(word => { // skip first word of sentence
      const clean = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (clean.length > 1 && /^\p{Lu}/u.test(clean)) {
        nouns.add(clean.toLowerCase());
      }
    });
  });
  return nouns;
}

function fixCapInText(text, sourceText = '') {
  if (!text.trim()) return text;

  // Detect proper nouns from the source text
  const properNouns = extractProperNouns(sourceText);

  // Step 1: Detect if bulk of text is CAPS LOCK (>75% uppercase alpha chars)
  const letters = text.match(/\p{L}/gu) || [];
  const uppers  = text.match(/\p{Lu}/gu) || [];
  const isAllCaps = letters.length > 2 && (uppers.length / letters.length) > 0.75;

  let result;
  if (isAllCaps) {
    // Full lowercase pass, then we'll re-capitalize by rule
    result = text.toLowerCase();
  } else {
    // Only normalize ALL-CAPS chunks of 4+ letters (leave shorter ones: OK, TV, etc.)
    result = text.replace(/(^|[\s(«])(\p{Lu}{4,})(?=$|[\s.,!?;:)»])/gu,
      (_, pre, word) => pre + word.toLowerCase()
    );
  }

  // Step 2: Re-capitalize sentence starts
  result = result
    .replace(/^(\p{Ll})/u, c => c.toUpperCase())
    .replace(/([.!?…]+\s+)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase())
    .replace(/(\n)(\p{Ll})/gu, (_, nl, c) => nl + c.toUpperCase());

  // Step 3: Re-capitalize proper nouns found in source
  // Match word-like tokens (Unicode letters only) and check against our noun set
  if (properNouns.size > 0) {
    result = result.replace(/\p{L}+/gu, word => {
      if (properNouns.has(word.toLowerCase()) && /^\p{Ll}/u.test(word)) {
        return word[0].toUpperCase() + word.slice(1);
      }
      return word;
    });
  }

  return result;
}

function fixCapCurrentCell() {
  const cell = getFocusedCell();
  if (!cell) { showToast('Click an editable cell first', 'error'); return; }

  // Get the source text for proper noun hints (same row, original column)
  const cellId = lastFocusedCellId;
  const offsetMatch = cellId.match(/^cell-(\d+)-/);
  let sourceText = '';
  if (offsetMatch) {
    const offset = parseInt(offsetMatch[1]);
    const rowData = csvData[currentRow + offset];
    if (rowData) sourceText = rowData[mapping.original] || '';
  }

  const before = cell.innerText;
  const after  = fixCapInText(before, sourceText);

  if (after !== before) {
    cell.innerText = after;
    markModified();
    showToast('Capitalization fixed', 'success');
  } else {
    showToast('Already looks good!', 'success');
  }
}

// ─────────── Edit: Add Column ───────────
function toggleAddColPanel() {
  const panel = document.getElementById('add-col-panel');
  const opening = !panel.classList.contains('open');
  document.getElementById('insert-row-panel')?.classList.remove('open');
  document.getElementById('col-picker-panel')?.classList.remove('open');
  panel.classList.toggle('open');
  if (opening) setTimeout(() => document.getElementById('new-col-name')?.focus(), 50);
}

function addColumn() {
  const nameInput = document.getElementById('new-col-name');
  const name = nameInput.value.trim();
  if (!name) { showToast('Enter a column name', 'error'); return; }

  csvHeaders.push(name);
  const newIdx = csvHeaders.length - 1;

  // Ensure every row has a cell for the new column
  csvData.forEach(row => {
    while (row.length <= newIdx) row.push('');
  });

  nameInput.value = '';
  document.getElementById('add-col-panel').classList.remove('open');
  markModified();
  showToast(`Column “${name}” added — col ${newIdx + 1}. Open Columns to map it.`, 'success');
}

// ─────────── Edit: Insert Row ───────────
function toggleInsertRowPanel() {
  const panel = document.getElementById('insert-row-panel');
  const opening = !panel.classList.contains('open');
  document.getElementById('add-col-panel')?.classList.remove('open');
  document.getElementById('col-picker-panel')?.classList.remove('open');
  panel.classList.toggle('open');
  if (opening) {
    const input = document.getElementById('insert-row-pos');
    input.value = currentRow + 2; // default: after current row
    input.max = csvData.length + 1;
    setTimeout(() => input.focus(), 50);
  }
}

function insertRow() {
  const posInput = document.getElementById('insert-row-pos');
  const pos = parseInt(posInput.value) - 1; // to 0-indexed

  if (isNaN(pos) || pos < 0 || pos > csvData.length) {
    showToast(`Position must be between 1 and ${csvData.length + 1}`, 'error');
    return;
  }

  flushCurrentRow();

  // Create empty row with correct column count
  const emptyRow = new Array(csvHeaders.length).fill('');
  csvData.splice(pos, 0, emptyRow);

  // Navigate to the newly inserted row
  currentRow = pos;
  document.getElementById('insert-row-panel').classList.remove('open');
  renderRow();
  updateNav();
  markModified();
  showToast(`Empty row inserted at position ${pos + 1}`, 'success');
}
