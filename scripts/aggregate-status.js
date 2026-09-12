'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Contract, JsonRpcProvider, isAddress } = require('ethers');
const { collectAggregateStatus } = require('../src/aggregate-view');

function reader(contract, blockTag) {
  return { address: contract.target,
    readOne: (name, args = []) => contract[name](...args, { blockTag }) };
}
async function main() {
  require('dotenv').config({ quiet: true });
  const [gateAddress, requested = '1'] = process.argv.slice(2);
  if (!isAddress(gateAddress) || !/^\d+$/.test(requested))
    throw new Error('Usage: AGGREGATE_RPC_URL=<url> node scripts/aggregate-status.js <gate-address> [request-raw-units]');
  if (!process.env.AGGREGATE_RPC_URL) throw new Error('AGGREGATE_RPC_URL is required');
  const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts/contracts.json'), 'utf8')).contracts;
  const provider = new JsonRpcProvider(process.env.AGGREGATE_RPC_URL);
  try {
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('Destination block unavailable');
    const connect = (name, address) => reader(new Contract(address, artifacts[name].abi, provider), block.number);
    const gate = connect('ExposurePolicyGate', gateAddress);
    const ledger = connect('MultiLoanLedger', await gate.readOne('ledger'));
    const registry = connect('ExposureScopeRegistry', await ledger.readOne('registry'));
    const report = await collectAggregateStatus({ gate, ledger, registry, requestedAmount: BigInt(requested), block,
      evidenceKind: 'RPC_READ_ONLY' });
    report.destinationChainId = String((await provider.getNetwork()).chainId);
    // Detect reorganization while reading instead of silently mixing two versions of one height.
    if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error('Destination block changed; retry export');
    console.log(JSON.stringify(report, null, 2));
  } finally { provider.destroy(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reader };
