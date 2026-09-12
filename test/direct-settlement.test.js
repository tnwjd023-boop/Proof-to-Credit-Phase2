'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { createVmHarness } = require('./helpers/vm');
const { OWNER, OTHER, BORROWER } = require('./helpers/aggregate');

test('direct settlement adapter binds a request and funds through the vault once', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OWNER, OWNER]);
  const adapter = await vm.deploy('DirectSettlementAdapter', [vault.address, OWNER, OWNER]);
  await vault.write('setAuthority', [adapter.address]);
  await token.write('mint', [vault.address, 100n]);
  await adapter.write('setRelayer', [OTHER, true]);
  await adapter.write('requestFunding', [id('direct-origination'), BORROWER, 40n, id('source-proof')]);
  await adapter.write('fund', [id('direct-origination'), BORROWER, 40n, id('direct-transport')], { caller: OTHER });
  assert.equal(await adapter.readOne('status', [id('direct-origination')]), 2n);
  assert.equal(await token.readOne('balanceOf', [BORROWER]), 40n);
  await assert.rejects(() => adapter.write('fund', [id('direct-origination'), BORROWER, 40n, id('direct-transport-2')], { caller: OTHER }), /InvalidSettlement/);
});

test('direct settlement records a retryable failure when the vault lacks funds', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OWNER, OWNER]);
  const adapter = await vm.deploy('DirectSettlementAdapter', [vault.address, OWNER, OWNER]);
  await vault.write('setAuthority', [adapter.address]);
  await adapter.write('setRelayer', [OTHER, true]);
  await adapter.write('requestFunding', [id('direct-failed'), BORROWER, 40n, id('source-proof-failed')]);
  const result = await adapter.write('fund', [id('direct-failed'), BORROWER, 40n, id('direct-transport-failed')], { caller: OTHER });
  assert.equal(result.result[0], false);
  assert.equal(await adapter.readOne('status', [id('direct-failed')]), 3n);
  await token.write('mint', [vault.address, 40n]);
  await adapter.write('retry', [id('direct-failed')], { caller: OTHER });
  assert.equal(await adapter.readOne('status', [id('direct-failed')]), 2n);
});
