# Aggregate Exposure A–C Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Verify a complete fixed set of sealed source loans and atomically reserve remaining capacity.

**Architecture:** Preserve the v1 contracts, proof pipeline and canonical run. Add an immutable scope registry, a sealed multi-loan source, a proof-driven ledger and a separate reservation gate. Source checkpoints commit to a rolling event history and automatically maintained loan/event counts and principal/repayment totals.

**Tech Stack:** Solidity 0.8.36, Node.js 22, ethers 6, existing EvmV1Decoder and Attestcoin verifier interface, EthereumJS VM tests.

**Spec:** `Proof_to_Credit_총익스포저_개발방향.md`, sections 3–7; this iteration implements A–E. F, real lending and public-network evidence are separate milestones.

## Global Constraints

- Unit is `keccak256("DEMO_USD_6")`; amounts use six decimal places.
- All registered sources are mandatory; immutable scope membership, identities and adapter versions. A new scope requires a new deployment and re-ingestion of retained debts.
- Supported sources are non-upgradeable sealed demo contracts. Their owner may open loans only before sealing; repayments remain possible.
- Admission requires verifier success, successful receipt, registered chain/emitter, continuous global and loan sequences, stable identities, repayment arithmetic and strictly increasing source positions.
- Checkpoints use source-produced counts and history hashes. Every source must provide a checkpoint for the requested epoch, including zero-loan sources.
- Snapshot validity is bounded by the oldest source timestamp, never by proof submission time. A later ledger update invalidates the snapshot until all checkpoints reconcile again.
- Scope is a connected debt capacity pool, not a claim that all debts belong to one borrower or represent regulatory EAD.
- Reservations are permanent accounting commitments in A–C: no cancellation, expiry or execution conversion until execution authority can be safely revoked/verified.
- Existing runs remain untouched; local VM evidence must never be described as public Attestcoin verification.

## Task 1: Sealed sources and scope

Files: `contracts/aggregate/ExposureTypes.sol`, `ExposureScopeRegistry.sol`, `SealedLoanSource.sol`; `test/aggregate.test.js`.

- [x] Test unauthorized opening, duplicate loan IDs, zero principal, sealing, forbidden post-seal opening, repayment and zero-position checkpoints.
- [x] Implement `openLoan(bytes32,address,address,bytes32,uint256)`, `repay(bytes32,uint256)`, `seal()`, `checkpoint()` with automatic epoch increments and a rolling history commitment.
- [x] Registry constructor fixes `scopeId`, `scopeVersion`, owner and source records (chain key, emitter, adapter version, mapping version, unit, effective epoch).
- [x] Compile and run the source tests against real EVM bytecode.

## Task 2: Proof-driven ledger and complete snapshots

Files: `contracts/aggregate/MultiLoanLedger.sol`; `test/helpers/aggregate.js`; `test/aggregate.test.js`.

- [x] Test two sources sharing a loan ID sum to 90; omitting B fails finalization; missing final loan/event fails checkpoint reconciliation; zero source checkpoint completes coverage.
- [x] Keep the existing proof submission signature `submitSourceTransaction(uint64,uint64,bytes,MerkleProof,ContinuityProof)` and real receipt decoder. Test-only verifier models the external attestation boundary.
- [x] Reconstruct per-source and per-loan state; reconcile checkpoint count/hash/arithmetic; reject duplicate/older proofs and roll back an entire invalid receipt.
- [x] `finalizeSnapshot(uint64)` computes a snapshot ID over scope, epoch, ledger version and each source checkpoint position; records the minimum checkpoint timestamp plus immutable TTL.
- [x] Test replay, invalid proof, failed receipt, wrong source/unit/identity, skipped sequence, malformed logs, stale/future timestamps and snapshot invalidation after repayment.

## Task 3: Atomic reservations and usable evidence

Files: `contracts/aggregate/ExposurePolicyGate.sol`, `src/aggregate-view.js`, `scripts/aggregate-status.js`, `ui/aggregate.html`, `ui/aggregate.js`; existing Pages/server allowlists, `test/aggregate.test.js`, `test/aggregate-view.test.js`.

- [x] Test incomplete coverage vs over-limit, zero request, staleness, unauthorized policy/reservation, duplicate commitments, stale state/policy/scope/snapshot, and two requests competing for the same capacity.
- [x] `evaluate(uint256)` returns reason, observed debt/reservations/headroom and version bindings. `reserve(bytes32,uint256,uint64,uint64,uint64,bytes32)` checks every binding, caller authorization and limit before updating reservation totals.
- [x] Export on-chain read-only aggregate state to a separate JSON status artifact; show source balances, checkpoint positions, missing coverage, total and reservations. Imported reports are explicitly point-in-time data.
- [x] Document deployment order, proof ingestion, snapshot finalization and reservation calls; provide reproducible local tests and keep public execution claims pending.
- [x] Run `node scripts/compile.js`, `node --test`, `node scripts/build-pages.js`, inspect changes and report implementation/evidence boundaries.

## Task 4: Canonical debt lineage (D)

Files: `contracts/aggregate/MultiLoanLedger.sol`; `test/aggregate-de.test.js`.

- [x] Test `REPRESENTS` and `WRAPS` aliases sharing one canonical balance, unresolved aliases remaining separate, and an unrelated canonical ID increasing debt.
- [x] Register each relation before its first source event with immutable `canonicalDebtId`; reject relation changes after ingestion and require matching borrower, lender, asset, unit, principal, and non-increasing outstanding values across representations.
- [x] Keep per-source checkpoint arithmetic independent while decrementing unique total debt only once for a canonical outstanding decrease.

## Task 5: Reservation lifecycle (E)

Files: `contracts/aggregate/ExposurePolicyGate.sol`, `src/aggregate-view.js`, `ui/aggregate.*`; `test/aggregate-de.test.js`, `test/aggregate-view.test.js`.

- [x] Test authorised executor conversion from `RESERVED` to `EXECUTED`, exact commitment and state-version checks, stale snapshot rejection, repayment bounds, terminal `CLOSED` state, and proof-reference replay rejection.
- [x] Move the exact amount atomically between `reservedCredit` and `executedCredit`; include both in utilization so conversion never creates or destroys capacity.
- [x] Expose executed balances and lifecycle evidence in read-only reports. Proof IDs are opaque evidence bindings until a source-specific execution attestor is integrated in F.

## Task 6: Institution origination controls (F)

Files: `contracts/aggregate/OriginationController.sol`; `test/aggregate-f.test.js`.

- [x] Require every origination caller to be an approved institution and every source key to be registered in the immutable scope.
- [x] Require an `EXECUTED` gate commitment with an exact remaining amount; bind a unique origination proof reference and `(commitmentId, sourceKey, loanId)` identity.
- [x] Enforce independent institution/source quotas atomically, retain used totals, and reject quota reductions below already originated amounts.
- [x] Keep this controller accounting-only: source-specific proof ingestion and actual fund transfer remain separate integration work and must not be claimed from local tests.

## Acceptance examples

```js
assert.equal(await ledger.readOne('totalDebt'), 90_000_000n);
assert.equal((await gate.readOne('evaluate', [20_000_000n])).reason, 1n); // OVER_LIMIT
await gate.write('reserve', [id('first'), 10_000_000n, stateVersion, 1n, 1n, snapshotId]);
await assert.rejects(() => gate.write('reserve', [id('second'), 10_000_000n, stateVersion, 1n, 1n, snapshotId]), /StaleStateVersion/);
```
