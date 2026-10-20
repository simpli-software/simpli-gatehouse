// Pure generators and validators for Simpli Gatehouse. No DOM, no storage, no network
// except resolvePin(), which takes the fetch function as an argument.
import { CODE_REVIEW_TEMPLATE, AI_SCAN_TEMPLATE, SECURITY_SCAN_TEMPLATE } from './templates.js';

export const PLACEHOLDER_REF = '<commit-sha> # v1.x';

export const PATHS = {
  reviewWorkflow: '.github/workflows/code-review.yml',
  scanWorkflow: '.github/workflows/ai-scan.yml',
  reviewConfig: '.simpli-review/config.json',
  guardWorkflow: '.github/workflows/security-scan.yml',
  guardConfig: '.simpli-guard/config.json',
};

// ---------- defaults (they match the tools' own defaults) ----------

export const COMMENT_TYPES = ['logic', 'syntax', 'style'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CHECK_MODES = ['off', 'warning', 'error'];
export const BUILTIN_CHECKS = ['pr-template', 'declared-scope'];
export const RULE_SEVERITIES = ['low', 'medium', 'high'];
export const MAX_CHECKS = 20;
export const MAX_CHECK_NAME = 50;
export const MAX_CHECK_INSTRUCTIONS = 1000;

export const DEFAULT_IGNORE_PATTERNS = [
  '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'uv.lock', '*.min.js', '*.map',
  'dist/**', 'build/**', 'node_modules/**', '.venv/**', '*.svg', '*.png', '*.jpg', '*.pdf',
];

export const GUARD_CATEGORIES = ['sast', 'dependency', 'secret', 'iac', 'container', 'license', 'surface', 'actions'];
export const GUARD_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export function defaultReviewState() {
  return {
    heading: 'Code Review',
    strictness: 2,
    commentTypes: [...COMMENT_TYPES],
    minConfidence: 3,
    maxComments: 15,
    includeDiagram: true,
    learnFromReactions: true,
    autoReview: ['open'],
    reReviewLabel: 're-review',
    excludeAuthors: [],
    blockOn: 'none',
    overrideLabel: 'review-override',
    builtinChecks: { 'pr-template': 'warning', 'declared-scope': 'warning' },
    checks: [], // { name, instructions, mode }
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
    instructions: '',
    rules: [], // { id, rule, scope: string[], severity }
    scan: { enabled: false, maxTurns: 60, effort: 'high', maxInputTokens: 3000000, maxIssues: 5, minSeverity: 'P1' },
  };
}

export function defaultGuardState() {
  return {
    heading: 'Security scan',
    failOn: 'high',
    categories: Object.fromEntries(GUARD_CATEGORIES.map((c) => [c, true])),
    surfaceUrls: [],
    triage: { enabled: true, model: 'claude-sonnet-5-5', effort: 'medium', maxFindings: 60 },
    ignore: [], // { kind: 'rule' | 'path' | 'id', value, reason, expires }
    testPaths: [],
  };
}

// ---------- small helpers ----------

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');
const isInt = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;

// A YAML scalar that is safe on one line: plain when obviously safe, else double-quoted.
function yamlScalar(s) {
  const plain = /^[A-Za-z][A-Za-z0-9 _./()-]*$/.test(s) && s === s.trim() &&
    !/^(true|false|yes|no|null|on|off|y|n)$/i.test(s);
  return plain ? s : JSON.stringify(s);
}

function replaceOnce(text, needle, replacement, what) {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`template changed: ${what} not found`);
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

function replaceEvery(text, needle, replacement, what) {
  if (!text.includes(needle)) throw new Error(`template changed: ${what} not found`);
  return text.split(needle).join(replacement);
}

/** Replace the `<commit-sha> # v1.x` placeholder on every simpli-software `uses:` line. */
export function applyPin(template, repo, pin) {
  const needle = `simpli-software/${repo}@${PLACEHOLDER_REF}`;
  const ref = pin ? `${pin.sha} # ${pin.tag}` : PLACEHOLDER_REF;
  return replaceEvery(template, needle, `simpli-software/${repo}@${ref}`, `${repo} uses: line`);
}

// ---------- pinning ----------

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Latest release tag of simpli-software/<repo> and the commit it points to.
 * Annotated tags are dereferenced to the commit. Throws on any failure.
 * fetchFn is passed in so the caller owns timeouts and so tests need no network.
 */
export async function resolvePin(repo, fetchFn) {
  const base = `https://api.github.com/repos/simpli-software/${repo}`;
  const get = async (path) => {
    const res = await fetchFn(base + path);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return res.json();
  };
  const release = await get('/releases/latest');
  const tag = release && release.tag_name;
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new Error('unexpected release tag');
  const ref = await get(`/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref && ref.object;
  for (let i = 0; i < 5 && object && object.type === 'tag'; i++) {
    object = (await get(`/git/tags/${object.sha}`)).object;
  }
  if (!object || object.type !== 'commit' || !SHA_RE.test(object.sha)) {
    throw new Error('tag does not point to a commit');
  }
  return { tag, sha: object.sha };
}

// ---------- Review ----------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/;

const isBlankCheck = (c) => !trimmed(c.name) && !trimmed(c.instructions);
const isBlankRule = (r) => !trimmed(r.id) && !trimmed(r.rule) && (r.scope || []).every((g) => !trimmed(g));
const activeChecks = (s) => s.checks.filter((c) => !isBlankCheck(c));
const activeRules = (s) => s.rules.filter((r) => !isBlankRule(r));

export function validateReview(state) {
  const out = [];
  const err = (path, message) => out.push({ path, message, level: 'error' });

  const heading = trimmed(state.heading);
  if (!heading) err('heading', 'Enter a heading for the summary comment.');
  else if (heading.length > 80) err('heading', 'Keep the heading to 80 characters or fewer.');
  else if (/[\r\n]/.test(state.heading)) err('heading', 'The heading must be a single line.');

  if (state.commentTypes.length === 0) err('commentTypes', 'Choose at least one comment type, or nothing is ever posted.');
  if (!isInt(state.minConfidence, 1, 5)) err('minConfidence', 'Enter a whole number from 1 to 5.');
  if (!isInt(state.maxComments, 0)) err('maxComments', 'Enter a whole number, 0 or more.');

  for (const [path, value] of [['reReviewLabel', state.reReviewLabel], ['overrideLabel', state.overrideLabel]]) {
    if (!LABEL_RE.test(value || '')) {
      err(path, 'Use 1 to 50 letters, digits, spaces or . _ : / - and start with a letter or digit.');
    }
  }
  if (!out.some((e) => e.path === 'overrideLabel') && state.reReviewLabel === state.overrideLabel) {
    err('overrideLabel', 'Use a different label from the re-review label.');
  }

  const seenChecks = new Set(BUILTIN_CHECKS);
  const checks = activeChecks(state);
  if (checks.length > MAX_CHECKS) err('checks', `At most ${MAX_CHECKS} custom checks.`);
  state.checks.forEach((c, i) => {
    if (isBlankCheck(c)) return;
    const name = trimmed(c.name);
    if (!name) err(`checks.${i}.name`, 'Give the check a name.');
    else if (name.length > MAX_CHECK_NAME) err(`checks.${i}.name`, `Names are up to ${MAX_CHECK_NAME} characters.`);
    else if (seenChecks.has(name.toLowerCase())) {
      err(`checks.${i}.name`, 'Check names must be unique and cannot reuse a built-in name.');
    }
    seenChecks.add(name.toLowerCase());
    const text = trimmed(c.instructions);
    if (!text) err(`checks.${i}.instructions`, 'Say what the model should check.');
    else if (text.length > MAX_CHECK_INSTRUCTIONS) {
      err(`checks.${i}.instructions`, `Instructions are up to ${MAX_CHECK_INSTRUCTIONS} characters.`);
    }
  });

  const seenRules = new Set();
  state.rules.forEach((r, i) => {
    if (isBlankRule(r)) return;
    const id = trimmed(r.id);
    if (!id) err(`rules.${i}.id`, 'Give the rule an id.');
    else if (!ID_RE.test(id)) err(`rules.${i}.id`, 'Use letters, digits, . _ - and start with a letter or digit.');
    else if (seenRules.has(id.toLowerCase())) err(`rules.${i}.id`, 'Rule ids must be unique.');
    seenRules.add(id.toLowerCase());
    if (!trimmed(r.rule)) err(`rules.${i}.rule`, 'Write the rule in a sentence.');
    const scope = r.scope || [];
    if (scope.length > 0 && scope.some((g) => !trimmed(g))) {
      err(`rules.${i}.scope`, 'Scope has an empty glob. Add one glob per line, or clear the field to cover the whole repository.');
    } else if (scope.some((g) => /\\|\s/.test(g.trim()))) {
      err(`rules.${i}.scope`, 'Globs use forward slashes and contain no spaces.');
    }
  });

  if (state.scan.enabled) {
    const s = state.scan;
    if (!isInt(s.maxTurns, 1, 500)) err('scan.maxTurns', 'Enter a whole number from 1 to 500.');
    if (!isInt(s.maxInputTokens, 10000)) err('scan.maxInputTokens', 'Enter a whole number, 10000 or more.');
    if (!isInt(s.maxIssues, 0, 50)) err('scan.maxIssues', 'Enter a whole number from 0 to 50.');
  }
  return out;
}

/** The .simpli-review/config.json object, with only the fields that differ from the defaults. */
export function reviewConfig(state) {
  const d = defaultReviewState();
  const cfg = {};
  if (state.strictness !== d.strictness) cfg.strictness = state.strictness;
  const types = COMMENT_TYPES.filter((t) => state.commentTypes.includes(t));
  if (!sameList(types, d.commentTypes)) cfg.commentTypes = types;
  const auto = ['open', 'push'].filter((t) => state.autoReview.includes(t));
  if (!sameList(auto, d.autoReview)) cfg.autoReview = auto;
  if (state.excludeAuthors.length) cfg.excludeAuthors = state.excludeAuthors;
  const patterns = state.ignorePatterns.map(trimmed).filter(Boolean);
  if (!sameList(patterns, d.ignorePatterns)) cfg.ignorePatterns = patterns.join('\n');
  if (state.maxComments !== d.maxComments) cfg.maxComments = state.maxComments;
  if (state.minConfidence !== d.minConfidence) cfg.minConfidence = state.minConfidence;
  if (state.includeDiagram !== d.includeDiagram) cfg.includeDiagram = state.includeDiagram;
  if (state.learnFromReactions !== d.learnFromReactions) cfg.learnFromReactions = state.learnFromReactions;
  if (state.blockOn !== d.blockOn) cfg.blockOn = state.blockOn;
  if (state.overrideLabel !== d.overrideLabel) cfg.overrideLabel = state.overrideLabel;
  if (state.reReviewLabel !== d.reReviewLabel) cfg.reReviewLabel = state.reReviewLabel;

  const builtin = {};
  for (const name of BUILTIN_CHECKS) {
    if (state.builtinChecks[name] !== d.builtinChecks[name]) builtin[name] = state.builtinChecks[name];
  }
  if (Object.keys(builtin).length) cfg.builtinChecks = builtin;

  const checks = activeChecks(state).map((c) => {
    const item = { name: trimmed(c.name), instructions: trimmed(c.instructions) };
    if (c.mode !== 'warning') item.mode = c.mode;
    return item;
  });
  if (checks.length) cfg.checks = checks;

  if (state.scan.enabled) {
    const scan = {};
    for (const key of ['maxTurns', 'effort', 'maxInputTokens', 'maxIssues', 'minSeverity']) {
      if (state.scan[key] !== d.scan[key]) scan[key] = state.scan[key];
    }
    if (Object.keys(scan).length) cfg.scan = scan;
  }

  if (trimmed(state.instructions)) cfg.instructions = trimmed(state.instructions);

  const rules = activeRules(state).map((r) => {
    const item = { id: trimmed(r.id), rule: trimmed(r.rule) };
    const scope = (r.scope || []).map(trimmed).filter(Boolean);
    if (scope.length && !sameList(scope, ['**'])) item.scope = scope;
    if (r.severity !== 'medium') item.severity = r.severity;
    return item;
  });
  if (rules.length) cfg.rules = rules;
  return cfg;
}

export const toJsonText = (obj) => JSON.stringify(obj, null, 2) + '\n';

export function reviewConfigText(state) {
  return toJsonText(reviewConfig(state));
}

export function reviewWorkflow(state, pin) {
  const d = defaultReviewState();
  let text = applyPin(CODE_REVIEW_TEMPLATE, 'simpli-review', pin);
  const heading = trimmed(state.heading);
  if (heading !== d.heading) {
    const value = yamlScalar(heading);
    const pad = ' '.repeat(Math.max(1, 24 - `name: ${value}`.length));
    text = replaceOnce(
      text,
      '          name: Code Review       # summary heading',
      `          name: ${value}${pad}# summary heading`,
      'summary heading line',
    );
  }
  if (state.autoReview.includes('push')) {
    text = replaceOnce(
      text,
      'types: [opened, reopened, ready_for_review, labeled]',
      'types: [opened, reopened, ready_for_review, synchronize, labeled]',
      'pull_request types line',
    );
  }
  if (state.overrideLabel !== d.overrideLabel) {
    text = replaceEvery(text, 'review-override', state.overrideLabel, 'override label');
  }
  if (state.reReviewLabel !== d.reReviewLabel) {
    text = replaceEvery(text, 're-review', state.reReviewLabel, 're-review label');
  }
  return text;
}

