// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "../../contracts/interfaces/INativeQueryVerifier.sol";
import "../../contracts/cc3/SourcePosition.sol";

contract TestOnlyPositionHarness {
    function isAfter(
        uint64 blockNumber,
        uint64 txIndex,
        uint64 logIndex,
        uint64 previousBlock,
        uint64 previousTx,
        uint64 previousLog
    ) external pure returns (bool) {
        return SourcePosition.isAfter(blockNumber, txIndex, logIndex, previousBlock, previousTx, previousLog);
    }
}

contract TestOnlyVerifierMock {
    bool private immutable verdict;

    constructor(bool verdict_) {
        verdict = verdict_;
    }

    function verify(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external view returns (bool) {
        return verdict;
    }

    function calculateTxIndex(INativeQueryVerifier.MerkleProof calldata merkleProof) external pure returns (uint64) {
        uint64 index;
        for (uint256 i; i < 64 && i < merkleProof.siblings.length; ++i) {
            if (merkleProof.siblings[i].isLeft) index |= uint64(uint256(1) << i);
        }
        return index;
    }
}

contract TestSettlementToken {
    string public constant name = "Settlement Test Token";
    string public constant symbol = "STT";
    uint8 public constant decimals = 6;
    address public immutable owner;
    mapping(address => uint256) public balanceOf;

    constructor(address owner_) { owner = owner_; }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "owner");
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
