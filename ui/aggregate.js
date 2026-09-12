'use strict';
(function () {
  function check(condition) { if (!condition) throw new Error('Invalid aggregate report'); }
  function integer(value) { check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)); return BigInt(value); }
  function formatAmount(value) {
    const raw = integer(value);
    return `${raw / 1000000n}.${String(raw % 1000000n).padStart(6, '0')}`;
  }
  function deriveAggregateView(r) {
    check(r?.schema === 'proof-to-credit/aggregate-status-v1' && r.unit === 'DEMO_USD_6');
    check(['LOCAL_VM_MOCK_VERIFIER', 'RPC_READ_ONLY'].includes(r.evidenceKind));
    check(Array.isArray(r.sources) && r.sourceCount === r.sources.length && r.sourceCount > 0 && r.sourceCount <= 16);
    check(typeof r.snapshotComplete === 'boolean' && typeof r.allowed === 'boolean');
    const keys = new Set();
    const epoch = integer(r.targetEpoch), snapshotEpoch = integer(r.snapshotEpoch);
    const sources = r.sources.map(s => {
      check(/^0x[0-9a-fA-F]{64}$/.test(s.key) && !keys.has(s.key)); keys.add(s.key);
      check(/^0x[0-9a-fA-F]{40}$/.test(s.emitter) && typeof s.sealed === 'boolean');
      const issued = integer(s.totalIssued), repaid = integer(s.totalRepaid), debt = integer(s.debt);
      check(issued >= repaid && debt === issued - repaid);
      const cpEpoch = integer(s.checkpointEpoch), events = integer(s.eventCount), cpEvents = integer(s.checkpointEventCount);
      check(cpEvents <= events && Array.isArray(s.lastPosition) && s.lastPosition.length === 3);
      s.lastPosition.forEach(integer); integer(s.checkpointTimestamp); integer(s.loanCount); integer(s.chainKey);
      const covered = s.sealed && cpEpoch === epoch && cpEpoch >= integer(s.effectiveEpoch) && cpEvents === events;
      return { ...s, covered, debt: formatAmount(s.debt), rawDebt: debt };
    });
    const debt = integer(r.totalDebt), reserved = integer(r.reservedCredit), executed = integer(r.executedCredit), limit = integer(r.creditLimit);
    const request = integer(r.requestedAmount), until = integer(r.validUntil), timestamp = integer(r.block.timestamp);
    check(sources.reduce((sum, s) => sum + s.rawDebt, 0n) === debt);
    check(!r.snapshotComplete || (snapshotEpoch === epoch && sources.every(s => s.covered) && /^0x[0-9a-fA-F]{64}$/.test(r.snapshotId) && !/^0x0+$/.test(r.snapshotId)));
    const available = limit > debt + reserved + executed ? limit - debt - reserved - executed : 0n;
    check(integer(r.headroom) === available);
    const reason = !r.snapshotComplete ? 'COVERAGE_INCOMPLETE' : timestamp > until ? 'SNAPSHOT_STALE'
      : request === 0n ? 'ZERO_AMOUNT' : request > available ? 'OVER_LIMIT' : 'ALLOW';
    check(r.reason === reason && r.allowed === (reason === 'ALLOW'));
    return { complete: r.snapshotComplete, total: r.snapshotComplete ? formatAmount(r.totalDebt) : '미확정',
      observed: formatAmount(r.totalDebt), reserved: formatAmount(r.reservedCredit), executed: formatAmount(r.executedCredit), headroom: formatAmount(r.headroom),
      limit: formatAmount(r.creditLimit), request: formatAmount(r.requestedAmount), reason, sources,
      coverage: `${sources.filter(s => s.covered).length} / ${sources.length}` };
  }
  function showReport(report, document) {
    const view = deriveAggregateView(report);
    for (const key of ['total', 'observed', 'reserved', 'executed', 'headroom', 'limit', 'request', 'reason', 'coverage']) {
      document.getElementById(key).textContent = view[key];
    }
    document.getElementById('evidence').textContent = report.evidenceKind === 'LOCAL_VM_MOCK_VERIFIER'
      ? '로컬 EVM 실행 · 증명 검증기는 테스트 대역입니다. 공개 Attestcoin 검증 기록이 아닙니다.'
      : 'RPC에서 내보낸 시점 보고서 · 파일의 진위와 현재 상태를 이 화면에서 독립 검증하지 않습니다.';
    document.getElementById('snapshot').textContent = `Epoch ${report.snapshotEpoch} · ${report.snapshotId}`;
    document.getElementById('versions').textContent = `Scope ${report.scopeVersion} · State ${report.exposureStateVersion} · Policy ${report.policyVersion}`;
    document.getElementById('asof').textContent = `목적지 블록 ${report.block.number} · 기준 시각 ${report.block.timestamp} · 유효 종료 ${report.validUntil} (Unix 초)`;
    const tbody = document.getElementById('sources'); tbody.replaceChildren();
    for (const s of view.sources) {
      const row = document.createElement('tr');
      for (const value of [s.emitter, s.chainKey, s.debt, s.loanCount, s.eventCount,
        s.covered ? '확인됨' : '누락 / 미대조', s.checkpointEpoch, s.lastPosition.join(' / '), s.checkpointTimestamp]) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    document.getElementById('report').hidden = false;
  }
  if (typeof module !== 'undefined') module.exports = { deriveAggregateView, formatAmount, showReport };
  if (typeof document !== 'undefined') {
    let reports = [];
    const error = document.getElementById('error');
    const select = document.getElementById('scenario');
    function render() {
      document.getElementById('report').hidden = true; error.textContent = '';
      try { showReport(reports[Number(select.value)].report, document); }
      catch { error.textContent = '보고서 형식 또는 수치가 일치하지 않습니다. 표시를 중단했습니다.'; }
    }
    document.getElementById('file').addEventListener('change', async event => {
      document.getElementById('report').hidden = true; select.hidden = true; error.textContent = '';
      try {
        const file = event.target.files[0]; if (!file) return;
        check(file.size <= 2000000);
        const data = JSON.parse(await file.text());
        reports = Array.isArray(data.scenarios) ? data.scenarios : [{ name: '상태 보고서', report: data }];
        check(reports.length > 0 && reports.length <= 30);
        reports.forEach(s => deriveAggregateView(s.report));
        select.replaceChildren();
        reports.forEach((s, index) => { const option = document.createElement('option'); option.value = String(index);
          option.textContent = s.name; select.appendChild(option); });
        select.hidden = reports.length === 1; render();
      } catch { error.textContent = '유효한 총 익스포저 JSON 보고서를 선택해 주세요 (최대 2 MB).'; }
    });
    select.addEventListener('change', render);
  }
})();
