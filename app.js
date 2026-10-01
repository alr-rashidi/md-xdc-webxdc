// All third-party libraries are vendored under lib/ — the app works fully offline.
import { marked } from './lib/marked.esm.js';
import { downloadZip } from './lib/client-zip.js';
import { highlightHTML } from './lib/speed-highlight/index.js';

/* ---------------- GitHub-style alerts ---------------- */
const ALERT_RE = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
const ALERT_LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    blockquote(body) {
      const m = body.match(ALERT_RE);
      if (m) {
        const type = m[1].toLowerCase();
        const body2 = body.replace(ALERT_RE, '<p>').replace(/^<p><br\s*\/?>/, '<p>');
        return `<blockquote class="alert alert-${type}"><p class="alert-title">${ALERT_LABELS[type]}</p>${body2}</blockquote>`;
      }
      return `<blockquote>${body}</blockquote>`;
    },
    // Tag task items like GitHub does. The checkbox can end up either directly in
    // the <li> (tight list) or wrapped in a <p> (loose list), so a CSS-only
    // selector would miss one of them; the class covers both. `checked` is unused
    // here because the checkbox itself is already part of the item body.
    listitem(text, task) {
      return task ? `<li class="task-list-item">${text}</li>\n` : `<li>${text}</li>\n`;
    },
    // GitHub's class for a list holding task items; the stylesheet uses it to drop
    // the marker indentation that a pure task list no longer needs.
    list(body, ordered, start) {
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = (ordered && start !== 1) ? ` start="${start}"` : '';
      const tasks = (body.match(/class="task-list-item"/g) || []).length;
      const items = (body.match(/<li[ >]/g) || []).length;
      // A list of nothing but task items needs no marker indentation; marking it
      // here keeps that out of CSS, where :has() support would be required.
      const cls = tasks ? ` class="contains-task-list${tasks === items ? ' pure-task-list' : ''}"` : '';
      return `<${tag}${startAttr}${cls}>\n${body}</${tag}>\n`;
    }
  }
});

/* ---------------- State ---------------- */
const STORAGE_KEY = 'mdx-doc';
const SPLIT_KEY = 'mdx-split';
const mediaObjectUrls = {}; // 'media/uuid.ext' -> blobURL
let viewMode = 'split';

const $ = (id) => document.getElementById(id);
const editorEl = $('editor');
const preview = $('preview');
const mainEl = $('main');
const dividerEl = $('divider');

/* ---------------- Single-element editor: text <-> DOM ---------------- */
// Invisible anchor kept after a trailing newline: without a real text node
// there, the browser resolves "caret at the end" to just *before* that newline
// and the next character typed lands on the previous line.
const CARET_ANCHOR = '\u200B';

function editorText(el) {
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.data); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'BR') { parts.push('\n'); return; }
    if (tag === 'IMG' || tag === 'BUTTON') return;
    if (tag === 'DIV' || tag === 'P') {
      // A block only ever *starts* a new line: a break before its content. Adding
      // one after it as well would invent a trailing blank line, since the
      // browser wraps text in blocks freely while editing.
      if (parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
    }
    for (const child of node.childNodes) walk(child);
  };
  // Walk the children directly: the block-newline rule applies to blocks
  // *inside* the editor, not to the editor element itself. A trailing block
  // with no text is the caret placeholder the browser leaves behind after
  // some edits — it is not content, so it must not become a trailing newline.
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    const placeholder = i === kids.length - 1 && child.nodeType === Node.ELEMENT_NODE
      && (child.tagName === 'DIV' || child.tagName === 'P') && !child.textContent;
    if (placeholder) break;
    walk(child);
  }
  return parts.join('').replace(/\u200B/g, '');
}

function renderEditor(el, text) {
  const sel = getSelection();
  let saved = null;
  if (sel.rangeCount && el.contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0);
    saved = {
      anchor: r.startOffset,
      anchorNode: r.startContainer,
      focus: r.endOffset,
      focusNode: r.endContainer,
      anchorBefore: textOffsetOf(el, r.startContainer, r.startOffset),
      focusBefore: textOffsetOf(el, r.endContainer, r.endOffset),
    };
  }
  const html = lastHighlightedHTML ?? escapeHtml(text);
  lastHighlightedHTML = null;
  el.innerHTML = html;
  if (text.endsWith('\n')) el.appendChild(document.createTextNode(CARET_ANCHOR));
  if (saved) {
    try {
      const range = document.createRange();
      const posAt = (offset) => {
        const t = textNodeForOffset(el, Math.min(offset, text.length));
        if (t) return [t.node, t.offset];
        return [el, el.childNodes.length]; // end of document
      };
      const [aNode, aOff] = posAt(saved.anchorBefore);
      const [fNode, fOff] = posAt(saved.focusBefore);
      range.setStart(aNode, aOff);
      if (saved.anchorNode === saved.focusNode && saved.anchor === saved.focus) {
        range.collapse(true);
      } else {
        range.setEnd(fNode, fOff);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* caret lost — not fatal */ }
  }
}

function textOffsetOf(el, node, offset) {
  if (node === el) {
    let n = 0;
    for (let i = 0; i < offset && i < el.childNodes.length; i++) {
      n += editorText(wrap(el.childNodes[i])).length;
    }
    return n;
  }
  let total = 0;
  const walk = (cur) => {
    if (cur === node) return true;
    if (cur.nodeType === Node.TEXT_NODE) { total += cur.data.length; return false; }
    if (cur.nodeType !== Node.ELEMENT_NODE) return false;
    if (cur.tagName === 'BR') { total += 1; return false; }
    for (const child of cur.childNodes) if (walk(child)) return true;
    return false;
  };
  for (const child of el.childNodes) if (walk(child)) break;
  return total + offset;
}

function wrap(node) {
  const frag = document.createDocumentFragment();
  frag.appendChild(node.cloneNode(true));
  const tmp = document.createElement('div');
  tmp.appendChild(frag);
  return tmp;
}

