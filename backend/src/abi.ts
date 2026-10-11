import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "struct Round { uint256 pool; uint256 fee; uint256 attempts; uint256 totalContributed; uint256 refundPool; uint64 startedAt; uint64 lastAttemptAt; address lastPlayer; address winner; uint8 endReason; }",
  "struct Attempt { address player; uint64 round; uint64 timestamp; bytes32 messageHash; uint256 fee; }",
  "function currentRound() view returns (uint256)",
  "function currentFee() view returns (uint256)",
  "function expiresAt() view returns (uint256)",
  "function attemptsCount() view returns (uint256)",
  "function getRound(uint256 id) view returns (Round)",
  "function getAttempt(uint256 id) view returns (Attempt)",
  "function refundOf(uint256 roundId, address player) view returns (uint256)",
  "function timeout() view returns (uint256)",
  "function agent() view returns (address)",
  "function release(uint256 attemptId)",
  "event AttemptMade(uint256 indexed attemptId, uint256 indexed round, address indexed player, bytes32 messageHash, uint256 fee, uint256 poolAfter, uint256 nextFee)",
  "event VaultCracked(uint256 indexed round, uint256 indexed attemptId, address indexed winner, uint256 amount)",
  "event RoundExpired(uint256 indexed round, address indexed lastPlayer, uint256 bonus, uint256 refundPool)",
  "event Seeded(uint256 indexed round, address indexed from, uint256 amount, uint256 poolAfter)",
]);
