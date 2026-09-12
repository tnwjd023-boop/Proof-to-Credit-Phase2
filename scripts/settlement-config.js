'use strict';

const { isAddress, isHexString } = require('ethers');

const PUBLIC_FIELDS = [
  'mode', 'endpoint', 'sourceEid', 'destinationEid', 'sourcePeer', 'destinationPeer', 'vault', 'asset',
];

function invalid(message) {
  throw new Error(`InvalidSettlementConfig: ${message}`);
}

function requireAddress(value, name, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !isAddress(value)) invalid(`${name} must be an EVM address`);
  if (!allowZero && BigInt(value) === 0n) invalid(`${name} must be nonzero`);
}

function requireEid(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) invalid(`${name} must be a positive uint32`);
}

function validateSettlementConfig(config) {
  if (!config || (config.mode !== 'direct' && config.mode !== 'layerzero')) invalid('mode must be direct or layerzero');
  requireAddress(config.vault, 'vault');
  requireAddress(config.asset, 'asset', { allowZero: true });
  if (config.mode === 'layerzero') {
    requireAddress(config.endpoint, 'endpoint');
    requireEid(config.sourceEid, 'sourceEid');
    requireEid(config.destinationEid, 'destinationEid');
    if (!isHexString(config.sourcePeer, 32) || BigInt(config.sourcePeer) === 0n) invalid('sourcePeer must be a nonzero bytes32');
    if (!isHexString(config.destinationPeer, 32) || BigInt(config.destinationPeer) === 0n) invalid('destinationPeer must be a nonzero bytes32');
  }
  return { ...config };
}

function publicSettlementConfig(config) {
  return Object.fromEntries(PUBLIC_FIELDS.filter((key) => config && config[key] !== undefined)
    .map((key) => [key, config[key]]));
}

module.exports = { validateSettlementConfig, publicSettlementConfig };
