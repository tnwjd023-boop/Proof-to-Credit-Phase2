'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID}=require('node:crypto');
const assert = require('node:assert/strict');
const { Contract, Interface, FetchRequest, JsonRpcProvider, keccak256 } = require('ethers');
const { networkConfig } = require('./config');
const { verifierArgs, fetchProof, normalizeProof } = require('./proof-client');
const { buildTamperedProofs } = require('./runtime-negative');
const { writeJsonExclusive } = require('./evidence');
const { plain, validateIntent } = require('./phase2-journal');
const { collectAggregateStatus } = require('./aggregate-view');
const MERKLE = '(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)';
const CONTINUITY = '(bytes32 lowerEndpointDigest,bytes32[] roots)';
const PROVER_ABI = [`function verify(uint64,uint64,bytes,${MERKLE},${CONTINUITY}) view returns(bool)`,
  `function calculateTxIndex(${MERKLE}) view returns(uint64)`];
function provider(url) {
  const request=new FetchRequest(url); request.timeout=15000;
  return new JsonRpcProvider(request, undefined, {cacheTimeout:-1});
}
function errorData(e) {
  const data=e.data || e.info?.error?.data;
  if(e.code !== 'CALL_EXCEPTION' || typeof data !== 'string' || !/^0x[0-9a-f]*$/i.test(data))
    throw new Error(`RPC call failed without an EVM rejection (${e.code || 'unknown'})`);
  return data;
}
async function callAt(p, tx, block) {
  try { return {kind:'return', data:await p.call({...tx,blockTag:block.number})}; }
  catch(e) { return {kind:'revert', data:errorData(e)}; }
}
async function stableBlock(p, block) {
  if((await p.getBlock(block.number))?.hash !== block.hash) throw new Error('block reorganization detected');
}
async function codeAtOrLatest(p,address,blockNumber) {
  try {
    const code=await p.getCode(address,blockNumber);
    if(code!=='0x') return {code,source:'DEPLOYMENT_BLOCK'};
  } catch(error) {
    if(error.code!=='UNKNOWN_ERROR') throw error;
  }
  const code=await p.getCode(address,'latest');
  if(code==='0x') throw new Error('deployed runtime code is unavailable at deployment block and latest');
  return {code,source:'LATEST_RPC_FALLBACK'};
}
async function checkNetworks(ps) {
  for(const name of ['source','destination']) {
    const expected=networkConfig[name].evmChainId;
    if((await ps[name].getNetwork()).chainId !== expected) throw new Error(`wrong ${name} chain`);
  }
}
async function proofControls(p, proof, block) {
  const iface=new Interface(PROVER_ABI), target=networkConfig.destination.blockProver;
  const candidate=async bundle => {
    const tx={to:target,data:iface.encodeFunctionData('verify',verifierArgs(bundle))};
    return {tx,...await callAt(p,tx,block)};
  };
  const normal=await candidate(proof);
  if(normal.kind !== 'return' || !iface.decodeFunctionResult('verify',normal.data)[0]) throw new Error('proof not currently valid');
  const derived=await new Contract(target,PROVER_ABI,p).calculateTxIndex(verifierArgs(proof)[3],{blockTag:block.number});
  if(derived !== BigInt(proof.txIndex)) throw new Error('proof transaction index mismatch');
  const negatives={};
  for(const [name,bundle] of Object.entries(buildTamperedProofs(proof))) {
    const result=await candidate(bundle);
    if(result.kind === 'return' && iface.decodeFunctionResult('verify',result.data)[0]) throw new Error('tampered proof accepted');
    negatives[name]=result;
  }
  await stableBlock(p,block);
  return {evidenceKind:'RPC_READ_ONLY',block:plain(block.toJSON()),precompileCode:await p.getCode(target,block.number),derivedIndex:String(derived),normal,negatives};
}
async function acquireProof({ps,manifest,sourceStep,directory,save}) {
  const record=manifest.steps[sourceStep]; if(record?.status !== 'CONFIRMED') throw new Error('source step incomplete');
  const receipt=record.receipt;
  const freshReceipt=await ps.source.getTransactionReceipt(record.intent.transactionHash);
  if(!freshReceipt || freshReceipt.blockHash !== receipt.blockHash || freshReceipt.status !== 1) throw new Error('source receipt changed');
  const versions=manifest.proofs[sourceStep] || [];
  let proof;
  if(versions.length) proof=JSON.parse(fs.readFileSync(path.join(directory,versions.at(-1).file),'utf8')).bundle;
  let runtime;
  if(proof) {
    proof=normalizeProof(proof,{chainKey:1,headerNumber:receipt.blockNumber});
    try { runtime=await proofControls(ps.destination,proof,await ps.destination.getBlock('latest')); } catch { /* refresh exact source transaction once */ }
  }
  if(!runtime) {
    proof=await fetchProof({baseUrl:networkConfig.proofApiUrl,chainKey:1,txHash:record.intent.transactionHash,
      headerNumber:receipt.blockNumber,onProgress:({status})=>console.log(`WAITING ${sourceStep}: proof API ${status}`)});
    if(BigInt(proof.txIndex) !== BigInt(receipt.index)) throw new Error('source receipt/proof index mismatch');
    runtime=await proofControls(ps.destination,proof,await ps.destination.getBlock('latest'));
  }
  if(BigInt(proof.txIndex) !== BigInt(receipt.index)) throw new Error('source receipt/proof index mismatch');
  // Every preflight is immutable, including any refreshed continuity bundle.
  const file=`proofs/${sourceStep}-${randomUUID()}.json`;
  fs.mkdirSync(path.join(directory,'proofs'),{recursive:true});
  const evidence={sourceStep,sourceTransactionHash:record.intent.transactionHash,sourceBlock:record.block,
    sourceTransactionIndex:receipt.index,bundle:proof,runtime,classification:'BLOCKPROVER_VERIFIED_READ_ONLY'};
  writeJsonExclusive(path.join(directory,file),evidence);
  const ref={file,hash:keccak256(fs.readFileSync(path.join(directory,file))),verificationBlock:runtime.block.number};
  manifest.proofs[sourceStep]=[...versions,ref]; save();
  return {proof,ref};
}
async function aggregateReport(ps,manifest,artifacts,block,amount) {
  const reader=(name,key)=>{
    const c=new Contract(manifest.deployments[key].address,artifacts.contracts[name].abi,ps.destination);
    return {address:c.target,readOne:(method,args=[])=>c[method](...args,{blockTag:block.number})};
  };
  const report=await collectAggregateStatus({gate:reader('ExposurePolicyGate','gate'),ledger:reader('MultiLoanLedger','ledger'),
    registry:reader('ExposureScopeRegistry','registry'),requestedAmount:BigInt(amount),block,evidenceKind:'RPC_READ_ONLY'});
  report.destinationChainId='102031'; report.runId=manifest.runId;
  const ledger=reader('MultiLoanLedger','ledger');
  report.ledgerStateVersion=String(await ledger.readOne('stateVersion'));
  report.snapshotStateVersion=String(await ledger.readOne('snapshotStateVersion'));
  report.loans=await Promise.all(report.sources.map((s,i)=>ledger.readOne('loanState',[s.key,manifest.loanIds[i]]).then(plain)));
  await stableBlock(ps.destination,block); return report;
}
async function audit({ps,manifest,artifacts,directory}) {
  await checkNetworks(ps);
  if(manifest.status==='COMPLETE') validateCompletion(manifest);
  let transactions=0,calls=0,proofs=0;
  for(const step of Object.values(manifest.steps)) {
    const stepName=Object.entries(manifest.steps).find(([,value])=>value===step)?.[0] || 'unknown-step';
    try {
    if(step.status !== 'CONFIRMED') throw new Error('run contains an incomplete transaction');
    const p=BigInt(step.intent.chainId)===11155111n?ps.source:ps.destination;
    validateIntent(await p.getTransaction(step.intent.transactionHash),step.intent);
    const r=await p.getTransactionReceipt(step.intent.transactionHash);
    if(!r || r.status !== 1 || r.blockHash !== step.receipt.blockHash || r.blockNumber !== step.receipt.blockNumber) throw new Error('recorded receipt mismatch');
    await stableBlock(p,step.block); transactions++;
    } catch (error) { throw new Error(`audit transaction ${stepName}: ${error.shortMessage || error.message || error.code || 'unknown'}`); }
  }
  const codeObservations={};
  for(const [deploymentKey,deployment] of Object.entries(manifest.deployments)) {
    const p=deployment.network==='source'?ps.source:ps.destination;
    const observed=await codeAtOrLatest(p,deployment.address,deployment.blockNumber);
    if(keccak256(observed.code) !== deployment.runtimeCodeHash) throw new Error('deployed code hash mismatch');
    codeObservations[deploymentKey]={address:deployment.address,requestedBlock:deployment.blockNumber,source:observed.source,runtimeCodeHash:keccak256(observed.code)};
  }
  for(const versions of Object.values(manifest.proofs)) for(const ref of versions) {
    try {
    const bytes=fs.readFileSync(path.join(directory,ref.file));
    if(keccak256(bytes)!==ref.hash) throw new Error('proof file changed');
    const e=JSON.parse(bytes); const block=e.runtime.block;
    const bundle=normalizeProof(e.bundle,{chainKey:1,headerNumber:manifest.steps[e.sourceStep].receipt.blockNumber});
    assert.equal(e.sourceTransactionHash,manifest.steps[e.sourceStep].intent.transactionHash);
    assert.equal(String(bundle.txIndex),String(manifest.steps[e.sourceStep].receipt.index));
    const iface=new Interface(PROVER_ABI);
    assert.equal(e.runtime.normal.tx.to,networkConfig.destination.blockProver);
    assert.equal(e.runtime.normal.tx.data,iface.encodeFunctionData('verify',verifierArgs(bundle)));
    assert.equal(e.runtime.normal.kind,'return');
    assert.equal(iface.decodeFunctionResult('verify',e.runtime.normal.data)[0],true);
    for(const [name,mutated]of Object.entries(buildTamperedProofs(bundle))) {
      const neg=e.runtime.negatives[name];
      assert.ok(neg,'missing proof negative control');
      assert.equal(neg.tx.to,networkConfig.destination.blockProver);
      assert.equal(neg.tx.data,iface.encodeFunctionData('verify',verifierArgs(mutated)));
      assert.ok(neg.kind==='revert' || !iface.decodeFunctionResult('verify',neg.data)[0]);
    }
    const normal=await callAt(ps.destination,e.runtime.normal.tx,block);
    assert.deepEqual(normal,{kind:e.runtime.normal.kind,data:e.runtime.normal.data});
    for(const negative of Object.values(e.runtime.negatives)) {
      assert.deepEqual(await callAt(ps.destination,negative.tx,block),{kind:negative.kind,data:negative.data});
    }
    await stableBlock(ps.destination,block); proofs++;
    } catch (error) { throw new Error(`audit proof: ${error.shortMessage || error.message || error.code || 'unknown'}`); }
  }
  for(const [key,ref]of Object.entries(manifest.submissionProofs || {})) {
    const evidence=JSON.parse(fs.readFileSync(path.join(directory,ref.file),'utf8'));
    const iface=new Interface(artifacts.contracts.MultiLoanLedger.abi);
    assert.equal(manifest.steps[key].intent.to,manifest.deployments.ledger.address);
    assert.equal(manifest.steps[key].intent.request.data,iface.encodeFunctionData('submitSourceTransaction',verifierArgs(evidence.bundle)));
    assert.ok((manifest.proofs[evidence.sourceStep] || []).some(p=>p.file===ref.file && p.hash===ref.hash));
  }
  for(const observation of Object.values(manifest.observations)) {
    try {
    const report=await aggregateReport(ps,manifest,artifacts,observation.block,observation.amount);
    assert.deepEqual(report,observation.report);
    for(const call of observation.calls || []) {
      assert.deepEqual(await callAt(ps.destination,call.tx,observation.block),call.result); calls++;
    }
    }
    catch (error) { throw new Error(`audit observation: ${error.shortMessage || error.message || error.code || 'unknown'}`); }
  }
  return {status:manifest.status==='COMPLETE'?'COMPLETE':'PARTIAL',evidenceKind:'RPC_READ_ONLY',transactions,proofs,calls,newTransactions:0,codeObservations};
}
function validateCompletion(m){
  const sourceSteps=['A-open','A-checkpoint-1','B-open','B-checkpoint-1','B-repay','A-checkpoint-2','B-checkpoint-2'];
  const required=['deploy-A','deploy-B','deploy-registry','deploy-decoder','deploy-ledger','deploy-gate','A-seal','B-seal',...sourceSteps,...sourceSteps.map(k=>`submit-${k}`),'finalize-1','finalize-2','reserve-20'];
  for(const key of required) assert.equal(m.steps[key]?.status,'CONFIRMED',`missing completed step ${key}`);
  for(const key of ['A','B','registry','decoder','ledger','gate'])assert.ok(m.deployments[key]?.address,`missing deployment ${key}`);
  for(const key of sourceSteps){assert.ok(m.proofs[key]?.length,`missing proof ${key}`);assert.ok(m.submissionProofs?.[`submit-${key}`],`missing proof binding ${key}`);}
  const expected={
    'missing-B':{totalDebt:'30000000',reason:'COVERAGE_INCOMPLETE',snapshotComplete:false},
    'epoch-1':{totalDebt:'50000000',reason:'OVER_LIMIT',snapshotEpoch:'1',snapshotComplete:true},
    'repayment-invalidates':{totalDebt:'40000000',snapshotComplete:false},
    'epoch-2':{totalDebt:'40000000',reason:'ALLOW',headroom:'20000000',snapshotEpoch:'2',snapshotComplete:true},
    reserved:{totalDebt:'40000000',reservedCredit:'20000000',headroom:'0',reason:'OVER_LIMIT'},
    'proof-negatives':{totalDebt:'40000000',reservedCredit:'20000000'},
  };
  for(const [key,fields]of Object.entries(expected))for(const [field,value]of Object.entries(fields))assert.equal(m.observations[key]?.report[field],value,`missing scenario observation ${key}.${field}`);
  const names=Object.values(m.observations).flatMap(o=>(o.calls || []).map(c=>c.name));
  for(const name of ['missing-source-finalize','missing-source-reserve','over-limit-epoch1','competing-reservation','additional-one','replay','rootTampered','bytesTampered','continuityTampered'])assert.ok(names.includes(name),`missing negative ${name}`);
}
module.exports={provider,checkNetworks,proofControls,acquireProof,aggregateReport,audit,callAt,stableBlock,PROVER_ABI,validateCompletion};