function textNodeForOffset(el, target) {
  let acc = 0;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (acc + child.data.length >= target) return { node: child, offset: target - acc };
        acc += child.data.length;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') { acc += 1; continue; }
        const r = walk(child);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(el);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Insert plain text straight into the DOM at the caret. The browser's own
// commands are avoided for line breaks and pastes: at the end of the document
// they leave an extra trailing newline behind (a caret placeholder) that the
// next re-render would bake into the saved note as a blank line.
function insertRawText(text) {
  const sel = getSelection();
  if (!sel.rangeCount || !editorEl.contains(sel.anchorNode) || !text) return false;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

let lastHighlightedHTML = null;
let hlTimer;
let hlToken = 0;
async function updateHighlight() {
  const text = editorText(editorEl);
  const my = ++hlToken;
  try {
    const html = await highlightHTML(text, 'md', { block: false });
    if (my !== hlToken) return;
    // If the user kept typing while we were highlighting, skip this render —
    // the input event from those keystrokes already scheduled a fresher one.
    if (editorText(editorEl) !== text) return;
    lastHighlightedHTML = html;
    renderEditor(editorEl, text);
  } catch { /* keep current DOM */ }
}

/* ---------------- Undo / redo ----------------
   Re-rendering the highlighted markup replaces the editor's DOM wholesale,
   which throws away the browser's native undo stack — so the editor keeps its
   own history of text snapshots and handles Ctrl/Cmd+Z itself. */
const HISTORY_LIMIT = 200;
const HISTORY_COALESCE_MS = 800; // a burst of typing becomes one undo step
let historyStack = [];
let historyIndex = -1;

// Run a direct DOM edit, then let the normal input pipeline (history, preview,
// save, highlighting) react to it.
function editWith(edit) {
  if (edit() === false) return;
  editorEl.dispatchEvent(new Event('input'));
}

function caretRawOffset() {
  const sel = getSelection();
  if (!sel.rangeCount || !editorEl.contains(sel.focusNode)) return null;
  return textOffsetOf(editorEl, sel.focusNode, sel.focusOffset);
}

function seedHistory() {
  historyStack = [{ text: editorText(editorEl), caret: null, time: Date.now(), kind: 'init' }];
  historyIndex = 0;
}

function pushHistory(inputType = '') {
  const text = editorText(editorEl);
  if (historyIndex >= 0 && historyStack[historyIndex].text === text) return; // nothing changed
  const typing = /^(insertText|deleteContent)/.test(inputType || '');
  const now = Date.now();
  const top = historyStack[historyIndex];
  // Extend the current typing burst instead of adding a step per keystroke;
  // never fold into the base state, so the original document stays reachable.
  if (top && typing && top.kind === 'typing' && historyIndex > 0 && now - top.time < HISTORY_COALESCE_MS) {
    historyStack[historyIndex] = { text, caret: caretRawOffset(), time: now, kind: 'typing' };
    historyStack.length = historyIndex + 1;
    return;
  }
  historyStack.length = historyIndex + 1; // editing after an undo drops the redo branch
  historyStack.push({ text, caret: caretRawOffset(), time: now, kind: typing ? 'typing' : 'edit' });
  historyIndex = historyStack.length - 1;
  if (historyStack.length > HISTORY_LIMIT) { historyStack.shift(); historyIndex -= 1; }
}

function stepHistory(direction) {
  const next = historyIndex + direction;
  if (next < 0 || next >= historyStack.length) return false;
  historyIndex = next;
  const state = historyStack[next];
  lastHighlightedHTML = null; // render plain text; highlighting follows on input
  renderEditor(editorEl, state.text);
  editorEl.focus();
  const range = document.createRange();
  const pos = state.caret == null ? null : textNodeForOffset(editorEl, state.caret);
  if (pos) { range.setStart(pos.node, pos.offset); range.collapse(true); }
  else { range.selectNodeContents(editorEl); range.collapse(false); }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  editorEl.dispatchEvent(new Event('input')); // preview + save + re-highlight
  return true;
}

/* ---------------- Theme ---------------- */
function currentTheme() {
  return localStorage.getItem('mdx-theme')
    || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('mdx-theme', t);
}
applyTheme(currentTheme());
$('btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ---------------- Text direction (LTR / RTL) ---------------- */
// Sets the *document* direction (editor + preview + exported HTML). The app
// chrome stays LTR.
function applyDir(d) {
  const rtl = d === 'rtl';
  document.documentElement.dataset.dir = rtl ? 'rtl' : 'ltr';
  localStorage.setItem('mdx-dir', rtl ? 'rtl' : 'ltr');
  const btn = $('btn-dir');
  btn.setAttribute('aria-pressed', String(rtl));
  btn.title = rtl ? 'Text direction: RTL — click for LTR' : 'Text direction: LTR — click for RTL';
}
applyDir(localStorage.getItem('mdx-dir') === 'rtl' ? 'rtl' : 'ltr');
$('btn-dir').addEventListener('click', () => applyDir(document.documentElement.dataset.dir === 'rtl' ? 'ltr' : 'rtl'));

/* ---------------- Editor behaviour (Enter / paste / scroll) ---------------- */
// Upgrade to true plaintext-only mode where supported (Chrome/Safari/Firefox 136+);
// elsewhere the keydown/beforeinput/paste guards below keep the content plain.
(() => {
  const probe = document.createElement('div');
  probe.setAttribute('contenteditable', 'plaintext-only');
  if (probe.contentEditable === 'plaintext-only') editorEl.setAttribute('contenteditable', 'plaintext-only');
})();

editorEl.addEventListener('beforeinput', (e) => {
  // Route any native undo/redo (menu, context menu) through our own history too.
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    stepHistory(e.inputType === 'historyUndo' ? -1 : 1);
    return;
  }
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
    editWith(() => insertRawText('\n'));
  }
});
editorEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  editWith(() => insertRawText(text));
});
editorEl.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // Guard against rich-text shortcuts on browsers without real plaintext-only support
  if (mod && ['b', 'i', 'u'].includes(key)) { e.preventDefault(); return; }
  if (!mod || e.altKey) return;
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); stepHistory(-1); }
  else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); stepHistory(1); }
});
// Force plain-text drops (a rich drop could otherwise inject markup)
editorEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
  if (text) editWith(() => insertRawText(text));
});
editorEl.addEventListener('dragover', (e) => e.preventDefault());

