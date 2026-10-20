import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PLACEHOLDER_REF, defaultReviewState, defaultGuardState, reviewWorkflow, scanWorkflow, reviewConfig,
  reviewConfigText, guardWorkflow, guardConfig, guardConfigText, validateReview, validateGuard, resolvePin,
  isIsoDate, checkHttpsUrl,
} from '../generate.js';
import * as templates from '../templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const SHA = 'a'.repeat(39) + 'b';
const PIN = { sha: SHA, tag: 'v1.4.2' };
const pinned = (text, repo) =>
  text.replaceAll(`simpli-software/${repo}@${PLACEHOLDER_REF}`, `simpli-software/${repo}@${SHA} # v1.4.2`);

// Light YAML-shape check (no YAML parser is available without dependencies).
function assertYamlShaped(text) {
  assert.ok(text.endsWith('\n'), 'ends with a newline');
  assert.ok(!text.includes('\t'), 'no tabs');
  assert.ok(!text.includes('\r'), 'LF line endings only');
  for (const key of ['name:', 'on:', 'permissions:', 'jobs:']) {
    assert.match(text, new RegExp(`^${key}`, 'm'), `top-level ${key}`);
  }
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    assert.equal((line.length - line.trimStart().length) % 2, 0, `even indentation: ${line}`);
  }
}

// ---------- workflows are the examples, byte for byte ----------

test('default Review workflow equals examples/code-review.yml apart from the pinned ref', () => {
  assert.equal(reviewWorkflow(defaultReviewState(), PIN), pinned(fixture('code-review.yml'), 'simpli-review'));
});

test('without a pin the workflow is the example, placeholder included', () => {
  assert.equal(reviewWorkflow(defaultReviewState(), null), fixture('code-review.yml'));
  assert.equal(scanWorkflow(null), fixture('ai-scan.yml'));
  assert.equal(guardWorkflow(null), fixture('security-scan.yml'));
});

test('AI scan workflow equals examples/ai-scan.yml apart from the pinned ref', () => {
  assert.equal(scanWorkflow(PIN), pinned(fixture('ai-scan.yml'), 'simpli-review'));
});

test('Guard workflow equals examples/security-scan.yml apart from both pinned refs', () => {
  const out = guardWorkflow(PIN);
  assert.equal(out, pinned(fixture('security-scan.yml'), 'simpli-guard'));
  assert.equal(out.match(new RegExp(`simpli-guard@${SHA} # v1.4.2`, 'g')).length, 2);
});

