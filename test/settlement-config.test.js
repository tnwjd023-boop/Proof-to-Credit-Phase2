'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettlementConfig, publicSettlementConfig } = require('../scripts/settlement-config');

const valid = {
  mode: 'layerzero', endpoint: '0x1000000000000000000000000000000000000001',
  sourceEid: 40161, destinationEid: 40161,
  sourcePeer: '0x' + '11'.repeat(32), destinationPeer: '0x' + '22'.repeat(32), vault: '0x2000000000000000000000000000000000000002',
  asset: '0x3000000000000000000000000000000000000003',
};

test('settlement config validates explicit route and emits only public fields', () => {
  assert.deepEqual(validateSettlementConfig(valid), valid);
  const output = publicSettlementConfig({ ...valid, privateKey: 'secret', mnemonic: 'secret words', rpcUrl: 'https://secret' });
  assert.equal(output.privateKey, undefined); assert.equal(output.mnemonic, undefined); assert.equal(output.rpcUrl, undefined);
  assert.equal(output.mode, 'layerzero'); assert.equal(output.destinationEid, 40161);
});

test('layerzero config fails closed for missing endpoint, EID, peer, or invalid mode', async () => {
  for (const [key, value] of [['endpoint', '0x' + '00'.repeat(20)], ['sourceEid', 0], ['destinationEid', 0], ['sourcePeer', '0x' + '00'.repeat(32)]]) {
    await assert.rejects(Promise.resolve().then(() => validateSettlementConfig({ ...valid, [key]: value })), /InvalidSettlementConfig/);
  }
  await assert.rejects(Promise.resolve().then(() => validateSettlementConfig({ ...valid, mode: 'unknown' })), /InvalidSettlementConfig/);
});

test('direct config does not require a LayerZero endpoint but still requires vault and asset', () => {
  const direct = { ...valid, mode: 'direct', endpoint: undefined, sourceEid: undefined, destinationEid: undefined, sourcePeer: undefined, destinationPeer: undefined };
  assert.equal(validateSettlementConfig(direct).mode, 'direct');
});
