# Phase 2 testnet run

Run from the repository root with Node 22 and compiled artifacts. The commands below never create a wallet. Configure the existing testnet-only signer locally through the ignored environment configuration; never paste credentials into chat or evidence.

```powershell
npm ci
npm run compile
npm test
npm run phase2 -- probe --run phase2-20260913-multisource-02
npm run phase2 -- run --run phase2-20260913-multisource-02
npm run phase2 -- audit --run phase2-20260913-multisource-02
```

For a new execution choose a new `phase2-` run ID. For interruption recovery repeat `run` with the same ID. `--stop-after <step>` can deliberately stop after a confirmed step. Each populated transaction and its signed hash are saved before broadcast. A retry recovers that hash, or rebroadcasts the exact same signed transaction if it is unknown. It never creates a replacement transaction with a new nonce. A reverted or still-pending transaction stops execution. One process per run is enforced with a local execution lock.

`audit` creates no signer, sends no new transactions and does not change the manifest. It verifies recorded receipts, transaction identities, deployment code hashes, proof bundle/calldata bindings, historical BlockProver controls, and block-pinned aggregate observations. Historical RPC availability is required. A successful historical audit does not imply that the snapshot is still fresh now.

The source chain is Sepolia (`11155111`), its Attestcoin chain key is `1`, and the destination is CC3 Testnet (`102031`). Two `SealedLoanSource` deployments represent two distinct demo debts on the same source chain, using one existing testnet signer. No independent institutions or second source chain are demonstrated.

The verifier constructor permits a code-less address only for CC3 Testnet's native BlockProver `0x0000000000000000000000000000000000000FD2`. Other networks/empty addresses are rejected. Ordinary verifier contracts still require bytecode and are a deployment trust input, not an authenticity guarantee. Before public deployment the CLI confirms network IDs, native transaction-index calculation and real normal/tampered proof behavior. A local VM accepting the native address proves only constructor configuration, not proof verification.

The immutable snapshot TTL is **7,200 seconds**, chosen before deployment to accommodate sequential proof acquisition (the existing client has a 30-minute attestation polling limit) plus submission time. `validUntil` derives from the oldest source checkpoint timestamp. Source event time, source attestation delay, current BlockProver proof validity and snapshot TTL are different checks. Timestamp alteration and freshness bypasses are not supported. If the epoch expires, preserve that run and start a new scenario rather than mislabeling it complete.

Amounts are six-decimal `DEMO_USD_6` accounting units: A opens `30000000`, B opens `20000000`, B repays `10000000`, limit is `60000000`, reservation is `20000000`, and final request is `1000000`. No asset transfer or settlement occurs; native testnet tokens pay transaction fees only.

The run proves missing required B coverage fails closed; epoch 1 debt 50 denies request 20; B's repayment produces debt 40 and invalidates the old snapshot; both epoch 2 checkpoints restore coverage; reservation 20 consumes remaining headroom; stale competing reservation and additional request 1 fail. Replays and modified proofs are also tried through `eth_call`. These are read-only rejection observations, not mined reverted transactions. `evaluate` is a view, not a permanent approval/rejection log.

The manifest stores compiler/source provenance, constructor arguments, addresses, transaction intents and receipts, runtime code hashes, immutable proof references, block hashes, source counts/sequences/positions/epochs, snapshots and decisions. The aggregate reports use the existing UI-compatible schema and identify run ID, chain, block and evidence kind. Load a saved report explicitly in `/ui/aggregate.html`; the default UI remains the separate v1 evidence view.