/* ---------------- Preview ---------------- */
let pvToken = 0;
async function highlightPreviewCode(token) {
  const blocks = preview.querySelectorAll('pre code');
  for (const code of blocks) {
    if (token !== pvToken) return;
    const m = code.className.match(/language-([\w-]+)/);
    const lang = m ? m[1] : 'plain';
    const txt = code.textContent;
    try {
      const html = await highlightHTML(txt, lang, { block: false });
      if (token === pvToken) code.innerHTML = html;
    } catch (e) { /* leave as-is */ }
  }
}
function renderPreview() {
  preview.innerHTML = marked.parse(editorText(editorEl));
  preview.querySelectorAll('img[src^="media/"], video[src^="media/"], audio[src^="media/"], source[src^="media/"]').forEach((el) => {
    const src = el.getAttribute('src');
    if (mediaObjectUrls[src]) el.setAttribute('src', mediaObjectUrls[src]);
  });
  const token = ++pvToken;
  highlightPreviewCode(token);
  // The send dialog's unused-media notice goes stale when the note changes
  // underneath it, so it tracks the document here.
  if (!$('send-modal').hidden) refreshSendWarn();
}
let pvTimer;
function updatePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 120); }

/* ---------------- Persist document ---------------- */
function loadDoc() {
  const saved = localStorage.getItem(STORAGE_KEY);
  // No template: a fresh note starts empty (the editor shows its placeholder).
  editorEl.innerHTML = escapeHtml(saved || '');
}
let saveTimer;
editorEl.addEventListener('input', (e) => {
  if (!e.isComposing) pushHistory(e.inputType);
  updatePreview();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, editorText(editorEl)), 400);
  clearTimeout(hlTimer); hlTimer = setTimeout(updateHighlight, 40);
});

/* ---------------- Insert text at cursor ---------------- */
// Caret/selection position expressed as offsets into the plain-text model.
// (Range text ignores <br>, and the trailing anchor is stripped, so this maps
// straight onto editorText's output for the editor's normal DOM.)
function selectionModelOffsets() {
  const sel = getSelection();
  if (!sel.rangeCount || !editorEl.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const offsetOf = (node, offset) => {
    const probe = document.createRange();
    probe.selectNodeContents(editorEl);
    probe.setEnd(node, offset);
    return probe.toString().replace(/\u200B/g, '').length;
  };
  const start = offsetOf(r.startContainer, r.startOffset);
  const end = offsetOf(r.endContainer, r.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function placeCaretAtModelOffset(target) {
  let acc = 0;
  let found = null;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (acc + child.data.length >= target) { found = { node: child, offset: target - acc }; return true; }
        acc += child.data.length;
      } else if (child.nodeType === Node.ELEMENT_NODE && walk(child)) {
        return true;
      }
    }
    return false;
  };
  walk(editorEl);
  const range = document.createRange();
  if (found) { range.setStart(found.node, found.offset); range.collapse(true); }
  else { range.selectNodeContents(editorEl); range.collapse(false); }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertText(text) {
  // Edit the text model directly rather than going through execCommand: the
  // browser needs a caret to insert at all (otherwise the snippet lands at the
  // very start) and it also drops the trailing newline of a snippet inserted at
  // the end of the note. This way the same insert always produces the same text.
  const current = editorText(editorEl);
  const sel = selectionModelOffsets();
  let next;
  let caretAfter;
  if (sel) {
    next = current.slice(0, sel.start) + text + current.slice(sel.end);
    caretAfter = sel.start + text.length;
  } else {
    // Nothing focused in the editor: append to the end, starting on its own line.
    next = current + (current && !current.endsWith('\n') ? '\n' : '') + text;
    caretAfter = next.length;
  }
  lastHighlightedHTML = null; // render plain text; highlighting follows on input
  renderEditor(editorEl, next);
  editorEl.focus();
  placeCaretAtModelOffset(caretAfter);
  editorEl.dispatchEvent(new Event('input'));
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'md-to-xdc', STORE = 'media', DB_VER = 1;
let dbPromise;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
const tx = (mode) => openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
function dbPut(rec) { return tx('readwrite').then((s) => new Promise((res, rej) => { const rq = s.put(rec); rq.onsuccess = () => res(); rq.onerror = () => rej(rq.error); })); }
function dbGet(name) { return tx('readonly').then((s) => new Promise((res, rej) => { const rq = s.get(name); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); })); }
function dbAll() { return tx('readonly').then((s) => new Promise((res, rej) => { const rq = s.getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); })); }
function dbDelete(name) { return tx('readwrite').then((s) => new Promise((res, rej) => { const rq = s.delete(name); rq.onsuccess = () => res(); rq.onerror = () => rej(rq.error); })); }
function dbClear() { return tx('readwrite').then((s) => new Promise((res, rej) => { const rq = s.clear(); rq.onsuccess = () => res(); rq.onerror = () => rej(rq.error); })); }

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function addMedia(file) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const name = `${crypto.randomUUID()}.${ext}`;
  const type = file.type || guessType(ext);
  // `orig` keeps the original filename so the library can build a readable
  // alt text later; older records simply fall back to their stored name.
  await dbPut({ name, orig: file.name, blob: file, type, ext, size: file.size, created: Date.now() });
  mediaObjectUrls['media/' + name] = URL.createObjectURL(file);
  updateMediaCount();
  return { name, orig: file.name, type, ext };
}

