// DOM glue for Simpli Gatehouse. All generation and validation lives in generate.js.
// Nothing typed here is stored or sent anywhere. The only network calls are the GitHub API
// lookups that resolve the latest release of each action to a commit hash.
import {
  DEFAULT_IGNORE_PATTERNS, MAX_CHECKS, reviewWorkflow, scanWorkflow,
  reviewConfig, guardWorkflow, guardConfig, toJsonText, validateReview, validateGuard, resolvePin,
} from './generate.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const lines = (text) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const num = (text) => (text.trim() === '' ? NaN : Number(text));
const checkedValues = (form, name) => $$(`input[name="${name}"]:checked`, form).map((i) => i.value);
const rowsOf = (form, group) => $$(`[data-row="${group}"]`, form);
const subValue = (row, name) => $(`[data-sub="${name}"]`, row).value;

// ---------- reading the forms into plain state ----------

function readReview(form) {
  const f = form.elements;
  const scope = (row) => {
    const raw = subValue(row, 'scope');
    const globs = lines(raw);
    return raw !== '' && globs.length === 0 ? [''] : globs; // spaces only: report it
  };
  return {
    heading: f.heading.value,
    strictness: Number(f.strictness.value),
    commentTypes: checkedValues(form, 'commentTypes'),
    minConfidence: num(f.minConfidence.value),
    maxComments: num(f.maxComments.value),
    includeDiagram: f.includeDiagram.checked,
    learnFromReactions: f.learnFromReactions.checked,
    autoReview: checkedValues(form, 'autoReview'),
    reReviewLabel: f.reReviewLabel.value.trim(),
    excludeAuthors: lines(f.excludeAuthors.value),
    blockOn: f.blockOn.value,
    overrideLabel: f.overrideLabel.value.trim(),
    builtinChecks: { 'pr-template': f['bc-pr-template'].value, 'declared-scope': f['bc-declared-scope'].value },
    checks: rowsOf(form, 'checks').map((row) => ({
      name: subValue(row, 'name'), instructions: subValue(row, 'instructions'), mode: subValue(row, 'mode'),
    })),
    ignorePatterns: f.ignorePatterns.value.split(/\r?\n/),
    instructions: f.instructions.value,
    rules: rowsOf(form, 'rules').map((row) => ({
      id: subValue(row, 'id'), rule: subValue(row, 'rule'), scope: scope(row), severity: subValue(row, 'severity'),
    })),
    scan: {
      enabled: f.scanEnabled.checked,
      maxTurns: num(f['scan-maxTurns'].value),
      effort: f['scan-effort'].value,
      maxInputTokens: num(f['scan-maxInputTokens'].value),
      maxIssues: num(f['scan-maxIssues'].value),
      minSeverity: f['scan-minSeverity'].value,
    },
  };
}

function readGuard(form) {
  const f = form.elements;
  return {
    heading: f.heading.value,
    failOn: f.failOn.value,
    categories: Object.fromEntries($$('input[name="cat"]', form).map((i) => [i.value, i.checked])),
    surfaceUrls: lines(f.surfaceUrls.value),
    triage: {
      enabled: f.triageEnabled.checked,
      model: f.triageModel.value,
      effort: f.triageEffort.value,
      maxFindings: num(f.triageMaxFindings.value),
    },
    ignore: rowsOf(form, 'ignore').map((row) => ({
      kind: subValue(row, 'kind'), value: subValue(row, 'value'), reason: subValue(row, 'reason'),
      expires: subValue(row, 'expires'),
    })),
    testPaths: lines(f.testPaths.value),
  };
}

// ---------- inline validation display ----------

let idCounter = 0;
const nextId = (prefix) => `${prefix}-${++idCounter}`;

/** Give hints and error lines ids and point each control at them with aria-describedby. */
function wire(root) {
  for (const field of $$('.field', root)) {
    const control = field.matches('fieldset') ? field : $('input, select, textarea', field);
    if (!control) continue;
    const ids = $$('.hint, .err', field).map((el) => (el.id ||= nextId('d')));
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
  }
}

function pathOf(control) {
  if (control.dataset.path) return control.dataset.path;
  const row = control.closest('[data-row]');
  const index = [...row.parentElement.children].indexOf(row);
  return `${row.dataset.row}.${index}.${control.dataset.sub}`;
}

