'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id, ZeroHash } = require('ethers');
const { setup, OWNER, BORROWER, OTHER, UNIT, coder } = require('./helpers/aggregate');
const LOAN = 'tuple(address borrower,address lender,bytes32 assetId,bytes32 unitId,uint64 sequence,uint64 eventSequence,uint256 principal,uint256 repaid,uint256 outstanding,uint64 timestamp)';
function changeLoan(result, change) {
  const e = result.events[0];
  const payload = coder.decode(['bytes'], e.data)[0];
  const values = [...coder.decode([LOAN], payload)[0]];
  change(values);
  return { events: [{ ...e, data: coder.encode(['bytes'], [coder.encode([LOAN], [values])]) }] };
}
function changeCheckpoint(result, change) {
  const types = ['uint64', 'uint64', 'bytes32', 'uint256', 'uint256', 'uint64', 'bool'];
  const e = result.events[0];
  const values = [...coder.decode(types, e.data)]; change(values);
  return { events: [{ ...e, data: coder.encode(types, values) }] };
}

test('checkpoint expiry is based on source time, including the exact TTL boundary', async () => {
  const s = await setup({ count: 1, ttl: 10 });
  s.vm.setTimestamp(100);
  await s.open(0, 50_000_000n); await s.complete();
  s.vm.setTimestamp(110);
  assert.equal((await s.gate.readOne('evaluate', [1])).reason, 0n);
  s.vm.setTimestamp(111);
  const args = await s.reserveArgs('expired', 1n);
  assert.equal((await s.gate.readOne('evaluate', [1])).reason, 3n);
  await assert.rejects(() => s.gate.write('reserve', args), /DecisionDenied/);
  const delayed = await setup({ count: 1, ttl: 10 });
  delayed.vm.setTimestamp(100);
  await delayed.open(0, 50_000_000n); await delayed.sources[0].write('seal', []);
  const cp = await delayed.sources[0].write('checkpoint', []);
  delayed.vm.setTimestamp(111);
  // Historical evidence remains ingestible after TTL; freshness is enforced when finalizing.
  await delayed.submit(0, cp);
  await assert.rejects(() => delayed.ledger.write('finalizeSnapshot', [1]), /SnapshotStale/);
  assert.equal(await delayed.ledger.readOne('snapshotId'), ZeroHash);
});

test('checkpoint counters, history, arithmetic, seal and future timestamp are each enforced', async () => {
  const mutations = [v => { v[0] = 2; }, v => { v[1] = 2; }, v => { v[2] = id('bad'); },
    v => { v[3] = 1; }, v => { v[4] = 1; }, v => { v[5] = 1; }, v => { v[6] = false; }];
  for (const mutate of mutations) {
    const s = await setup({ count: 1 }); await s.open(0, 50_000_000n);
    await s.sources[0].write('seal', []); const cp = await s.sources[0].write('checkpoint', []);
    await assert.rejects(() => s.submit(0, changeCheckpoint(cp, mutate)), /CheckpointMismatch|InvalidTimestamp/);
    assert.equal(await s.ledger.readOne('stateVersion'), 1n);
  }
});

test('repayment cannot alter borrower, lender, asset, unit or principal or invent repayment arithmetic', async () => {
  const mutations = [v => { v[0] = OTHER; }, v => { v[1] = OTHER; }, v => { v[2] = id('bad'); },
    v => { v[3] = id('EUR'); }, v => { v[6] = 60_000_000; }, v => { v[7] = 0; },
    v => { v[7] = 60_000_000; }, v => { v[8] = 39_000_000; }];
  for (const mutate of mutations) {
    const s = await setup({ count: 1 }); await s.open(0, 50_000_000n);
    const repay = await s.sources[0].write('repay', [id('loan-1'), 10_000_000]);
    await assert.rejects(() => s.submit(0, changeLoan(repay, mutate)), /InvalidLoan|InvalidRepayment/);
    assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
    assert.equal(await s.ledger.readOne('stateVersion'), 1n);
  }
});

test('older source positions, future loan time and regressing checkpoint time fail without mutations', async () => {
  const s = await setup({ count: 1 }); s.vm.setTimestamp(100);
  await s.open(0, 50_000_000n);
  const repay = await s.sources[0].write('repay', [id('loan-1'), 10_000_000]);
  await assert.rejects(() => s.submit(0, repay, { height: 0 }), /OutOfOrderSourcePosition/);
  await assert.rejects(() => s.submit(0, changeLoan(repay, v => { v[9] = 101; })), /InvalidTimestamp/);
  await s.sources[0].write('seal', []);
  const cp = await s.sources[0].write('checkpoint', []);
  await s.submit(0, repay);
  await assert.rejects(() => s.submit(0, changeCheckpoint(cp, v => { v[5] = 99; })), /InvalidTimestamp/);
});

test('malformed matching event reverts earlier valid events in the same receipt', async () => {
  const s = await setup({ count: 1 });
  const first = await s.sources[0].write('openLoan', [id('loan'), BORROWER, OWNER, id('asset'), 50_000_000]);
  const malformed = { ...first.events[0], data: '0x12' };
  await assert.rejects(() => s.submit(0, { events: [...first.events, malformed] }), /revert/i);
  assert.equal(await s.ledger.readOne('totalDebt'), 0n);
  await s.submit(0, first);
  assert.equal(await s.ledger.readOne('totalDebt'), 50_000_000n);
});

test('registry rejects duplicate sources, unsupported units, unknown adapters and empty scopes', async () => {
  const s = await setup({ count: 1 });
  const valid = [1, s.sources[0].address, id('sealed-v1'), id('mapping'), UNIT, 1];
  for (const entries of [[], [valid, valid], [[...valid.slice(0, 4), id('EUR'), 1]],
    [[1, s.sources[0].address, id('unknown'), ...valid.slice(3)]]]) {
    await assert.rejects(() => s.vm.deploy('ExposureScopeRegistry', [id('scope'), 1, OWNER, entries]), /InvalidScope/);
  }
});

test('lower policy limit fails closed without deleting observed debt or reservations', async () => {
  const s = await setup({ count: 1 }); await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('reserved', 10_000_000n));
  await s.gate.write('setPolicy', [40_000_000]);
  const d = await s.gate.readOne('evaluate', [1]);
  assert.equal(d.reason, 1n); assert.equal(d.headroom, 0n);
  assert.equal(d.totalDebt, 50_000_000n); assert.equal(d.reservedCredit, 10_000_000n);
});
