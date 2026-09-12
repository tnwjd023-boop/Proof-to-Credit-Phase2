'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('settlement interface exposes the shared funding lifecycle', () => {
  const artifactPath = path.join(__dirname, '..', 'artifacts', 'contracts.json');
  const bundle = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.ok(bundle.contracts.SettlementTypes, 'SettlementTypes artifact is required');
  const abi = JSON.stringify(bundle.contracts.ISettlementAdapter.abi);
  assert.match(abi, /fund/);
  assert.match(abi, /status/);
});
