'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runs', '20260906-t05', 'manifest.json'), 'utf8'));
const negative = JSON.parse(fs.readFileSync(path.join(root, 'runs', '20260906-t05', 'negative.json'), 'utf8'));

test('derives the canonical three-state numerical story from evidence', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const model = deriveCanonicalViewModel(manifest, negative);

  assert.deepEqual(model.values, {
    opening: 50,
    openingDebt: 50,
    repayment: 20,
    repaidDebt: 30,
    limit: 60,
    request: 30,
    openingProposed: 80,
    repaymentProposed: 60,
    committed: 30,
    utilization: 60,
    headroom: 0,
    finalRequest: 1,
    finalRequestDecimal: '0.000001',
    finalProposed: 60.000001,
    finalProposedDecimal: '60.000001',
    utilizationDecimal: '60.000000',
    limitDecimal: '60.000000',
  });
  assert.deepEqual(model.decisions, {
    opening: 'REJECT',
    repayment: 'ALLOW',
    final: 'REJECT',
  });
  assert.equal(model.verified, true);
  assert.equal(model.evidence.length, 5);
  assert.equal(model.evidence[0].shortHash, '0xa5c0\u202642cd');
  assert.deepEqual(
    model.evidence.map((item) => item.label),
    ['Source Open', 'Source Repayment', 'Opening Proof Submission', 'Repayment Proof Submission', 'Credit Commitment'],
  );
});

test('fails closed when a recorded decision contradicts its arithmetic', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const changed = structuredClone(manifest);
  changed.destinationT12.demo.decisions.afterCommit.allowed = true;

  assert.throws(
    () => deriveCanonicalViewModel(changed, negative),
    /Evidence mismatch: final decision verdict/,
  );
});

test('fails closed when the canonical final request is coherently changed from one raw unit', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const changed = structuredClone(manifest);
  changed.destinationT12.demo.decisions.afterCommit.proposedUtilization = '60000002';

  assert.throws(
    () => deriveCanonicalViewModel(changed, negative),
    /Evidence mismatch: final request must be one minimum accounting unit/,
  );
});

test('fails closed when runtime proof verification is incomplete', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const changed = structuredClone(negative);
  changed.proofs[0].normal.verdict = false;
  const wrongMode = structuredClone(negative);
  wrongMode.proofs[1].normal.method = 'broadcast';

  assert.throws(
    () => deriveCanonicalViewModel(manifest, changed),
    /Evidence mismatch: runtime normal proof verdict/,
  );
  assert.throws(
    () => deriveCanonicalViewModel(manifest, wrongMode),
    /Evidence mismatch: runtime normal proof method/,
  );
});

test('fails closed when canonical evidence is missing or identifies another run', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const incomplete = structuredClone(manifest);
  delete incomplete.destinationT12.submissions['debt-repaid'];
  const otherRun = structuredClone(manifest);
  otherRun.runId = 'not-canonical';

  assert.throws(() => deriveCanonicalViewModel(incomplete, negative), /Evidence mismatch/);
  assert.throws(() => deriveCanonicalViewModel(otherRun, negative), /Evidence mismatch: canonical run ID/);
});

test('fails closed when matching gate or verifier identifiers are not EVM addresses', () => {
  const { deriveCanonicalViewModel } = require('../ui/app');
  const badGateManifest = structuredClone(manifest);
  const badGateNegative = structuredClone(negative);
  badGateManifest.destinationT12.gate.address = 'matching-but-malformed';
  badGateNegative.applicationGate = 'matching-but-malformed';
  const badVerifierManifest = structuredClone(manifest);
  const badVerifierNegative = structuredClone(negative);
  badVerifierManifest.destinationT12.verifier = '0x1234';
  badVerifierNegative.blockProver = '0x1234';

  assert.throws(
    () => deriveCanonicalViewModel(badGateManifest, badGateNegative),
    /Evidence mismatch: canonical gate address/,
  );
  assert.throws(
    () => deriveCanonicalViewModel(badVerifierManifest, badVerifierNegative),
    /Evidence mismatch: canonical verifier address/,
  );
});

test('static server exposes only the UI and canonical evidence files', () => {
  const { resolvePublicFile } = require('../scripts/serve-ui');

  assert.match(resolvePublicFile('/ui/app.js'), /ui[\\/]app\.js$/);
  assert.match(resolvePublicFile('/ui/styles.css'), /ui[\\/]styles\.css$/);
  assert.match(resolvePublicFile('/runs/20260906-t05/manifest.json'), /manifest\.json$/);
  assert.match(resolvePublicFile('/runs/20260906-t05/negative.json'), /negative\.json$/);
  assert.throws(() => resolvePublicFile('/.env'), /Not found/);
  assert.throws(() => resolvePublicFile('/contracts/cc3/VerifiedDebtGate.sol'), /Not found/);
  assert.throws(() => resolvePublicFile('/ui/../package.json'), /Not found/);
  assert.throws(() => resolvePublicFile('/ui/%2e%2e/package.json'), /Not found/);
});