/* ---------------- Media snippets (shared by toolbar + library) ---------------- */
// Single source of truth: extension -> MIME. The per-kind extension lists used
// by mediaKind() are derived from it, so the two can never drift apart.
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
};
const KIND_BY_EXT = Object.fromEntries(
  ['image', 'video', 'audio'].map((kind) => [kind, Object.keys(MIME_BY_EXT).filter((ext) => MIME_BY_EXT[ext].startsWith(kind + '/'))])
);
function guessType(ext) { return MIME_BY_EXT[ext] || 'application/octet-stream'; }
function mediaKind(rec) {
  const t = rec.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  const ext = (rec.ext || '').toLowerCase();
  for (const kind of ['image', 'video', 'audio']) if (KIND_BY_EXT[kind].includes(ext)) return kind;
  return null;
}
// True when the file is displayable in the exported note (image/video/audio).
// Anything else (pdfs, zips, ...) can still be shipped as an attachment, but
// the note has no way to show it, so inserting a snippet makes no sense.
function isSupportedMedia(rec) { return mediaKind(rec) !== null; }
// Pre-import check on the raw File: accepts whatever mediaKind will decide later.
function fileIsSupportedMedia(file) {
  return isSupportedMedia({ type: file.type || guessType((file.name.split('.').pop() || 'bin').toLowerCase()), ext: (file.name.split('.').pop() || 'bin').toLowerCase() });
}
function mediaRef(rec) {
  return 'media/' + rec.name;
}
function mediaSnippet(rec, kind = mediaKind(rec)) {
  const ref = mediaRef(rec);
  const base = (rec.orig || rec.name).replace(/\.[^.]+$/, '');
  return kind === 'image'
    ? `![${base}](${ref})\n`
    : kind === 'video'
      ? `<video src="${ref}" controls></video>\n`
      : `<audio src="${ref}" controls></audio>\n`;
}
// Media is set off by a blank line before and after: an image glued to a paragraph
// would render inline, and two HTML snippets on adjacent lines would merge into
// one element. The wrap is added once around the whole batch (not per snippet) so
// inserting several files does not stack blank lines between them.
function insertMediaSnippets(recs, kinds) {
  const current = editorText(editorEl);
  const lead = !current || /\n\n$/.test(current) ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  insertText(lead + recs.map((rec, i) => mediaSnippet(rec, kinds[i])).join('') + '\n');
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ---------------- Media count badge ---------------- */
function updateMediaCount() {
  dbAll().then((items) => {
    const badge = $('media-count');
    if (!badge) return;
    const n = items.length;
    badge.textContent = n;
    badge.hidden = n === 0;
  }).catch(() => {});
}

/* ---------------- Unused media detection ---------------- */
// The exact regex the export packs by, so the warning can never disagree with
// what actually ships in the .xdc.
const MEDIA_REF_RE = /media\/[A-Za-z0-9-]+\.[A-Za-z0-9]+/g;

function unusedMediaItems(items) {
  const refs = new Set(editorText(editorEl).match(MEDIA_REF_RE) || []);
  return items.filter((rec) => !refs.has(mediaRef(rec)));
}

/* ---------------- Insert media ---------------- */
const KIND_PLURAL = { image: 'images', video: 'videos', audio: 'audio files' };

// A pick can carry several files. They are stored one after another (so IndexedDB
// writes stay in pick order) and their snippets go into the note as one edit, which
// keeps a batch to a single undo step. A file that fails to store is skipped rather
// than losing the rest of the batch.
async function addMediaFiles(files) {
  const recs = [];
  let failed = 0;
  for (const file of files) {
    try { recs.push(await addMedia(file)); } catch (e) { failed++; console.error(e); }
  }
  return { recs, failed };
}

// The header's Insert button opens the picker straight away — no type menu, because
// each file's kind is inferred from the file itself (mediaKind checks the MIME type,
// then the extension). One pick may therefore mix images, video and audio.
$('btn-insert').addEventListener('click', () => $('file-media').click());

function wireInsert() {
  const input = $('file-media');
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';                       // cleared up front so a cancel cannot leave a stale list
    if (!files.length) return;
    // Files the note cannot display (anything but image/video/audio) get a
    // warning first: they can be kept in the library and shipped with the
    // .xdc, but no snippet is inserted for them.
    const unsupported = files.filter((f) => !fileIsSupportedMedia(f));
    let keepUnsupported = false;
    if (unsupported.length) {
      const names = unsupported.map((f) => f.name).join(', ');
      keepUnsupported = confirm(
        `${unsupported.length === 1 ? `'${names}' is` : `${unsupported.length} files (${names}) are`} not a supported media type (image, video or audio).\n\n` +
        'It cannot be shown in the exported note. You can still keep it in the media library, but no snippet is added to the text.\n\n' +
        'OK to import it into the library, Cancel to skip it.'
      );
    }
    const toImport = files.filter((f) => fileIsSupportedMedia(f) || keepUnsupported);
    if (!toImport.length) { toast('Nothing added'); return; }
    const { recs, failed } = await addMediaFiles(toImport);
    if (!recs.length) { toast('Could not add those files'); return; }
    // Only displayable files produce a snippet; unsupported ones land in the
    // library silently (their Insert button is disabled there).
    const insertable = recs.filter((rec) => isSupportedMedia(rec));
    const kinds = insertable.map((rec) => mediaKind(rec));
    if (insertable.length) insertMediaSnippets(insertable, kinds);
    const kept = recs.length - insertable.length;
    if (kept) toast(`Added ${kept} file${kept > 1 ? 's' : ''} to the library (not shown in the note)`);
    if (!insertable.length) return;
    const mixed = new Set(kinds).size > 1;
    const plural = mixed ? 'files' : KIND_PLURAL[kinds[0]];
    const skipped = unsupported.length && !keepUnsupported ? unsupported.length : 0;
    if (failed || skipped) toast(`Inserted ${insertable.length} of ${insertable.length + failed + skipped} ${plural}`);
    else if (insertable.length === 1) toast(`Inserted ${kinds[0]}`);
    else toast(`Inserted ${insertable.length} ${plural}`);
  });
}
wireInsert();

