// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HeistVault} from "../src/HeistVault.sol";

/// forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    // USDC ERC-20 interface on Arc (same address on mainnet and testnet), 6 decimals.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (HeistVault vault) {
        address agent = vm.envAddress("AGENT_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        uint256 baseFee = vm.envOr("BASE_FEE", uint256(500_000)); // 0.50 USDC
        uint256 growth = vm.envOr("FEE_GROWTH_BPS", uint256(100)); // +1% per attempt
        uint256 maxFee = vm.envOr("MAX_FEE", uint256(10_000_000)); // 10 USDC cap
        uint256 poolShare = vm.envOr("POOL_SHARE_BPS", uint256(9_000)); // 90% to pool
        uint256 timeout = vm.envOr("TIMEOUT_SECONDS", uint256(72 hours));
        uint256 bonus = vm.envOr("LAST_PLAYER_BONUS_BPS", uint256(1_000)); // 10%

        vm.startBroadcast();
        vault = new HeistVault(ARC_USDC, agent, treasury, baseFee, growth, maxFee, poolShare, timeout, bonus);
        vm.stopBroadcast();

        console2.log("HeistVault deployed at", address(vault));
    }
}
