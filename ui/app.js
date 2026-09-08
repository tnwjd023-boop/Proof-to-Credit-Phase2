'use strict';

(function expose(factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.ProofToCreditUI = api;
    if (typeof document !== 'undefined') api.mount(document, window.fetch.bind(window));
  }
}(function createApi() {
  const UNIT = 1_000_000n;
  const MANIFEST_URL = 'https://github.com/tnwjd023-boop/Proof-to-Credit/blob/main/runs/20260906-t05/manifest.json';
  const NEGATIVE_URL = 'https://github.com/tnwjd023-boop/Proof-to-Credit/blob/main/runs/20260906-t05/negative.json';

  class EvidenceError extends Error {
    constructor(detail) {
      super(`Evidence mismatch: ${detail}`);
      this.name = 'EvidenceError';
      this.code = 'mismatch';
    }
  }

  class EvidenceUnavailableError extends Error {
    constructor(detail) {
      super(`Canonical evidence unavailable: ${detail}`);
      this.name = 'EvidenceUnavailableError';
      this.code = 'unavailable';
    }
  }

  function mismatch(detail) {
    throw new EvidenceError(detail);
  }

  function integer(value, field) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) mismatch(`${field} must be an integer string`);
    return BigInt(value);
  }

  function formatUnits(value, field) {
    const raw = integer(value, field);
    if (raw % UNIT !== 0n) mismatch(`${field} is not a whole DEMO_USD_6 value`);
    const whole = raw / UNIT;
    if (whole > BigInt(Number.MAX_SAFE_INTEGER)) mismatch(`${field} exceeds the display range`);
    return Number(whole);
  }

  function decimalUnits(value, field) {
    const raw = integer(value, field);
    const whole = raw / UNIT;
    const fraction = (raw % UNIT).toString().padStart(6, '0');
    return `${whole}.${fraction}`;
  }

  function shortHash(hash) {
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) mismatch('invalid transaction hash');
    return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  }

  function evidenceItem(label, network, chainId, hash) {
    return Object.freeze({
      label,
      network,
      chainId: String(chainId),
      hash,
      shortHash: shortHash(hash),
      status: 'CONFIRMED',
      href: MANIFEST_URL,
    });
  }

  function equal(actual, expected, detail) {
    if (actual !== expected) mismatch(detail);
  }

  function equalInteger(actual, expected, detail) {
    if (integer(actual, detail) !== expected) mismatch(detail);
  }

  function equalHex(actual, expected, detail) {
    if (typeof actual !== 'string' || typeof expected !== 'string' || actual.toLowerCase() !== expected.toLowerCase()) {
      mismatch(detail);
    }
  }

  function transactionHash(value, detail) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) mismatch(detail);
    return value;
  }

  function evmAddress(value, detail) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) mismatch(detail);
    return value;
  }

  function decisionValues(record, utilization, limit, detail) {
    const observedHeadroom = utilization < limit ? limit - utilization : 0n;
    const proposed = integer(record.proposedUtilization, `${detail} proposed utilization`);
    const request = proposed - utilization;
    if (request <= 0n) mismatch(`${detail} request must be positive`);
    const allowed = proposed <= limit;
    equal(record.allowed, allowed, `${detail} decision verdict`);
    equal(String(record.reason), allowed ? '0' : '3', `${detail} decision reason`);
    equalInteger(record.observedHeadroom, observedHeadroom, `${detail} observed headroom`);
    transactionHash(record.stateHash, `${detail} state hash`);
    return { observedHeadroom, proposed, request };
  }

  function validateRuntimeEvidence(manifest, destination, decisions, negative) {
    equal(negative.classification, 'VERIFIED', 'runtime evidence classification');
    equal(negative.callMode, 'eth_call', 'runtime evidence call mode');
    equal(String(negative.sourceChainId), String(manifest.source.chainId), 'runtime source chain');
    equal(String(negative.destinationChainId), String(destination.chainId), 'runtime destination chain');
    equalHex(negative.blockProver, destination.verifier, 'runtime BlockProver');
    equalHex(negative.applicationGate, destination.gate.address, 'runtime application gate');
    equalHex(negative.stateBeforeHash, negative.stateAfterHash, 'runtime state changed');
    equalHex(negative.stateAfterHash, decisions.afterCommit.stateHash, 'runtime final state hash');
    equal(negative.replay?.rejected, true, 'runtime replay verdict');
    equal(negative.replay?.errorName, 'AlreadyProcessed', 'runtime replay reason');

    if (!Array.isArray(negative.proofs) || negative.proofs.length !== 2) mismatch('runtime proof set');
    const expectedProofs = new Map([
      ['debt-opened', manifest.opening],
      ['debt-repaid', manifest.repayment],
    ]);
    for (const [kind, source] of expectedProofs) {
      const proof = negative.proofs.find((item) => item.kind === kind);
      if (!proof) mismatch('runtime proof set');
      equalHex(proof.sourceTransactionHash, source.transactionHash, 'runtime source transaction');
      equal(String(proof.sourceBlockNumber), String(source.blockNumber), 'runtime source block');
      equal(String(proof.chainKey), '1', 'runtime source chain key');
      equal(String(proof.headerNumber), String(source.blockNumber), 'runtime proof header');
      equal(proof.normal?.method, 'verify.eth_call', 'runtime normal proof method');
      equal(proof.normal?.verdict, true, 'runtime normal proof verdict');
      for (const mutation of ['rootTampered', 'bytesTampered', 'continuityTampered']) {
        if (!/\.eth_call$/.test(proof[mutation]?.method || '')) mismatch(`runtime ${mutation} method`);
        equal(proof[mutation]?.verdict, false, `runtime ${mutation} verdict`);
      }
    }
  }

  function capacityGeometry(values) {
    const scaled = (value) => (value / values.limit) * 75;
    return Object.freeze({
      openDebt: scaled(values.openingDebt),
      openHeadroom: scaled(values.limit - values.openingDebt),
      openRequestLeft: scaled(values.openingDebt),
      openRequestWidth: scaled(values.request),
      repaidDebt: scaled(values.repaidDebt),
      repaidRequest: scaled(values.request),
      finalDebt: scaled(values.repaidDebt),
      finalCommitted: scaled(values.committed),
    });
  }

  async function fetchCanonicalEvidence(fetchImpl) {
    let responses;
    try {
      responses = await Promise.all([
        fetchImpl('../runs/20260906-t05/manifest.json'),
        fetchImpl('../runs/20260906-t05/negative.json'),
      ]);
    } catch (error) {
      throw new EvidenceUnavailableError(error instanceof Error ? error.message : 'fetch failed');
    }
    const failed = responses.find((response) => !response?.ok);
    if (failed) throw new EvidenceUnavailableError(`HTTP ${failed.status || 'error'}`);

    let evidence;
    try {
      evidence = await Promise.all(responses.map((response) => response.json()));
    } catch (error) {
      mismatch(error instanceof Error ? error.message : 'invalid JSON');
    }
    return deriveCanonicalViewModel(evidence[0], evidence[1]);
  }

  function setText(documentRoot, selector, value) {
    documentRoot.querySelectorAll(selector).forEach((node) => { node.textContent = String(value); });
  }

  function applyWidth(documentRoot, name, width) {
    const node = documentRoot.querySelector(`[data-bar="${name}"]`);
    if (node) node.style.width = `${width}%`;
  }

  function focusStateForEvidence(label) {
    const states = {
      'Source Open': 1,
      'Opening Proof Submission': 1,
      'Source Repayment': 2,
      'Repayment Proof Submission': 2,
      'Credit Commitment': 3,
    };
    const state = states[label];
    if (!state) throw new Error(`Unknown evidence focus state: ${label}`);
    return state;
  }

  function isRelatedToState(node, state) {
    return node.dataset.focusStates.split(/\s+/).includes(String(state));
  }

  function createFocusController(documentRoot) {
    const demo = documentRoot.querySelector('#demo');
    const modeSwitcher = documentRoot.querySelector('[data-mode-switcher]');
    const overview = documentRoot.querySelector('[data-overview-control]');
    const status = documentRoot.querySelector('[data-mode-status]');
    const buttons = [...documentRoot.querySelectorAll('[data-focus-state]')];
    const rows = [...documentRoot.querySelectorAll('[data-state-row]')];
    const architecture = [...documentRoot.querySelectorAll('.architecture-flow [data-focus-states]')];
    const evidence = [...documentRoot.querySelectorAll('.evidence-list [data-focus-states]')];
    let activeState = null;

    function applyFocus(nextState) {
      activeState = nextState;
      const focused = activeState !== null;
      demo.dataset.focusMode = focused ? `state-${activeState}` : 'overview';
      overview.setAttribute('aria-pressed', String(!focused));
      overview.classList.toggle('is-active', !focused);
      status.textContent = focused ? `STATE ${activeState} FOCUS` : 'ALL STATES';

      buttons.forEach((button) => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.focusState) === activeState));
      });
      rows.forEach((row) => {
        const selected = Number(row.dataset.stateRow) === activeState;
        row.classList.toggle('is-focused', selected);
        row.classList.toggle('is-deemphasized', focused && !selected);
      });
      [...architecture, ...evidence].forEach((item) => {
        const related = focused && isRelatedToState(item, activeState);
        item.classList.toggle('is-focus-related', related);
        item.classList.toggle('is-focus-muted', focused && !related);
      });
    }

    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const selected = Number(button.dataset.focusState);
        applyFocus(activeState === selected ? null : selected);
      });
    });
    overview.addEventListener('click', () => applyFocus(null));
    applyFocus(null);
    modeSwitcher.hidden = false;

    return Object.freeze({
      get activeState() { return activeState; },
      setActiveState: applyFocus,
    });
  }

  function renderEvidence(documentRoot, evidence) {
    const list = documentRoot.querySelector('[data-evidence-list]');
    list.replaceChildren(...evidence.map((item) => {
      const listItem = documentRoot.createElement('li');
      listItem.className = 'evidence-item';
      listItem.dataset.focusStates = String(focusStateForEvidence(item.label));
      const link = documentRoot.createElement('a');
      link.href = item.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = `${item.label}: ${item.hash}`;
      link.setAttribute('aria-label', `${item.label}, ${item.network}, ${item.hash}, confirmed. Open canonical manifest.`);
      const label = documentRoot.createElement('span');
      label.className = 'evidence-label';
      label.textContent = item.label;
      const chain = documentRoot.createElement('span');
      chain.className = 'evidence-chain';
      chain.textContent = item.network;
      const status = documentRoot.createElement('span');
      status.className = 'evidence-status';
      status.textContent = item.status;
      const hash = documentRoot.createElement('span');
      hash.className = 'evidence-hash';
      hash.textContent = item.shortHash;
      link.append(label, chain, status, hash);
      listItem.append(link);
      return listItem;
    }));
  }

  function recordLayoutStatus(documentRoot) {
    const view = documentRoot.defaultView;
    if (!view) return;
    documentRoot.documentElement.dataset.overflowX = String(documentRoot.documentElement.scrollWidth > view.innerWidth);
    documentRoot.documentElement.dataset.overflowY = String(documentRoot.documentElement.scrollHeight > view.innerHeight);
    documentRoot.documentElement.dataset.ready = 'true';
  }

  function renderModel(documentRoot, model) {
    for (const [field, value] of Object.entries(model.values)) setText(documentRoot, `[data-field="${field}"]`, value);
    for (const [field, value] of Object.entries(model.decisions)) setText(documentRoot, `[data-decision="${field}"]`, value);
    setText(documentRoot, '[data-run-id]', model.runId);

    const status = documentRoot.querySelector('[data-status]');
    status.textContent = 'CANONICAL RUN VERIFIED';
    status.classList.add('is-verified');
    documentRoot.querySelectorAll('[data-manifest-link]').forEach((link) => { link.href = model.manifestUrl; });
    const negativeLink = documentRoot.querySelector('[data-negative-link]');
    negativeLink.href = NEGATIVE_URL;
    renderEvidence(documentRoot, model.evidence);

    const geometry = capacityGeometry(model.values);
    applyWidth(documentRoot, 'open-debt', geometry.openDebt);
    applyWidth(documentRoot, 'open-headroom', geometry.openHeadroom);
    const openRequest = documentRoot.querySelector('[data-bar="open-request"]');
    openRequest.style.left = `${geometry.openRequestLeft}%`;
    openRequest.style.width = `${geometry.openRequestWidth}%`;
    applyWidth(documentRoot, 'repaid-debt', geometry.repaidDebt);
    applyWidth(documentRoot, 'repaid-request', geometry.repaidRequest);
    applyWidth(documentRoot, 'final-debt', geometry.finalDebt);
    applyWidth(documentRoot, 'final-committed', geometry.finalCommitted);

    documentRoot.querySelector('#loading-state').hidden = true;
    documentRoot.querySelector('#error-state').hidden = true;
    documentRoot.querySelector('#demo').hidden = false;
    const view = documentRoot.defaultView;
    if (view?.requestAnimationFrame) {
      view.requestAnimationFrame(() => view.requestAnimationFrame(() => recordLayoutStatus(documentRoot)));
    } else {
      recordLayoutStatus(documentRoot);
    }
  }

  function renderError(documentRoot, error) {
    const unavailable = error instanceof EvidenceUnavailableError;
    setText(documentRoot, '[data-error-title]', unavailable ? 'Canonical evidence unavailable' : 'Evidence mismatch');
    setText(
      documentRoot,
      '[data-error-detail]',
      unavailable ? 'The local evidence files could not be loaded.' : 'The canonical files loaded, but validation did not pass.',
    );
    documentRoot.querySelector('#loading-state').hidden = true;
    documentRoot.querySelector('#demo').hidden = true;
    documentRoot.querySelector('#error-state').hidden = false;
    documentRoot.documentElement.dataset.ready = 'error';
  }

  async function mount(documentRoot, fetchImpl) {
    try {
      renderModel(documentRoot, await fetchCanonicalEvidence(fetchImpl));
      createFocusController(documentRoot);
    } catch (error) {
      console.error('Proof-to-Credit canonical evidence error', error);
      renderError(documentRoot, error);
    }
  }

  function deriveCanonicalViewModel(manifest, negative) {
    try {
      if (!manifest || !negative) mismatch('canonical evidence is missing');
      equal(manifest.runId, '20260906-t05', 'canonical run ID');
      equal(String(manifest.source?.chainId), '11155111', 'canonical source chain');
      const destination = manifest.destinationT12;
      const submissions = destination.submissions;
      const demo = destination.demo;
      const decisions = demo.decisions;

      equal(String(destination.chainId), '102031', 'canonical destination chain');
      evmAddress(manifest.source.contractAddress, 'canonical source emitter address');
      evmAddress(destination.verifier, 'canonical verifier address');
      evmAddress(destination.gate.address, 'canonical gate address');
      equal(demo.classification, 'VERIFIED', 'canonical demo classification');
      if (Number.isNaN(Date.parse(demo.verifiedAt))) mismatch('canonical verification time');

      const openingRaw = integer(manifest.opening.principal, 'opening.principal');
      equalInteger(manifest.opening.outstanding, openingRaw, 'opening outstanding');
      equal(manifest.opening.confirmedState?.opened, true, 'opening confirmed state');
      equalInteger(manifest.opening.confirmedState?.principalOpened, openingRaw, 'opening confirmed principal');
      equalInteger(manifest.opening.confirmedState?.outstanding, openingRaw, 'opening confirmed outstanding');
      equalInteger(manifest.opening.confirmedState?.totalRepaid, 0n, 'opening confirmed repayment');
      equal(String(manifest.opening.sequence), '1', 'opening sequence');
      equal(String(manifest.opening.confirmedState?.sequence), '1', 'opening confirmed sequence');

      const repaymentRaw = integer(manifest.repayment.amount, 'repayment.amount');
      const repaidDebtRaw = integer(manifest.repayment.outstanding, 'repayment.outstanding');
      equalInteger(manifest.repayment.cumulativeRepaid, repaymentRaw, 'repayment cumulative amount');
      if (openingRaw - repaymentRaw !== repaidDebtRaw) mismatch('repayment arithmetic');
      equal(manifest.repayment.confirmedState?.opened, true, 'repayment confirmed state');
      equalInteger(manifest.repayment.confirmedState?.principalOpened, openingRaw, 'repayment confirmed principal');
      equalInteger(manifest.repayment.confirmedState?.totalRepaid, repaymentRaw, 'repayment confirmed amount');
      equalInteger(manifest.repayment.confirmedState?.outstanding, repaidDebtRaw, 'repayment confirmed outstanding');
      equal(String(manifest.repayment.sequence), '2', 'repayment sequence');
      equal(String(manifest.repayment.confirmedState?.sequence), '2', 'repayment confirmed sequence');

      const openingSubmission = submissions['debt-opened'];
      const repaymentSubmission = submissions['debt-repaid'];
      equal(openingSubmission.receiptStatus, 1, 'opening proof receipt');
      equal(repaymentSubmission.receiptStatus, 1, 'repayment proof receipt');
      equal(openingSubmission.initialized, true, 'opening proof initialization');
      equal(repaymentSubmission.initialized, true, 'repayment proof initialization');
      equalInteger(openingSubmission.principalOpened, openingRaw, 'opening submission principal');
      equalInteger(openingSubmission.totalRepaid, 0n, 'opening submission repayment');
      equalInteger(openingSubmission.verifiedDebt, openingRaw, 'opening submission debt');
      equalInteger(repaymentSubmission.principalOpened, openingRaw, 'repayment submission principal');
      equalInteger(repaymentSubmission.totalRepaid, repaymentRaw, 'repayment submission repayment');
      equalInteger(repaymentSubmission.verifiedDebt, repaidDebtRaw, 'repayment submission debt');
      equal(String(openingSubmission.stateVersion), '1', 'opening submission state version');
      equal(String(repaymentSubmission.stateVersion), '2', 'repayment submission state version');

      const limitRaw = integer(destination.initialCreditLimit, 'destinationT12.initialCreditLimit');
      if (limitRaw <= 0n) mismatch('credit limit must be positive');
      const before = decisionValues(decisions.beforeRepayment, openingRaw, limitRaw, 'opening');
      const after = decisionValues(decisions.afterRepayment, repaidDebtRaw, limitRaw, 'repayment');
      if (before.request !== after.request) mismatch('policy request changed between opening and repayment');
      equal(String(decisions.beforeRepayment.stateVersion), '1', 'opening decision state version');
      equal(String(decisions.afterRepayment.stateVersion), '2', 'repayment decision state version');
      equal(String(decisions.beforeRepayment.policyVersion), String(decisions.afterRepayment.policyVersion), 'policy version changed');

      const committedRaw = integer(demo.committedCredit, 'committed credit');
      if (committedRaw !== after.request) mismatch('committed credit differs from allowed request');
      equal(demo.receiptStatus, 1, 'commitment receipt');
      const utilizationRaw = repaidDebtRaw + committedRaw;
      const finalDecision = decisionValues(decisions.afterCommit, utilizationRaw, limitRaw, 'final');
      if (finalDecision.request !== 1n) mismatch('final request must be one minimum accounting unit');
      equal(String(decisions.afterCommit.stateVersion), '3', 'final decision state version');
      equal(String(decisions.afterCommit.policyVersion), String(decisions.afterRepayment.policyVersion), 'final policy version');
      const expectedHeadroomPath = [before.observedHeadroom, after.observedHeadroom, finalDecision.observedHeadroom];
      if (!Array.isArray(demo.headroomPath) || demo.headroomPath.length !== expectedHeadroomPath.length) {
        mismatch('headroom path');
      }
      demo.headroomPath.forEach((value, index) => equalInteger(value, expectedHeadroomPath[index], 'headroom path'));

      validateRuntimeEvidence(manifest, destination, decisions, negative);

      transactionHash(manifest.opening.transactionHash, 'source opening transaction');
      transactionHash(manifest.repayment.transactionHash, 'source repayment transaction');
      transactionHash(openingSubmission.transactionHash, 'opening proof transaction');
      transactionHash(repaymentSubmission.transactionHash, 'repayment proof transaction');
      transactionHash(demo.commitTransactionHash, 'commitment transaction');

      const opening = formatUnits(openingRaw.toString(), 'opening.principal');
      const openingDebt = formatUnits(openingSubmission.verifiedDebt, 'opening submission debt');
      const repayment = formatUnits(repaymentRaw.toString(), 'repayment.amount');
      const repaidDebt = formatUnits(repaymentSubmission.verifiedDebt, 'repayment submission debt');
      const limit = formatUnits(destination.initialCreditLimit, 'destinationT12.initialCreditLimit');
      const openingProposed = formatUnits(decisions.beforeRepayment.proposedUtilization, 'opening proposed utilization');
      const repaymentProposed = formatUnits(decisions.afterRepayment.proposedUtilization, 'repayment proposed utilization');
      const committed = formatUnits(demo.committedCredit, 'committed credit');
      const finalProposedRaw = finalDecision.proposed;
      const finalRequestRaw = finalDecision.request;
      if (finalRequestRaw <= 0n) mismatch('final request must be positive');
      if (finalRequestRaw > BigInt(Number.MAX_SAFE_INTEGER)) mismatch('final request exceeds the display range');
      const finalRequest = Number(finalRequestRaw);
      const utilization = formatUnits(utilizationRaw.toString(), 'utilization');
      const headroomRaw = integer(destination.initialCreditLimit, 'destinationT12.initialCreditLimit') - utilizationRaw;
      if (headroomRaw < 0n) mismatch('committed utilization exceeds the limit');
      const headroom = formatUnits(headroomRaw.toString(), 'headroom');
      const request = formatUnits(before.request.toString(), 'policy request');

      const evidence = Object.freeze([
        evidenceItem('Source Open', manifest.source.network, manifest.source.chainId, manifest.opening.transactionHash),
        evidenceItem('Source Repayment', manifest.source.network, manifest.source.chainId, manifest.repayment.transactionHash),
        evidenceItem('Opening Proof Submission', destination.network, destination.chainId, submissions['debt-opened'].transactionHash),
        evidenceItem('Repayment Proof Submission', destination.network, destination.chainId, submissions['debt-repaid'].transactionHash),
        evidenceItem('Credit Commitment', destination.network, destination.chainId, demo.commitTransactionHash),
      ]);

      return Object.freeze({
        verified: true,
        runId: manifest.runId,
        unit: 'DEMO_USD_6',
        values: Object.freeze({
          opening,
          openingDebt,
          repayment,
          repaidDebt,
          limit,
          request,
          openingProposed,
          repaymentProposed,
          committed,
          utilization,
          headroom,
          finalRequest,
          finalRequestDecimal: decimalUnits(finalRequestRaw.toString(), 'final request'),
          finalProposed: Number(finalProposedRaw) / Number(UNIT),
          finalProposedDecimal: decimalUnits(finalProposedRaw.toString(), 'final proposed utilization'),
          utilizationDecimal: decimalUnits(utilizationRaw.toString(), 'utilization'),
          limitDecimal: decimalUnits(limitRaw.toString(), 'credit limit'),
        }),
        decisions: Object.freeze({
          opening: decisions.beforeRepayment.allowed ? 'ALLOW' : 'REJECT',
          repayment: decisions.afterRepayment.allowed ? 'ALLOW' : 'REJECT',
          final: decisions.afterCommit.allowed ? 'ALLOW' : 'REJECT',
        }),
        evidence,
        manifestUrl: MANIFEST_URL,
      });
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      mismatch(error instanceof Error ? error.message : 'invalid canonical evidence');
    }
  }

  return Object.freeze({
    EvidenceError,
    EvidenceUnavailableError,
    capacityGeometry,
    createFocusController,
    deriveCanonicalViewModel,
    decimalUnits,
    fetchCanonicalEvidence,
    focusStateForEvidence,
    formatUnits,
    mount,
    renderModel,
    shortHash,
  });
}));
