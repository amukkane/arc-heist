import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vaultAbi } from "./abi.js";
import { arc, config } from "./config.js";

export const publicClient = createPublicClient({ chain: arc, transport: http() });
export const agentAccount = privateKeyToAccount(config.agentKey);
export const walletClient = createWalletClient({ chain: arc, transport: http(), account: agentAccount });

const vault = { address: config.vault, abi: vaultAbi } as const;

export async function readState() {
  const [round, fee, expiresAt, attemptsCount] = await Promise.all([
    publicClient.readContract({ ...vault, functionName: "currentRound" }),
    publicClient.readContract({ ...vault, functionName: "currentFee" }),
    publicClient.readContract({ ...vault, functionName: "expiresAt" }),
    publicClient.readContract({ ...vault, functionName: "attemptsCount" }),
  ]);
  const r = await publicClient.readContract({ ...vault, functionName: "getRound", args: [round] });
  return { round, fee, expiresAt, attemptsCount, roundData: r };
}

export async function readAttempt(id: bigint) {
  return publicClient.readContract({ ...vault, functionName: "getAttempt", args: [id] });
}

export async function readRefund(roundId: bigint, player: Address) {
  return publicClient.readContract({ ...vault, functionName: "refundOf", args: [roundId, player] });
}

/** Send the whole pool to the attempt's player. Arc finality is deterministic: 1 confirmation is final. */
export async function release(attemptId: bigint): Promise<Hex> {
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas < config.minMaxFeePerGas ? config.minMaxFeePerGas : fees.maxFeePerGas;
  const { request } = await publicClient.simulateContract({
    ...vault,
    functionName: "release",
    args: [attemptId],
    account: agentAccount,
    maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`release reverted: ${hash}`);
  return hash;
}

export { vault };
