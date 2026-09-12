'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id, ZeroHash } = require('ethers');
const { setup, OWNER, BORROWER, OTHER, coder } = require('./helpers/aggregate');

test('sealed source rejects unauthorized/duplicate/zero opening and permits only repayment after seal', async () => {
  const s = await setup({ count: 1 });
  const args = [id('loan'), BORROWER, OWNER, id('asset'), 50_000_000n];
  await assert.rejects(() => s.sources[0].write('openLoan', args, { caller: OTHER }), /Unauthorized/);
  await assert.rejects(() => s.sources[0].write('openLoan', [...args.slice(0, 4), 0]), /InvalidLoan/);
  await s.sources[0].write('openLoan', args);
  await assert.rejects(() => s.sources[0].write('openLoan', args), /InvalidLoan/);
  await assert.rejects(() => s.sources[0].write('checkpoint', []), /NotSealed/);
  await s.sources[0].write('seal', []);
  await assert.rejects(() => s.sources[0].write('openLoan', [id('new'), ...args.slice(1)]), /SourceSealed/);
  await assert.rejects(() => s.sources[0].write('repay', [id('loan'), 1], { caller: OTHER }), /Unauthorized/);
  await assert.rejects(() => s.sources[0].write('repay', [id('loan'), 50_000_001]), /InvalidRepayment/);
  await s.sources[0].write('repay', [id('loan'), 20_000_000]);
  const cp = await s.sources[0].write('checkpoint', []);
  assert.equal(cp.events[0].args.loanCount, 1n);
  assert.equal(cp.events[0].args.eventCount, 2n);
  assert.equal(cp.events[0].args.totalIssued, 50_000_000n);
  assert.equal(cp.events[0].args.totalRepaid, 20_000_000n);
});
test('two real source contracts with the same loan ID aggregate to 90 and reject a request for 20', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n);
  await s.open(1, 40_000_000n);
  await s.complete();
  assert.equal(await s.ledger.readOne('totalDebt'), 90_000_000n);
  const d = await s.gate.readOne('evaluate', [20_000_000]);
  assert.equal(d.reason, 1n);
  assert.equal(d.headroom, 10_000_000n);
  await assert.rejects(async () => s.gate.write('reserve', await s.reserveArgs('too-big', 20_000_000n)), /DecisionDenied/);
});
test('missing mandatory source never finalizes even when all submitted proofs are valid', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n);
  await s.sources[0].write('seal', []);
  await s.checkpoint(0);
  await assert.rejects(() => s.ledger.write('finalizeSnapshot', [1]), /CoverageIncomplete/);
  assert.equal((await s.gate.readOne('evaluate', [20_000_000])).reason, 2n);
  assert.equal(await s.ledger.readOne('snapshotId'), ZeroHash);
});

test('a zero-position checkpoint is required and completes coverage', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n);
  await s.complete();
  assert.equal((await s.gate.readOne('evaluate', [20_000_000])).reason, 0n);
  assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
});

test('omitted last loan and omitted last repayment each fail checkpoint reconciliation atomically', async () => {
  for (const tail of ['loan', 'repayment']) {
    const s = await setup({ count: 1 });
    await s.open(0, 50_000_000n);
    if (tail === 'loan') await s.sources[0].write('openLoan', [id('hidden'), BORROWER, OWNER, id('asset'), 40_000_000]);
    else await s.sources[0].write('repay', [id('loan-1'), 20_000_000]);
    await s.sources[0].write('seal', []);
    const cp = await s.sources[0].write('checkpoint', []);
    const before = await s.ledger.readOne('stateVersion');
    await assert.rejects(() => s.submit(0, cp), /CheckpointMismatch/);
    assert.equal(await s.ledger.readOne('stateVersion'), before);
    assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
  }
});

