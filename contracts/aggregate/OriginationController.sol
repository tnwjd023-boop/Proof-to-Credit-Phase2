// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "./ExposurePolicyGate.sol";
import "./ExposureScopeRegistry.sol";
import "../settlement/ISettlementAdapter.sol";

interface ISettlementRequestAdapter {
    function requestFunding(bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest) external;
}

/// @notice F-stage source origination control. It records a proof reference and quota use;
///         it does not transfer funds or replace source-side Attestcoin admission.
contract OriginationController {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidQuota();
    error QuotaBelowUsage();
    error SourceNotRegistered();
    error CommitmentNotExecuted();
    error AmountMismatch();
    error InvalidProof();
    error ProofAlreadyUsed();
    error QuotaExceeded();
    error OriginationAlreadyRecorded();
    error CommitmentAlreadyConsumed();
    error InvalidSettlement();

    enum OriginationStatus { NONE, ORIGINATED, SETTLED }
    struct Origination {
        address institution;
        bytes32 sourceKey;
        bytes32 loanId;
        address borrower;
        address lender;
        uint256 amount;
        bytes32 proofId;
    }

    ExposurePolicyGate public immutable gate;
    ExposureScopeRegistry public immutable registry;
    address public immutable owner;
    uint64 public quotaVersion = 1;
    uint256 public totalOriginated;
    mapping(address => bool) public institutions;
    mapping(bytes32 => uint256) public quota;
    mapping(bytes32 => uint256) public quotaUsed;
    mapping(bytes32 => uint256) public sourceQuota;
    mapping(bytes32 => uint256) public sourceQuotaUsed;
    mapping(address => uint256) public institutionQuota;
    mapping(address => uint256) public institutionQuotaUsed;
    mapping(bytes32 => uint256) public sourceOriginated;
    mapping(address => uint256) public institutionOriginated;
    mapping(bytes32 => Origination) public originations;
    mapping(bytes32 => OriginationStatus) private originationStatuses;
    mapping(bytes32 => bool) public usedProofIds;
    mapping(bytes32 => bool) public commitmentConsumed;
    address public settlementAdapter;

    event InstitutionUpdated(address indexed institution, bool authorized, uint64 quotaVersion);
    event QuotaUpdated(address indexed institution, bytes32 indexed sourceKey, uint256 limit, uint64 quotaVersion);
    event InstitutionOrigination(bytes32 indexed originationId, bytes32 indexed commitmentId,
        address indexed institution, bytes32 sourceKey, bytes32 loanId, uint256 amount, bytes32 proofId);
    event SettlementAdapterUpdated(address indexed adapter);
    event SettlementRequested(bytes32 indexed originationId, bytes32 indexed sourceProofDigest, address indexed adapter);

    constructor(address gate_, address registry_, address owner_) {
        if (gate_.code.length == 0 || registry_.code.length == 0 || owner_ == address(0)) revert InvalidConfiguration();
        if (address(ExposurePolicyGate(gate_).ledger().registry()) != registry_) revert InvalidConfiguration();
        gate = ExposurePolicyGate(gate_);
        registry = ExposureScopeRegistry(registry_);
        owner = owner_;
        institutions[owner_] = true;
    }

    function setInstitution(address institution, bool authorized) external {
        if (msg.sender != owner || institution == address(0)) revert Unauthorized();
        institutions[institution] = authorized;
        quotaVersion++;
        emit InstitutionUpdated(institution, authorized, quotaVersion);
    }

    function quotaKey(address institution, bytes32 sourceKey) public pure returns (bytes32) {
        return keccak256(abi.encode(institution, sourceKey));
    }

    function originationStatus(bytes32 commitmentId, bytes32 sourceKey, bytes32 loanId) external view returns (OriginationStatus) {
        return originationStatuses[keccak256(abi.encode(commitmentId, sourceKey, loanId))];
    }

    function setSettlementAdapter(address adapter) external {
        if (msg.sender != owner || adapter == address(0) || adapter.code.length == 0) revert Unauthorized();
        settlementAdapter = adapter;
        emit SettlementAdapterUpdated(adapter);
    }

    function settlementStatus(bytes32 originationId) external view returns (SettlementTypes.Status) {
        if (settlementAdapter == address(0)) return SettlementTypes.Status.NONE;
        return ISettlementAdapter(settlementAdapter).status(originationId);
    }

    function requestSettlement(bytes32 originationId, bytes32 sourceProofDigest) external {
        Origination memory o = originations[originationId];
        if (o.institution == address(0) || msg.sender != o.institution) revert Unauthorized();
        if (settlementAdapter == address(0) || sourceProofDigest == bytes32(0)) revert InvalidSettlement();
        if (ISettlementAdapter(settlementAdapter).status(originationId) != SettlementTypes.Status.NONE)
            revert InvalidSettlement();
        ISettlementRequestAdapter(settlementAdapter).requestFunding(originationId, o.borrower, o.amount, sourceProofDigest);
        emit SettlementRequested(originationId, sourceProofDigest, settlementAdapter);
    }

    function setQuota(address institution, bytes32 sourceKey, uint256 limit) external {
        if (msg.sender != owner) revert Unauthorized();
        if (institution == address(0) || !institutions[institution] || !registry.registered(sourceKey) || limit == 0)
            revert InvalidQuota();
        bytes32 key = quotaKey(institution, sourceKey);
        if (quotaUsed[key] > limit) revert QuotaBelowUsage();
        quota[key] = limit;
        quotaVersion++;
        emit QuotaUpdated(institution, sourceKey, limit, quotaVersion);
    }

    function setSourceQuota(bytes32 sourceKey, uint256 limit) external {
        if (msg.sender != owner) revert Unauthorized();
        if (!registry.registered(sourceKey) || limit == 0) revert InvalidQuota();
        if (sourceQuotaUsed[sourceKey] > limit) revert QuotaBelowUsage();
        sourceQuota[sourceKey] = limit;
        quotaVersion++;
        emit QuotaUpdated(address(0), sourceKey, limit, quotaVersion);
    }

    function setInstitutionQuota(address institution, uint256 limit) external {
        if (msg.sender != owner) revert Unauthorized();
        if (institution == address(0) || !institutions[institution] || limit == 0) revert InvalidQuota();
        if (institutionQuotaUsed[institution] > limit) revert QuotaBelowUsage();
        institutionQuota[institution] = limit;
        quotaVersion++;
        emit QuotaUpdated(institution, bytes32(0), limit, quotaVersion);
    }

    function originate(bytes32 commitmentId, bytes32 sourceKey, bytes32 loanId,
        address borrower, address lender, uint256 amount, bytes32 proofId) external returns (bytes32 originationId) {
        if (!institutions[msg.sender]) revert Unauthorized();
        if (proofId == bytes32(0)) revert InvalidProof();
        if (usedProofIds[proofId]) revert ProofAlreadyUsed();
        if (!registry.registered(sourceKey)) revert SourceNotRegistered();
        if (gate.reservationStatus(commitmentId) != ExposurePolicyGate.Lifecycle.EXECUTED)
            revert CommitmentNotExecuted();
        (, uint256 remaining,) = gate.reservations(commitmentId);
        if (amount == 0 || amount != remaining || borrower == address(0) || lender == address(0)) revert AmountMismatch();
        originationId = keccak256(abi.encode(commitmentId, sourceKey, loanId));
        if (originationStatuses[originationId] != OriginationStatus.NONE) revert OriginationAlreadyRecorded();
        if (commitmentConsumed[commitmentId]) revert CommitmentAlreadyConsumed();
        bytes32 key = quotaKey(msg.sender, sourceKey);
        if (quotaUsed[key] > quota[key] || amount > quota[key] - quotaUsed[key]) revert QuotaExceeded();
        if (sourceQuotaUsed[sourceKey] > sourceQuota[sourceKey] || amount > sourceQuota[sourceKey] - sourceQuotaUsed[sourceKey]) revert QuotaExceeded();
        if (institutionQuotaUsed[msg.sender] > institutionQuota[msg.sender] || amount > institutionQuota[msg.sender] - institutionQuotaUsed[msg.sender]) revert QuotaExceeded();
        quotaUsed[key] += amount;
        sourceQuotaUsed[sourceKey] += amount;
        institutionQuotaUsed[msg.sender] += amount;
        sourceOriginated[sourceKey] += amount;
        institutionOriginated[msg.sender] += amount;
        totalOriginated += amount;
        usedProofIds[proofId] = true;
        commitmentConsumed[commitmentId] = true;
        originations[originationId] = Origination(msg.sender, sourceKey, loanId, borrower, lender, amount, proofId);
        originationStatuses[originationId] = OriginationStatus.ORIGINATED;
        emit InstitutionOrigination(originationId, commitmentId, msg.sender, sourceKey, loanId, amount, proofId);
    }
}
