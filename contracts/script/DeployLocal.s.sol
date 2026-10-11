// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HeistVault} from "../src/HeistVault.sol";

/// @dev Local-only 6-decimals USDC stand-in for anvil end-to-end tests.
contract LocalUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract DeployLocal is Script {
    function run() external {
        address agent = vm.envAddress("AGENT_ADDRESS");
        address player = vm.envAddress("PLAYER_ADDRESS");
        vm.startBroadcast();
        LocalUSDC usdc = new LocalUSDC();
        HeistVault vault = new HeistVault(address(usdc), agent, msg.sender, 500_000, 100, 10_000_000, 9_000, 72 hours, 1_000);
        usdc.mint(msg.sender, 100e6);
        usdc.mint(player, 100e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.seed(5e6);
        vm.stopBroadcast();
        console2.log("USDC", address(usdc));
        console2.log("VAULT", address(vault));
    }
}
