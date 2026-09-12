# Claims register

| Claim | Level | Evidence / limitation |
|---|---|---|
| CC3 Testnet uses EVM chain ID `102031` | VERIFIED (official documentation) | Creditcoin testnet environment page; runtime check is part of `check-env`. |
| Sepolia is Attestcoin `chainKey=1` | VERIFIED | Live Proof Builder and BlockProver accepted the chain mapping in T02. |
| BlockProver and ChainInfo are at `0x...0FD2` and `0x...0FD3` | VERIFIED (official documentation) | Creditcoin USC migration guide; live call is T02 evidence. |
| Proof verification through `eth_call` is a real runtime verdict | VERIFIED | T02 normal proof returned true and two tampered proofs reverted. It does not write state and is not application E2E evidence. |
| Proof-to-Credit integrates with KGLD | FALSE / OUT OF SCOPE | KGLD is an industry reference only. |
| The prototype verifies physical gold, ownership, collateral rights, or actual transfers | FALSE / OUT OF SCOPE | Explicitly not claimed. |
| The state is complete or always latest | FALSE / OUT OF SCOPE | It is an event-derived prefix for one single-draw loan. |
| The policy uses proof-derived debt in its limit calculation | VERIFIED (T12) | The canonical T12 gate used debt50/debt30 in historical `evaluate` calls and recorded a version-checked commit30 transaction. |
| The policy derives gold value or collateral rights | FALSE / OUT OF SCOPE | Gold quantity and price are not policy inputs; `assetId` is a demo reference label only. |
| An allowed decision reserves capacity by itself | FALSE | `evaluate` is read-only; only a successful version-checked `commitCredit` changes `committedCredit`. |
| Competing commitments can reuse one observed headroom | REJECTED (local T11) | The first successful commitment increments `stateVersion`; a second request carrying the same version reverts. |
| The full proof-to-state-to-policy path runs on public testnets | VERIFIED (T12) | Public Sepolia open/repay events were proven and applied on the canonical CC3 gate, followed by a successful version-checked commit30 transaction. |
| The gate independently enforces the configured source EVM chain ID | FALSE | `sourceEvmChainId` is stored but not consumed by admission. Provenance is enforced by Attestcoin `chainKey=1`, BlockProver, and the fixed emitter. |
| A REJECT decision is a persistent on-chain decision record | FALSE / OUT OF SCOPE | `evaluate` is a view call. Historical calls reproduce the result, but no successful rejection-record transaction exists. |
| Actual BlockProver rejects mutated proof inputs | VERIFIED (T14 `eth_call`) | At CC3 block `5439094`, both source proofs verified normally while root, transaction-bytes, and continuity mutations failed. This is runtime rejection evidence, not a failed transaction receipt. |
| A stale saved proof can be submitted without a current runtime check | FALSE | T15 checks the exact bundle before creating a signer, refreshes the same source transaction at most once, and requires the refreshed bundle to verify before broadcast. |
| Re-running a completed proof or demo step sends another transaction | FALSE | Completed steps return `COMPLETE`; a journaled pending hash is reconciled from its receipt instead of being replaced. |
| Settlement vault payments are real public transfers | FALSE / LOCAL ONLY | Vault, direct escrow, and LayerZero tests use local VM mocks; public asset, endpoint, peer, and funding evidence are not deployed by this repository. |