/* ---------------- Media manager ---------------- */
async function openMedia() {
  const list = $('media-list');
  const items = (await dbAll()).sort((a, b) => b.created - a.created);
  const used = new Set(editorText(editorEl).match(MEDIA_REF_RE) || []);
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<p class="empty">No media stored yet. Use Insert to add some.</p>'; }
  items.forEach((rec) => {
    const row = document.createElement('div'); row.className = 'mrow';
    const prev = document.createElement('div'); prev.className = 'mprev';
    const url = mediaObjectUrls['media/' + rec.name];
    if (rec.type.startsWith('image/')) { const i = document.createElement('img'); i.src = url; prev.appendChild(i); }
    else if (rec.type.startsWith('video/')) { const v = document.createElement('video'); v.src = url; v.muted = true; prev.appendChild(v); }
    else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('width', '22'); svg.setAttribute('height', '22');
      // Audio gets the waveform icon; anything else (pdf, zip, ...) a generic file icon.
      svg.innerHTML = rec.type.startsWith('audio/')
        ? '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>'
        : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>';
      prev.appendChild(svg);
    }
    const meta = document.createElement('div'); meta.className = 'mmeta';
    meta.innerHTML = `<div class="mname">${rec.name}</div><div class="msize">${fmtSize(rec.size)} · ${rec.type || rec.ext}</div>`;

    // A file whose reference appears nowhere in the note would silently be left
    // out of the .xdc, so the library flags it for the user.
    if (!used.has(mediaRef(rec))) {
      row.classList.add('unused');
      const tag = document.createElement('span');
      tag.className = 'mtag';
      tag.textContent = 'not used';
      tag.title = 'Not referenced in the note — it will not be included in the .xdc';
      meta.querySelector('.mname').appendChild(tag);
    }

    const kind = mediaKind(rec);
    const insert = document.createElement('button');
    insert.className = 'btn sm';
    insert.textContent = 'Insert';
    insert.title = 'Insert this media into the note';
    // Files that cannot be displayed in the note (pdf, zip, ...) have no
    // snippet form, so inserting is disabled rather than broken.
    if (!kind) {
      insert.disabled = true;
      insert.title = 'This file type cannot be shown in the note';
    } else {
      insert.addEventListener('click', () => {
        insertMediaSnippets([rec], [kind]);
        $('media-modal').hidden = true;
        $('media-modal').classList.remove('stack-top');
        toast(`Inserted ${kind}`);
      });
    }

    const copy = document.createElement('button');
    copy.className = 'btn sm';
    copy.textContent = 'Copy link';
    copy.title = `Copy ${mediaRef(rec)}`;
    copy.addEventListener('click', async () => {
      toast(await copyToClipboard(mediaRef(rec)) ? 'Link copied' : `Copy failed: ${mediaRef(rec)}`);
    });

    const del = document.createElement('button'); del.className = 'btn sm danger'; del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await dbDelete(rec.name);
      if (mediaObjectUrls['media/' + rec.name]) { URL.revokeObjectURL(mediaObjectUrls['media/' + rec.name]); delete mediaObjectUrls['media/' + rec.name]; }
      updateMediaCount();
      openMedia(); updatePreview();
      refreshSendWarn();
    });

    const actions = document.createElement('div'); actions.className = 'mactions';
    actions.append(insert, copy, del);
    row.append(prev, meta, actions);
    list.appendChild(row);
  });
  $('media-modal').hidden = false;
}
$('btn-media').addEventListener('click', openMedia);
$('media-close').addEventListener('click', () => { $('media-modal').hidden = true; $('media-modal').classList.remove('stack-top'); });
$('media-modal').addEventListener('click', (e) => { if (e.target === $('media-modal')) { $('media-modal').hidden = true; $('media-modal').classList.remove('stack-top'); } });

/* ---------------- Clear all media ---------------- */
$('media-clear').addEventListener('click', async () => {
  const items = await dbAll();
  if (!items.length) { toast('No media to clear'); return; }
  if (!confirm(`Delete all ${items.length} media file(s)? This cannot be undone.`)) return;
  await dbClear();
  Object.keys(mediaObjectUrls).forEach((k) => { URL.revokeObjectURL(mediaObjectUrls[k]); delete mediaObjectUrls[k]; });
  updateMediaCount();
  openMedia();
  updatePreview();
  refreshSendWarn();
  toast('Cleared all media');
});

/* ---------------- View mode ---------------- */
function setView(mode) {
  viewMode = mode;
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  mainEl.classList.remove('view-edit', 'view-split', 'view-preview');
  mainEl.classList.add('view-' + mode);
}
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

/* ---------------- Resizable divider ---------------- */
function splitOrientation() {
  return getComputedStyle(mainEl).flexDirection === 'column' ? 'vertical' : 'horizontal';
}
function applySplit(pct) {
  pct = Math.max(10, Math.min(90, pct));
  mainEl.style.setProperty('--split', pct + '%');
}
function loadSplit() {
  const saved = parseFloat(localStorage.getItem(SPLIT_KEY));
  applySplit(isNaN(saved) ? 50 : saved);
}
loadSplit();

let dragging = false;
dividerEl.addEventListener('pointerdown', (e) => {
  if (viewMode !== 'split') return;
  // Touch drags would otherwise scroll the page / select text while resizing.
  e.preventDefault();
  dragging = true;
  dividerEl.setPointerCapture(e.pointerId);
  dividerEl.classList.add('dragging');
  document.body.style.cursor = splitOrientation() === 'vertical' ? 'row-resize' : 'col-resize';
});
dividerEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = mainEl.getBoundingClientRect();
  const orient = splitOrientation();
  let pct;
  if (orient === 'vertical') {
    pct = ((e.clientY - rect.top) / rect.height) * 100;
  } else {
    pct = ((e.clientX - rect.left) / rect.width) * 100;
  }
  applySplit(pct);
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  dividerEl.classList.remove('dragging');
  document.body.style.cursor = '';
  if (e && e.pointerId !== undefined && dividerEl.hasPointerCapture(e.pointerId)) dividerEl.releasePointerCapture(e.pointerId);
  localStorage.setItem(SPLIT_KEY, mainEl.style.getPropertyValue('--split'));
}
dividerEl.addEventListener('pointerup', endDrag);
dividerEl.addEventListener('pointercancel', endDrag);

/* ---------------- Export .xdc ---------------- */

const ALERT_CSS = `
.alert { margin: .8em 0; padding: .4em 1em; border-left: 3px solid var(--border); border-radius: 6px; background: var(--bg-soft); }
.alert > *:first-child { margin-top: 0; }
.alert > *:last-child { margin-bottom: 0; }
.alert-title { font-weight: 700; display: flex; align-items: center; gap: 6px; }
.alert-title::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
.alert > p.alert-title { margin: .2em 0 .1em; }
.alert > p { margin: .3em 0; }
/* Scoped with .note so these beat the plain-quote rule (0,1,1) and the bar stays
   colored in light mode too, not just dark. (No backticks in here: this whole
   block is a template literal.) */
.note .alert-note { border-left-color: #0969da; } .note .alert-note .alert-title { color: #0969da; }
.note .alert-tip { border-left-color: #1a7f37; } .note .alert-tip .alert-title { color: #1a7f37; }
.note .alert-important { border-left-color: #8250df; } .note .alert-important .alert-title { color: #8250df; }
.note .alert-warning { border-left-color: #9a6700; } .note .alert-warning .alert-title { color: #9a6700; }
.note .alert-caution { border-left-color: #cf222e; } .note .alert-caution .alert-title { color: #cf222e; }
:root[data-theme="dark"] .note .alert-note { border-left-color: #2f81f7; } :root[data-theme="dark"] .note .alert-note .alert-title { color: #2f81f7; }
:root[data-theme="dark"] .note .alert-tip { border-left-color: #3fb950; } :root[data-theme="dark"] .note .alert-tip .alert-title { color: #3fb950; }
:root[data-theme="dark"] .note .alert-important { border-left-color: #a371f7; } :root[data-theme="dark"] .note .alert-important .alert-title { color: #a371f7; }
:root[data-theme="dark"] .note .alert-warning { border-left-color: #d29922; } :root[data-theme="dark"] .note .alert-warning .alert-title { color: #d29922; }
:root[data-theme="dark"] .note .alert-caution { border-left-color: #f85149; } :root[data-theme="dark"] .note .alert-caution .alert-title { color: #f85149; }
`;

