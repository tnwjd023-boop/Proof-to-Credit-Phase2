// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "./SettlementTypes.sol";

interface ISettlementAdapter {
    function fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)
        external returns (bool);
    function status(bytes32 originationId) external view returns (SettlementTypes.Status);
}