export function scanWorkflow(pin) {
  return applyPin(AI_SCAN_TEMPLATE, 'simpli-review', pin);
}

// ---------- Guard ----------

export const isIsoDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export function checkHttpsUrl(value) {
  if (/\s/.test(value)) return 'URLs cannot contain spaces.';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Not a valid URL. Use the form https://app.example.com';
  }
  if (url.protocol !== 'https:') return 'Use an https:// URL.';
  if (!url.hostname) return 'The URL needs a host name.';
  if (url.username || url.password) return 'Do not put credentials in the URL.';
  return '';
}

const isBlankIgnore = (e) => !trimmed(e.value) && !trimmed(e.reason) && !trimmed(e.expires);
const activeIgnores = (s) => s.ignore.filter((e) => !isBlankIgnore(e));

export function validateGuard(state, today = new Date()) {
  const out = [];
  const err = (path, message) => out.push({ path, message, level: 'error' });
  const warn = (path, message) => out.push({ path, message, level: 'warning' });

  const heading = trimmed(state.heading);
  if (!heading) err('heading', 'Enter a heading for comments, issues and reports.');
  else if (heading.length > 80) err('heading', 'Keep the heading to 80 characters or fewer.');
  else if (/[\r\n]/.test(state.heading)) err('heading', 'The heading must be a single line.');

  state.surfaceUrls.forEach((u, i) => {
    const problem = checkHttpsUrl(u);
    if (problem) err('surfaceUrls', `Line ${i + 1}: ${problem}`);
  });

  const t = state.triage;
  if (t.enabled) {
    if (!trimmed(t.model) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed(t.model))) {
      err('triage.model', 'Enter a model name such as claude-sonnet-5-5.');
    }
    if (!isInt(t.maxFindings, 0, 100)) err('triage.maxFindings', 'Enter a whole number from 0 to 100.');
  }

  const todayIso = today.toISOString().slice(0, 10);
  state.ignore.forEach((e, i) => {
    if (isBlankIgnore(e)) return;
    if (!trimmed(e.value)) err(`ignore.${i}.value`, `Enter the ${e.kind === 'id' ? 'finding id' : e.kind} to ignore.`);
    if (!trimmed(e.reason)) err(`ignore.${i}.reason`, 'A reason is required. Entries without one are rejected.');
    const exp = trimmed(e.expires);
    if (exp) {
      if (!isIsoDate(exp)) err(`ignore.${i}.expires`, 'Use an ISO date, YYYY-MM-DD, that exists.');
      else if (exp < todayIso) warn(`ignore.${i}.expires`, 'This date has passed, so the entry would not apply.');
    }
  });

  state.testPaths.forEach((g, i) => {
    if (/\\|\s/.test(g)) err('testPaths', `Line ${i + 1}: globs use forward slashes and contain no spaces.`);
  });
  return out;
}

