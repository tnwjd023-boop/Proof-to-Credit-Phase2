'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { setup, OWNER, OTHER, BORROWER } = require('./helpers/aggregate');

async function sourceKey(s) {
  const config = await s.registry.readOne('sourceAt', [0]);
  return s.registry.readOne('sourceKey', [config.chainKey, config.emitter]);
}

test('an originated obligation requests settlement and reports funded after vault payment', async () => {
  const s = await setup({ count: 1 }); const key = await sourceKey(s);
  const controller = await s.vm.deploy('OriginationController', [s.gate.address, s.registry.address, OWNER]);
  await controller.write('setInstitution', [OTHER, true]);
  await controller.write('setQuota', [OTHER, key, 10_000_000n]);
  await controller.write('setSourceQuota', [key, 10_000_000n]);
  await controller.write('setInstitutionQuota', [OTHER, 10_000_000n]);
  await s.gate.write('setExecutor', [OTHER, true]); await s.open(0, 50_000_000n); await s.complete();
  await s.gate.write('reserve', await s.reserveArgs('settle-commitment', 10_000_000n));
  await s.gate.write('executeReservation', [id('settle-commitment'), id('settle-execution'), await s.gate.readOne('exposureStateVersion')], { caller: OTHER });
  const commitmentId = id('settle-commitment'); const loanId = id('settle-loan');
  const originResult = await controller.write('originate', [commitmentId, key, loanId, BORROWER, OWNER, 10_000_000n, id('settle-origin-proof')], { caller: OTHER });
  const originationId = originResult.result[0];
  const token = await s.vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await s.vm.deploy('SettlementVault', [token.address, OWNER, OWNER]);
  const adapter = await s.vm.deploy('DirectSettlementAdapter', [vault.address, controller.address, OWNER]);
  await vault.write('setAuthority', [adapter.address]); await token.write('mint', [vault.address, 10_000_000n]);
  await controller.write('setSettlementAdapter', [adapter.address]);
  await controller.write('requestSettlement', [originationId, id('settle-source-proof')], { caller: OTHER });
  assert.equal(await controller.readOne('settlementStatus', [originationId]), 1n);
  await adapter.write('setRelayer', [OTHER, true]);
  await adapter.write('fund', [originationId, BORROWER, 10_000_000n, id('settle-transport')], { caller: OTHER });
  assert.equal(await controller.readOne('settlementStatus', [originationId]), 2n);
  assert.equal(await token.readOne('balanceOf', [BORROWER]), 10_000_000n);
});

test('settlement request fails for unknown or unauthorized origination records', async () => {
  const s = await setup({ count: 1 });
  const controller = await s.vm.deploy('OriginationController', [s.gate.address, s.registry.address, OWNER]);
  await assert.rejects(() => controller.write('requestSettlement', [id('missing'), id('proof')], { caller: OTHER }), /InvalidSettlement|Unauthorized/);
});
