# Proof-to-Credit

[![CI](https://github.com/tnwjd023-boop/Proof-to-Credit/actions/workflows/ci.yml/badge.svg)](https://github.com/tnwjd023-boop/Proof-to-Credit/actions/workflows/ci.yml)

**Verified external event → Reconstructed financial state → Independent policy evaluation → Atomic bounded capacity consumption**

Proof-to-Credit is a public-testnet reference implementation of that narrow pipeline. One canonical run makes the state transition concrete:

```text
Ethereum Sepolia                                      Creditcoin CC3 Testnet

DebtOpened(50)  -- Attestcoin proof -->  verifiedDebt = 50
                                            50 debt + 30 request > 60 limit
                                            REJECT · headroom 10

DebtRepaid(20)  -- Attestcoin proof -->  verifiedDebt = 30
                                            30 debt + 30 request = 60 limit
                                            ALLOW  · headroom 30

                                         commitCredit(30)
                                            committedCredit = 30
                                            headroom = 0
                                            next request 1 → REJECT
```

All values use the single six-decimal accounting unit `DEMO_USD_6` and are backed by the [canonical run manifest](runs/20260906-t05/manifest.json). The proof establishes inclusion of the supplied source transaction bytes in the supported source chain path. The application then validates the receipt, emitter, event identity, sequence, and repayment arithmetic. `REJECT` and `ALLOW` are reproducible `evaluate` view results; only `commitCredit` changes capacity.

Attestcoin does **not** prove creditworthiness or decide whether credit should be granted. This prototype does not verify collateral, gold reserves, custody, price, complete history, or aggregate exposure. `commitCredit` is an accounting commitment; it does not transfer or lend funds. See the [submission description](docs/SUBMISSION.md) for the concise project narrative.

## Canonical public evidence

The completed public run is [`runs/20260906-t05/manifest.json`](runs/20260906-t05/manifest.json). Its saved opening and repayment bundles are under [`runs/20260906-t05/proofs/`](runs/20260906-t05/proofs/), and the read-only runtime-negative evidence is [`runs/20260906-t05/negative.json`](runs/20260906-t05/negative.json). [`runs/t15-recovery-check/manifest.json`](runs/t15-recovery-check/manifest.json) separately records receipt recovery of five already-public transactions with zero new broadcasts; it is a recovery exercise, not another financial run.

The canonical destination is the T12 gate `0xC97b7EA6de5fc4Cb39D7Fc52881B3d98f4b68147`. Earlier `destination` and `destinationT09` entries are historical deployments, not the latest implementation.

To re-check all eight recorded transaction receipts, deployed code hashes, latest `verifiedDebt`, and `committedCredit` without signing or broadcasting:

```powershell
node scripts/resume.js --run 20260906-t05 --slot destinationT12
```

Expected final values are `verifiedDebt=30000000`, `committedCredit=30000000`, and status `COMPLETE`. RPC availability is required, but this command creates no signer and never uses or prints a private key.

## Requirements and testnet safety

- Node.js 22 or newer and `npm install`.
- Sepolia ETH and CC3 testnet CTC for a fresh run.
- A dedicated testnet-only wallet. Never use a wallet holding mainnet or real-value assets.
- Copy `.env.example` to `.env` and fill `WALLET_ADDRESS` and `PRIVATE_KEY` only for commands that sign. `.env*` is ignored except `.env.example`.

The scripts refuse chain IDs other than Ethereum Sepolia `11155111` and Creditcoin CC3 testnet `102031`. They do not support mainnet execution.

Run the local verification suite first:

```powershell
npm test
npm run compile
```

## Read-only demo UI

The published UI is available at [tnwjd023-boop.github.io/Proof-to-Credit/ui/](https://tnwjd023-boop.github.io/Proof-to-Credit/ui/).

```powershell
npm run ui
```

This UI only visualizes the existing canonical public testnet evidence. It does not sign or broadcast transactions.

## Fresh reproducible run

Choose a new run ID. Reusing an existing ID never replaces its manifest: a completed step returns `COMPLETE`, while a journaled incomplete step enters receipt recovery.

```powershell
$runId = "YYYYMMDD-demo1"
$slot = "destinationDemo1"

node scripts/check-env.js
node scripts/deploy-source.js --run $runId
node scripts/source-actions.js open --run $runId --amount 50
node scripts/source-actions.js repay --run $runId --amount 20
node scripts/fetch-proof.js --run $runId --tx <openingTxHash>
node scripts/fetch-proof.js --run $runId --tx <repaymentTxHash>
node scripts/deploy-cc3.js --run $runId --slot $slot
node scripts/submit-proof.js --run $runId --slot $slot --proof debt-opened
node scripts/submit-proof.js --run $runId --slot $slot --proof debt-repaid
node scripts/demo.js --run $runId --slot $slot --mode testnet
node scripts/resume.js --run $runId --slot $slot
```

Replace the two hash placeholders with the hashes printed by the source action commands. Proof generation can be delayed while the source block becomes attestable.

The scenario uses one accounting unit (`DEMO_USD_6`): open 50, repay 20, reconstructed debt 30, policy limit 60, then commit 30. These are demo accounting values, not token transfers or gold quantities.

## Resume and proof freshness

Run the inspector at any time:

```powershell
node scripts/resume.js --run <runId> --slot <destinationSlot>
```

It performs read-only network checks and prints the next incomplete command. It never signs or silently submits a replacement transaction.

`submit-proof.js` checks a saved bundle against the live BlockProver before creating a signer. If continuity data has become stale, it refreshes the same immutable source transaction once, re-runs the positive and tamper controls, and only then permits broadcast. A refresh changes proof availability data, not source identity or replay semantics.

Every state-changing step journals transaction hash, sender, chain, target, calldata hash, and value immediately after broadcast and before waiting for the receipt. This includes source deployment/actions, decoder and gate deployment, proof submissions, and `commitCredit`. Re-running the same step validates the exact transaction and recovers its receipt rather than sending again. A confirmed step returns `COMPLETE` without network broadcast.

If the process ended after broadcast but before the pending record was written, provide the known transaction hash and its kind. Supported kinds are `source-deploy`, `source-open`, `source-repay`, `decoder-deploy`, `gate-deploy`, `debt-opened`, `debt-repaid`, and `commit-credit`:

```powershell
node scripts/resume.js --run <runId> --slot <destinationSlot> --tx <cc3TxHash> --kind debt-opened
node scripts/resume.js --run <runId> --slot <destinationSlot> --tx <cc3TxHash> --kind debt-repaid
node scripts/resume.js --run <runId> --slot <destinationSlot> --tx <cc3TxHash> --kind commit-credit
```

For example, a source action can be recovered with `--tx <sepoliaTxHash> --kind source-open`, and a deployment with `--kind source-deploy`, `decoder-deploy`, or `gate-deploy`. The inspector selects the correct chain, verifies sender/target/zero value and the exact deployment or function calldata, records it as pending, and prints the command that performs receipt-based finalization. A reverted, mislabelled, or conflicting transaction is not ignored.

## Evidence boundary

Public run evidence may contain addresses, transaction hashes, proof bytes, receipts, state, and timestamps. Evidence writers reject normalized credential field names, credential-bearing URLs, and common environment-style secret assignments. This is a guardrail, not a general secret scanner. They write JSON atomically; the initial manifest uses exclusive creation. Do not manually add `.env`, private keys, mnemonics, faucet credentials, or unrelated wallet data to `runs/`.

Local verifier mocks test application admission rules but do not prove BlockProver behavior. Actual BlockProver negative calls and actual CC3 storage are separately identified in [`docs/TEST_MATRIX.md`](docs/TEST_MATRIX.md). REJECT results are view evaluations, not persistent rejection logs.
