'use strict';
const { getAddress, keccak256 } = require('ethers');
const { validatePendingTransaction } = require('./evidence');
const plain = value => JSON.parse(JSON.stringify(value, (_, child) => typeof child === 'bigint' ? String(child) : child));

function validateIntent(tx, intent) {
  validatePendingTransaction(tx, intent);
  if (Number(tx.nonce) !== Number(intent.request.nonce)) throw new Error('transaction nonce mismatch');
  return true;
}
function matches(request, intent, chainId, from) {
  if (BigInt(intent.chainId) !== BigInt(chainId) || getAddress(intent.from) !== getAddress(from) ||
      (request.to ? getAddress(request.to) : null) !== intent.to ||
      keccak256(request.data || '0x') !== intent.dataHash || BigInt(request.value || 0) !== 0n)
    throw new Error('step intent mismatch');
}
// A signature is recreated only for an identical populated transaction whose hash
// was saved before the first broadcast. Private keys and signed payloads are never persisted.
async function transact({manifest, key, provider, wallet, request, chainId, save}) {
  if (![11155111n,102031n].includes(BigInt(chainId)) || (await provider.getNetwork()).chainId !== BigInt(chainId))
    throw new Error('refusing unexpected chain');
  let step = manifest.steps[key];
  if (!step) {
    if (!wallet) throw new Error('existing testnet signing configuration is required');
    if (BigInt(request.value || 0) !== 0n) throw new Error('only zero-value demo transactions are allowed');
    const populated = await wallet.populateTransaction({...request, value:0n, chainId:BigInt(chainId)});
    const raw = await wallet.signTransaction(populated);
    const intent = {request:plain(populated), transactionHash:keccak256(raw), from:wallet.address,
      to:request.to ? getAddress(request.to) : null, chainId:String(chainId), dataHash:keccak256(request.data || '0x'), value:'0'};
    step = manifest.steps[key] = {status:'PREPARED', intent}; save();
  }
  matches(request, step.intent, chainId, wallet?.address || manifest.signer);
  if (step.status === 'CONFIRMED') {
    const receipt=await provider.getTransactionReceipt(step.intent.transactionHash);
    if(!receipt || receipt.status!==1 || receipt.blockHash!==step.receipt.blockHash) throw new Error('confirmed receipt changed');
    validateIntent(await provider.getTransaction(step.intent.transactionHash),step.intent);
    return step;
  }
  const hash = step.intent.transactionHash;
  let receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) {
    if (await provider.getTransaction(hash)) throw new Error(`recorded transaction pending: ${key}`);
    if (!wallet) throw new Error(`prepared transaction needs original signer: ${key}`);
    const raw = await wallet.signTransaction(step.intent.request);
    if (keccak256(raw) !== hash) throw new Error('reconstructed transaction hash mismatch');
    // Re-broadcasting the identical signed hash cannot create a second transaction.
    const sent = await provider.broadcastTransaction(raw);
    if (sent.hash !== hash) throw new Error('broadcast hash mismatch');
    receipt = await sent.wait(1, 180000);
  }
  if (!receipt || receipt.hash !== hash || Number(receipt.status) !== 1) throw new Error(`transaction not confirmed successfully: ${key}`);
  if (getAddress(receipt.from) !== getAddress(step.intent.from) ||
      (receipt.to ? getAddress(receipt.to) : null) !== step.intent.to) throw new Error('receipt identity mismatch');
  const tx = await provider.getTransaction(hash);
  validateIntent(tx, step.intent);
  const block = await provider.getBlock(receipt.blockNumber);
  if (block.hash !== receipt.blockHash) throw new Error('receipt block changed');
  step.receipt = plain(receipt.toJSON ? receipt.toJSON() : receipt);
  step.block = {number:block.number, hash:block.hash, timestamp:block.timestamp};
  step.status = 'CONFIRMED'; save();
  return step;
}
module.exports = {transact, validateIntent, plain};
