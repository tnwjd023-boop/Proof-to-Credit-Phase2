// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

library ExposureTypes {
    bytes32 internal constant UNIT = keccak256("DEMO_USD_6");
    struct Loan {
        address borrower;
        address lender;
        bytes32 assetId;
        bytes32 unitId;
        uint64 sequence;
        uint64 eventSequence;
        uint256 principal;
        uint256 repaid;
        uint256 outstanding;
        uint64 timestamp;
    }
    struct CheckpointData {
        uint64 loanCount;
        uint64 eventCount;
        bytes32 historyRoot;
        uint256 totalIssued;
        uint256 totalRepaid;
        uint64 timestamp;
        bool sealedSource;
    }
}