test('every pinned uses: line is a full hash with a version comment', () => {
  for (const text of [reviewWorkflow(defaultReviewState(), PIN), scanWorkflow(PIN), guardWorkflow(PIN)]) {
    const own = text.split('\n').filter((l) => l.includes('uses: simpli-software/'));
    assert.ok(own.length > 0);
    for (const line of own) assert.match(line, /@[0-9a-f]{40} # v\d/);
  }
});

test('generated workflows are YAML-shaped', () => {
  for (const text of [reviewWorkflow(defaultReviewState(), PIN), scanWorkflow(PIN), guardWorkflow(PIN)]) {
    assertYamlShaped(text);
  }
});

test('templates.js is in sync with the fixtures', () => {
  assert.equal(templates.CODE_REVIEW_TEMPLATE, fixture('code-review.yml'));
  assert.equal(templates.AI_SCAN_TEMPLATE, fixture('ai-scan.yml'));
  assert.equal(templates.SECURITY_SCAN_TEMPLATE, fixture('security-scan.yml'));
});

test('a custom heading changes only the name line', () => {
  const state = { ...defaultReviewState(), heading: 'Acme Review' };
  const a = reviewWorkflow(defaultReviewState(), PIN).split('\n');
  const b = reviewWorkflow(state, PIN).split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
  assert.equal(changed.length, 1);
  assert.match(changed[0][1], /^ {10}name: Acme Review {1,}# summary heading$/);
});

test('a heading that needs quoting is quoted', () => {
  const state = { ...defaultReviewState(), heading: 'Review: strict #1' };
  assert.match(reviewWorkflow(state, PIN), /name: "Review: strict #1" +# summary heading/);
  assertYamlShaped(reviewWorkflow(state, PIN));
});

test('push auto-review adds synchronize; labels are renamed everywhere', () => {
  const state = { ...defaultReviewState(), autoReview: ['open', 'push'], reReviewLabel: 'again', overrideLabel: 'skip-gate' };
  const text = reviewWorkflow(state, PIN);
  assert.match(text, /types: \[opened, reopened, ready_for_review, synchronize, labeled\]/);
  assert.match(text, /github\.event\.label\.name == 'again'/);
  assert.ok(!text.includes('re-review') && !text.includes('review-override'));
  assertYamlShaped(text);
});

// ---------- config JSON holds only non-default fields ----------

test('defaults produce an empty config for both tools', () => {
  assert.deepEqual(reviewConfig(defaultReviewState()), {});
  assert.deepEqual(guardConfig(defaultGuardState()), {});
  assert.equal(reviewConfigText(defaultReviewState()), '{}\n');
  assert.equal(guardConfigText(defaultGuardState()), '{}\n');
});

test('Review config contains exactly the fields that were changed', () => {
  const s = defaultReviewState();
  s.strictness = 3;
  s.commentTypes = ['style', 'logic']; // order is canonicalised
  s.blockOn = 'P1';
  s.builtinChecks['pr-template'] = 'off';
  s.maxComments = 10;
  s.excludeAuthors = ['dependabot[bot]'];
  s.checks = [{ name: 'tests-added', instructions: 'Every new branch has a test.', mode: 'error' }, { name: '', instructions: '', mode: 'warning' }];
  s.rules = [{ id: 'no-pii-logs', rule: 'Never log emails.', scope: [], severity: 'high' }];
  assert.deepEqual(reviewConfig(s), {
    strictness: 3,
    commentTypes: ['logic', 'style'],
    excludeAuthors: ['dependabot[bot]'],
    maxComments: 10,
    blockOn: 'P1',
    builtinChecks: { 'pr-template': 'off' },
    checks: [{ name: 'tests-added', instructions: 'Every new branch has a test.', mode: 'error' }],
    rules: [{ id: 'no-pii-logs', rule: 'Never log emails.', severity: 'high' }],
  });
  assert.deepEqual(validateReview(s), []);
});

test('rule scope is kept only when it differs from the whole repository', () => {
  const s = defaultReviewState();
  s.rules = [
    { id: 'a', rule: 'x', scope: ['backend/**/*.py'], severity: 'medium' },
    { id: 'b', rule: 'y', scope: ['**'], severity: 'medium' },
  ];
  assert.deepEqual(reviewConfig(s).rules, [{ id: 'a', rule: 'x', scope: ['backend/**/*.py'] }, { id: 'b', rule: 'y' }]);
});

test('scan settings appear only when the scan is on and differ from the defaults', () => {
  const s = defaultReviewState();
  s.scan = { ...s.scan, maxInputTokens: 1000000, maxIssues: 3 };
  assert.deepEqual(reviewConfig(s), {});
  s.scan.enabled = true;
  assert.deepEqual(reviewConfig(s), { scan: { maxInputTokens: 1000000, maxIssues: 3 } });
});

test('default ignorePatterns are omitted; a changed list is written as one newline-joined string', () => {
  const s = defaultReviewState();
  s.ignorePatterns = [...s.ignorePatterns, ''];
  assert.deepEqual(reviewConfig(s), {});
  s.ignorePatterns = ['*.lock', 'dist/**'];
  assert.deepEqual(reviewConfig(s), { ignorePatterns: '*.lock\ndist/**' });
});

test('Guard config contains exactly the fields that were changed', () => {
  const s = defaultGuardState();
  s.heading = 'Acme scan';
  s.failOn = 'medium';
  s.categories.license = false;
  s.surfaceUrls = ['https://app.example.com'];
  s.triage.maxFindings = 30;
  s.ignore = [
    { kind: 'rule', value: 'python.lang.security.audit.subprocess-shell-true', reason: 'fixed command list', expires: '2027-01-31' },
    { kind: 'path', value: 'scripts/**', reason: 'dev scripts', expires: '' },
    { kind: 'id', value: '', reason: '', expires: '' },
  ];
  s.testPaths = ['qa/**'];
  assert.deepEqual(guardConfig(s), {
    name: 'Acme scan',
    failOn: 'medium',
    categories: { license: false },
    surface: { urls: ['https://app.example.com'] },
    ignore: [
      { rule: 'python.lang.security.audit.subprocess-shell-true', reason: 'fixed command list', expires: '2027-01-31' },
      { path: 'scripts/**', reason: 'dev scripts' },
    ],
    triage: { maxFindings: 30 },
    testPaths: ['qa/**'],
  });
  assert.deepEqual(validateGuard(s, new Date('2026-10-20T00:00:00Z')), []);
});

// ---------- validation ----------

const paths = (errs) => errs.map((e) => e.path);

test('Review validation: unique rule ids, scope globs, check names, labels', () => {
  const s = defaultReviewState();
  s.rules = [
    { id: 'dup', rule: 'one', scope: [], severity: 'low' },
    { id: 'DUP', rule: 'two', scope: [], severity: 'low' },
    { id: 'ok', rule: '', scope: [' '], severity: 'low' },
    { id: 'spaces', rule: 'x', scope: ['a b'], severity: 'low' },
  ];
  s.checks = [
    { name: 'PR-Template', instructions: 'x', mode: 'warning' },
    { name: 'mine', instructions: '', mode: 'warning' },
  ];
  s.reReviewLabel = 'bad"label';
  s.commentTypes = [];
  s.minConfidence = 9;
  const got = paths(validateReview(s));
  for (const p of ['rules.1.id', 'rules.2.rule', 'rules.2.scope', 'rules.3.scope', 'checks.0.name', 'checks.1.instructions', 'reReviewLabel', 'commentTypes', 'minConfidence']) {
    assert.ok(got.includes(p), `expected an error at ${p}, got ${got}`);
  }
  assert.ok(!got.includes('rules.0.id'));
});

test('Review validation: scan numbers only checked when the scan is on', () => {
  const s = defaultReviewState();
  s.scan.maxTurns = 0;
  assert.deepEqual(validateReview(s), []);
  s.scan.enabled = true;
  assert.deepEqual(paths(validateReview(s)), ['scan.maxTurns']);
});

test('turning triage off writes only enabled:false', () => {
  const s = defaultGuardState();
  s.triage = { enabled: false, model: 'x', effort: 'high', maxFindings: 5 };
  assert.deepEqual(guardConfig(s), { triage: { enabled: false } });
  assert.deepEqual(validateGuard(s), []);
});

test('Guard validation: https URLs only', () => {
  assert.equal(checkHttpsUrl('https://app.example.com'), '');
  assert.equal(checkHttpsUrl('https://app.example.com/health?x=1'), '');
  for (const bad of ['http://app.example.com', 'app.example.com', 'ftp://x.example.com', 'https://', 'https://u:p@x.example.com', 'https://a b.example.com']) {
    assert.notEqual(checkHttpsUrl(bad), '', bad);
  }
  const s = defaultGuardState();
  s.surfaceUrls = ['https://ok.example.com', 'http://nope.example.com'];
  assert.deepEqual(paths(validateGuard(s)), ['surfaceUrls']);
});

test('Guard validation: ISO dates, reasons, selectors', () => {
  assert.ok(isIsoDate('2027-01-31'));
  for (const bad of ['2027-02-30', '2027-1-5', '31/01/2027', 'tomorrow', '2027-13-01', '']) assert.ok(!isIsoDate(bad), bad);
  const s = defaultGuardState();
  s.ignore = [
    { kind: 'rule', value: 'r', reason: ' ', expires: '2027-02-30' },
    { kind: 'path', value: '', reason: 'why', expires: '' },
    { kind: 'id', value: 'abc', reason: 'accepted', expires: '2020-01-01' },
  ];
  const errs = validateGuard(s, new Date('2026-10-20T00:00:00Z'));
  assert.deepEqual(errs.map((e) => `${e.level}:${e.path}`).sort(), [
    'error:ignore.0.expires', 'error:ignore.0.reason', 'error:ignore.1.value', 'warning:ignore.2.expires',
  ]);
});

// ---------- pinning ----------

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = routes[url.replace('https://api.github.com/repos/simpli-software/', '')];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit };
  };
  fn.calls = calls;
  return fn;
}

