'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');
const { createVmHarness } = require('./helpers/vm');
const { OWNER, OTHER, BORROWER } = require('./helpers/aggregate');

test('LayerZero settlement accepts the configured peer and funds once', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const endpoint = await vm.deploy('TestLayerZeroEndpoint', []);
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OWNER, OWNER]);
  const app = await vm.deploy('LayerZeroSettlementOApp', [endpoint.address, 40161, id('source-peer'), 40161, id('destination-peer'), vault.address, OWNER]);
  await vault.write('setAuthority', [app.address]); await token.write('mint', [vault.address, 100n]);
  const origination = id('lz-origination');
  await app.write('sendFunding', [origination, BORROWER, 40n, id('source-proof-lz'), '0x']);
  const guid = await app.readOne('outboundGuid', [origination]);
  await endpoint.write('deliver', [app.address, guid, 40161, id('source-peer'), origination, BORROWER, 40n, id('source-proof-lz')]);
  assert.equal(await app.readOne('status', [origination]), 2n);
  assert.equal(await token.readOne('balanceOf', [BORROWER]), 40n);
  await assert.rejects(() => endpoint.write('deliver', [app.address, guid, 40161, id('source-peer'), origination, BORROWER, 40n, id('source-proof-lz')]), /GuidAlreadyProcessed/);
});

test('LayerZero settlement keeps a failed delivery retryable and rejects a wrong peer', async () => {
  const vm = await createVmHarness({ caller: OWNER });
  const endpoint = await vm.deploy('TestLayerZeroEndpoint', []);
  const token = await vm.deploy('TestSettlementToken', [OWNER]);
  const vault = await vm.deploy('SettlementVault', [token.address, OWNER, OWNER]);
  const app = await vm.deploy('LayerZeroSettlementOApp', [endpoint.address, 40161, id('source-peer'), 40161, id('destination-peer'), vault.address, OWNER]);
  await vault.write('setAuthority', [app.address]);
  const origination = id('lz-failed');
  await app.write('sendFunding', [origination, BORROWER, 40n, id('source-proof-failed'), '0x']);
  const guid = await app.readOne('outboundGuid', [origination]);
  await endpoint.write('deliver', [app.address, guid, 40161, id('source-peer'), origination, BORROWER, 40n, id('source-proof-failed')]);
  assert.equal(await app.readOne('status', [origination]), 3n);
  await assert.rejects(() => endpoint.write('deliver', [app.address, id('wrong-guid'), 40161, id('wrong-peer'), origination, BORROWER, 40n, id('source-proof-failed')]), /InvalidPeer/);
  await token.write('mint', [vault.address, 40n]);
  await app.write('retry', [guid]);
  await endpoint.write('deliver', [app.address, guid, 40161, id('source-peer'), origination, BORROWER, 40n, id('source-proof-failed')]);
  assert.equal(await app.readOne('status', [origination]), 2n);
});
