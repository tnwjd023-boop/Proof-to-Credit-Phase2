'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {audit,callAt,validateCompletion}=require('../src/phase2-runtime');
test('audit refuses an empty manifest claiming complete',async()=>{
  const ps={source:{getNetwork:async()=>({chainId:11155111n})},destination:{getNetwork:async()=>({chainId:102031n})}};
  await assert.rejects(()=>audit({ps,manifest:{status:'COMPLETE',steps:{},deployments:{},proofs:{},observations:{}},artifacts:{},directory:'.'}),/missing|incomplete/);
});
test('network failures cannot count as EVM rejection evidence',async()=>{
  await assert.rejects(()=>callAt({call:async()=>{throw {code:'TIMEOUT'};}},{},{number:1}),/without an EVM rejection/);
  assert.deepEqual(await callAt({call:async()=>{throw {code:'CALL_EXCEPTION',data:'0x12345678'};}},{},{number:1}),{kind:'revert',data:'0x12345678'});
});
