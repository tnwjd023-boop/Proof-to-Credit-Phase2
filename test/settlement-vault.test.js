'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { createVmHarness } = require('./helpers/vm');
const { OWNER, OTHER, BORROWER } = require('./helpers/aggregate');

test('settlement vault releases an exact ERC-20 amount once', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OTHER, OWNER]);
  await token.write('mint', [vault.address, 100n]);
  await vault.write('fund', [id('origination-1'), BORROWER, 40n, id('transport-1')], { caller: OTHER });
  assert.equal(await token.readOne('balanceOf', [BORROWER]), 40n);
  assert.equal(await vault.readOne('funded', [id('origination-1')]), true);
  await assert.rejects(() => vault.write('fund', [id('origination-1'), BORROWER, 40n, id('transport-2')], { caller: OTHER }), /OriginationAlreadyFunded/);
});

test('settlement vault rejects unauthorized, duplicate transport, zero, and insufficient funding', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OTHER, OWNER]);
  await token.write('mint', [vault.address, 10n]);
  const args = [id('origination-2'), BORROWER, 10n, id('transport-2')];
  await assert.rejects(() => vault.write('fund', args), /Unauthorized/);
  await assert.rejects(() => vault.write('fund', [args[0], BORROWER, 0n, args[3]], { caller: OTHER }), /InvalidFunding/);
  await vault.write('fund', args, { caller: OTHER });
  await assert.rejects(() => vault.write('fund', [id('origination-3'), BORROWER, 1n, args[3]], { caller: OTHER }), /TransportAlreadyUsed/);
  await assert.rejects(() => vault.write('fund', [id('origination-4'), BORROWER, 1n, id('transport-4')], { caller: OTHER }), /TransferFailed/);
});