test('HTTP server serves canonical JSON and rejects write methods', async (t) => {
  const { createUiServer } = require('../scripts/serve-ui');
  const server = createUiServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const redirectResponse = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(redirectResponse.status, 302);
  assert.equal(redirectResponse.headers.get('location'), '/ui/');

  const pageResponse = await fetch(`${origin}/ui/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /^text\/html/);
  assert.match(pageResponse.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(pageResponse.headers.get('content-security-policy'), /form-action 'none'/);
  const styleResponse = await fetch(`${origin}/ui/styles.css`);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get('content-type'), /^text\/css/);
  const manifestResponse = await fetch(`${origin}/runs/20260906-t05/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type'), /^application\/json/);
  assert.equal((await manifestResponse.json()).runId, '20260906-t05');

  const blockedResponse = await fetch(`${origin}/.env`);
  assert.equal(blockedResponse.status, 404);
  const writeResponse = await fetch(`${origin}/`, { method: 'POST' });
  assert.equal(writeResponse.status, 405);
  assert.equal(writeResponse.headers.get('allow'), 'GET, HEAD');
});

test('page provides the complete read-only story without embedded financial values', () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

  for (const copy of [
    'Verified external event',
    'Reconstructed financial state',
    'Independent policy',
    'Bounded commitment',
    'commitCredit</code> consumes',
    'STATE 1',
    'STATE 2',
    'STATE 3',
    'Canonical Testnet Evidence',
    'No transaction is created by this UI',
    'It does not prove creditworthiness, collateral, reserves, custody, or price',
    'raw =',
    'data-field="finalRequestDecimal"',
    'data-field="finalProposedDecimal"',
  ]) {
    assert.match(html, new RegExp(copy));
  }
  assert.doesNotMatch(html, />\s*(?:20|30|50|60)\s*</);
  assert.doesNotMatch(html, /<form|wallet connect|metamask/i);
  assert.match(html, /class="mode-switcher"[^>]*data-mode-switcher[^>]*hidden/);
  assert.match(html, /data-overview-control/);
  assert.equal((html.match(/data-focus-state=/g) || []).length, 3);
  assert.equal((html.match(/class="scenario /g) || []).length, 3);
  assert.match(html, /id="loading-state"/);
  assert.match(html, /id="error-state"/);
  assert.match(html, /id="demo"/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\/ui\//);
});

class TestClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class TestElement extends EventTarget {
  constructor(dataset = {}) {
    super();
    this.dataset = { ...dataset };
    this.classList = new TestClassList();
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    this.dispatchEvent(new Event('click'));
  }
}

function focusFixture() {
  const demo = new TestElement();
  const modeSwitcher = new TestElement();
  modeSwitcher.hidden = true;
  const overview = new TestElement();
  const status = new TestElement();
  const buttons = [1, 2, 3].map((state) => new TestElement({ focusState: String(state) }));
  const rows = [1, 2, 3].map((state) => new TestElement({ stateRow: String(state) }));
  const architecture = [
    new TestElement({ focusStates: '1 2' }),
    new TestElement({ focusStates: '1 2' }),
    new TestElement({ focusStates: '1 2 3' }),
    new TestElement({ focusStates: '3' }),
  ];
  const evidence = [
    new TestElement({ focusStates: '1' }),
    new TestElement({ focusStates: '2' }),
    new TestElement({ focusStates: '1' }),
    new TestElement({ focusStates: '2' }),
    new TestElement({ focusStates: '3' }),
  ];
  const one = (selector) => ({
    '#demo': demo,
    '[data-mode-switcher]': modeSwitcher,
    '[data-overview-control]': overview,
    '[data-mode-status]': status,
  }[selector] || null);
  const many = (selector) => ({
    '[data-focus-state]': buttons,
    '[data-state-row]': rows,
    '.architecture-flow [data-focus-states]': architecture,
    '.evidence-list [data-focus-states]': evidence,
  }[selector] || []);

  return {
    root: { querySelector: one, querySelectorAll: many },
    demo,
    modeSwitcher,
    overview,
    status,
    buttons,
    rows,
    architecture,
    evidence,
  };
}

test('focus controller keeps the overview visible and toggles one state at a time', () => {
  const { createFocusController } = require('../ui/app');
  const fixture = focusFixture();
  const controller = createFocusController(fixture.root);

  assert.equal(controller.activeState, null);
  assert.equal(fixture.modeSwitcher.hidden, false);
  assert.equal(fixture.demo.dataset.focusMode, 'overview');
  assert.equal(fixture.overview.getAttribute('aria-pressed'), 'true');
  assert.ok(fixture.rows.every((row) => !row.classList.contains('is-deemphasized')));

  fixture.buttons[1].click();
  assert.equal(controller.activeState, 2);
  assert.equal(fixture.demo.dataset.focusMode, 'state-2');
  assert.equal(fixture.status.textContent, 'STATE 2 FOCUS');
  assert.equal(fixture.buttons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(fixture.rows[1].classList.contains('is-focused'), true);
  assert.equal(fixture.rows[0].classList.contains('is-deemphasized'), true);
  assert.equal(fixture.rows[2].classList.contains('is-deemphasized'), true);
  assert.deepEqual(fixture.architecture.map((item) => item.classList.contains('is-focus-related')), [true, true, true, false]);
  assert.deepEqual(fixture.evidence.map((item) => item.classList.contains('is-focus-related')), [false, true, false, true, false]);

  fixture.buttons[1].click();
  assert.equal(controller.activeState, null);
  assert.ok(fixture.rows.every((row) => !row.classList.contains('is-deemphasized')));

  fixture.buttons[2].click();
  assert.deepEqual(fixture.architecture.map((item) => item.classList.contains('is-focus-related')), [false, false, true, true]);
  assert.deepEqual(fixture.evidence.map((item) => item.classList.contains('is-focus-related')), [false, false, false, false, true]);
  fixture.overview.click();
  assert.equal(controller.activeState, null);
});

test('canonical evidence cards map to their related focus state', () => {
  const { focusStateForEvidence } = require('../ui/app');

  assert.deepEqual([
    focusStateForEvidence('Source Open'),
    focusStateForEvidence('Source Repayment'),
    focusStateForEvidence('Opening Proof Submission'),
    focusStateForEvidence('Repayment Proof Submission'),
    focusStateForEvidence('Credit Commitment'),
  ], [1, 2, 1, 2, 3]);
});

test('capacity geometry preserves the limit boundary and visible overrun', () => {
  const { capacityGeometry, deriveCanonicalViewModel } = require('../ui/app');
  const model = deriveCanonicalViewModel(manifest, negative);

  assert.deepEqual(capacityGeometry(model.values), {
    openDebt: 62.5,
    openHeadroom: 12.5,
    openRequestLeft: 62.5,
    openRequestWidth: 37.5,
    repaidDebt: 37.5,
    repaidRequest: 37.5,
    finalDebt: 37.5,
    finalCommitted: 37.5,
  });
});

test('browser loader fetches both canonical evidence files and returns only a validated model', async () => {
  const { fetchCanonicalEvidence } = require('../ui/app');
  const requested = [];
  const readOnlyFetch = async (url) => {
    requested.push(url);
    return {
      ok: true,
      json: async () => structuredClone(url.endsWith('negative.json') ? negative : manifest),
    };
  };

  const model = await fetchCanonicalEvidence(readOnlyFetch);
  assert.equal(model.verified, true);
  assert.deepEqual(requested, [
    '../runs/20260906-t05/manifest.json',
    '../runs/20260906-t05/negative.json',
  ]);

  await assert.rejects(
    () => fetchCanonicalEvidence(async () => ({ ok: false, status: 404 })),
    /Canonical evidence unavailable/,
  );
});

test('package exposes the dependency-free UI server command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.ui, 'node scripts/serve-ui.js');
});

test('Pages build publishes the UI under /ui/ with only its canonical evidence', (t) => {
  const { buildPages } = require('../scripts/build-pages');
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-to-credit-pages-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  buildPages(outputRoot);

  assert.equal(fs.existsSync(path.join(outputRoot, 'ui', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'ui', 'app.js')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'ui', 'styles.css')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'runs', '20260906-t05', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'runs', '20260906-t05', 'negative.json')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, '.nojekyll')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(outputRoot, 'runs', '20260906-t05', 'proofs')), false);
});

test('Pages build refuses to replace a non-empty custom output directory', (t) => {
  const { buildPages } = require('../scripts/build-pages');
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-to-credit-pages-existing-'));
  const sentinel = path.join(outputRoot, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  assert.throws(() => buildPages(outputRoot), /custom Pages output directory must be empty/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('README documents the read-only UI command and transaction boundary', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /## Read-only demo UI/);
  assert.match(readme, /npm run ui/);
  assert.match(readme, /does not sign or broadcast transactions/i);
});

test('UI runtime has no credential, wallet, signer, or transaction-broadcast surface', () => {
  const sources = ['ui/index.html', 'ui/app.js', 'ui/styles.css', 'scripts/serve-ui.js']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');

  assert.doesNotMatch(sources, /private[_ -]?key|mnemonic|\.env(?:\b|\/)|walletconnect|metamask/i);
  assert.doesNotMatch(sources, /sendTransaction|broadcastTransaction|eth_sendRawTransaction|new\s+Wallet|commitCredit\s*\(/i);
  assert.doesNotMatch(sources, /Credit score verified|Borrower approved by Attestcoin|Collateral verified|Gold verified|Reserve verified|Creditworthiness verified|Loan issued|Funds transferred|Aggregate exposure|Total market exposure/i);
});
