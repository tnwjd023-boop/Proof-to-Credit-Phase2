'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/aggregate');

test('status export distinguishes observed debt from complete totals and includes the missing source', async () => {
  const { collectAggregateStatus } = require('../src/aggregate-view');
  const { deriveAggregateView } = require('../ui/aggregate');
  const s = await setup(); await s.open(0, 50_000_000n);
  await s.sources[0].write('seal', []); await s.checkpoint(0);
  const status = await collectAggregateStatus({ ...s, requestedAmount: 20_000_000n,
    block: { number: 1, timestamp: 0, hash: `0x${'11'.repeat(32)}` }, evidenceKind: 'LOCAL_VM_MOCK_VERIFIER' });
  const view = deriveAggregateView(status);
  assert.equal(view.complete, false);
  assert.equal(view.total, '미확정');
  assert.equal(view.observed, '50.000000');
  assert.equal(view.reason, 'COVERAGE_INCOMPLETE');
  assert.equal(view.sources[0].covered, true);
  assert.equal(view.sources[1].covered, false);
  assert.equal(view.sources[1].debt, '0.000000');
  assert.equal(status.evidenceKind, 'LOCAL_VM_MOCK_VERIFIER');
});

test('status view preserves six-decimal integers and fails closed on inconsistent imported reports', async () => {
  const { collectAggregateStatus } = require('../src/aggregate-view');
  const { deriveAggregateView, formatAmount } = require('../ui/aggregate');
  const s = await setup(); await s.open(0, 50_000_000n); await s.open(1, 40_000_000n); await s.complete();
  const status = await collectAggregateStatus({ ...s, requestedAmount: 20_000_000n,
    block: { number: 1, timestamp: 0, hash: `0x${'11'.repeat(32)}` }, evidenceKind: 'LOCAL_VM_MOCK_VERIFIER' });
  assert.equal(deriveAggregateView(status).total, '90.000000');
  assert.equal(deriveAggregateView(status).headroom, '10.000000');
  assert.equal(deriveAggregateView(status).executed, '0.000000');
  assert.equal(formatAmount('9007199254740993'), '9007199254.740993');
  for (const mutate of [r => { r.totalDebt = '1'; }, r => { r.reason = 'ALLOW'; },
    r => { r.sources.pop(); }, r => { r.unit = 'USD'; }, r => { r.sources[1] = r.sources[0]; },
    r => { r.executedCredit = '1'; }, r => { r.snapshotComplete = false; }, r => { r.evidenceKind = 'PUBLIC_VERIFIED'; }]) {
    const changed = structuredClone(status); mutate(changed);
    assert.throws(() => deriveAggregateView(changed), /Invalid aggregate report/);
  }
});

test('aggregate page and scripts are served and built without exposing arbitrary reports', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createUiServer, resolvePublicFile } = require('../scripts/serve-ui');
  const { buildPages } = require('../scripts/build-pages');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aggregate-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  buildPages(dir);
  assert.ok(fs.existsSync(path.join(dir, 'ui/aggregate.html')));
  assert.ok(fs.existsSync(path.join(dir, 'ui/aggregate.js')));
  assert.throws(() => resolvePublicFile('/runs/private/status.json'), /Not found/);
  const server = createUiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const url of ['/ui/aggregate.html', '/ui/aggregate.js', '/ui/aggregate.css']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  }
});
