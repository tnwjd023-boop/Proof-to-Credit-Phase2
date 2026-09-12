// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "./SettlementTypes.sol";

interface IERC20Settlement {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Destination custody boundary. It transfers one configured asset and records each payment once.
contract SettlementVault {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidFunding();
    error OriginationAlreadyFunded();
    error TransportAlreadyUsed();
    error TransferFailed();
    error AuthorityAlreadyLocked();

    address public immutable asset;
    address public authority;
    address public immutable owner;
    bool public authorityLocked;
    mapping(bytes32 => bool) public funded;
    mapping(bytes32 => bool) public usedTransportIds;
    mapping(bytes32 => SettlementTypes.Funding) public funding;

    event FundsReleased(bytes32 indexed originationId, bytes32 indexed transportId,
        address indexed recipient, address asset, uint256 amount);

    constructor(address asset_, address authority_, address owner_) {
        if (authority_ == address(0) || owner_ == address(0)) revert InvalidConfiguration();
        if (asset_ != address(0) && asset_.code.length == 0) revert InvalidConfiguration();
        asset = asset_; authority = authority_; owner = owner_;
    }

    function setAuthority(address authority_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (authorityLocked || authority_ == address(0) || authority_.code.length == 0) revert AuthorityAlreadyLocked();
        authority = authority_;
    }

    function fund(bytes32 originationId, address recipient, uint256 amount, bytes32 transportId)
        external payable returns (bool) {
        if (msg.sender != authority) revert Unauthorized();
        if (originationId == bytes32(0) || recipient == address(0) || amount == 0 || transportId == bytes32(0))
            revert InvalidFunding();
        if (funded[originationId]) revert OriginationAlreadyFunded();
        if (usedTransportIds[transportId]) revert TransportAlreadyUsed();
        if (asset == address(0)) {
            if (msg.value != amount) revert InvalidFunding();
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (msg.value != 0) revert InvalidFunding();
            (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20Settlement.transfer, (recipient, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
        funded[originationId] = true;
        usedTransportIds[transportId] = true;
        authorityLocked = true;
        funding[originationId] = SettlementTypes.Funding(recipient, amount, transportId);
        emit FundsReleased(originationId, transportId, recipient, asset, amount);
        return true;
    }
}
