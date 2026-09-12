'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {Wallet,Contract,ContractFactory,Interface,id,keccak256,getAddress}=require('ethers');
const {networkConfig}=require('../src/config');
const {writeJsonAtomic,writeJsonExclusive}=require('../src/evidence');
const {transact,plain}=require('../src/phase2-journal');
const {provider,checkNetworks,proofControls,acquireProof,aggregateReport,audit,callAt,stableBlock,PROVER_ABI}=require('../src/phase2-runtime');
const {verifierArgs,fetchProof}=require('../src/proof-client');
const {buildTamperedProofs}=require('../src/runtime-negative');
const ROOT=path.join(__dirname,'..');
const TTL=7200;
function option(args,name){const i=args.indexOf(name);return i<0?undefined:args[i+1];}
function runDirectory(runId){
  if(!/^phase2-[a-zA-Z0-9_-]+$/.test(runId || '')) throw new Error('use a separate --run phase2-<unique-id>');
  return path.join(ROOT,'runs',runId);
}
function provenance(artifacts){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  const files=git('ls-files','contracts','src','scripts','test','package.json','package-lock.json').split(/\r?\n/).filter(Boolean);
  // New runner files are included before the first commit as well.
  for(const file of ['src/phase2-journal.js','src/phase2-runtime.js','scripts/phase2-demo.js']) if(!files.includes(file)) files.push(file);
  return {commit:git('rev-parse','HEAD'),compiler:artifacts.compiler,settings:artifacts.settings,
    artifactHash:keccak256(fs.readFileSync(path.join(ROOT,'artifacts/contracts.json'))),
    sourceHashes:Object.fromEntries(files.map(file=>[file,keccak256(fs.readFileSync(path.join(ROOT,file)))]))};
}
function lock(directory){
  const file=path.join(directory,'.execution-lock');
  if(fs.existsSync(file)){
    const old=JSON.parse(fs.readFileSync(file,'utf8'));
    if(old.host!==os.hostname()) throw new Error('run locked by another host');
    let active=true; try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH') active=false;else throw e;}
    if(active) throw new Error('run already executing');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file,JSON.stringify({host:os.hostname(),pid:process.pid}),{flag:'wx'});
  return ()=>fs.unlinkSync(file);
}
async function main(args=process.argv.slice(2)){
  const command=args[0],runId=option(args,'--run');
  if(!['probe','run','audit'].includes(command)) throw new Error('Usage: node scripts/phase2-demo.js <probe|run|audit> --run phase2-<unique-id>');
  const directory=runDirectory(runId),file=path.join(directory,'manifest.json');
  const artifacts=JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts/contracts.json'),'utf8'));
  const ps={source:provider(networkConfig.source.rpcUrl),destination:provider(networkConfig.destination.rpcUrl)};
  let unlock;
  try{
    await checkNetworks(ps);
    if(command==='audit'){
      const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
      const result=await audit({ps,manifest,artifacts,directory});
      writeJsonAtomic(path.join(directory,'audit.json'),{schema:'proof-to-credit/phase2-audit-v1',runId,evidenceKind:'RPC_READ_ONLY',auditedAt:new Date().toISOString(),command:`npm run phase2 -- audit --run ${runId}`,result});
      console.log(JSON.stringify(result,null,2)); return;
    }
    fs.mkdirSync(directory,{recursive:true}); unlock=lock(directory);
    let manifest;
    if(fs.existsSync(file)){
      manifest=JSON.parse(fs.readFileSync(file,'utf8'));
      if(manifest.schema!=='proof-to-credit/phase2-run-v1' || manifest.runId!==runId) throw new Error('incompatible manifest');
    }else{
      const address=process.env.WALLET_ADDRESS;
      manifest={schema:'proof-to-credit/phase2-run-v1',runId,status:'INITIALIZED',createdAt:new Date().toISOString(),
        signer:address?getAddress(address):null,networks:{source:{chainId:'11155111',attestcoinChainKey:'1'},destination:{chainId:'102031',blockProver:networkConfig.destination.blockProver}},
        unit:'DEMO_USD_6',rawScale:'1000000',scenario:{principalA:'30000000',principalB:'20000000',repaymentB:'10000000',creditLimit:'60000000',request:'20000000'},
        ttl:{seconds:TTL,rationale:'Two-hour source-checkpoint validity budget permits sequential attestation/proof retrieval (30-minute client timeout) and submissions. No source timestamp alteration; expiration stops the scenario.'},
        scope:'Two distinct Sepolia demo accounting sources and distinct debts; one testnet signer; no independent institutions or multiple source chains.',
        provenance:provenance(artifacts),loanIds:[id(`${runId}:A:loan`),id(`${runId}:B:loan`)],
        steps:{},deployments:{},proofs:{},observations:{}};
      writeJsonExclusive(file,manifest);
    }
    const save=()=>writeJsonAtomic(file,manifest);
    const sourceBlock=await ps.source.getBlock('latest'),destinationBlock=await ps.destination.getBlock('latest');
    const prover=new Contract(networkConfig.destination.blockProver,PROVER_ABI,ps.destination);
    const existing=JSON.parse(fs.readFileSync(path.join(ROOT,'runs/20260906-t05/proofs/debt-opened.json'),'utf8')).bundle;
    const derived=await prover.calculateTxIndex(verifierArgs(existing)[3],{blockTag:destinationBlock.number});
    if(derived!==BigInt(existing.txIndex)) throw new Error('native BlockProver behavior mismatch');
    const probe={evidenceKind:'RPC_READ_ONLY',sourceBlock:plain(sourceBlock.toJSON()),destinationBlock:plain(destinationBlock.toJSON()),
      precompileCode:await ps.destination.getCode(networkConfig.destination.blockProver,destinationBlock.number),
      calculatedTxIndex:String(derived),expectedTxIndex:existing.txIndex,signingConfigured:Boolean(process.env.PRIVATE_KEY)};
    if(manifest.signer){probe.sourceBalance=String(await ps.source.getBalance(manifest.signer));probe.destinationBalance=String(await ps.destination.getBalance(manifest.signer));}
    manifest.probes ||= []; manifest.probes.push(probe);save();
    console.log(JSON.stringify({runId,sourceBlock:sourceBlock.number,destinationBlock:destinationBlock.number,precompileCode:probe.precompileCode,calculatedTxIndex:String(derived),signingConfigured:probe.signingConfigured,sourceBalance:probe.sourceBalance,destinationBalance:probe.destinationBalance}));
    if(command==='probe')return;
    if(!process.env.PRIVATE_KEY || !manifest.signer)throw new Error('existing PRIVATE_KEY and WALLET_ADDRESS configuration required; do not send credentials in chat');
    // Keep the current exact artifacts bound to this run, even on a resume.
    if(manifest.provenance.artifactHash!==keccak256(fs.readFileSync(path.join(ROOT,'artifacts/contracts.json'))))throw new Error('artifacts changed since run creation');
    const wallets={source:new Wallet(process.env.PRIVATE_KEY,ps.source),destination:new Wallet(process.env.PRIVATE_KEY,ps.destination)};
    if(wallets.source.address!==manifest.signer || getAddress(process.env.WALLET_ADDRESS)!==manifest.signer)throw new Error('testnet signer mismatch');
    if(BigInt(probe.sourceBalance)===0n || BigInt(probe.destinationBalance)===0n)throw new Error('testnet gas balance missing');
    if(!manifest.predeploymentProver){
      const canonical=JSON.parse(fs.readFileSync(path.join(ROOT,'runs/20260906-t05/proofs/debt-opened.json'),'utf8'));
      let bundle=canonical.bundle,runtime;
      try{runtime=await proofControls(ps.destination,bundle,await ps.destination.getBlock('latest'));}catch{}
      if(!runtime){
        bundle=await fetchProof({baseUrl:networkConfig.proofApiUrl,chainKey:1,txHash:canonical.sourceTransactionHash,headerNumber:existing.headerNumber,onProgress:({status})=>console.log(`WAITING predeployment proof: ${status}`)});
        runtime=await proofControls(ps.destination,bundle,await ps.destination.getBlock('latest'));
      }
      manifest.predeploymentProver={sourceTransactionHash:canonical.sourceTransactionHash,bundle,runtime};save();
      console.log('VERIFIED predeployment BlockProver positive and tamper controls (eth_call only)');
    }
    const stop=option(args,'--stop-after');
    const progress=key=>{console.log(`CONFIRMED ${key}`);if(stop===key)throw new Error(`requested stop after ${key}; resume with the same run ID`);};
    async function tx(key,network,request){
      const result=await transact({manifest,key,provider:ps[network],wallet:wallets[network],request,chainId:networkConfig[network].evmChainId,save});
      return result;
    }
    async function deploy(key,name,network,constructorArgs){
      const a=artifacts.contracts[name];const request=await new ContractFactory(a.abi,a.bytecode).getDeployTransaction(...constructorArgs);
      const step=await tx(`deploy-${key}`,network,request);
      const address=step.receipt.contractAddress;
      if(!address)throw new Error('deployment address missing');
      const code=await ps[network].getCode(address,step.receipt.blockNumber);
      if(code==='0x')throw new Error('deployment has no runtime code');
      manifest.deployments[key]={name,network,address,constructorArgs:plain(constructorArgs),transactionHash:step.intent.transactionHash,
        blockNumber:step.receipt.blockNumber,runtimeCodeHash:keccak256(code)};save();progress(`deploy-${key}`);
      return new Contract(address,a.abi,ps[network]);
    }
    async function write(key,network,contract,method,params){
      const result=await tx(key,network,{to:contract.target,data:contract.interface.encodeFunctionData(method,params),value:0n});
      progress(key);return result;
    }
    const sources=[];
    for(const label of ['A','B'])sources.push(await deploy(label,'SealedLoanSource','source',[manifest.signer]));
    const scope=sources.map(s=>[1,s.target,id('sealed-v1'),id(`${runId}:demo-identities`),id('DEMO_USD_6'),1]);
    await deploy('registry','ExposureScopeRegistry','destination',[id(`${runId}:scope`),1,manifest.signer,scope]);
    await deploy('decoder','EvmV1Decoder','destination',[]);
    const ledger=await deploy('ledger','MultiLoanLedger','destination',[manifest.deployments.registry.address,networkConfig.destination.blockProver,manifest.deployments.decoder.address,manifest.ttl.seconds]);
    const gate=await deploy('gate','ExposurePolicyGate','destination',[ledger.target,manifest.signer,60000000n]);
    for(let i=0;i<2;i++){
      const label=['A','B'][i];
      await write(`${label}-open`,'source',sources[i],'openLoan',[manifest.loanIds[i],manifest.signer,manifest.signer,id(`${runId}:demo-asset`),i===0?30000000n:20000000n]);
      await write(`${label}-seal`,'source',sources[i],'seal',[]);
      await write(`${label}-checkpoint-1`,'source',sources[i],'checkpoint',[]);
    }
    async function submit(sourceStep){
      const key=`submit-${sourceStep}`;
      if(manifest.steps[key]){
        await tx(key,'destination',manifest.steps[key].intent.request);progress(key);return;
      }
      const {proof,ref}=await acquireProof({ps,manifest,sourceStep,directory,save});
      // The proof and its three mutations have passed real BlockProver controls.
      const request={to:ledger.target,data:ledger.interface.encodeFunctionData('submitSourceTransaction',verifierArgs(proof)),value:0n};
      manifest.submissionProofs ||= {};manifest.submissionProofs[key]=ref;save();
      await tx(key,'destination',request);progress(key);
    }
    const reserveArgs=(report,name,amount)=>[id(`${runId}:${name}`),amount,report.exposureStateVersion,report.policyVersion,report.scopeVersion,report.snapshotId];
    async function observe(key,amount,expected,negativeCalls){
      if(manifest.observations[key])return manifest.observations[key].report;
      const block=await ps.destination.getBlock('latest');
      const report=await aggregateReport(ps,manifest,artifacts,block,amount);
      for(const [field,value]of Object.entries(expected))assert.equal(report[field],value,`${key}.${field}`);
      const calls=[];
      for(const spec of negativeCalls?await negativeCalls(report):[]){
        const call={to:spec.contract.target,from:manifest.signer,data:spec.contract.interface.encodeFunctionData(spec.method,spec.args)};
        const result=await callAt(ps.destination,call,block);
        if(result.kind!=='revert')throw new Error(`negative call unexpectedly succeeded: ${spec.name}`);
        let parsed;try{parsed=spec.contract.interface.parseError(result.data);}catch{}
        if(spec.error && parsed?.name!==spec.error)throw new Error(`unexpected rejection for ${spec.name}: ${parsed?.name || result.data}`);
        if(spec.reason!==undefined && Number(parsed?.args[0])!==spec.reason)throw new Error('wrong denial reason');
        calls.push({name:spec.name,tx:call,result,errorName:parsed?.name || 'NativeVerifierRevert'});
      }
      assert.deepEqual(await aggregateReport(ps,manifest,artifacts,block,amount),report,'negative calls changed state');
      manifest.observations[key]={evidenceKind:'RPC_READ_ONLY',block:{number:block.number,hash:block.hash,timestamp:block.timestamp},amount:String(amount),report,calls,stateUnchanged:true};
      save();console.log(`OBSERVED ${key}: debt=${report.totalDebt} reserved=${report.reservedCredit} ${report.reason}`);return report;
    }
    await submit('A-open');await submit('A-checkpoint-1');
    await observe('missing-B',20000000,{totalDebt:'30000000',snapshotComplete:false,reason:'COVERAGE_INCOMPLETE'},report=>[
      {name:'missing-source-finalize',contract:ledger,method:'finalizeSnapshot',args:[1],error:'CoverageIncomplete'},
      {name:'missing-source-reserve',contract:gate,method:'reserve',args:reserveArgs(report,'missing',20000000),error:'DecisionDenied',reason:2}]);
    await submit('B-open');await submit('B-checkpoint-1');
    await write('finalize-1','destination',ledger,'finalizeSnapshot',[1]);
    await observe('epoch-1',20000000,{totalDebt:'50000000',snapshotEpoch:'1',snapshotComplete:true,reason:'OVER_LIMIT'},report=>[
      {name:'over-limit-epoch1',contract:gate,method:'reserve',args:reserveArgs(report,'over-limit',20000000),error:'DecisionDenied',reason:1}]);
    await write('B-repay','source',sources[1],'repay',[manifest.loanIds[1],10000000]);
    await submit('B-repay');
    await observe('repayment-invalidates',20000000,{totalDebt:'40000000',snapshotComplete:false,reason:'COVERAGE_INCOMPLETE'});
    for(let i=0;i<2;i++)await write(`${['A','B'][i]}-checkpoint-2`,'source',sources[i],'checkpoint',[]);
    await submit('A-checkpoint-2');await submit('B-checkpoint-2');
    await write('finalize-2','destination',ledger,'finalizeSnapshot',[2]);
    const before=await observe('epoch-2',20000000,{totalDebt:'40000000',snapshotEpoch:'2',snapshotComplete:true,reason:'ALLOW',headroom:'20000000'});
    await write('reserve-20','destination',gate,'reserve',reserveArgs(before,'reservation',20000000));
    await observe('reserved',1000000,{totalDebt:'40000000',reservedCredit:'20000000',headroom:'0',reason:'OVER_LIMIT'},report=>[
      {name:'competing-reservation',contract:gate,method:'reserve',args:reserveArgs(before,'competitor',20000000),error:'StaleStateVersion'},
      {name:'additional-one',contract:gate,method:'reserve',args:reserveArgs(report,'additional-one',1000000),error:'DecisionDenied',reason:1}]);
    if(!manifest.observations['proof-negatives']){
      const {proof}=await acquireProof({ps,manifest,sourceStep:'B-repay',directory,save});
      const tampered=buildTamperedProofs(proof);
      await observe('proof-negatives',1000000,{totalDebt:'40000000',reservedCredit:'20000000'},()=>[
        {name:'replay',contract:ledger,method:'submitSourceTransaction',args:verifierArgs(proof),error:'AlreadyProcessed'},
        ...Object.entries(tampered).map(([name,bundle])=>({name,contract:ledger,method:'submitSourceTransaction',args:verifierArgs(bundle)}))]);
    }
    manifest.status='COMPLETE';save();
    console.log(JSON.stringify(await audit({ps,manifest,artifacts,directory}),null,2));
  }finally{if(unlock)unlock();ps.source.destroy();ps.destination.destroy();}
}
if(require.main===module)main().catch(e=>{
  // RPC exception objects may contain credential-bearing URLs; never serialize them.
  const detail=e.code ? `${String(e.code)}${e.shortMessage ? `: ${e.shortMessage}` : ''}` : (e.message || 'unknown failure');
  console.error(`PHASE2_BLOCKED: ${detail}`);process.exitCode=1;
});
module.exports={main,runDirectory,provenance};
