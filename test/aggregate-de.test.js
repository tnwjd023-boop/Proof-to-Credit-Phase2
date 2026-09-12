'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { setup, OWNER, OTHER, BORROWER } = require('./helpers/aggregate');

async function sourceKey(s, index) {
  const config = await s.registry.readOne('sourceAt', [index]);
  return s.registry.readOne('sourceKey', [config.chainKey, config.emitter]);
}

test('REPRESENTS and WRAPS aliases share one canonical debt while a new canonical debt increases exposure', async () => {
  const s = await setup();
  const a = await sourceKey(s, 0); const b = await sourceKey(s, 1);
  const canonical = id('debt-D1');
  await s.ledger.write('setDebtRelation', [a, id('loan-1'), canonical, 1]);
  await s.ledger.write('setDebtRelation', [b, id('loan-1'), canonical, 2]);
  assert.equal(await s.ledger.readOne('canonicalDebtId', [a, id('loan-1')]), canonical);
  assert.equal(await s.ledger.readOne('relationType', [b, id('loan-1')]), 2n);
  await s.open(0, 50_000_000n); await s.open(1, 50_000_000n);
  assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
  await assert.rejects(() => s.ledger.write('setDebtRelation', [b, id('loan-1'), id('debt-other'), 1]), /RelationImmutable/);
  await s.open(1, 40_000_000n, id('loan-new'));
  assert.equal(await s.ledger.readOne('totalDebt'), 90_000_000n);
});

test('unresolved aliases remain separate and a relation cannot be invented after a source event', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n); await s.open(1, 40_000_000n);
  assert.equal(await s.ledger.readOne('totalDebt'), 90_000_000n);
  const key = await sourceKey(s, 0);
  await assert.rejects(() => s.ledger.write('setDebtRelation', [key, id('loan-1'), id('late'), 1]), /RelationImmutable/);
});

test('representations can arrive in independent source order and an alias can open after canonical debt has repaid', async () => {
  const ordered = await setup();
  const a = await sourceKey(ordered, 0); const b = await sourceKey(ordered, 1); const canonical = id('debt-order');
  await ordered.ledger.write('setDebtRelation', [a, id('loan-1'), canonical, 1]);
  await ordered.ledger.write('setDebtRelation', [b, id('loan-1'), canonical, 2]);
  await ordered.open(0, 50_000_000n); await ordered.open(1, 50_000_000n);
  await ordered.submit(0, await ordered.sources[0].write('repay', [id('loan-1'), 10_000_000n]));
  await ordered.submit(1, await ordered.sources[1].write('repay', [id('loan-1'), 5_000_000n]));
  assert.equal(await ordered.ledger.readOne('totalDebt'), 40_000_000n);

  const late = await setup({ count: 2 });
  const lateA = await sourceKey(late, 0); const lateB = await sourceKey(late, 1); const lateCanonical = id('debt-late-open');
  await late.ledger.write('setDebtRelation', [lateA, id('loan-1'), lateCanonical, 1]);
  await late.ledger.write('setDebtRelation', [lateB, id('loan-1'), lateCanonical, 2]);
  await late.open(0, 50_000_000n);
  await late.submit(0, await late.sources[0].write('repay', [id('loan-1'), 10_000_000n]));
  await late.open(1, 50_000_000n);
  assert.equal(await late.ledger.readOne('totalDebt'), 40_000_000n);
});