test('rejected verifier, failed receipt, wrong chain and emitter leave no debt', async () => {
  for (const mode of ['verifier', 'receipt', 'chain', 'emitter']) {
    const s = await setup({ count: 1, verdict: mode !== 'verifier' });
    const e = await s.sources[0].write('openLoan', [id('loan'), BORROWER, OWNER, id('asset'), 50_000_000]);
    await assert.rejects(() => s.submit(0, e, { status: mode === 'receipt' ? 0 : 1,
      chain: mode === 'chain' ? 2 : 1, emitter: mode === 'emitter' ? OTHER : undefined }), /InvalidProof|NoApplicableLog/);
    assert.equal(await s.ledger.readOne('totalDebt'), 0n);
    assert.equal(await s.ledger.readOne('stateVersion'), 0n);
  }
});

test('replay, sequence gap and duplicate logs revert the whole receipt', async () => {
  const s = await setup({ count: 1 });
  const e = await s.open(0, 50_000_000n);
  await assert.rejects(() => s.submit(0, e, { height: 1n }), /AlreadyProcessed/);
  const repay = await s.sources[0].write('repay', [id('loan-1'), 10_000_000]);
  await assert.rejects(() => s.submit(0, { events: [...repay.events, ...repay.events] }), /InvalidSequence/);
  assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
  const last = await s.sources[0].write('repay', [id('loan-1'), 10_000_000]);
  await assert.rejects(() => s.submit(0, last), /InvalidSequence/);
});

test('two allocators cannot reserve the same observed capacity', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n);
  await s.open(1, 40_000_000n);
  await s.complete();
  const first = await s.reserveArgs('first', 10_000_000n);
  const second = [id('second'), ...first.slice(1)];
  await s.gate.write('reserve', first);
  await assert.rejects(() => s.gate.write('reserve', second, { caller: OTHER }), /StaleStateVersion/);
  assert.equal(await s.gate.readOne('reservedCredit'), 10_000_000n);
  assert.equal((await s.gate.readOne('evaluate', [1])).reason, 1n);
});

test('reserve binds policy, scope, snapshot, caller, commitment ID and nonzero amount', async () => {
  const s = await setup({ count: 1 });
  await s.open(0, 50_000_000n);
  await s.complete();
  const args = await s.reserveArgs('one', 10_000_000n);
  await assert.rejects(() => s.gate.write('reserve', args, { caller: BORROWER }), /Unauthorized/);
  await assert.rejects(() => s.gate.write('setPolicy', [200_000_000], { caller: OTHER }), /Unauthorized/);
  await assert.rejects(() => s.gate.write('reserve', [args[0], 0, ...args.slice(2)]), /DecisionDenied/);
  await assert.rejects(() => s.gate.write('reserve', [...args.slice(0, 4), 2, args[5]]), /StaleScopeVersion/);
  await assert.rejects(() => s.gate.write('reserve', [...args.slice(0, 5), id('wrong')]), /StaleSnapshot/);
  await s.gate.write('setPolicy', [90_000_000]);
  await assert.rejects(() => s.gate.write('reserve', args), /StalePolicyVersion/);
  await s.gate.write('reserve', await s.reserveArgs('one', 10_000_000n));
  await assert.rejects(async () => s.gate.write('reserve', await s.reserveArgs('one', 1n)), /InvalidCommitment/);
});

test('repayment invalidates snapshot until every source supplies the next epoch; reservations persist', async () => {
  const s = await setup();
  await s.open(0, 50_000_000n); await s.open(1, 40_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('first', 10_000_000n));
  const repay = await s.sources[1].write('repay', [id('loan-1'), 20_000_000]);
  await s.submit(1, repay);
  assert.equal((await s.gate.readOne('evaluate', [1])).reason, 2n);
  await s.checkpoint(1);
  await assert.rejects(() => s.ledger.write('finalizeSnapshot', [2]), /CoverageIncomplete/);
  await s.checkpoint(0); await s.ledger.write('finalizeSnapshot', [2]);
  const d = await s.gate.readOne('evaluate', [20_000_000]);
  assert.equal(d.reason, 0n); assert.equal(d.totalDebt, 70_000_000n);
  assert.equal(d.reservedCredit, 10_000_000n); assert.equal(d.headroom, 20_000_000n);
});
