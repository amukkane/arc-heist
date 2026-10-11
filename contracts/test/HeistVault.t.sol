// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HeistVault} from "../src/HeistVault.sol";

contract MockUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract HeistVaultTest is Test {
    MockUSDC usdc;
    HeistVault vault;
    address agent = makeAddr("agent");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant BASE = 500_000; // 0.50 USDC

    function setUp() public {
        usdc = new MockUSDC();
        vault = new HeistVault(address(usdc), agent, treasury, BASE, 100, 10_000_000, 9_000, 72 hours, 1_000);
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i; i < ps.length; i++) {
            usdc.mint(ps[i], 1_000e6);
            vm.prank(ps[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
        usdc.mint(address(this), 100e6);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _try(address p, string memory m) internal returns (uint256) {
        vm.prank(p);
        return vault.attempt(keccak256(bytes(m)), type(uint256).max);
    }

    function test_attemptSplitsFeeAndGrows() public {
        uint256 id = _try(alice, "please");
        assertEq(id, 0);
        HeistVault.Round memory r = vault.getRound(0);
        assertEq(r.pool, 450_000);
        assertEq(usdc.balanceOf(treasury), 50_000);
        assertEq(r.fee, 505_000);
        assertEq(vault.contributed(0, alice), 450_000);
        HeistVault.Attempt memory a = vault.getAttempt(0);
        assertEq(a.player, alice);
        assertEq(a.messageHash, keccak256("please"));
    }

    function test_maxFeeAcceptedProtects() public {
        vm.prank(alice);
        vm.expectRevert(HeistVault.BadParams.selector);
        vault.attempt(keccak256("x"), BASE - 1);
    }

    function test_feeCapped() public {
        vault.setParams(BASE, 1_000, 600_000, 9_000, 72 hours, 1_000);
        // round 0 fee already BASE; growth 10%/attempt capped at 0.60
        _try(alice, "1");
        _try(alice, "2");
        _try(alice, "3");
        assertEq(vault.currentFee(), 600_000);
    }

    function test_releasePaysWholePoolAndStartsNewRound() public {
        vault.seed(10e6);
        _try(alice, "a");
        uint256 winId = _try(bob, "b");
        uint256 pool = vault.getRound(0).pool;
        uint256 before = usdc.balanceOf(bob);

        vm.prank(agent);
        vault.release(winId);

        assertEq(usdc.balanceOf(bob) - before, pool);
        assertEq(vault.currentRound(), 1);
        assertEq(vault.currentFee(), BASE);
        HeistVault.Round memory r0 = vault.getRound(0);
        assertEq(r0.winner, bob);
        assertEq(uint8(r0.endReason), uint8(HeistVault.EndReason.Cracked));
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_onlyAgentCanRelease() public {
        uint256 id = _try(alice, "a");
        vm.expectRevert(HeistVault.NotAgent.selector);
        vault.release(id);
    }

    function test_cannotReleaseOldRoundAttempt() public {
        uint256 id = _try(alice, "a");
        vm.prank(agent);
        vault.release(id);
        vm.prank(agent);
        vm.expectRevert(HeistVault.WrongRound.selector);
        vault.release(id);
    }

    function test_expireBonusAndRefunds() public {
        vault.seed(9e6);
        _try(alice, "a"); // 0.45 to pool
        _try(alice, "a2"); // 0.4545
        _try(bob, "b"); // 0.459045 -> bob last
        HeistVault.Round memory r = vault.getRound(0);

        vm.expectRevert(HeistVault.NotExpired.selector);
        vault.expire();

        vm.warp(block.timestamp + 72 hours);
        uint256 bobBefore = usdc.balanceOf(bob);
        vault.expire();
        uint256 bonus = (r.pool * 1_000) / 10_000;
        assertEq(usdc.balanceOf(bob) - bobBefore, bonus);

        uint256 refundPool = r.pool - bonus;
        uint256 aliceExp = (refundPool * vault.contributed(0, alice)) / r.totalContributed;
        assertEq(vault.refundOf(0, alice), aliceExp);

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimRefund(0);
        assertEq(usdc.balanceOf(alice) - aBefore, aliceExp);

        vm.prank(alice);
        vm.expectRevert(HeistVault.AlreadyClaimed.selector);
        vault.claimRefund(0);

        vm.prank(bob);
        vault.claimRefund(0);
        vm.prank(carol);
        vm.expectRevert(HeistVault.NothingToClaim.selector);
        vault.claimRefund(0);

        // only rounding dust remains
        assertLe(usdc.balanceOf(address(vault)), 2);
        assertEq(vault.currentRound(), 1);
    }

    function test_cannotExpireWithoutAttempts() public {
        vm.warp(block.timestamp + 100 hours);
        vm.expectRevert(HeistVault.NoAttempts.selector);
        vault.expire();
    }

    function test_cannotRefundCrackedRound() public {
        uint256 id = _try(alice, "a");
        vm.prank(agent);
        vault.release(id);
        vm.prank(alice);
        vm.expectRevert(HeistVault.NotRefundable.selector);
        vault.claimRefund(0);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(alice);
        vm.expectRevert(HeistVault.NotOwner.selector);
        vault.setAgent(alice);
    }

    function test_badParamsRejected() public {
        vm.expectRevert(HeistVault.BadParams.selector);
        vault.setParams(BASE, 2_000, 10e6, 9_000, 72 hours, 1_000);
    }

    function testFuzz_poolAccounting(uint8 n) public {
        uint256 count = bound(n, 1, 60);
        for (uint256 i; i < count; i++) {
            _try(i % 2 == 0 ? alice : bob, vm.toString(i));
        }
        HeistVault.Round memory r = vault.getRound(0);
        assertEq(usdc.balanceOf(address(vault)), r.pool);
        assertEq(r.totalContributed, vault.contributed(0, alice) + vault.contributed(0, bob));
    }
}