test('a reservation converts once to executed exposure and repayments reduce only the executed amount', async () => {
  const s = await setup({ count: 1 });
  await s.gate.write('setExecutor', [OTHER, true]);
  await s.open(0, 50_000_000n); await s.complete();
  const args = await s.reserveArgs('commitment-D1', 10_000_000n);
  await s.gate.write('reserve', args);
  const state = await s.gate.readOne('exposureStateVersion');
  await s.gate.write('executeReservation', [id('commitment-D1'), id('execution-proof-D1'), state], { caller: OTHER });
  assert.equal(await s.gate.readOne('reservedCredit'), 0n);
  assert.equal(await s.gate.readOne('executedCredit'), 10_000_000n);
  assert.equal((await s.gate.readOne('evaluate', [1])).headroom, 40_000_000n);
  const afterExecute = await s.gate.readOne('exposureStateVersion');
  await assert.rejects(() => s.gate.write('executeReservation', [id('commitment-D1'), id('execution-proof-again'), afterExecute], { caller: OTHER }), /InvalidLifecycle/);
  const repayState = await s.gate.readOne('exposureStateVersion');
  await s.gate.write('repayExecution', [id('commitment-D1'), 4_000_000n, id('repayment-proof-D1'), repayState], { caller: OTHER });
  assert.equal(await s.gate.readOne('executedCredit'), 6_000_000n);
  assert.equal((await s.gate.readOne('evaluate', [1])).headroom, 44_000_000n);
  const afterRepay = await s.gate.readOne('exposureStateVersion');
  await assert.rejects(() => s.gate.write('repayExecution', [id('commitment-D1'), 7_000_000n, id('repayment-proof-too-much'), afterRepay], { caller: OTHER }), /InvalidRepayment/);
  await s.gate.write('repayExecution', [id('commitment-D1'), 6_000_000n, id('repayment-proof-final'), afterRepay], { caller: OTHER });
  assert.equal(await s.gate.readOne('reservationStatus', [id('commitment-D1')]), 3n);
  assert.equal(await s.gate.readOne('executedCredit'), 0n);
  const secondCommit = await s.reserveArgs('commitment-D1b', 1_000_000n);
  await s.gate.write('reserve', secondCommit);
  const secondState = await s.gate.readOne('exposureStateVersion');
  await assert.rejects(() => s.gate.write('executeReservation', [id('commitment-D1b'), id('execution-proof-D1'), secondState], { caller: OTHER }), /ProofAlreadyUsed/);
});

test('executed repayment fails closed after its source snapshot expires', async () => {
  const s = await setup({ count: 1, ttl: 10 });
  s.vm.setTimestamp(100); await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('setExecutor', [OTHER, true]);
  await s.gate.write('reserve', await s.reserveArgs('expired-execution', 10_000_000n));
  await s.gate.write('executeReservation', [id('expired-execution'), id('execution-expired'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  s.vm.setTimestamp(111);
  const expiredState = await s.gate.readOne('exposureStateVersion');
  await assert.rejects(() => s.gate.write('repayExecution', [id('expired-execution'), 1_000_000n, id('repayment-expired'), expiredState], { caller: OTHER }), /StaleSnapshot/);
  assert.equal(await s.gate.readOne('executedCredit'), 10_000_000n);
});

test('execution requires executor authorization, nonzero proof IDs, exact versions and an active snapshot', async () => {
  const s = await setup({ count: 1 }); await s.open(0, 50_000_000n); await s.complete();
  const args = await s.reserveArgs('commitment-D2', 10_000_000n); await s.gate.write('reserve', args);
  const id0 = id('commitment-D2');
  await assert.rejects(() => s.gate.write('executeReservation', [id0, id('proof'), args[2]], { caller: BORROWER }), /Unauthorized/);
  await s.gate.write('setExecutor', [OTHER, true]);
  await assert.rejects(() => s.gate.write('executeReservation', [id0, '0x' + '00'.repeat(32), args[2]], { caller: OTHER }), /InvalidProof/);
  await assert.rejects(() => s.gate.write('executeReservation', [id0, id('proof'), args[2] - 1n], { caller: OTHER }), /StaleStateVersion/);
  const repayment = await s.sources[0].write('repay', [id('loan-1'), 1_000_000n]);
  await s.submit(0, repayment);
  const checkpoint = await s.sources[0].write('checkpoint', []);
  await s.submit(0, checkpoint);
  const staleState = await s.gate.readOne('exposureStateVersion');
  await assert.rejects(() => s.gate.write('executeReservation', [id0, id('proof'), staleState], { caller: OTHER }), /DecisionDenied|StaleSnapshot/);
});
