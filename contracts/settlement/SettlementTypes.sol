// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

library SettlementTypes {
    enum Status { NONE, PENDING, FUNDED, FAILED }

    struct Funding {
        address recipient;
        uint256 amount;
        bytes32 transportId;
    }
}