function showErrors(form, issues) {
  const byPath = new Map();
  for (const issue of issues) {
    const known = byPath.get(issue.path);
    if (!known || (known.level === 'warning' && issue.level === 'error')) byPath.set(issue.path, issue);
  }
  for (const p of $$('.err', form)) {
    p.hidden = true;
    p.textContent = '';
    p.classList.remove('warn');
  }
  for (const control of $$('[data-path], [data-sub]', form)) {
    const issue = byPath.get(pathOf(control));
    const isField = control.matches('input, select, textarea');
    if (isField) control.removeAttribute('aria-invalid');
    if (!issue) continue;
    const message = $('.err', control.closest('.field'));
    if (!message) continue;
    message.textContent = issue.message;
    message.hidden = false;
    message.classList.toggle('warn', issue.level === 'warning');
    if (isField && issue.level === 'error') control.setAttribute('aria-invalid', 'true');
  }
  for (const p of $$('[data-group-err]', form)) {
    const issue = byPath.get(p.dataset.groupErr);
    p.textContent = issue ? issue.message : '';
    p.hidden = !issue;
  }
  return issues.filter((i) => i.level === 'error').length;
}

// ---------- outputs: preview, copy, download ----------

const outputs = new Map(); // id -> { text, filename, type }
const FILES = {
  'review-workflow': { card: 'file-review-workflow', filename: 'code-review.yml', type: 'text/yaml' },
  'review-scan': { card: 'file-review-scan', filename: 'ai-scan.yml', type: 'text/yaml' },
  'review-config': { card: 'file-review-config', filename: 'config.json', type: 'application/json' },
  'guard-workflow': { card: 'file-guard-workflow', filename: 'security-scan.yml', type: 'text/yaml' },
  'guard-config': { card: 'file-guard-config', filename: 'config.json', type: 'application/json' },
};

function setOutput(id, text) {
  const meta = FILES[id];
  outputs.set(id, { ...meta, text });
  const code = $('pre code', document.getElementById(meta.card));
  if (code.textContent !== text) code.textContent = text;
}

function setBlocked(key, errorCount) {
  const banner = document.getElementById(`blocked-${key}`);
  banner.hidden = errorCount === 0;
  banner.textContent = errorCount === 0
    ? ''
    : `Fix the ${errorCount} highlighted ${errorCount === 1 ? 'field' : 'fields'} to copy or download these files.`;
  for (const button of $$(`#panel-${key} [data-copy], #panel-${key} [data-download]`)) {
    button.disabled = errorCount > 0;
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the selection fallback
    }
  }
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.className = 'offscreen';
  document.body.append(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  box.remove();
  return ok;
}

