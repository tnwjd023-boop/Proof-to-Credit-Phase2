// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "./ISettlementAdapter.sol";
import "./SettlementVault.sol";

/// @notice Destination-local relayer path used when no cross-chain messaging endpoint is available.
contract DirectSettlementAdapter is ISettlementAdapter {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidSettlement();
    error ProofRequired();
    error RelayerNotAuthorized();

    struct Request {
        address recipient;
        uint256 amount;
        bytes32 sourceProofDigest;
        bytes32 transportId;
        SettlementTypes.Status state;
    }

    SettlementVault public immutable vault;
    address public immutable controller;
    address public immutable owner;
    mapping(address => bool) public relayers;
    mapping(bytes32 => Request) public requests;
    mapping(bytes32 => bool) public usedTransportIds;

    event RelayerUpdated(address indexed relayer, bool authorized);
    event FundingRequested(bytes32 indexed originationId, address indexed recipient, uint256 amount, bytes32 sourceProofDigest);
    event FundingFailed(bytes32 indexed originationId, bytes32 indexed transportId);
    event FundingConfirmed(bytes32 indexed originationId, bytes32 indexed transportId, uint256 amount);

    constructor(address vault_, address controller_, address owner_) {
        if (vault_.code.length == 0 || controller_ == address(0) || owner_ == address(0)) revert InvalidConfiguration();
        vault = SettlementVault(vault_); controller = controller_; owner = owner_;
    }

    function setRelayer(address relayer, bool authorized) external {
        if (msg.sender != owner || relayer == address(0)) revert Unauthorized();
        relayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function requestFunding(bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest) external {
        if (msg.sender != controller) revert Unauthorized();
        if (originationId == bytes32(0) || recipient == address(0) || amount == 0) revert InvalidSettlement();
        if (sourceProofDigest == bytes32(0)) revert ProofRequired();
        if (requests[originationId].state != SettlementTypes.Status.NONE) revert InvalidSettlement();
        requests[originationId] = Request(recipient, amount, sourceProofDigest, bytes32(0), SettlementTypes.Status.PENDING);
        emit FundingRequested(originationId, recipient, amount, sourceProofDigest);
    }

    function status(bytes32 originationId) external view returns (SettlementTypes.Status) {
        return requests[originationId].state;
    }

    function fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)
        external returns (bool) {
        if (!relayers[msg.sender]) revert RelayerNotAuthorized();
        Request storage r = requests[originationId];
        if (r.state != SettlementTypes.Status.PENDING || recipient != r.recipient || amount != r.amount || transportId == bytes32(0))
            revert InvalidSettlement();
        if (r.transportId == bytes32(0)) {
            if (usedTransportIds[transportId]) revert InvalidSettlement();
            r.transportId = transportId;
        } else if (r.transportId != transportId) {
            revert InvalidSettlement();
        }
        return _attemptFund(originationId, r);
    }

    function retry(bytes32 originationId) external returns (bool) {
        if (!relayers[msg.sender]) revert RelayerNotAuthorized();
        Request storage r = requests[originationId];
        if (r.state != SettlementTypes.Status.FAILED || r.transportId == bytes32(0)) revert InvalidSettlement();
        r.state = SettlementTypes.Status.PENDING;
        return _attemptFund(originationId, r);
    }

    function _attemptFund(bytes32 originationId, Request storage r) internal returns (bool) {
        try vault.fund(originationId, r.recipient, r.amount, r.transportId) returns (bool ok) {
            if (!ok) {
                r.state = SettlementTypes.Status.FAILED;
                emit FundingFailed(originationId, r.transportId);
                return false;
            }
        } catch {
            r.state = SettlementTypes.Status.FAILED;
            emit FundingFailed(originationId, r.transportId);
            return false;
        }
        r.state = SettlementTypes.Status.FUNDED;
        usedTransportIds[r.transportId] = true;
        emit FundingConfirmed(originationId, r.transportId, r.amount);
        return true;
    }
}
