// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;
import "./ExposureScopeRegistry.sol";
import "../interfaces/INativeQueryVerifier.sol";
import "../interfaces/IEvmDecoder.sol";
import "../cc3/SourcePosition.sol";

contract MultiLoanLedger {
    error InvalidConfiguration();
    error InvalidProof();
    error AlreadyProcessed();
    error NoApplicableLog();
    error OutOfOrderSourcePosition();
    error InvalidSequence();
    error InvalidLoan();
    error InvalidRepayment();
    error CheckpointMismatch();
    error CoverageIncomplete();
    error SnapshotStale();
    error InvalidTimestamp();
    error InvalidEpoch();
    error Unauthorized();
    error InvalidRelation();
    error RelationImmutable();

    struct SourceState {
        uint64 loanCount;
        uint64 eventCount;
        bytes32 historyRoot;
        uint256 totalIssued;
        uint256 totalRepaid;
        uint64 lastBlock;
        uint64 lastTx;
        uint64 lastLog;
        uint64 lastTimestamp;
        bool seen;
        bool sealedSource;
        uint64 checkpointEpoch;
        uint64 checkpointEventCount;
        uint64 checkpointTimestamp;
        bytes32 checkpointPosition;
    }
    event SourceApplied(bytes32 indexed sourceKey, bytes32 indexed queryId, uint64 blockHeight,
        uint64 txIndex, uint64 logIndex, uint64 stateVersion);
    event SnapshotFinalized(bytes32 indexed snapshotId, uint64 epoch, uint64 stateVersion, uint64 validUntil, uint256 totalDebt);

    bytes32 private constant LOAN_SIGNATURE = keccak256("LoanState(bytes32,bytes)");
    bytes32 private constant CHECKPOINT_SIGNATURE = keccak256("Checkpoint(uint64,uint64,uint64,bytes32,uint256,uint256,uint64,bool)");
    ExposureScopeRegistry public immutable registry;
    INativeQueryVerifier public immutable verifier;
    IEvmDecoder public immutable decoder;
    uint64 public immutable maxAge;
    address public immutable owner;
    uint64 public stateVersion;
    uint256 public totalDebt;
    bytes32 public snapshotId;
    uint64 public snapshotEpoch;
    uint64 public snapshotStateVersion;
    uint64 public validUntil;
    mapping(bytes32 => SourceState) private sourceStates;
    mapping(bytes32 => ExposureTypes.Loan) private loanStates;
    mapping(bytes32 => ExposureTypes.Loan) private canonicalStates;
    mapping(bytes32 => bytes32) private canonicalIds;
    mapping(bytes32 => uint8) private relationTypes;
    mapping(bytes32 => bool) private relationLocked;
    mapping(bytes32 => bool) public processedQueries;

    constructor(address registry_, address verifier_, address decoder_, uint64 maxAge_) {
        if (registry_.code.length == 0 || verifier_.code.length == 0 || decoder_.code.length == 0 || maxAge_ == 0)
            revert InvalidConfiguration();
        registry = ExposureScopeRegistry(registry_);
        verifier = INativeQueryVerifier(verifier_);
        decoder = IEvmDecoder(decoder_);
        maxAge = maxAge_;
        owner = msg.sender;
    }
    function sourceState(bytes32 key) external view returns (SourceState memory) { return sourceStates[key]; }
    function loanState(bytes32 key, bytes32 loanId) external view returns (ExposureTypes.Loan memory) {
        return loanStates[keccak256(abi.encode(key, loanId))];
    }
    function canonicalDebtId(bytes32 key, bytes32 loanId) public view returns (bytes32) {
        bytes32 debtKey = keccak256(abi.encode(key, loanId));
        return canonicalIds[debtKey] == bytes32(0) ? debtKey : canonicalIds[debtKey];
    }
    function relationType(bytes32 key, bytes32 loanId) external view returns (uint8) {
        return relationTypes[keccak256(abi.encode(key, loanId))];
    }
    function canonicalLoanState(bytes32 canonicalId) external view returns (ExposureTypes.Loan memory) {
        return canonicalStates[canonicalId];
    }
    function setDebtRelation(bytes32 key, bytes32 loanId, bytes32 canonicalId, uint8 relation) external {
        if (msg.sender != owner) revert Unauthorized();
        bytes32 debtKey = keccak256(abi.encode(key, loanId));
        if (canonicalId == bytes32(0) || (relation != 1 && relation != 2) || relationLocked[debtKey] || canonicalIds[debtKey] != bytes32(0))
            revert RelationImmutable();
        canonicalIds[debtKey] = canonicalId;
        relationTypes[debtKey] = relation;
    }
    function snapshotComplete() public view returns (bool) {
        return snapshotId != bytes32(0) && snapshotStateVersion == stateVersion;
    }

    function submitSourceTransaction(uint64 chainKey, uint64 height, bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof) external returns (uint64 applied) {
        if (!verifier.verify(chainKey, height, encodedTransaction, merkleProof, continuityProof)) revert InvalidProof();
        uint64 txIndex = verifier.calculateTxIndex(merkleProof);
        bytes32 queryId = keccak256(abi.encode(chainKey, height, txIndex));
        if (processedQueries[queryId]) revert AlreadyProcessed();
        IEvmDecoder.ReceiptFields memory receipt = decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert InvalidProof();
        for (uint64 i; i < receipt.receiptLogs.length; i++) {
            IEvmDecoder.LogEntry memory entry = receipt.receiptLogs[i];
            bytes32 key = registry.sourceKey(chainKey, entry.address_);
            if (!registry.registered(key) || entry.topics.length == 0) continue;
            bytes32 signature = entry.topics[0];
            if (signature != LOAN_SIGNATURE && signature != CHECKPOINT_SIGNATURE) continue;
            if (entry.topics.length != 2) revert InvalidProof();
            SourceState storage s = sourceStates[key];
            if (s.seen && !SourcePosition.isAfter(height, txIndex, i, s.lastBlock, s.lastTx, s.lastLog))
                revert OutOfOrderSourcePosition();
            if (signature == LOAN_SIGNATURE) _applyLoan(key, s, entry);
            else _applyCheckpoint(s, entry, keccak256(abi.encode(chainKey, height, txIndex, i)));
            s.lastBlock = height; s.lastTx = txIndex; s.lastLog = i; s.seen = true;
            stateVersion++;
            emit SourceApplied(key, queryId, height, txIndex, i, stateVersion);
            applied++;
        }
        if (applied == 0) revert NoApplicableLog();
        processedQueries[queryId] = true;
    }

    function _applyLoan(bytes32 key, SourceState storage s, IEvmDecoder.LogEntry memory entry) private {
        bytes32 loanId = entry.topics[1];
        bytes memory payload = abi.decode(entry.data, (bytes));
        ExposureTypes.Loan memory next = abi.decode(payload, (ExposureTypes.Loan));
        bytes32 debtKey = keccak256(abi.encode(key, loanId));
        bytes32 canonicalId = canonicalIds[debtKey];
        if (canonicalId == bytes32(0)) canonicalId = debtKey;
        ExposureTypes.Loan storage previous = loanStates[debtKey];
        ExposureTypes.Loan storage canonicalPrevious = canonicalStates[canonicalId];
        if (next.eventSequence != s.eventCount + 1 || next.sequence != previous.sequence + 1) revert InvalidSequence();
        if (next.timestamp < s.lastTimestamp || next.timestamp > block.timestamp) revert InvalidTimestamp();
        if (loanId == bytes32(0) || next.borrower == address(0) || next.lender == address(0) ||
            next.assetId == bytes32(0) || next.unitId != ExposureTypes.UNIT || next.principal == 0) revert InvalidLoan();
        if (previous.sequence == 0) {
            if (s.sealedSource || next.repaid != 0 || next.outstanding != next.principal) revert InvalidLoan();
            s.loanCount++;
            s.totalIssued += next.principal;
            if (canonicalPrevious.sequence == 0) totalDebt += next.principal;
            else if (canonicalPrevious.principal != next.principal || canonicalPrevious.assetId != next.assetId ||
                canonicalPrevious.unitId != next.unitId || canonicalPrevious.borrower != next.borrower ||
                canonicalPrevious.lender != next.lender || next.outstanding < canonicalPrevious.outstanding)
                revert InvalidLoan();
        } else {
            if (next.borrower != previous.borrower || next.lender != previous.lender || next.assetId != previous.assetId ||
                next.unitId != previous.unitId || next.principal != previous.principal || next.repaid <= previous.repaid ||
                next.repaid > next.principal || next.outstanding != next.principal - next.repaid) revert InvalidRepayment();
            uint256 amount = canonicalPrevious.outstanding > next.outstanding ? canonicalPrevious.outstanding - next.outstanding : 0;
            if (next.principal != canonicalPrevious.principal ||
                next.assetId != canonicalPrevious.assetId || next.unitId != canonicalPrevious.unitId ||
                next.borrower != canonicalPrevious.borrower || next.lender != canonicalPrevious.lender)
                revert InvalidRepayment();
            s.totalRepaid += amount;
            totalDebt -= amount;
        }
        loanStates[debtKey] = next;
        if (canonicalPrevious.sequence == 0 || next.outstanding < canonicalPrevious.outstanding) {
            canonicalStates[canonicalId] = next;
        }
        relationLocked[debtKey] = true;
        s.eventCount = next.eventSequence;
        s.historyRoot = keccak256(abi.encode(s.historyRoot, loanId, payload));
        s.lastTimestamp = next.timestamp;
    }

    function _applyCheckpoint(SourceState storage s, IEvmDecoder.LogEntry memory entry, bytes32 position) private {
        uint256 rawEpoch = uint256(entry.topics[1]);
        if (rawEpoch == 0 || rawEpoch > type(uint64).max || rawEpoch <= s.checkpointEpoch) revert InvalidEpoch();
        ExposureTypes.CheckpointData memory cp = abi.decode(entry.data, (ExposureTypes.CheckpointData));
        if (!cp.sealedSource || cp.loanCount != s.loanCount || cp.eventCount != s.eventCount ||
            cp.historyRoot != s.historyRoot || cp.totalIssued != s.totalIssued || cp.totalRepaid != s.totalRepaid)
            revert CheckpointMismatch();
        if (cp.timestamp < s.lastTimestamp || cp.timestamp > block.timestamp) revert InvalidTimestamp();
        s.sealedSource = true;
        s.checkpointEpoch = uint64(rawEpoch);
        s.checkpointEventCount = cp.eventCount;
        s.checkpointTimestamp = cp.timestamp;
        s.checkpointPosition = position;
        s.lastTimestamp = cp.timestamp;
    }

    function finalizeSnapshot(uint64 epoch) external {
        if (epoch == 0 || epoch <= snapshotEpoch) revert InvalidEpoch();
        uint64 oldest = type(uint64).max;
        bytes32 vector = keccak256(abi.encode(block.chainid, address(this), registry.scopeId(), registry.scopeVersion(), epoch, stateVersion));
        for (uint256 i; i < registry.sourceCount(); i++) {
            ExposureScopeRegistry.Source memory config = registry.sourceAt(i);
            bytes32 key = registry.sourceKey(config.chainKey, config.emitter);
            SourceState storage s = sourceStates[key];
            if (epoch < config.effectiveEpoch || !s.sealedSource || s.checkpointEpoch != epoch ||
                s.checkpointEventCount != s.eventCount) revert CoverageIncomplete();
            if (s.checkpointTimestamp < oldest) oldest = s.checkpointTimestamp;
            vector = keccak256(abi.encode(vector, key, s.checkpointPosition, s.historyRoot, s.checkpointTimestamp));
        }
        if (block.timestamp > uint256(oldest) + maxAge) revert SnapshotStale();
        snapshotId = vector;
        snapshotEpoch = epoch;
        snapshotStateVersion = stateVersion;
        validUntil = oldest + maxAge;
        emit SnapshotFinalized(vector, epoch, stateVersion, validUntil, totalDebt);
    }
}
