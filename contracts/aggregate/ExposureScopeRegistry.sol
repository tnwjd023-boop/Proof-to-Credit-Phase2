// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;
import "./ExposureTypes.sol";

/// @notice Immutable A–C scope: every listed source is mandatory and cannot be retired away.
contract ExposureScopeRegistry {
    error InvalidScope();
    struct Source {
        uint64 chainKey;
        address emitter;
        bytes32 adapterVersion;
        bytes32 identityMappingVersion;
        bytes32 unitId;
        uint64 effectiveEpoch;
    }
    bytes32 public immutable scopeId;
    uint64 public immutable scopeVersion;
    address public immutable owner;
    Source[] private entries;
    mapping(bytes32 => bool) public registered;

    constructor(bytes32 scopeId_, uint64 version_, address owner_, Source[] memory sources_) {
        if (scopeId_ == bytes32(0) || version_ == 0 || owner_ == address(0) ||
            sources_.length == 0 || sources_.length > 16) revert InvalidScope();
        scopeId = scopeId_;
        scopeVersion = version_;
        owner = owner_;
        for (uint256 i; i < sources_.length; i++) {
            Source memory s = sources_[i];
            bytes32 key = sourceKey(s.chainKey, s.emitter);
            if (s.chainKey == 0 || s.emitter == address(0) || s.unitId != ExposureTypes.UNIT ||
                s.adapterVersion != keccak256("sealed-v1") || s.identityMappingVersion == bytes32(0) ||
                s.effectiveEpoch == 0 || registered[key]) revert InvalidScope();
            registered[key] = true;
            entries.push(s);
        }
    }
    function sourceKey(uint64 chainKey, address emitter) public pure returns (bytes32) {
        return keccak256(abi.encode(chainKey, emitter));
    }
    function sourceCount() external view returns (uint256) { return entries.length; }
    function sourceAt(uint256 index) external view returns (Source memory) { return entries[index]; }
}