test('resolvePin reads a lightweight tag', async () => {
  const f = fakeFetch({
    'simpli-review/releases/latest': { tag_name: 'v1.3.1' },
    'simpli-review/git/ref/tags/v1.3.1': { object: { type: 'commit', sha: SHA } },
  });
  assert.deepEqual(await resolvePin('simpli-review', f), { tag: 'v1.3.1', sha: SHA });
});

test('resolvePin dereferences an annotated tag to its commit', async () => {
  const tagObject = 'c'.repeat(40);
  const f = fakeFetch({
    'simpli-guard/releases/latest': { tag_name: 'v1.2.0' },
    'simpli-guard/git/ref/tags/v1.2.0': { object: { type: 'tag', sha: tagObject } },
    [`simpli-guard/git/tags/${tagObject}`]: { object: { type: 'commit', sha: SHA } },
  });
  assert.deepEqual(await resolvePin('simpli-guard', f), { tag: 'v1.2.0', sha: SHA });
  assert.equal(f.calls.length, 3);
});

test('resolvePin fails closed on errors and odd data, so the placeholder is used', async () => {
  await assert.rejects(resolvePin('simpli-review', fakeFetch({})));
  await assert.rejects(resolvePin('simpli-review', fakeFetch({ 'simpli-review/releases/latest': { tag_name: 'v1\nuses: evil' } })));
  await assert.rejects(resolvePin('simpli-review', fakeFetch({
    'simpli-review/releases/latest': { tag_name: 'v1.0.0' },
    'simpli-review/git/ref/tags/v1.0.0': { object: { type: 'commit', sha: 'not-a-sha' } },
  })));
});
