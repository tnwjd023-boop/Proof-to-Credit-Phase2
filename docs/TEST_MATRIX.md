# T13 security and evidence matrix

This matrix separates application behavior tested with a local verifier mock from actual Attestcoin runtime and public-testnet storage evidence. `TestOnlyVerifierMock(true)` proves only what `VerifiedDebtGate` does after verifier acceptance; it does not prove Merkle inclusion or continuity.

## Evidence levels

| Level | What it establishes | Current evidence |
|---|---|---|
| Local application | Receipt decoding, identity admission, ordering, sequence, arithmetic, rollback, policy, commitment | EthereumJS VM suites, including `test/security.test.js` |
| Real receipt bytes | Vendored decoder handles persisted Sepolia transaction envelopes | `test/decoder.test.js` and persisted proof bundles |
| Actual BlockProver | Runtime accepts normal proofs and rejects root, transaction-bytes, and continuity tampering | `runs/20260906-t05/negative.json`, observed at CC3 block `5439094` |
| Actual CC3 storage | Proof submissions changed the canonical gate and commit consumed capacity | T12 transactions, manifest, and historical getters |

## Application security cases

Reverting security cases assert unchanged `stateVersion`, `verifiedDebt`, `totalRepaid`, and position-derived `processedQueries` where applicable.

| Case | Expected result | Protection | Evidence |
|---|---|---|---|
| wrong chain / verifier false | revert | Protected | `admission.test.js` |
| receipt status `0` with matching log | revert, no residue | Protected | synthetic receipt in `security.test.js` |
| fake emitter / wrong signature | revert, no residue | Protected | `admission.test.js`, `security.test.js` |
| wrong asset / loan / borrower / unit | revert, no residue | Protected | `security.test.js` |
| malformed matching log ABI | revert, no residue | Protected | `security.test.js` |
| repayment before opening | revert | Protected | `repayment.test.js` |
| zero / over repayment | revert | Protected | `repayment.test.js`, `security.test.js` |
| cumulative mismatch or greater than principal | revert, no residue | Protected | `repayment.test.js`, `security.test.js` |
| outstanding arithmetic mismatch | revert, no residue | Protected | `repayment.test.js`, `security.test.js` |
| source timestamp regression | revert, no residue | Protected | `security.test.js` |
| sequence gap | revert | Protected | `repayment.test.js` |
| exact replay / earlier source position | revert, no residue | Protected | `sequence.test.js`, `security.test.js` |
| duplicate matching log in one receipt | whole batch rolls back | Protected | synthetic batch in `security.test.js` |
| repayment after full repayment | revert, debt stays zero | Protected | `security.test.js` |
| unauthorized policy / commitment | revert, no residue | Protected | policy, commitment, and security suites |
| same-version competing commitments | only first transition succeeds | Protected | `commitment.test.js` |
| extreme `uint256` principal | evaluation panics and commitment rejects; no over-allocation | Partially protected / fail-closed | `security.test.js` |
| unseen tail repayment | destination may retain higher debt | Not proven by sequence; constrained by single-draw source | source mutation-surface tests |
| settlement vault exact payment / replay / authorization | revert or one successful release | Protected locally | `settlement-vault.test.js` |
| direct escrow failed payment and retry | remains `FAILED` until a later exact retry succeeds | Protected locally | `direct-settlement.test.js` |
| LayerZero peer/EID/GUID and retry handling | wrong packet reverts; failed delivery can retry once | Protected locally | `layerzero-settlement.test.js` |

Synthetic receipt tests do not claim Attestcoin accepted mutated bytes. The verifier mock deliberately returns `true` to isolate application checks. T14 separately records actual BlockProver rejection of root, transaction-bytes, and continuity mutations for both source proofs.

## T14 actual runtime negative evidence

At CC3 block `5439094`, the saved opening and repayment bundles were checked through BlockProver `0x0000000000000000000000000000000000000FD2` using read-only calls:

