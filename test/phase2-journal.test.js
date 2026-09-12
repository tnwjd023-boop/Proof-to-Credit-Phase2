'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Transaction, keccak256 } = require('ethers');
const { transact, validateIntent } = require('../src/phase2-journal');
const signer = new Wallet('0x' + '01'.repeat(32)); // Local test fixture only.
function setup() {
  const manifest = { steps: {} }; let saved; let sends = 0; let receipt = null; let transaction=null;
  const provider = {
    getNetwork: async () => ({chainId:102031n}),
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    broadcastTransaction: async raw => {
      sends++; const t = Transaction.from(raw);
      transaction=t;
      assert.equal(saved.steps.demo.intent.transactionHash, t.hash, 'intent must be durable before network write');
      receipt = { hash:t.hash, from:signer.address, to:t.to, status:1, blockNumber:1, blockHash:'0x'+'ab'.repeat(32), toJSON() {return {...this,toJSON:undefined};} };
      return {hash:t.hash, wait:async()=>receipt};
    },
    getBlock:async()=>({number:1,hash:'0x'+'ab'.repeat(32),timestamp:100}),
  };
  const request = { to:'0x'+'22'.repeat(20), data:'0x1234', value:0, nonce:0, gasLimit:100000, gasPrice:1, type:0, chainId:102031 };
  const save = () => { saved = structuredClone(manifest); };
  const wallet = { address:signer.address, populateTransaction:async r=>({...request,...r}), signTransaction:r=>signer.signTransaction(r) };
  return {manifest,provider,request,save,wallet,sends:()=>sends,dropReceipt:()=>{receipt=null;}};
}
test('durable signed hash precedes broadcast; completed steps do not send twice', async()=>{
  const s=setup();
  await transact({...s,key:'demo',chainId:102031});
  await transact({...s,key:'demo',chainId:102031});
  assert.equal(s.sends(),1); assert.equal(s.manifest.steps.demo.status,'CONFIRMED');
});
test('crash after broadcast recovers the exact receipt without sending again',async()=>{
  const s=setup(); const real=s.save; let writes=0;
  s.save=()=>{writes++; if(writes===2) throw new Error('crash'); real();};
  await assert.rejects(()=>transact({...s,key:'demo',chainId:102031}),/crash/);
  s.save=real; s.manifest.steps.demo.status='PREPARED'; delete s.manifest.steps.demo.receipt;
  await transact({...s,key:'demo',chainId:102031}); assert.equal(s.sends(),1);
});
test('prepared intent cannot be reused with different call data, target or chain',async()=>{
  const s=setup(); await transact({...s,key:'demo',chainId:102031});
  for(const request of [{...s.request,data:'0xab'},{...s.request,to:signer.address}])
    await assert.rejects(()=>transact({...s,request,key:'demo',chainId:102031}),/intent/);
  await assert.rejects(()=>transact({...s,key:'demo',chainId:1}),/chain/);
});
test('intent validation binds sender, nonce, calldata and zero value',async()=>{
  const s=setup(); await transact({...s,key:'demo',chainId:102031});
  const intent=s.manifest.steps.demo.intent;
  const tx={...intent.request,from:signer.address,hash:intent.transactionHash};
  assert.equal(validateIntent(tx,intent),true);
  for(const delta of [{nonce:1},{data:'0xab'},{from:s.request.to},{value:1},{chainId:1}])
    assert.throws(()=>validateIntent({...tx,...delta},intent),/mismatch|zero/);
});
test('pending hash is retained and no replacement is signed or broadcast',async()=>{
  const s=setup(); await transact({...s,key:'demo',chainId:102031}); s.dropReceipt();
  s.manifest.steps.demo.status='PREPARED'; delete s.manifest.steps.demo.receipt;
  s.provider.getTransaction=async()=>({});
  await assert.rejects(()=>transact({...s,key:'demo',chainId:102031}),/pending/);
  assert.equal(s.sends(),1);
});
