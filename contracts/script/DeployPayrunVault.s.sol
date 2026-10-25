// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../PayrunVault.sol";

/// @notice Deploys PayrunVault with Arc USDC as the token.
contract DeployPayrunVault is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (PayrunVault vault) {
        vm.startBroadcast();
        vault = new PayrunVault(ARC_USDC);
        vm.stopBroadcast();
    }
}
