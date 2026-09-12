# Phase 2 public demo implementation plan

**Goal:** Execute the user's two-source Sepolia → Attestcoin → CC3 Testnet accounting scenario with independently replayable evidence.

**Architecture:** Preserve v1. Fix the aggregate ledger, then add a separate Phase 2 CLI with an exclusive run manifest, ordered scenario steps, pre-broadcast transaction identity journaling, receipt recovery, and read-only historical audit. Reuse the proof client, production decoder, evidence writer and aggregate status exporter.

**Tech stack:** Node 22, ethers 6, Solidity 0.8.36 viaIR / optimizer 200 / Paris, EthereumJS VM.

**Specification:** User request of 2026-09-13, sections 1–7. Source amounts 30/20, B repayment 10, limit 60 and reservation 20 in DEMO_USD_6; raw scale 1,000,000. Distinct demo debts, distinct emitters, one Sepolia chain and one testnet signer; no independent-institution claim.

## Constraints

- Never edit existing v1 contracts or runs/20260906-t05.
- Networks must return 11155111 and 102031; proof chainKey must be 1.
- Code-less verifier exception only for chain 102031 and address 0x0000000000000000000000000000000000000FD2. Deployment must additionally confirm live precompile behavior; local constructor acceptance does not prove verification.
- Snapshot TTL: 7200 seconds, fixed before deployment. Allows sequential proof acquisition within the proof client's 30-minute retry window plus submission time. Source checkpoint timestamps remain unchanged; TTL expiry stops execution.
- No asset transfers, wallet creation or settlement. No credentials in evidence or logs.

## Implementation and validation

- [ ] Reproduce constructor rejection on a CC3-chain VM and reject the same address on other networks and other empty addresses on CC3.
- [ ] Reproduce equal and lagged alias repayments in both ingestion orders, reconcile each source's totals, finalize both checkpoints; test malformed checkpoint batch rollback.
- [ ] Separate source-local repayment increment from canonical outstanding decrease. Run targeted and complete VM suites.
- [ ] Add Phase 2 run journal and deterministic transaction recovery tests: durable intent before broadcast, missing/pending receipts, confirmed recovery, wrong chain/from/to/data/nonce, completed idempotence, exclusive run creation.
- [ ] Implement probe, run/resume and audit CLI. Record constructor args, compiler/source hashes, receipts, runtime code hashes, immutable proof bundles and block-pinned observations.
- [ ] Execute A-only missing coverage, full epoch 1 / debt50 / denial20, B repay10 / invalidated snapshot, epoch2 / debt40 / reserve20, stale competitor and final denial1. Validate exact errors and unchanged state for read-only negative calls.
- [ ] Run live precompile probe without printing credentials. Execute only with the existing configured testnet signer and funded balances.
- [ ] Re-audit recorded transactions and historical calls without a signer; publish only actual evidence levels in README, CLAIMS and TEST_MATRIX.

Failure handling: retain pending intents and all confirmed receipts; never replace an unknown or pending nonce. Proof polling timeout and snapshot expiry are explicit resumable failures, never bypass freshness. Read-only rejections are eth_call evidence, not mined revert receipts.
