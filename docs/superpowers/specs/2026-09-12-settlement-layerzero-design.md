# Settlement and LayerZero Integration Design

## Goal

Add an execution boundary for actual destination-chain funding without treating a
local accounting record or an opaque proof identifier as evidence that funds moved.
The design supports a LayerZero route when the destination chain has a verified
LayerZero Endpoint/EID and falls back to a destination escrow adapter when it does
not.

## Boundaries

- `MultiLoanLedger` remains the source-event and Attestcoin-proof admission layer.
- `ExposurePolicyGate` remains the capacity reservation and execution lifecycle.
- `OriginationController` remains the one-time origination and quota authority.
- A settlement adapter is the only component allowed to turn an originated
  obligation into a funded state.
- No private key, RPC credential, or public-network address is embedded in the UI.
- Local mocks prove state-machine behavior only; they do not prove public
  LayerZero or Attestcoin execution.

## Components

### Settlement vault

`SettlementVault` owns or escrows one configured asset on the destination chain.
The owner assigns its adapter authority once before the first payment, after
which the authority is locked. A funding call checks the exact asset, recipient,
amount, and unused origination ID before transferring. A zero amount, duplicate
ID, insufficient balance, or unauthorized caller fails without state changes.

### Settlement adapter interface

`ISettlementAdapter` exposes a destination-local funding operation and a status
lookup. The adapter receives an origination ID, recipient, amount, and opaque
transport reference. It must be idempotent: a retry for the same transport
reference cannot pay twice. The adapter emits a canonical funding event containing
the origination ID, transport GUID/hash, asset, recipient, and amount.

### LayerZero OApp adapter

`LayerZeroSettlementOApp` is an optional adapter. It accepts messages only from a
configured source peer/EID through the LayerZero Endpoint and sends only to a
configured destination peer/EID. The payload binds the
origination ID, recipient, amount, asset identifier, and source commitment. The
destination handler verifies the peer and exact payload, calls the vault, and
records the LayerZero GUID. Failed destination execution remains retryable and
must not mark an origination funded until the vault transfer succeeds.

The contract does not assume that CC3 is LayerZero-supported. Endpoint and EID
are deployment inputs; deployment scripts must reject zero values and operators
must verify the official LayerZero address book before enabling this route.

### Direct escrow adapter

When CC3 has no LayerZero Endpoint, a destination-owned escrow adapter performs
funding after an authorised relayer submits a settlement record. The record binds
the same origination ID, amount, asset, recipient, and source proof digest. This
is an asynchronous operational path and must expose pending, funded, and failed
states; it is not presented as atomic cross-chain settlement.

## State transitions

```text
ORIGINATED
  -> PENDING_SETTLEMENT
  -> FUNDED       (vault transfer succeeded)
  -> FAILED       (transport or execution failure; retry permitted)
```

The existing gate's `EXECUTED` exposure remains the capacity record. Settlement
status is a separate value-transfer record. Repayment can close executed exposure
independently, but downstream reports must not add funded amounts to executed
exposure a second time.

## Failure handling

- Validate LayerZero peer, source EID, GUID, payload hash, and replay status.
- Store a failed message before allowing retry; retrying must reuse the same
  origination ID and cannot bypass quota or commitment checks.
- If vault transfer fails, leave the message retryable and keep the origination
  unfunded.
- If a destination transfer succeeds, mark the transport reference consumed in the
  same transaction as the vault payment.
- Expose a compensating refund path only as a separately authorised operation;
  never infer refund success from a failed message alone.

## Verification and testing

Tests use a mock Endpoint and mock ERC-20/native vault asset to cover:

1. valid peer message funds the exact recipient and amount once;
2. wrong peer/EID, malformed payload, zero amount, wrong asset, duplicate GUID,
   and duplicate origination all fail closed;
3. failed destination execution records retryable failure and a later retry funds
   once;
4. insufficient vault balance leaves state unfunded;
5. direct escrow and LayerZero adapters expose equivalent funding semantics.

Public integration requires separate deployment evidence: CC3 Endpoint/EID,
LayerZero peer and DVN configuration, asset contract/allowances, funded vault,
and a real source proof accepted by the deployed Attestcoin verifier.