/** The .simpli-guard/config.json object, with only the fields that differ from the defaults. */
export function guardConfig(state) {
  const d = defaultGuardState();
  const cfg = {};
  const heading = trimmed(state.heading);
  if (heading !== d.heading) cfg.name = heading;
  if (state.failOn !== d.failOn) cfg.failOn = state.failOn;

  const categories = {};
  for (const c of GUARD_CATEGORIES) if (state.categories[c] === false) categories[c] = false;
  if (Object.keys(categories).length) cfg.categories = categories;

  if (state.surfaceUrls.length) cfg.surface = { urls: state.surfaceUrls };

  const ignore = activeIgnores(state).map((e) => {
    const item = { [e.kind]: trimmed(e.value), reason: trimmed(e.reason) };
    if (trimmed(e.expires)) item.expires = trimmed(e.expires);
    return item;
  });
  if (ignore.length) cfg.ignore = ignore;

  // With triage off, its other settings do nothing, so they are not written.
  const triage = {};
  if (!state.triage.enabled) {
    triage.enabled = false;
  } else {
    if (trimmed(state.triage.model) !== d.triage.model) triage.model = trimmed(state.triage.model);
    if (state.triage.effort !== d.triage.effort) triage.effort = state.triage.effort;
    if (state.triage.maxFindings !== d.triage.maxFindings) triage.maxFindings = state.triage.maxFindings;
  }
  if (Object.keys(triage).length) cfg.triage = triage;

  if (state.testPaths.length) cfg.testPaths = state.testPaths;
  return cfg;
}

export function guardConfigText(state) {
  return toJsonText(guardConfig(state));
}

export function guardWorkflow(pin) {
  return applyPin(SECURITY_SCAN_TEMPLATE, 'simpli-guard', pin);
}
