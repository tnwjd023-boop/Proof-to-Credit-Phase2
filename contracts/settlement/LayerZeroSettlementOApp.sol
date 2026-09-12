// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "./ILayerZeroEndpointV2.sol";
import "./ISettlementAdapter.sol";
import "./SettlementVault.sol";

/// @notice Optional LayerZero transport boundary. It is inert until deployed with a real endpoint and peer.
contract LayerZeroSettlementOApp is ISettlementAdapter, ILayerZeroReceiver {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidPeer();
    error InvalidSettlement();
    error GuidAlreadyProcessed();
    error ProofRequired();

    struct Request {
        address recipient;
        uint256 amount;
        bytes32 sourceProofDigest;
        SettlementTypes.Status state;
    }

    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable sourceEid;
    uint32 public immutable destinationEid;
    bytes32 public immutable sourcePeer;
    bytes32 public immutable destinationPeer;
    SettlementVault public immutable vault;
    address public immutable owner;
    mapping(bytes32 => Request) public requests;
    mapping(bytes32 => bytes32) public outboundGuid;
    mapping(bytes32 => bytes32) public guidOrigination;
    mapping(bytes32 => bool) public processedGuids;

    event FundingMessageSent(bytes32 indexed originationId, bytes32 indexed guid, uint32 destinationEid);
    event FundingMessageFailed(bytes32 indexed originationId, bytes32 indexed guid);
    event FundingMessageConfirmed(bytes32 indexed originationId, bytes32 indexed guid, uint256 amount);
    event FundingMessageRetryable(bytes32 indexed originationId, bytes32 indexed guid);

    constructor(address endpoint_, uint32 sourceEid_, bytes32 sourcePeer_, uint32 destinationEid_, bytes32 destinationPeer_, address vault_, address owner_) {
        if (endpoint_.code.length == 0 || vault_.code.length == 0 || sourceEid_ == 0 || destinationEid_ == 0 ||
            sourcePeer_ == bytes32(0) || destinationPeer_ == bytes32(0) || owner_ == address(0)) revert InvalidConfiguration();
        endpoint = ILayerZeroEndpointV2(endpoint_); sourceEid = sourceEid_; sourcePeer = sourcePeer_;
        destinationEid = destinationEid_; destinationPeer = destinationPeer_; vault = SettlementVault(vault_); owner = owner_;
    }

    function sendFunding(bytes32 originationId, address recipient, uint256 amount,
        bytes32 sourceProofDigest, bytes calldata options) external payable returns (bytes32 guid) {
        return _sendFunding(originationId, recipient, amount, sourceProofDigest, options);
    }

    function _sendFunding(bytes32 originationId, address recipient, uint256 amount,
        bytes32 sourceProofDigest, bytes memory options) internal returns (bytes32 guid) {
        if (msg.sender != owner) revert Unauthorized();
        if (originationId == bytes32(0) || recipient == address(0) || amount == 0) revert InvalidSettlement();
        if (sourceProofDigest == bytes32(0) || requests[originationId].state != SettlementTypes.Status.NONE)
            revert InvalidSettlement();
        requests[originationId] = Request(recipient, amount, sourceProofDigest, SettlementTypes.Status.PENDING);
        ILayerZeroEndpointV2.MessagingParams memory params = ILayerZeroEndpointV2.MessagingParams(
            destinationEid, destinationPeer,
            abi.encode(originationId, recipient, amount, sourceProofDigest), options, false);
        ILayerZeroEndpointV2.MessagingReceipt memory receipt = endpoint.send{value: msg.value}(params, msg.sender);
        guid = receipt.guid;
        if (guid == bytes32(0)) revert InvalidSettlement();
        outboundGuid[originationId] = guid;
        guidOrigination[guid] = originationId;
        emit FundingMessageSent(originationId, guid, destinationEid);
    }

    function requestFunding(bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest) external {
        _sendFunding(originationId, recipient, amount, sourceProofDigest, "");
    }

    function status(bytes32 originationId) external view returns (SettlementTypes.Status) {
        return requests[originationId].state;
    }

    /// @dev Endpoint-only compatibility entry point for transports that separate packet delivery from app dispatch.
    function fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)
        external override returns (bool) {
        if (msg.sender != address(endpoint)) revert Unauthorized();
        if (guidOrigination[transportId] != originationId) revert InvalidSettlement();
        return _attemptFund(originationId, recipient, amount, transportId);
    }

    function retry(bytes32 guid) external {
        if (msg.sender != owner) revert Unauthorized();
        bytes32 originationId = guidOrigination[guid];
        Request storage r = requests[originationId];
        if (originationId == bytes32(0) || r.state != SettlementTypes.Status.FAILED) revert InvalidSettlement();
        r.state = SettlementTypes.Status.PENDING;
        emit FundingMessageRetryable(originationId, guid);
    }

    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message,
        address, bytes calldata) external payable {
        if (msg.sender != address(endpoint)) revert Unauthorized();
        if (origin.srcEid != sourceEid || origin.sender != sourcePeer) revert InvalidPeer();
        if (processedGuids[guid]) revert GuidAlreadyProcessed();
        (bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest) =
            abi.decode(message, (bytes32, address, uint256, bytes32));
        Request storage r = requests[originationId];
        if (r.state != SettlementTypes.Status.PENDING || recipient != r.recipient || amount != r.amount ||
            sourceProofDigest != r.sourceProofDigest)
            revert InvalidSettlement();
        if (guidOrigination[guid] == bytes32(0)) guidOrigination[guid] = originationId;
        else if (guidOrigination[guid] != originationId) revert InvalidSettlement();
        _attemptFund(originationId, recipient, amount, guid);
    }

    function _attemptFund(bytes32 originationId, address recipient, uint256 amount, bytes32 guid)
        internal returns (bool) {
        Request storage r = requests[originationId];
        if (r.state != SettlementTypes.Status.PENDING || recipient != r.recipient || amount != r.amount)
            revert InvalidSettlement();
        try vault.fund(originationId, recipient, amount, guid) returns (bool ok) {
            if (!ok) {
                r.state = SettlementTypes.Status.FAILED;
                emit FundingMessageFailed(originationId, guid);
                return false;
            }
        } catch {
            r.state = SettlementTypes.Status.FAILED;
            emit FundingMessageFailed(originationId, guid);
            return false;
        }
        processedGuids[guid] = true;
        r.state = SettlementTypes.Status.FUNDED;
        processedGuids[guid] = true;
        emit FundingMessageConfirmed(originationId, guid, amount);
        return true;
    }
}
