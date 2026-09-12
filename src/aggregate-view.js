'use strict';

const REASONS = ['ALLOW', 'OVER_LIMIT', 'COVERAGE_INCOMPLETE', 'SNAPSHOT_STALE', 'LINEAGE_UNRESOLVED', 'ZERO_AMOUNT'];

// All readers must use the same destination block. VM readers are only for explicitly labelled local evidence.
async function collectAggregateStatus({ gate, ledger, registry, requestedAmount, block, evidenceKind }) {
  const d = await gate.readOne('evaluate', [requestedAmount]);
  const [count, epoch, complete, validUntil, limit, scopeId] = await Promise.all([
    registry.readOne('sourceCount'), ledger.readOne('snapshotEpoch'), ledger.readOne('snapshotComplete'),
    ledger.readOne('validUntil'), gate.readOne('creditLimit'), registry.readOne('scopeId'),
  ]);
  const sources = [];
  for (let i = 0; i < Number(count); i++) {
    const config = await registry.readOne('sourceAt', [i]);
    const key = await registry.readOne('sourceKey', [config.chainKey, config.emitter]);
    const s = await ledger.readOne('sourceState', [key]);
    sources.push({ key, chainKey: String(config.chainKey), emitter: config.emitter,
      adapterVersion: config.adapterVersion, identityMappingVersion: config.identityMappingVersion,
      effectiveEpoch: String(config.effectiveEpoch), loanCount: String(s.loanCount), eventCount: String(s.eventCount),
      debt: String(BigInt(s.totalIssued) - BigInt(s.totalRepaid)), totalIssued: String(s.totalIssued), totalRepaid: String(s.totalRepaid),
      sealed: s.sealedSource, checkpointEpoch: String(s.checkpointEpoch), checkpointEventCount: String(s.checkpointEventCount),
      checkpointTimestamp: String(s.checkpointTimestamp), historyRoot: s.historyRoot,
      checkpointPosition: s.checkpointPosition, lastPosition: [s.lastBlock, s.lastTx, s.lastLog].map(String) });
  }
  const targetEpoch = sources.reduce((max, s) => BigInt(s.checkpointEpoch) > max ? BigInt(s.checkpointEpoch) : max,
    epoch > 0n ? epoch : 1n);
  return { schema: 'proof-to-credit/aggregate-status-v1', evidenceKind,
    block: { number: String(block.number), timestamp: String(block.timestamp), hash: block.hash },
    gate: gate.address, ledger: ledger.address, registry: registry.address, scopeId,
    sourceCount: Number(count), unit: 'DEMO_USD_6', targetEpoch: String(targetEpoch), snapshotEpoch: String(epoch),
    snapshotComplete: complete, validUntil: String(validUntil), snapshotId: d.snapshotId,
    exposureStateVersion: String(d.exposureStateVersion), policyVersion: String(d.policyVersion), scopeVersion: String(d.scopeVersion),
    requestedAmount: String(requestedAmount), creditLimit: String(limit), totalDebt: String(d.totalDebt),
    reservedCredit: String(d.reservedCredit), executedCredit: String(d.executedCredit), headroom: String(d.headroom), allowed: d.allowed,
    reason: REASONS[Number(d.reason)], sources };
}
module.exports = { collectAggregateStatus };
