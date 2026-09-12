// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;
import "./ExposureTypes.sol";

/// @notice Demo accounting source. Does not transfer funds or prove real-world identities.
contract SealedLoanSource {
    error Unauthorized();
    error InvalidLoan();
    error InvalidRepayment();
    error SourceSealed();
    error NotSealed();

    event LoanState(bytes32 indexed loanId, bytes payload);
    event SourceSeal(uint64 loanCount, uint64 eventCount);
    event Checkpoint(uint64 indexed epoch, uint64 loanCount, uint64 eventCount, bytes32 historyRoot,
        uint256 totalIssued, uint256 totalRepaid, uint64 timestamp, bool sealedSource);

    address public immutable owner;
    bytes32 public constant unitId = ExposureTypes.UNIT;
    bool public sealedSource;
    uint64 public loanCount;
    uint64 public eventCount;
    uint64 public epoch;
    uint256 public totalIssued;
    uint256 public totalRepaid;
    bytes32 public historyRoot;
    mapping(bytes32 => ExposureTypes.Loan) public loans;

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
    }

    function openLoan(bytes32 loanId, address borrower, address lender, bytes32 assetId, uint256 principal) external {
        if (msg.sender != owner) revert Unauthorized();
        if (sealedSource) revert SourceSealed();
        if (loanId == bytes32(0) || borrower == address(0) || lender == address(0) ||
            assetId == bytes32(0) || principal == 0 || loans[loanId].sequence != 0) revert InvalidLoan();
        loans[loanId] = ExposureTypes.Loan(borrower, lender, assetId, unitId, 1, 0, principal, 0, principal, 0);
        loanCount++;
        totalIssued += principal;
        _emitState(loanId);
    }

    function repay(bytes32 loanId, uint256 amount) external {
        ExposureTypes.Loan storage loan = loans[loanId];
        if (msg.sender != owner && msg.sender != loan.borrower) revert Unauthorized();
        if (loan.sequence == 0 || amount == 0 || amount > loan.outstanding) revert InvalidRepayment();
        loan.repaid += amount;
        loan.outstanding -= amount;
        loan.sequence++;
        totalRepaid += amount;
        _emitState(loanId);
    }

    function seal() external {
        if (msg.sender != owner) revert Unauthorized();
        if (sealedSource) revert SourceSealed();
        sealedSource = true;
        emit SourceSeal(loanCount, eventCount);
    }

    function checkpoint() external {
        if (msg.sender != owner) revert Unauthorized();
        if (!sealedSource) revert NotSealed();
        epoch++;
        emit Checkpoint(epoch, loanCount, eventCount, historyRoot, totalIssued, totalRepaid,
            uint64(block.timestamp), true);
    }

    function _emitState(bytes32 loanId) private {
        ExposureTypes.Loan storage loan = loans[loanId];
        loan.eventSequence = ++eventCount;
        loan.timestamp = uint64(block.timestamp);
        bytes memory payload = abi.encode(loan);
        historyRoot = keccak256(abi.encode(historyRoot, loanId, payload));
        emit LoanState(loanId, payload);
    }
}
