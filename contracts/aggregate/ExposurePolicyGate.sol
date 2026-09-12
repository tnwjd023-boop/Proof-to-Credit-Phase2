// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;
import "./MultiLoanLedger.sol";

/// @notice Accounting reservations and explicitly authorised execution lifecycle. No funds move here.
contract ExposurePolicyGate {
    error Unauthorized();
    error InvalidPolicy();
    error InvalidCommitment();
    error StaleStateVersion();
    error StalePolicyVersion();
    error StaleScopeVersion();
    error DecisionDenied(Reason reason);
    error InvalidProof();
    error InvalidLifecycle();
    error InvalidRepayment();
    error StaleSnapshot();
    error ProofAlreadyUsed();
    enum Reason { ALLOW, OVER_LIMIT, COVERAGE_INCOMPLETE, SNAPSHOT_STALE, LINEAGE_UNRESOLVED, ZERO_AMOUNT }
    struct Decision {
        bool allowed;
        Reason reason;
        uint256 totalDebt;
        uint256 reservedCredit;
        uint256 executedCredit;
        uint256 headroom;
        uint64 exposureStateVersion;
        uint64 policyVersion;
        uint64 scopeVersion;
        bytes32 snapshotId;
    }
    struct Reservation { address allocator; uint256 amount; bytes32 snapshotId; }
    enum Lifecycle { NONE, RESERVED, EXECUTED, CLOSED }
    event AllocatorUpdated(address indexed allocator, bool authorized, uint64 policyVersion);
    event PolicyUpdated(uint256 creditLimit, uint64 policyVersion);
    event CreditReserved(bytes32 indexed commitmentId, address indexed allocator, uint256 amount,
        bytes32 snapshotId, uint64 exposureStateVersion, uint64 policyVersion, uint64 scopeVersion);
    event ReservationExecuted(bytes32 indexed commitmentId, bytes32 indexed executionProofId, uint256 amount,
        uint64 exposureStateVersion);
    event ExecutedCreditRepaid(bytes32 indexed commitmentId, bytes32 indexed repaymentProofId, uint256 amount,
        uint256 remaining, uint64 exposureStateVersion);
    MultiLoanLedger public immutable ledger;
    address public immutable owner;
    uint256 public creditLimit;
    uint256 public reservedCredit;
    uint256 public executedCredit;
    uint64 public policyVersion = 1;
    uint64 public reservationVersion;
    mapping(address => bool) public allocators;
    mapping(address => bool) public executors;
    mapping(bytes32 => Reservation) public reservations;
    mapping(bytes32 => Lifecycle) public reservationStatus;
    mapping(bytes32 => bytes32) public executionProofId;
    mapping(bytes32 => bool) public usedProofIds;
    mapping(bytes32 => bytes32) public proofBinding;

    constructor(address ledger_, address owner_, uint256 limit_) {
        if (ledger_.code.length == 0 || owner_ == address(0) || limit_ == 0) revert InvalidPolicy();
        ledger = MultiLoanLedger(ledger_); owner = owner_; creditLimit = limit_;
        allocators[owner_] = true;
    }
    function setAllocator(address allocator, bool authorized) external {
        if (msg.sender != owner) revert Unauthorized();
        if (allocator == address(0)) revert InvalidPolicy();
        allocators[allocator] = authorized;
        policyVersion++;
        emit AllocatorUpdated(allocator, authorized, policyVersion);
    }
    function setExecutor(address executor, bool authorized) external {
        if (msg.sender != owner) revert Unauthorized();
        if (executor == address(0)) revert InvalidPolicy();
        executors[executor] = authorized;
        policyVersion++;
    }
    function setPolicy(uint256 limit) external {
        if (msg.sender != owner) revert Unauthorized();
        if (limit == 0) revert InvalidPolicy();
        creditLimit = limit; policyVersion++;
        emit PolicyUpdated(limit, policyVersion);
    }
    function exposureStateVersion() public view returns (uint64) { return ledger.stateVersion() + reservationVersion; }
    function evaluate(uint256 amount) public view returns (Decision memory d) {
        d.totalDebt = ledger.totalDebt(); d.reservedCredit = reservedCredit;
        d.executedCredit = executedCredit;
        d.exposureStateVersion = exposureStateVersion(); d.policyVersion = policyVersion;
        d.scopeVersion = ledger.registry().scopeVersion(); d.snapshotId = ledger.snapshotId();
        // Subtractions avoid overflow even if observed debt exceeds the policy limit.
        if (d.totalDebt >= creditLimit || reservedCredit >= creditLimit || executedCredit >= creditLimit) {
            d.headroom = 0;
        } else {
            uint256 remaining = creditLimit - d.totalDebt;
            if (reservedCredit >= remaining) remaining = 0;
            else remaining -= reservedCredit;
            if (executedCredit >= remaining) remaining = 0;
            else remaining -= executedCredit;
            d.headroom = remaining;
        }
        if (!ledger.snapshotComplete()) d.reason = Reason.COVERAGE_INCOMPLETE;
        else if (block.timestamp > ledger.validUntil()) d.reason = Reason.SNAPSHOT_STALE;
        else if (amount == 0) d.reason = Reason.ZERO_AMOUNT;
        else if (amount > d.headroom) d.reason = Reason.OVER_LIMIT;
        else { d.reason = Reason.ALLOW; d.allowed = true; }
    }
    function reserve(bytes32 commitmentId, uint256 amount, uint64 expectedStateVersion,
        uint64 expectedPolicyVersion, uint64 expectedScopeVersion, bytes32 expectedSnapshotId) external {
        if (!allocators[msg.sender]) revert Unauthorized();
        if (commitmentId == bytes32(0) || reservations[commitmentId].allocator != address(0)) revert InvalidCommitment();
        Decision memory d = evaluate(amount);
        if (expectedStateVersion != d.exposureStateVersion) revert StaleStateVersion();
        if (expectedPolicyVersion != d.policyVersion) revert StalePolicyVersion();
        if (expectedScopeVersion != d.scopeVersion) revert StaleScopeVersion();
        if (expectedSnapshotId != d.snapshotId) revert StaleSnapshot();
        if (!d.allowed) revert DecisionDenied(d.reason);
        reservedCredit += amount; reservationVersion++;
        reservations[commitmentId] = Reservation(msg.sender, amount, d.snapshotId);
        reservationStatus[commitmentId] = Lifecycle.RESERVED;
        emit CreditReserved(commitmentId, msg.sender, amount, d.snapshotId, exposureStateVersion(), d.policyVersion, d.scopeVersion);
    }

    function executeReservation(bytes32 commitmentId, bytes32 proofId, uint64 expectedStateVersion) external {
        if (!executors[msg.sender]) revert Unauthorized();
        Reservation storage r = reservations[commitmentId];
        if (proofId == bytes32(0)) revert InvalidProof();
        if (usedProofIds[proofId]) revert ProofAlreadyUsed();
        if (reservationStatus[commitmentId] != Lifecycle.RESERVED) revert InvalidLifecycle();
        if (expectedStateVersion != exposureStateVersion()) revert StaleStateVersion();
        if (!ledger.snapshotComplete() || ledger.snapshotId() != r.snapshotId || block.timestamp > ledger.validUntil()) revert StaleSnapshot();
        reservedCredit -= r.amount;
        executedCredit += r.amount;
        reservationStatus[commitmentId] = Lifecycle.EXECUTED;
        executionProofId[commitmentId] = proofId;
        usedProofIds[proofId] = true;
        proofBinding[proofId] = keccak256(abi.encode("EXECUTE", commitmentId, r.amount, r.snapshotId));
        reservationVersion++;
        emit ReservationExecuted(commitmentId, proofId, r.amount, exposureStateVersion());
    }

    function repayExecution(bytes32 commitmentId, uint256 amount, bytes32 proofId, uint64 expectedStateVersion) external {
        if (!executors[msg.sender]) revert Unauthorized();
        Reservation storage r = reservations[commitmentId];
        if (proofId == bytes32(0)) revert InvalidProof();
        if (usedProofIds[proofId]) revert ProofAlreadyUsed();
        if (reservationStatus[commitmentId] != Lifecycle.EXECUTED || amount == 0 || amount > r.amount) revert InvalidRepayment();
        if (expectedStateVersion != exposureStateVersion()) revert StaleStateVersion();
        if (!ledger.snapshotComplete() || ledger.snapshotId() != r.snapshotId || block.timestamp > ledger.validUntil()) revert StaleSnapshot();
        r.amount -= amount;
        executedCredit -= amount;
        usedProofIds[proofId] = true;
        proofBinding[proofId] = keccak256(abi.encode("REPAY", commitmentId, amount, r.snapshotId, r.amount + amount));
        if (r.amount == 0) reservationStatus[commitmentId] = Lifecycle.CLOSED;
        reservationVersion++;
        emit ExecutedCreditRepaid(commitmentId, proofId, amount, r.amount, exposureStateVersion());
    }
}
