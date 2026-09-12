'use strict';

const { createVmHarness } = require('./vm');
const { OWNER, OTHER } = require('./aggregate');

async function settlementSetup({ asset = true, authority = OTHER } = {}) {
  const vm = await createVmHarness({ caller: OWNER });
  const token = asset ? await vm.deploy('TestSettlementToken', [OWNER]) : null;
  const vault = await vm.deploy('SettlementVault', [token ? token.address : '0x0000000000000000000000000000000000000000', authority, OWNER]);
  return { vm, token, vault, owner: OWNER, authority };
}

module.exports = { settlementSetup };