- both normal proofs returned `true`;
- both Merkle-root mutations were rejected with `Merkle proof validation failed`;
- both transaction-bytes mutations were rejected with `Merkle proof validation failed`;
- both continuity-endpoint mutations were rejected with `Continuity proof does not match attestation or checkpoint`;
- replaying the already accepted opening against canonical gate `0xC97b7EA6de5fc4Cb39D7Fc52881B3d98f4b68147` was rejected as `AlreadyProcessed`;
- application `stateHash` remained `0xf7185a0001933e757aeb3facc0eb10387bd7682552e4c04d5bd0cf39e3090063` before and after.

These are `eth_call` observations, not failed transaction receipts or persistent rejection logs. Full structured evidence is `runs/20260906-t05/negative.json`.

## Identity and decision limitations

- `sourceChainKey` is enforced by the gate and BlockProver. `sourceEvmChainId` is stored but is not separately decoded or checked during admission.
- `evaluate()` is a view call. REJECT is reproducible from historical state but is not a persistent rejection transaction or log.
- `commitCredit()` records a bounded accounting commitment only; it transfers no funds.
- Settlement adapters and vaults are local execution boundaries; no public LayerZero or asset transfer is claimed without deployment evidence.
- Canonical T12 uses one EOA as source borrower, destination borrower, and policy owner. Execution domains are separated; independent institutions are not demonstrated.

## T15 reproducibility and interruption safety

| Boundary | Evidence | Result |
| --- | --- | --- |
| Saved proof freshness | `ensureFreshProof` unit tests plus BlockProver preflight in `scripts/submit-proof.js` | Reuse only after runtime success; otherwise refresh exactly once and reverify before signer construction |
| Run-specific values | `deriveExpectedSubmission` and `submissionRecord` tests | Principal, repayment, debt, sequence, block, index, and state version are not fixed to the canonical run |
| Crash after broadcast | `recordPending`, `validatePendingTransaction`, `classifyPendingReceipt`, `clearPending`, and `finalizePending` tests plus journaling in every write script | Pending transaction identity is preserved; retry validates and recovers the recorded transaction instead of sending a replacement |
| Replay and resume | `proofUseStatus` and completed-script checks | Same destination returns `COMPLETE`; a saved proof remains available to a different destination |
| Evidence integrity | exclusive, atomic, BigInt, and credential-screening tests | Existing initial manifest is not overwritten; updates retain unrelated records; common secret-bearing JSON is rejected |
| Canonical public run | read-only `scripts/resume.js` audit | Eight status-1 receipts, source, decoder, and gate code hashes, debt30, and committed30 were rechecked through public RPC |
| Actual receipt recovery | `runs/t15-recovery-check/manifest.json` | Five public T05 deployment/action transactions were journaled and finalized by receipt with zero new broadcasts |

The interruption state machine is deterministic and local; T15 did not deliberately broadcast a redundant transaction or kill a live process. Actual proof authenticity and negative runtime behavior remain evidenced separately by T14.

## Phase 2 public multi-source evidence

| Boundary | Evidence | Result |
| --- | --- | --- |
| Native BlockProver constructor trust boundary | `test/aggregate-public.test.js` plus CC3 probe in the run manifest | Code-less verifier accepted only for chain `102031` address `0x...0FD2`; empty verifiers and other chains fail closed. Live proof behavior was checked separately with normal and tampered `eth_call`s. |
| Source-local versus canonical repayment | `test/aggregate-public.test.js` | Six alias repayment orders/amounts reconcile per-source totals while unique canonical debt decreases once; malformed checkpoint batch rolls back all state. |
| Public two-source accounting | `runs/phase2-20260913-multisource-01/manifest.json` | A `30`, B `20`, epoch 1 debt `50`, B repay `10`, epoch 2 debt `40`, reserve `20`; actual Sepolia proofs were submitted to CC3. |
| Public negative controls | Run observations and proof bundles | Missing B coverage, epoch 1 over-limit, stale competing reserve, additional request `1`, exact replay, and Merkle/bytes/continuity mutations were rejected. Rejections are read-only calls, not mined revert receipts. |
| Public revalidation | `runs/phase2-20260913-multisource-01/audit.json` | 25 transactions, 8 proof bundles and 9 block-pinned calls rechecked with `newTransactions=0`; B deployment code used an explicitly recorded latest-state fallback because the RPC pruned its deployment block. |