const EXPORT_CSS = `
:root, :root[data-theme="light"] {
  --bg:#fff; --bg-soft:#f6f8fa; --fg:#1f2328; --muted:#656d76; --border:#d0d7de; --accent:#0969da; --code-bg:#eff1f3;
}
:root[data-theme="dark"] {
  --bg:#0d1117; --bg-soft:#161b22; --fg:#e6edf3; --muted:#8b949e; --border:#30363d; --accent:#2f81f7; --code-bg:#161b22;
}
/* Scrollbars carry the document palette too, so a dark page does not show a
   bright platform scrollbar next to a dark code block. */
:root { --sb-track:var(--bg-soft); --sb-thumb:var(--muted); }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-track { background:var(--sb-track); }
::-webkit-scrollbar-thumb { background:var(--sb-thumb); border-radius:6px; }
::-webkit-scrollbar-thumb:hover { background:var(--accent); }
::-webkit-scrollbar-corner { background:var(--sb-track); }
@supports (-moz-appearance:none) { :root { scrollbar-width:thin; scrollbar-color:var(--sb-thumb) var(--sb-track); } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; font-size:16px; line-height:1.65; }
.doc-controls { position:fixed; top:14px; right:14px; z-index:10; display:flex; gap:6px; }
.doc-controls button { min-width:38px; height:38px; padding:0 10px; border:1px solid var(--border); background:var(--bg); color:var(--fg); border-radius:19px; cursor:pointer; font-size:14px; font-weight:600; display:flex; align-items:center; justify-content:center; }
.doc-controls button:hover { background:var(--bg-soft); }
.note-footer { max-width:760px; margin:0 auto; padding:0 20px 48px; color:var(--muted); font-size:12px; }
.note { max-width:760px; margin:0 auto; padding:32px 20px 80px; overflow-wrap:anywhere; }
.note > *:first-child { margin-top:0; }
.note h1 { font-size:1.9em; margin:1.2em 0 .5em; padding-bottom:.3em; border-bottom:1px solid var(--border); }
.note h2 { font-size:1.5em; margin:1.1em 0 .5em; padding-bottom:.3em; border-bottom:1px solid var(--border); }
.note h3 { font-size:1.25em; margin:1em 0 .4em; }
.note h4,.note h5,.note h6 { margin:1em 0 .4em; }
.note h4 { font-size:1.05em; }
.note h5,.note h6 { font-size:.95em; color:var(--muted); }
.note strong { font-weight:700; }
.note em { font-style:italic; }
.note p { margin:.65em 0; }
.note a { color:var(--accent); text-decoration:none; }
.note a:hover { text-decoration:underline; }
.note ul,.note ol { margin:.6em 0; padding-inline-start:1.6em; }
.note li { margin:.25em 0; }
.note li input[type="checkbox"] { margin-inline-end:.4em; transform:translateY(-1px); }
.note li.task-list-item { list-style:none; }
.note li.task-list-item + li.task-list-item { margin-top:3px; }
.note ul.pure-task-list,.note ol.pure-task-list { padding-inline-start:0; }
.note li:has(> input[type="checkbox"]) { list-style:none; }
.note blockquote:not(.alert) { margin:.8em 0; padding:.2em 1em; color:var(--muted); border-left:3px solid var(--border); }
.note code { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:.88em; background:var(--code-bg); padding:.15em .4em; border-radius:5px; }
.note pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow-x:auto; margin:.8em 0; white-space:pre-wrap; overflow-wrap:anywhere; }
.note pre code { background:none; padding:0; font-size:.85em; line-height:1.5; }
.note img { max-width:100%; height:auto; border-radius:8px; margin:.6em 0; }
.note video { max-width:100%; border-radius:8px; margin:.6em 0; }
.note audio { width:100%; margin:.6em 0; }
.note hr { border:0; border-top:1px solid var(--border); margin:1.4em 0; }
.note table { border-collapse:collapse; width:100%; margin:.8em 0; font-size:.95em; }
/* Cells default to centered; GFM alignment arrives as an align *attribute*, which
   any bare text-align would override, so each case is spelled out explicitly. */
.note th[align="left"],.note td[align="left"] { text-align:left; }
.note th[align="center"],.note td[align="center"] { text-align:center; }
.note th[align="right"],.note td[align="right"] { text-align:right; }
.note th,.note td { border:1px solid var(--border); padding:6px 10px; text-align:center; }
.note th { background:var(--bg-soft); font-weight:700; }
.note tr:nth-child(even) td { background:var(--bg-soft); }
${ALERT_CSS}
[dir="rtl"] .note { direction:rtl; }
[dir="rtl"] .note pre,[dir="rtl"] .note pre code,[dir="rtl"] .note :not(pre) > code { direction:ltr; unicode-bidi:isolate; text-align:left; }
[dir="rtl"] .note blockquote:not(.alert),[dir="rtl"] .note .alert { border-left:0; border-right:3px solid var(--border); }
[dir="rtl"] .note .alert-note { border-right-color:#0969da; }
[dir="rtl"] .note .alert-tip { border-right-color:#1a7f37; }
[dir="rtl"] .note .alert-important { border-right-color:#8250df; }
[dir="rtl"] .note .alert-warning { border-right-color:#9a6700; }
[dir="rtl"] .note .alert-caution { border-right-color:#cf222e; }
[dir="rtl"][data-theme="dark"] .note .alert-note { border-right-color:#2f81f7; }
[dir="rtl"][data-theme="dark"] .note .alert-tip { border-right-color:#3fb950; }
[dir="rtl"][data-theme="dark"] .note .alert-important { border-right-color:#a371f7; }
[dir="rtl"][data-theme="dark"] .note .alert-warning { border-right-color:#d29922; }
[dir="rtl"][data-theme="dark"] .note .alert-caution { border-right-color:#f85149; }
@media (max-width:600px){ .note{ padding:20px 14px 60px; } .note-footer{ padding:0 14px 40px; } }
`;