const copiedTimers = new WeakMap();
function say(card, message) {
  const line = $('.copied', card);
  line.textContent = message;
  clearTimeout(copiedTimers.get(line));
  copiedTimers.set(line, setTimeout(() => { line.textContent = ''; }, 2500));
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.copy) {
    const out = outputs.get(button.dataset.copy);
    const card = button.closest('.file');
    say(card, (await copyText(out.text)) ? 'Copied.' : 'Could not copy. Select the text and copy it by hand.');
  } else if (button.dataset.download) {
    const out = outputs.get(button.dataset.download);
    const url = URL.createObjectURL(new Blob([out.text], { type: `${out.type};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = out.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(button.closest('.file'), `Downloaded ${out.filename}.`);
  }
});

// ---------- pinning ----------

const pins = { review: null, guard: null };
const PIN_REPOS = { review: 'simpli-review', guard: 'simpli-guard' };

function showPinNote(key, state, pin) {
  const note = document.getElementById(`pin-${key}`);
  note.classList.toggle('warn', state === 'failed');
  if (state === 'ok') {
    note.textContent = `Pinned to ${pin.tag} (commit ${pin.sha.slice(0, 12)}). The files carry the full hash, so a moved tag cannot change what runs in your pipeline.`;
  } else if (state === 'failed') {
    note.textContent = `Could not look up the latest ${PIN_REPOS[key]} release (offline, rate-limited or not published yet), so the files keep the placeholder "<commit-sha> # v1.x". Before you commit, replace it with the full commit hash of the release you want and keep its version in the comment.`;
  }
}

async function loadPin(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    pins[key] = await resolvePin(PIN_REPOS[key], (url) =>
      fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }));
    showPinNote(key, 'ok', pins[key]);
  } catch {
    pins[key] = null;
    showPinNote(key, 'failed');
  } finally {
    clearTimeout(timer);
    refresh(key);
  }
}

// ---------- refresh ----------

const forms = {
  review: document.getElementById('form-review'),
  guard: document.getElementById('form-guard'),
};

function toggleEmptyNote(configId, config) {
  $('[data-empty-note]', document.getElementById(FILES[configId].card)).hidden = Object.keys(config).length > 0;
}

function refresh(key) {
  const form = forms[key];
  if (key === 'review') {
    const state = readReview(form);
    const errors = showErrors(form, validateReview(state));
    $('#scan-fields').disabled = !state.scan.enabled;
    document.getElementById('file-review-scan').hidden = !state.scan.enabled;
    setOutput('review-workflow', reviewWorkflow(state, pins.review));
    if (state.scan.enabled) setOutput('review-scan', scanWorkflow(pins.review));
    const config = reviewConfig(state);
    setOutput('review-config', toJsonText(config));
    toggleEmptyNote('review-config', config);
    $('[data-label-name="review"]').textContent = state.reReviewLabel || 're-review';
    $('[data-add="checks"]').disabled = state.checks.length >= MAX_CHECKS;
    setBlocked('review', errors);
  } else {
    const state = readGuard(form);
    const errors = showErrors(form, validateGuard(state));
    $('#triage-fields').disabled = !state.triage.enabled;
    setOutput('guard-workflow', guardWorkflow(pins.guard));
    const config = guardConfig(state);
    setOutput('guard-config', toJsonText(config));
    toggleEmptyNote('guard-config', config);
    setBlocked('guard', errors);
  }
}

for (const key of Object.keys(forms)) {
  forms[key].addEventListener('input', () => refresh(key));
  forms[key].addEventListener('change', () => refresh(key));
  forms[key].addEventListener('submit', (e) => e.preventDefault());
}

// ---------- add / remove rows ----------

const IGNORE_PLACEHOLDERS = {
  rule: 'python.lang.security.audit.eval-detected',
  path: 'scripts/**',
  id: '3f1c0a9e2b7d4c55a1e0f2b3',
};

function addRow(group, focus = true) {
  const form = group === 'ignore' ? forms.guard : forms.review;
  const list = $(`[data-rows="${group}"]`, form);
  const row = document.getElementById(`tpl-${group}`).content.firstElementChild.cloneNode(true);
  list.append(row);
  wire(row);
  if (focus) $('input, textarea', row).focus();
  refresh(group === 'ignore' ? 'guard' : 'review');
}

document.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add]');
  if (add) {
    addRow(add.dataset.add);
    return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const row = remove.closest('[data-row]');
    const key = forms.guard.contains(row) ? 'guard' : 'review';
    const addButton = $(`[data-add="${row.dataset.row}"]`, forms[key]);
    row.remove();
    refresh(key);
    addButton.focus();
  }
});

forms.guard.addEventListener('change', (event) => {
  const select = event.target;
  if (select.matches('[data-sub="kind"]')) {
    $('[data-sub="value"]', select.closest('[data-row]')).placeholder = IGNORE_PLACEHOLDERS[select.value];
  }
});

// ---------- tabs ----------

const tabs = $$('[role="tab"]');
function selectTab(tab, { focus = false, updateHash = true } = {}) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  if (updateHash) history.replaceState(null, '', `#${tab.id.replace('tab-', '')}`);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    const target = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1],
    }[event.key];
    if (target) {
      event.preventDefault();
      selectTab(target, { focus: true });
    }
  });
}

// ---------- start ----------

$('#r-ignore').value = DEFAULT_IGNORE_PATTERNS.join('\n');
// The defaults in the markup must match generate.js, or "only non-default fields" would be wrong.
console.assert(JSON.stringify(reviewConfig(readReview(forms.review))) === '{}', 'review form defaults drifted');
console.assert(JSON.stringify(guardConfig(readGuard(forms.guard))) === '{}', 'guard form defaults drifted');

wire(document);
const startTab = document.getElementById(`tab-${location.hash.slice(1)}`);
if (startTab) selectTab(startTab, { updateHash: false });
refresh('review');
refresh('guard');
loadPin('review');
loadPin('guard');
