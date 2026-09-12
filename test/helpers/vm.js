'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Chain, Common, Hardfork } = require('@ethereumjs/common');
const { Address, bytesToHex, hexToBytes } = require('@ethereumjs/util');
const { VM } = require('@ethereumjs/vm');
const { Block } = require('@ethereumjs/block');
const { Interface, concat, getAddress, toBeHex, zeroPadValue } = require('ethers');

const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'artifacts', 'contracts.json');

function loadArtifact(name) {
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error('Missing artifacts; run node scripts/compile.js first');
  const bundle = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const artifact = bundle.contracts[name];
  if (!artifact) throw new Error(`Artifact not found: ${name}`);
  if (!artifact.deployedBytecode || artifact.deployedBytecode === '0x') {
    throw new Error(`Artifact has no deployed bytecode: ${name}`);
  }
  return artifact;
}

async function runPureLibrary(contractName, functionName, args) {
  const artifact = loadArtifact(contractName);
  const iface = new Interface(artifact.abi);
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Paris });
  const vm = await VM.create({ common });
  const result = await vm.evm.runCode({
    code: hexToBytes(artifact.deployedBytecode),
    data: hexToBytes(iface.encodeFunctionData(functionName, args)),
    gasLimit: 30_000_000n,
    isStatic: true,
  });
  if (result.exceptionError) throw new Error(`EVM revert: ${result.exceptionError.error}`);
  return iface.decodeFunctionResult(functionName, result.returnValue);
}

function replaceFirstWord(encoded, value) {
  return `${zeroPadValue(toBeHex(value), 32)}${encoded.slice(66)}`;
}

function revertError(iface, result) {
  const data = bytesToHex(result.returnValue);
  try {
    const parsed = iface.parseError(data);
    if (parsed) return new Error(`${parsed.name}(${[...parsed.args].join(',')})`);
  } catch {}
  try {
    const bundle = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    for (const artifact of Object.values(bundle.contracts)) {
      try {
        const parsed = new Interface(artifact.abi).parseError(data);
        if (parsed) return new Error(`${parsed.name}(${[...parsed.args].join(',')})`);
      } catch {}
    }
  } catch {}
  return new Error(`EVM revert: ${result.exceptionError?.error || 'unknown'} (${data})`);
}

function parsedEvents(iface, logs = []) {
  return logs.map(([, topics, data]) => {
    const raw = { topics: topics.map(bytesToHex), data: bytesToHex(data) };
    const parsed = iface.parseLog(raw);
    return parsed ? { name: parsed.name, args: parsed.args, topics: raw.topics, data: raw.data } : null;
  }).filter(Boolean);
}

async function deployContract(contractName, constructorArgs, { caller }) {
  const artifact = loadArtifact(contractName);
  const iface = new Interface(artifact.abi);
  const common = new Common({ chain: Chain.Sepolia, hardfork: Hardfork.Paris });
  const vm = await VM.create({ common });
  const callerAddress = Address.fromString(caller);
  const deployment = await vm.evm.runCall({
    caller: callerAddress,
    data: hexToBytes(concat([artifact.bytecode, iface.encodeDeploy(constructorArgs)])),
    gasLimit: 30_000_000n,
  });
  if (deployment.execResult.exceptionError || !deployment.createdAddress) {
    throw revertError(iface, deployment.execResult);
  }
  const contractAddress = deployment.createdAddress;

  async function execute(functionName, args, { caller: callFrom = caller, isStatic = false } = {}) {
    const call = await vm.evm.runCall({
      caller: Address.fromString(callFrom),
      to: contractAddress,
      data: hexToBytes(iface.encodeFunctionData(functionName, args)),
      gasLimit: 30_000_000n,
      isStatic,
    });
    const result = call.execResult;
    if (result.exceptionError) throw revertError(iface, result);
    const decoded = iface.decodeFunctionResult(functionName, result.returnValue);
    const events = parsedEvents(iface, result.logs);
    return {
      result: decoded,
      events,
      blockTimestamp: events.length ? events[0].args[events[0].args.length - 1] : undefined,
    };
  }

  return {
    address: getAddress(contractAddress.toString()),
    read: async (functionName, args = []) => (await execute(functionName, args, { isStatic: true })).result,
    readOne: async (functionName, args = []) => (await execute(functionName, args, { isStatic: true })).result[0],
    write: (functionName, args, options = {}) => execute(functionName, args, options),
  };
}

async function createVmHarness({ caller, chainId = 11155111 }) {
  const common = Common.custom({ chainId }, { hardfork: Hardfork.Paris });
  const vm = await VM.create({ common });
  let timestamp = 0n;

  async function deploy(contractName, constructorArgs, { caller: deployer = caller } = {}) {
    const artifact = loadArtifact(contractName);
    const iface = new Interface(artifact.abi);
    const deployment = await vm.evm.runCall({
      caller: Address.fromString(deployer),
      data: hexToBytes(concat([artifact.bytecode, iface.encodeDeploy(constructorArgs)])),
      gasLimit: 30_000_000n,
    });
    if (deployment.execResult.exceptionError || !deployment.createdAddress) throw revertError(iface, deployment.execResult);
    const contractAddress = deployment.createdAddress;

    async function execute(functionName, args, { caller: callFrom = caller, isStatic = false } = {}) {
      const call = await vm.evm.runCall({
        block: Block.fromBlockData({ header: { timestamp } }, { common }),
        caller: Address.fromString(callFrom),
        to: contractAddress,
        data: hexToBytes(iface.encodeFunctionData(functionName, args)),
        gasLimit: 30_000_000n,
        isStatic,
      });
      const result = call.execResult;
      if (result.exceptionError) throw revertError(iface, result);
      return { result: iface.decodeFunctionResult(functionName, result.returnValue), events: parsedEvents(iface, result.logs) };
    }

    return {
      address: getAddress(contractAddress.toString()),
      read: async (name, args = []) => (await execute(name, args, { isStatic: true })).result,
      readOne: async (name, args = []) => (await execute(name, args, { isStatic: true })).result[0],
      write: (name, args, options = {}) => execute(name, args, options),
    };
  }

  return { deploy, setTimestamp: (value) => { timestamp = BigInt(value); } };
}

module.exports = { createVmHarness, deployContract, loadArtifact, replaceFirstWord, runPureLibrary };
