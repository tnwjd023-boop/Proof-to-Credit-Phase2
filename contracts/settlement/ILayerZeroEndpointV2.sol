// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

interface ILayerZeroEndpointV2 {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }
    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
    }

    function send(MessagingParams calldata params, address refundAddress)
        external payable returns (MessagingReceipt memory receipt);
}

interface ILayerZeroReceiver {
    struct Origin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }
    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message,
        address executor, bytes calldata extraData) external payable;
}
