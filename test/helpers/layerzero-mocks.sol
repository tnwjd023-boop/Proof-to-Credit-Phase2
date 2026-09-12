// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "../../contracts/settlement/ILayerZeroEndpointV2.sol";

contract TestLayerZeroEndpoint is ILayerZeroEndpointV2 {
    uint64 public nonce;
    mapping(bytes32 => bytes) public messages;
    event PacketSent(bytes32 indexed guid, uint32 indexed dstEid, bytes32 indexed receiver, bytes message);

    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory receipt) {
        receipt.guid = keccak256(abi.encode(msg.sender, params.dstEid, params.receiver, params.message, nonce));
        receipt.nonce = nonce++;
        messages[receipt.guid] = params.message;
        emit PacketSent(receipt.guid, params.dstEid, params.receiver, params.message);
    }

    function deliver(address receiver, bytes32 guid, uint32 srcEid, bytes32 sender,
        bytes32 originationId, address recipient, uint256 amount, bytes32 sourceProofDigest) external {
        bytes memory message = abi.encode(originationId, recipient, amount, sourceProofDigest);
        ILayerZeroReceiver(receiver).lzReceive(
            ILayerZeroReceiver.Origin(srcEid, sender, 0), guid, message, address(this), "");
    }
}
