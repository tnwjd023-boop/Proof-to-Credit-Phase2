# Settlement and LayerZero Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add destination-chain settlement accounting with an escrow vault, a direct relayer adapter, and an optional LayerZero OApp transport without overstating public execution.

**Architecture:** `OriginationController` remains the quota and one-time origination authority. A separate `SettlementVault` performs the only asset transfer and records an idempotent funded result. `DirectSettlementAdapter` and `LayerZeroSettlementOApp` both implement the same adapter interface; the latter is deployable only when a real Endpoint/EID and peer configuration are supplied.

**Tech Stack:** Solidity 0.8.36, Node.js 22, ethers 6, existing EthereumJS VM harness, minimal local mocks for ERC-20 and LayerZero Endpoint.

**Spec:** `docs/superpowers/specs/2026-09-12-settlement-layerzero-design.md`

## Global Constraints

- `MultiLoanLedger` remains the Attestcoin proof and source-event admission layer.
- `ExposurePolicyGate` remains the capacity reservation/execution layer.
- Settlement state is separate from executed exposure and must not be counted twice.
- Every funding operation is exact-amount, recipient-bound, asset-bound, and idempotent.
- Local mocks prove contract state transitions only; they do not claim public LayerZero or Attestcoin execution.
- No private keys, RPC credentials, or arbitrary report ingestion are added to the UI.

---

### Task 1: Settlement interfaces and test fixtures

**Files:**
- Create: `contracts/settlement/SettlementTypes.sol`
- Create: `contracts/settlement/ISettlementAdapter.sol`
- Create: `test/helpers/settlement.js`
- Test: `test/settlement.test.js`

**Interfaces:**
- `ISettlementAdapter.fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId) returns (bool)`
- `ISettlementAdapter.status(bytes32 originationId) view returns (uint8)`
- `SettlementTypes.Status`: `NONE`, `PENDING`, `FUNDED`, `FAILED`

- [x] **Step 1: Write failing tests** for status constants, adapter ABI loading, and a mock asset transfer fixture.
- [x] **Step 2: Run `node --test test/settlement.test.js`** and confirm failure because the interfaces/fixtures do not exist.
- [x] **Step 3: Add the enum, interface, and helper deployment methods** using the existing VM harness and six-decimal `DEMO_USD_6` conventions.
- [x] **Step 4: Run the focused test and confirm it passes.**
- [x] **Step 5: Commit** with `git add contracts/settlement test/helpers/settlement.js test/settlement.test.js && git commit -m "test: add settlement fixtures and interfaces"`.

### Task 2: Destination settlement vault

**Files:**
- Create: `contracts/settlement/SettlementVault.sol`
- Modify: `test/helpers/proof-mocks.sol` to add a minimal ERC-20 mock if the existing fixture cannot transfer balances
- Test: `test/settlement-vault.test.js`

**Interfaces:**
- Constructor: `SettlementVault(address asset, address authority, address owner)`
- `fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)` callable only by `authority`
- `funded(bytes32 originationId) view returns (bool)`
- `funding(bytes32 originationId) view returns (address recipient, uint256 amount, bytes32 transportId)`

- [x] **Step 1: Write failing tests** for exact ERC-20 payment, native payment mode, unauthorized caller, zero amount, wrong recipient, duplicate origination, duplicate transport ID, and insufficient balance.
- [x] **Step 2: Run the focused vault tests** and confirm expected custom-error failures.
- [x] **Step 3: Implement `SettlementVault`** with configured authority, consumed origination and transport mappings, safe transfer checks, and `FundsReleased` event.
- [x] **Step 4: Run the focused vault tests and the existing aggregate suite.**
- [x] **Step 5: Commit** with `git add contracts/settlement/SettlementVault.sol test/settlement-vault.test.js test/helpers/proof-mocks.sol && git commit -m "feat: add idempotent settlement vault"`.

### Task 3: Direct escrow adapter

**Files:**
- Create: `contracts/settlement/DirectSettlementAdapter.sol`
- Test: `test/direct-settlement.test.js`

**Interfaces:**
- Constructor: `DirectSettlementAdapter(address vault, address controller, address owner)`
- `requestFunding(bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest)` callable by controller
- `fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)` callable by relayer
- `retry(bytes32 originationId, bytes32 transportId)` callable by relayer for `FAILED`