function buildExportHtml(body) {
  const t = document.documentElement.dataset.theme || 'light';
  const d = document.documentElement.dataset.dir === 'rtl' ? 'rtl' : 'ltr';
  return `<!doctype html>
<html lang="en" dir="${d}" data-theme="${t}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MD-XDC</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="doc-controls">
  <button id="size-down" type="button" title="Decrease text size" aria-label="Decrease text size">A−</button>
  <button id="size-up" type="button" title="Increase text size" aria-label="Increase text size">A+</button>
  <button id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">🌙</button>
</div>
<article class="note">
${body}
</article>
<p class="note-footer">Powered by MD-XDC</p>
<script>
(function(){
  var t = localStorage.getItem('mdx-theme') || '${t}';
  document.documentElement.dataset.theme = t;
  var b = document.getElementById('theme-toggle');
  b.textContent = t === 'dark' ? '☀️' : '🌙';
  b.addEventListener('click', function(){
    t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    localStorage.setItem('mdx-theme', t);
    b.textContent = t === 'dark' ? '☀️' : '🌙';
  });
  // Text size: the note scales with the body font size (headings and code are em-based,
  // so everything follows). Kept per document in localStorage.
  var size = parseFloat(localStorage.getItem('mdx-size')) || 16;
  function applySize() {
    size = Math.min(24, Math.max(12, size));
    document.body.style.fontSize = size + 'px';
    localStorage.setItem('mdx-size', size);
  }
  applySize();
  document.getElementById('size-up').addEventListener('click', function(){ size += 1; applySize(); });
  document.getElementById('size-down').addEventListener('click', function(){ size -= 1; applySize(); });
})();
<\/script>
</body>
</html>`;
}

/* ---------------- Send dialog (app name + icon) ---------------- */
const APP_NAME_KEY = 'mdx-app-name';
const APP_ICON_KEY = 'mdx-app-icon';
const ICON_SIZE = 256;
let iconMode = 'default';  // 'default' (the drawn icon.png) | 'custom' (user's image)
let pendingIcon = null;    // { dataUrl, blob } — a custom icon picked by the user
let defaultIcon = null;    // { dataUrl, blob } — drawn once, ships as icon.png
let defaultIconJob = null;

// webxdc icons must be PNG, so convert whatever was picked and cap it at 256px.
async function imageToIconPng(file) {
  const MAX = 256;
  let source;
  if (typeof createImageBitmap === 'function') {
    source = await createImageBitmap(file);
  } else {
    source = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not read that image'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, MAX / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Icon conversion failed'))), 'image/png'));
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// roundRect() on the 2d context is newer than what a webxdc webview is
// guaranteed to have, so the path is traced by hand.
function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// The default icon is drawn rather than shipped as a file, so the project stays
// pure source with no binary asset to keep in sync. It is a page that becomes an
// arrow — a markdown note turning into the app.
function drawDefaultIcon() {
  const c = document.createElement('canvas');
  c.width = c.height = ICON_SIZE;
  const ctx = c.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, ICON_SIZE, ICON_SIZE);
  bg.addColorStop(0, '#2563eb');
  bg.addColorStop(1, '#7c3aed');
  roundedRect(ctx, 0, 0, ICON_SIZE, ICON_SIZE, 56);
  ctx.fillStyle = bg;
  ctx.fill();

  // The sheet of markdown, with a few lines of text.
  ctx.fillStyle = 'rgba(255,255,255,.96)';
  roundedRect(ctx, 36, 52, 96, 152, 12);
  ctx.fill();
  ctx.fillStyle = 'rgba(79,70,229,.45)';
  for (const [y, w] of [[100, 60], [124, 60], [148, 44]]) {
    roundedRect(ctx, 54, y, w, 10, 5);
    ctx.fill();
  }

  // The arrow it turns into.
  ctx.fillStyle = '#fff';
  roundedRect(ctx, 148, 120, 46, 16, 8);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(186, 98);
  ctx.lineTo(222, 128);
  ctx.lineTo(186, 158);
  ctx.closePath();
  ctx.fill();

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the default icon'))), 'image/png'));
}

// The icon.png that sits next to the app is the default app icon — a real asset
// you can swap out without touching code. It is normalised through the same
// canvas path as a picked image, so an oversized replacement is capped at 256px
// and always ships as PNG.
async function loadIconFile() {
  // no-cache: swapping icon.png should show up on the next dialog, not after a
  // hard reload.
  const res = await fetch('icon.png', { cache: 'no-cache' });
  if (!res.ok) throw new Error('icon.png missing');
  const blob = await res.blob();
  if (!blob.size) throw new Error('icon.png empty');
  return await imageToIconPng(blob);
}

function ensureDefaultIcon() {
  if (defaultIcon) return Promise.resolve(defaultIcon);
  if (!defaultIconJob) {
    defaultIconJob = (async () => {
      let blob;
      try {
        blob = await loadIconFile();
      } catch (e) {
        // No icon.png beside the app (or it could not be read): draw the built-in
        // one so an export is never left without an icon.
        blob = await drawDefaultIcon();
      }
      defaultIcon = { dataUrl: await blobToDataUrl(blob), blob };
      return defaultIcon;
    })()
      // Clear on failure so a later attempt can retry instead of caching the error.
      .catch((e) => { defaultIconJob = null; throw e; });
  }
  return defaultIconJob;
}

const ICON_LABELS = {
  default: 'App icon — icon.png ships with the app',
  custom: 'App icon — your image is stored as a 256px PNG',
};

function updateIconUI() {
  const shown = iconMode === 'custom' ? pendingIcon : iconMode === 'default' ? defaultIcon : null;
  const box = $('icon-preview');
  box.textContent = '';
  if (shown) {
    const img = document.createElement('img');
    img.src = shown.dataUrl; img.alt = 'App icon preview';
    box.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.textContent = 'none';
    box.appendChild(span);
  }
  box.title = shown ? ICON_LABELS[iconMode] : 'No icon';
  $('icon-label').textContent = ICON_LABELS[iconMode];
  $('icon-default').setAttribute('aria-pressed', String(iconMode === 'default'));
}

// The default icon may still be drawing when the dialog opens, so the preview is
// painted twice: once from whatever is ready, then again when the icon exists.
function useDefaultIcon() {
  iconMode = 'default';
  updateIconUI();
  ensureDefaultIcon().then(updateIconUI).catch(() => {});
}

