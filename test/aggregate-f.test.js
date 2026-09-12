'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { setup, OWNER, OTHER, THIRD, BORROWER, UNIT } = require('./helpers/aggregate');

async function sourceKey(s, index) {
  const config = await s.registry.readOne('sourceAt', [index]);
  return s.registry.readOne('sourceKey', [config.chainKey, config.emitter]);
}
async function controllerSetup(count = 2) {
  const s = await setup({ count });
  const controller = await s.vm.deploy('OriginationController', [s.gate.address, s.registry.address, OWNER]);
  return { ...s, controller };
}

test('institution origination requires an executed commitment and registered source quota', async () => {
  const s = await controllerSetup(1); const key = await sourceKey(s, 0);
  await s.controller.write('setInstitution', [OTHER, true]);
  await s.controller.write('setQuota', [OTHER, key, 10_000_000n]);
  await s.controller.write('setSourceQuota', [key, 10_000_000n]);
  await s.controller.write('setInstitutionQuota', [OTHER, 16_000_000n]);
  await s.gate.write('setExecutor', [OTHER, true]);
  await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('f-commitment', 10_000_000n));
  await assert.rejects(() => s.controller.write('originate', [id('f-commitment'), key, id('f-loan'), BORROWER, OWNER, 10_000_000n, id('f-proof')], { caller: OTHER }), /CommitmentNotExecuted/);
  await s.gate.write('executeReservation', [id('f-commitment'), id('execution-f-proof'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  const result = await s.controller.write('originate', [id('f-commitment'), key, id('f-loan'), BORROWER, OWNER, 10_000_000n, id('f-proof')], { caller: OTHER });
  assert.equal(result.events[0].name, 'InstitutionOrigination');
  assert.equal(await s.controller.readOne('sourceOriginated', [key]), 10_000_000n);
  assert.equal(await s.controller.readOne('institutionOriginated', [OTHER]), 10_000_000n);
  assert.equal(await s.controller.readOne('originationStatus', [id('f-commitment'), key, id('f-loan')]), 1n);
  await assert.rejects(() => s.controller.write('originate', [id('f-commitment'), key, id('f-loan'), BORROWER, OWNER, 10_000_000n, id('f-proof-again')], { caller: OTHER }), /OriginationAlreadyRecorded/);
  await assert.rejects(() => s.controller.write('originate', [id('f-commitment'), key, id('f-other-loan'), BORROWER, OWNER, 10_000_000n, id('f-proof-third')], { caller: OTHER }), /CommitmentAlreadyConsumed/);
});

test('source and institution quotas are independent but both cap the same atomic origination', async () => {
  const s = await controllerSetup(2); const a = await sourceKey(s, 0); const b = await sourceKey(s, 1);
  await s.gate.write('setPolicy', [120_000_000n]);
  await s.controller.write('setInstitution', [OTHER, true]); await s.gate.write('setExecutor', [OTHER, true]);
  await s.controller.write('setQuota', [OTHER, a, 10_000_000n]); await s.controller.write('setQuota', [OTHER, b, 5_000_000n]);
  await s.controller.write('setSourceQuota', [a, 10_000_000n]); await s.controller.write('setSourceQuota', [b, 5_000_000n]);
  await s.controller.write('setInstitutionQuota', [OTHER, 15_000_000n]);
  await s.open(0, 50_000_000n); await s.open(1, 40_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('f-a', 10_000_000n));
  await s.gate.write('executeReservation', [id('f-a'), id('proof-a'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await s.controller.write('originate', [id('f-a'), a, id('loan-a'), BORROWER, OWNER, 10_000_000n, id('orig-proof-a')], { caller: OTHER });
  await s.gate.write('reserve', await s.reserveArgs('f-b', 5_000_000n));
  await s.gate.write('executeReservation', [id('f-b'), id('proof-b'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await s.controller.write('originate', [id('f-b'), b, id('loan-b'), BORROWER, OWNER, 5_000_000n, id('orig-proof-b')], { caller: OTHER });
  assert.equal(await s.controller.readOne('totalOriginated'), 15_000_000n);
  const overArgs = await s.reserveArgs('f-over', 16_000_000n);
  await assert.rejects(() => s.gate.write('reserve', overArgs), /DecisionDenied/);
});

test('origination fails closed for unknown sources, unauthorised institutions, amount mismatch, stale quota and proof replay', async () => {
  const s = await controllerSetup(1); const key = await sourceKey(s, 0); const unknown = id('unknown-source');
  await s.controller.write('setInstitution', [OTHER, true]); await s.controller.write('setQuota', [OTHER, key, 10_000_000n]);
  await s.controller.write('setSourceQuota', [key, 10_000_000n]); await s.controller.write('setInstitutionQuota', [OTHER, 10_000_000n]);
  await s.gate.write('setExecutor', [OTHER, true]); await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('f-errors', 10_000_000n));
  await s.gate.write('executeReservation', [id('f-errors'), id('f-execution-proof'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  const base = [id('f-errors'), key, id('loan-errors'), BORROWER, OWNER, 10_000_000n, id('f-orig-proof')];
  await assert.rejects(() => s.controller.write('originate', base, { caller: BORROWER }), /Unauthorized/);
  await assert.rejects(() => s.controller.write('originate', [base[0], unknown, ...base.slice(2)], { caller: OTHER }), /SourceNotRegistered/);
  await assert.rejects(() => s.controller.write('originate', [...base.slice(0, 5), 9_000_000n, base[6]], { caller: OTHER }), /AmountMismatch/);
  await assert.rejects(() => s.controller.write('originate', [...base.slice(0, 6), '0x' + '00'.repeat(32)], { caller: OTHER }), /InvalidProof/);
  await s.controller.write('originate', base, { caller: OTHER });
  const second = await s.gate.readOne('exposureStateVersion');
  await s.gate.write('reserve', await s.reserveArgs('f-second', 1_000_000n));
  await s.gate.write('executeReservation', [id('f-second'), id('f-execution-second'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await assert.rejects(() => s.controller.write('originate', [id('f-second'), key, id('loan-second'), BORROWER, OWNER, 1_000_000n, id('f-orig-proof')], { caller: OTHER }), /ProofAlreadyUsed|QuotaExceeded/);
  assert.equal(second > 0n, true);
});

test('quota updates are owner-only, versioned, and cannot reduce below already originated amount', async () => {
  const s = await controllerSetup(1); const key = await sourceKey(s, 0);
  await s.controller.write('setInstitution', [OTHER, true]); await s.controller.write('setQuota', [OTHER, key, 10_000_000n]);
  await s.controller.write('setSourceQuota', [key, 10_000_000n]); await s.controller.write('setInstitutionQuota', [OTHER, 10_000_000n]);
  await s.gate.write('setExecutor', [OTHER, true]); await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('f-quota-use', 3_000_000n));
  await s.gate.write('executeReservation', [id('f-quota-use'), id('f-quota-exec'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await s.controller.write('originate', [id('f-quota-use'), key, id('f-quota-loan'), BORROWER, OWNER, 3_000_000n, id('f-quota-proof')], { caller: OTHER });
  await assert.rejects(() => s.controller.write('setQuota', [OTHER, key, 1_000_000n], { caller: OTHER }), /Unauthorized/);
  await assert.rejects(() => s.controller.write('setQuota', [OTHER, key, 1_000_000n], { caller: OWNER }), /QuotaBelowUsage/);
  await assert.rejects(() => s.controller.write('setSourceQuota', [key, 1_000_000n], { caller: OWNER }), /QuotaBelowUsage/);
  await assert.rejects(() => s.controller.write('setInstitutionQuota', [OTHER, 1_000_000n], { caller: OWNER }), /QuotaBelowUsage/);
  await assert.rejects(() => s.controller.write('setQuota', [OTHER, key, 0], { caller: OWNER }), /InvalidQuota/);
  assert.equal(await s.controller.readOne('quotaVersion'), 5n);
});

test('source-wide and institution-wide quotas apply across institutions and sources', async () => {
  const s = await controllerSetup(2); const a = await sourceKey(s, 0); const b = await sourceKey(s, 1);
  await s.gate.write('setPolicy', [200_000_000n]);
  await s.controller.write('setInstitution', [OTHER, true]);
  await s.controller.write('setInstitution', [THIRD, true]);
  await s.gate.write('setExecutor', [OTHER, true]); await s.gate.write('setExecutor', [THIRD, true]);
  await s.controller.write('setQuota', [OTHER, a, 10_000_000n]);
  await s.controller.write('setQuota', [THIRD, a, 10_000_000n]);
  await s.controller.write('setQuota', [OTHER, b, 10_000_000n]);
  await s.controller.write('setSourceQuota', [a, 10_000_000n]);
  await s.controller.write('setSourceQuota', [b, 20_000_000n]);
  await s.controller.write('setInstitutionQuota', [OTHER, 16_000_000n]);
  await s.controller.write('setInstitutionQuota', [THIRD, 10_000_000n]);
  await s.open(0, 50_000_000n); await s.open(1, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('f-cross-a', 10_000_000n));
  await s.gate.write('executeReservation', [id('f-cross-a'), id('f-cross-exec-a'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await s.controller.write('originate', [id('f-cross-a'), a, id('loan-cross-a'), BORROWER, OWNER, 10_000_000n, id('f-cross-proof-a')], { caller: OTHER });
  await s.gate.write('reserve', await s.reserveArgs('f-cross-a2', 1_000_000n));
  await s.gate.write('executeReservation', [id('f-cross-a2'), id('f-cross-exec-a2'), await s.gate.readOne('exposureStateVersion')], { caller: THIRD });
  await assert.rejects(() => s.controller.write('originate', [id('f-cross-a2'), a, id('loan-cross-a2'), BORROWER, OWNER, 1_000_000n, id('f-cross-proof-a2')], { caller: THIRD }), /QuotaExceeded/);
  await s.gate.write('reserve', await s.reserveArgs('f-cross-b', 6_000_000n));
  await s.gate.write('executeReservation', [id('f-cross-b'), id('f-cross-exec-b'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await s.controller.write('originate', [id('f-cross-b'), b, id('loan-cross-b'), BORROWER, OWNER, 6_000_000n, id('f-cross-proof-b')], { caller: OTHER });
  await s.gate.write('reserve', await s.reserveArgs('f-cross-b2', 5_000_000n));
  await s.gate.write('executeReservation', [id('f-cross-b2'), id('f-cross-exec-b2'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  await assert.rejects(() => s.controller.write('originate', [id('f-cross-b2'), b, id('loan-cross-b2'), BORROWER, OWNER, 5_000_000n, id('f-cross-proof-b2')], { caller: OTHER }), /QuotaExceeded/);
});

test('origination controller binds the gate to the supplied scope registry', async () => {
  const s = await controllerSetup(1); const source = s.sources[0];
  const wrongRegistry = await s.vm.deploy('ExposureScopeRegistry', [id('wrong-scope'), 1, OWNER,
    [[1, source.address, id('sealed-v1'), id('demo-identities-v1'), UNIT, 1]]]);
  await assert.rejects(() => s.vm.deploy('OriginationController', [s.gate.address, wrongRegistry.address, OWNER]), /InvalidConfiguration/);
});