- [x] **Step 1: Write failing tests** for `ORIGINATED → PENDING → FUNDED`, failed vault payment, retry, wrong proof digest, unauthorized relayer, and replay.
- [x] **Step 2: Run the focused tests and confirm they fail on missing adapter behavior.**
- [x] **Step 3: Implement pending records, digest binding, relayer allowlist, and retry-safe calls into the vault.**
- [x] **Step 4: Run focused and aggregate tests.**
- [x] **Step 5: Commit** with `git add contracts/settlement/DirectSettlementAdapter.sol test/direct-settlement.test.js && git commit -m "feat: add direct escrow settlement adapter"`.

### Task 4: LayerZero settlement OApp boundary

**Files:**
- Create: `contracts/settlement/ILayerZeroEndpointV2.sol`
- Create: `contracts/settlement/LayerZeroSettlementOApp.sol`
- Create: `test/helpers/layerzero-mocks.sol`
- Test: `test/layerzero-settlement.test.js`

**Interfaces:**
- Minimal endpoint calls: `send(...)`, `quote(...)`, and destination `lzReceive(...)` callback shape used by the mock.
- Constructor: `LayerZeroSettlementOApp(address endpoint, uint32 sourceEid, bytes32 sourcePeer, uint32 destinationEid, bytes32 destinationPeer, address vault, address owner)`
- `sendFunding(bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest, bytes calldata options)`
- `retry(bytes32 guid)` owner/relayer controlled retry hook

- [x] **Step 1: Write failing tests** for valid peer/EID delivery, malformed payload, wrong peer, duplicate GUID, vault revert retaining retryable failure, and successful retry funding exactly once.
- [x] **Step 2: Run focused LayerZero tests and confirm failure before implementation.**
- [x] **Step 3: Implement endpoint/peer checks, payload hash and GUID replay maps, pending/failed/funded state, and vault call.**
- [x] **Step 4: Run focused tests and verify no LayerZero dependency is required for compilation.**
- [x] **Step 5: Commit** with `git add contracts/settlement/ILayerZeroEndpointV2.sol contracts/settlement/LayerZeroSettlementOApp.sol test/helpers/layerzero-mocks.sol test/layerzero-settlement.test.js && git commit -m "feat: add LayerZero settlement adapter boundary"`.

### Task 5: Origination settlement integration

**Files:**
- Modify: `contracts/aggregate/OriginationController.sol`
- Modify: `test/aggregate-f.test.js`
- Test: `test/origination-settlement.test.js`

**Interfaces:**
- Add `setSettlementAdapter(address adapter)` owner-only.
- Add `requestSettlement(bytes32 originationId, bytes32 sourceProofDigest)` for the recorded institution origination.
- Add `settlementStatus(bytes32 originationId)` and `settlementAdapter()` views.

- [x] **Step 1: Write failing integration tests** proving only an existing `ORIGINATED` record can request settlement, amount/recipient come from stored origination data, and a funded event maps to the same ID.
- [x] **Step 2: Run the focused integration tests and confirm missing selector/state failures.**
- [x] **Step 3: Add the adapter binding and one-way settlement request without changing existing quota or gate semantics.**
- [x] **Step 4: Run all settlement and aggregate tests.**
- [x] **Step 5: Commit** with `git add contracts/aggregate/OriginationController.sol test/aggregate-f.test.js test/origination-settlement.test.js && git commit -m "feat: bind origination to settlement status"`.

### Task 6: Deployment configuration and evidence boundaries

**Files:**
- Create: `scripts/settlement-config.js`
- Modify: `README.md`
- Modify: `docs/CLAIMS.md`
- Modify: `docs/TEST_MATRIX.md`
- Test: `test/settlement-config.test.js`

- [x] **Step 1: Write failing tests** for rejecting zero endpoint/EID/peer, requiring an explicit route mode (`direct` or `layerzero`), and ensuring secrets are excluded from generated public config.
- [x] **Step 2: Run the focused config tests and confirm failure.**
- [x] **Step 3: Implement validation and documentation** that CC3 LayerZero support must be verified before enabling the route, while Attestcoin proof remains the source verification path.
- [x] **Step 4: Run `node scripts/compile.js`, `node --test`, and `node scripts/build-pages.js`.**
- [x] **Step 5: Commit** with `git add scripts/settlement-config.js README.md docs/CLAIMS.md docs/TEST_MATRIX.md test/settlement-config.test.js && git commit -m "docs: define settlement deployment boundaries"`.