function defaultAppName() {
  const saved = localStorage.getItem(APP_NAME_KEY);
  if (saved) return saved;
  // First heading of the note, so the chat entry reads like the document.
  const heading = (editorText(editorEl).match(/^#{1,6}\s+(.+)$/m) || [])[1];
  return (heading || '').trim().slice(0, 60) || 'MD-XDC';
}

// Stored media that the note never references would be left out of the .xdc
// without a trace, so the dialog says so and points at the library.
function refreshSendWarn() {
  const warn = $('send-media-warn');
  dbAll().then((items) => {
    const unused = unusedMediaItems(items);
    if (!unused.length) { warn.hidden = true; return; }
    warn.textContent = '';
    const label = document.createElement('span');
    label.textContent = `${unused.length} stored file${unused.length === 1 ? ' is' : 's are'} not used in the note — it will not be packed into the .xdc.`;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'warn-link';
    link.textContent = 'Media library';
    link.title = 'Review which files are unused';
    // The send dialog stays open underneath, so a custom app name survives.
    link.addEventListener('click', () => {
      // The library modal sits later in the DOM, but both share z-index 50 —
      // mark it explicitly so it stacks on top of the send dialog.
      $('media-modal').classList.add('stack-top');
      openMedia();
    });
    warn.append(label, link);
    warn.hidden = false;
  }).catch(() => { warn.hidden = true; });
}

function openSendDialog() {
  refreshSendWarn();

  if (!pendingIcon) {
    const saved = localStorage.getItem(APP_ICON_KEY);
    if (saved) { try { pendingIcon = { dataUrl: saved, blob: dataUrlToBlob(saved) }; iconMode = 'custom'; } catch (e) { pendingIcon = null; } }
  }
  $('app-name').value = defaultAppName();
  updateIconUI();
  $('send-modal').hidden = false;
  // Only needed for the 'default' mode, and it only ever draws once.
  if (iconMode === 'default') ensureDefaultIcon().then(updateIconUI).catch(() => {});
}
function closeSendDialog() { $('send-modal').hidden = true; }

$('send-close').addEventListener('click', closeSendDialog);
$('send-cancel').addEventListener('click', closeSendDialog);
$('send-modal').addEventListener('click', (e) => { if (e.target === $('send-modal')) closeSendDialog(); });
$('icon-pick').addEventListener('click', () => $('icon-file').click());
$('icon-default').addEventListener('click', useDefaultIcon);
$('icon-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await imageToIconPng(file);
    pendingIcon = { dataUrl: await blobToDataUrl(blob), blob };
    iconMode = 'custom';
    updateIconUI();
  } catch (err) { toast('Could not use that image'); }
});
$('send-confirm').addEventListener('click', async () => {
  const name = ($('app-name').value || '').trim().slice(0, 60) || 'MD-XDC';
  localStorage.setItem(APP_NAME_KEY, name);
  if (pendingIcon && pendingIcon.dataUrl.length < 200000) {
    try { localStorage.setItem(APP_ICON_KEY, pendingIcon.dataUrl); } catch (e) { /* too big to remember */ }
  }
  // An icon always ships now, so the manifest always points at icon.png.
  let icon = null;
  if (iconMode === 'custom' && pendingIcon) {
    icon = pendingIcon.blob;
  } else {
    try { icon = (await ensureDefaultIcon()).blob; } catch (e) { icon = null; }
  }
  closeSendDialog();
  exportXdc({ name, icon });
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportXdc(opts = {}) {
  const btn = $('btn-export');
  const label = $('btn-export-label');
  const idleLabel = label.textContent;
  const appName = (opts.name || 'MD-XDC').slice(0, 60);
  const manifest = `name = ${JSON.stringify(appName)}\n` + (opts.icon ? 'icon = "icon.png"\n' : '');
  // Only the label is swapped: the icon lives beside it, so it must survive
  // (overwriting button textContent would delete the inline SVG for good).
  btn.disabled = true;
  btn.classList.add('busy');
  label.textContent = 'Packing…';
  try {
    const md = editorText(editorEl);
    let body = marked.parse(md);
    const refs = [...new Set(md.match(MEDIA_REF_RE) || [])];
    const files = [
      new File([buildExportHtml(body)], 'index.html', { type: 'text/html' }),
      new File([EXPORT_CSS], 'style.css', { type: 'text/css' }),
      new File([manifest], 'manifest.toml', { type: 'text/plain' }),
    ];
    if (opts.icon) files.push(new File([opts.icon], 'icon.png', { type: 'image/png' }));
    for (const ref of refs) {
      const name = ref.slice('media/'.length);
      const rec = await dbGet(name);
      if (!rec) continue;
      // Inline audio & video as data URIs so the browser has the full file
      // and can seek freely (webxdc file serving often lacks Range support).
      if (rec.type.startsWith('audio/') || rec.type.startsWith('video/')) {
        const dataUrl = await blobToDataUrl(rec.blob);
        const escRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        body = body
          .replace(new RegExp('src="' + escRef + '"', 'g'), 'src="' + dataUrl + '"')
          .replace(new RegExp("src='" + escRef + "'", 'g'), "src='" + dataUrl + "'");
      } else {
        files.push(new File([rec.blob], ref, { type: rec.type || 'application/octet-stream' }));
      }
    }
    // Rebuild index.html with the (possibly inlined) body so media seek works.
    files[0] = new File([buildExportHtml(body)], 'index.html', { type: 'text/html' });

    const zipBlob = await (await downloadZip(files)).blob();
    const safe = appName.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'note';
    const fname = `${safe}-${Date.now()}.xdc`;
    if (window.webxdc && typeof window.webxdc.sendToChat === 'function') {
      try {
        await window.webxdc.sendToChat({ file: { name: fname, blob: zipBlob }, text: appName });
        toast('Sent to chat');
      } catch (e) {
        console.error('sendToChat rejected:', e);
        downloadBlob(zipBlob, fname);
        toast('Could not send to chat — downloaded .xdc instead');
      }
    } else {
      downloadBlob(zipBlob, fname);
      toast('webxdc API not found — downloaded .xdc');
    }
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    label.textContent = idleLabel;
  }
}
// The .xdc is sent from the dialog, so the button opens it rather than exporting.
$('btn-export').addEventListener('click', openSendDialog);

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------------- Init ---------------- */
(async function init() {
  loadDoc();
  seedHistory();
  try {
    const items = await dbAll();
    items.forEach((r) => { mediaObjectUrls['media/' + r.name] = URL.createObjectURL(r.blob); });
    updateMediaCount();
  } catch (e) { /* IndexedDB unavailable */ }
  updateHighlight();
  renderPreview();
})();
