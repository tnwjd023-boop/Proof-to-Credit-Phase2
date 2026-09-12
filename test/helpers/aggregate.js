'use strict';
const { AbiCoder, id, ZeroHash } = require('ethers');
const { createVmHarness } = require('./vm');
const coder = AbiCoder.defaultAbiCoder();
const OWNER = '0x3000000000000000000000000000000000000003';
const BORROWER = '0x4000000000000000000000000000000000000004';
const OTHER = '0x5000000000000000000000000000000000000005';
const THIRD = '0x6000000000000000000000000000000000000006';
const UNIT = id('DEMO_USD_6');
const MERKLE = [ZeroHash, []];
const CONTINUITY = [ZeroHash, []];

// Real source event bytes and production decoder; only the external verifier is mocked.
function receipt(events, emitter, status = 1) {
  const logs = events.map(e => [emitter, e.topics, e.data]);
  const encoded = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'], [status, 1, logs, '0x']);
  return coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', encoded]]);
}

async function setup({ verdict = true, count = 2, ttl = 3600 } = {}) {
  const vm = await createVmHarness({ caller: OWNER });
  const sources = [];
  for (let i = 0; i < count; i++) sources.push(await vm.deploy('SealedLoanSource', [OWNER]));
  const registry = await vm.deploy('ExposureScopeRegistry', [id('demo-scope'), 1, OWNER,
    sources.map(s => [1, s.address, id('sealed-v1'), id('demo-identities-v1'), UNIT, 1])]);
  const verifier = await vm.deploy('TestOnlyVerifierMock', [verdict]);
  const decoder = await vm.deploy('EvmV1Decoder', []);
  const ledger = await vm.deploy('MultiLoanLedger', [registry.address, verifier.address, decoder.address, ttl]);
  const gate = await vm.deploy('ExposurePolicyGate', [ledger.address, OWNER, 100_000_000n]);
  await gate.write('setAllocator', [OTHER, true]);
  let height = 1n;
  async function submit(index, result, options = {}) {
    const block = options.height ?? height++;
    return ledger.write('submitSourceTransaction', [options.chain ?? 1, block,
      receipt(result.events, options.emitter ?? sources[index].address, options.status ?? 1), MERKLE, CONTINUITY]);
  }
  async function open(index, amount, loan = id('loan-1')) {
    const result = await sources[index].write('openLoan', [loan, BORROWER, OWNER, id('asset'), amount]);
    await submit(index, result);
    return result;
  }
  async function checkpoint(index) {
    const result = await sources[index].write('checkpoint', []);
    await submit(index, result);
    return result;
  }
  async function complete() {
    for (let i = 0; i < count; i++) {
      await sources[i].write('seal', []);
      await checkpoint(i);
    }
    await ledger.write('finalizeSnapshot', [1]);
  }
  async function reserveArgs(name, amount) {
    const d = await gate.readOne('evaluate', [amount]);
    return [id(name), amount, d.exposureStateVersion, d.policyVersion, d.scopeVersion, d.snapshotId];
  }
  return { vm, sources, registry, ledger, gate, submit, open, checkpoint, complete, reserveArgs };
}
module.exports = { setup, receipt, OWNER, BORROWER, OTHER, THIRD, UNIT, MERKLE, CONTINUITY, coder };
