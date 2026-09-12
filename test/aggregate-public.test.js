'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id, ZeroAddress } = require('ethers');
const { createVmHarness } = require('./helpers/vm');
const { setup, OWNER, UNIT, coder } = require('./helpers/aggregate');
const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

test('code-less BlockProver configuration is accepted only on CC3 Testnet; other empty verifiers fail closed', async () => {
  for (const chainId of [102031, 11155111, 1]) {
    const vm = await createVmHarness({ caller: OWNER, chainId });
    const source = await vm.deploy('SealedLoanSource', [OWNER]);
    const registry = await vm.deploy('ExposureScopeRegistry', [id('scope'), 1, OWNER,
      [[1, source.address, id('sealed-v1'), id('identity'), UNIT, 1]]]);
    const decoder = await vm.deploy('EvmV1Decoder', []);
    const deploy = (verifier, reg = registry.address, dec = decoder.address, ttl = 7200) =>
      vm.deploy('MultiLoanLedger', [reg, verifier, dec, ttl]);
    for (const empty of [ZeroAddress, OWNER, '0x0000000000000000000000000000000000000FD3']) {
      await assert.rejects(() => deploy(empty), /InvalidConfiguration/);
    }
    if (chainId === 102031) {
      const ledger = await deploy(PRECOMPILE);
      assert.equal((await ledger.readOne('verifier')).toLowerCase(), PRECOMPILE.toLowerCase());
      await assert.rejects(() => deploy(PRECOMPILE, ZeroAddress), /InvalidConfiguration/);
      await assert.rejects(() => deploy(PRECOMPILE, registry.address, ZeroAddress), /InvalidConfiguration/);
      await assert.rejects(() => deploy(PRECOMPILE, registry.address, decoder.address, 0), /InvalidConfiguration/);
    } else await assert.rejects(() => deploy(PRECOMPILE), /InvalidConfiguration/);
    const mock = await vm.deploy('TestOnlyVerifierMock', [true]);
    await deploy(mock.address);
  }
});

for (const order of [[0, 1], [1, 0]]) {
  for (const repayments of [[10n, 10n], [10n, 5n], [5n, 15n]]) {
    test(`alias source totals reconcile through finalization: order ${order}, repayments ${repayments}`, async () => {
      const s = await setup(); s.vm.setTimestamp(100);
      const keys = await Promise.all(s.sources.map(source => s.registry.readOne('sourceKey', [1, source.address])));
      const loan = id('loan-1'); const canonical = id('shared-debt');
      for (let i = 0; i < 2; i++) await s.ledger.write('setDebtRelation', [keys[i], loan, canonical, i + 1]);
      await s.open(0, 50n); await s.open(1, 50n);
      for (const i of order) await s.submit(i, await s.sources[i].write('repay', [loan, repayments[i]]));
      assert.equal(await s.ledger.readOne('totalDebt'), 50n - (repayments[0] > repayments[1] ? repayments[0] : repayments[1]));
      for (let i = 0; i < 2; i++) {
        const local = await s.ledger.readOne('sourceState', [keys[i]]);
        assert.equal(local.totalRepaid, await s.sources[i].readOne('totalRepaid'));
      }
      await s.complete(); assert.equal(await s.ledger.readOne('snapshotComplete'), true);
      // A later catch-up repayment changes source totals even if canonical debt is already lower.
      const lag = repayments[0] <= repayments[1] ? 0 : 1;
      await s.submit(lag, await s.sources[lag].write('repay', [loan, 5n]));
      assert.equal(await s.ledger.readOne('snapshotComplete'), false);
      for (let i = 0; i < 2; i++) await s.checkpoint(i);
      await s.ledger.write('finalizeSnapshot', [2]);
      assert.equal(await s.ledger.readOne('snapshotComplete'), true);
    });
  }
}

test('bad checkpoint after a repayment in the same receipt rolls back all ledger state', async () => {
  const s = await setup(); s.vm.setTimestamp(100);
  const loan = id('loan-1'), canonical = id('shared-rollback');
  const keys = await Promise.all(s.sources.map(source => s.registry.readOne('sourceKey', [1, source.address])));
  for (let i = 0; i < 2; i++) { await s.ledger.write('setDebtRelation', [keys[i], loan, canonical, i + 1]); await s.open(i, 50n); }
  await s.complete();
  const repay = await s.sources[1].write('repay', [loan, 10n]);
  const cp = await s.sources[1].write('checkpoint', []);
  const bad = { topics: [...cp.events[0].topics], data: cp.events[0].data };
  const types = ['uint64','uint64','bytes32','uint256','uint256','uint64','bool'];
  const values = [...coder.decode(types, bad.data)]; values[4] = 9n;
  bad.data = coder.encode(types, values);
  const query = require('ethers').keccak256(coder.encode(['uint64','uint64','uint64'], [1, 100, 0]));
  const state = async () => ({
    sources: await Promise.all(keys.map(k => s.ledger.readOne('sourceState', [k]))),
    loans: await Promise.all(keys.map(k => s.ledger.readOne('loanState', [k, loan]))),
    canonical: await s.ledger.readOne('canonicalLoanState', [canonical]),
    global: await Promise.all(['totalDebt','stateVersion','snapshotId','snapshotEpoch','snapshotStateVersion','validUntil','snapshotComplete'].map(n => s.ledger.readOne(n))),
    processed: await s.ledger.readOne('processedQueries', [query]),
  });
  const before = await state();
  await assert.rejects(() => s.submit(1, {events:[...repay.events, bad]}, {height:100}), /CheckpointMismatch/);
  const encoded = value => JSON.stringify(value, (_, child) => typeof child === 'bigint' ? String(child) : child);
  assert.equal(encoded(await state()), encoded(before));
  await s.submit(1, {events:[...repay.events, ...cp.events]}, {height:100});
  await s.checkpoint(0); await s.ledger.write('finalizeSnapshot', [2]);
  assert.equal(await s.ledger.readOne('totalDebt'), 40n);
});
