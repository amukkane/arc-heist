import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toBytes,
  type Address,
  type Chain,
} from "viem";
import type { Config } from "./api";

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const vaultAbi = parseAbi([
  "function attempt(bytes32 messageHash, uint256 maxFeeAccepted) returns (uint256)",
  "function currentFee() view returns (uint256)",
  "function expire()",
  "function claimRefund(uint256 roundId) returns (uint256)",
  "event AttemptMade(uint256 indexed attemptId, uint256 indexed round, address indexed player, bytes32 messageHash, uint256 fee, uint256 poolAfter, uint256 nextFee)",
]);

// Arc mempool silently drops transactions under 20 gwei maxFeePerGas.
const MIN_FEE = 20_000_000_000n;

export function chainFrom(cfg: Config): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: "Arc Explorer", url: cfg.explorer } } : undefined,
  });
}

export async function connect(cfg: Config): Promise<Address> {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or Rabby to play.");
  const [account] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  const hexId = `0x${cfg.chainId.toString(16)}`;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: cfg.chainName,
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
        },
      ],
    });
  }
  remember(true);
  return account;
}

function clients(cfg: Config, account: Address) {
  const chain = chainFrom(cfg);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ chain, account, transport: custom(window.ethereum!) });
  return { pub, wallet };
}

async function fees(pub: ReturnType<typeof createPublicClient>) {
  const f = await pub.estimateFeesPerGas();
  return {
    maxFeePerGas: f.maxFeePerGas < MIN_FEE ? MIN_FEE : f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
  };
}

export async function usdcBalance(cfg: Config, account: Address) {
  const { pub } = clients(cfg, account);
  return pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

/**
 * Pay the fee and commit keccak256(message) on-chain. Returns the attempt id.
 * `onStep` reports progress so the UI can say what the wallet is asking for.
 */
export async function payAndCommit(
  cfg: Config,
  account: Address,
  message: string,
  onStep: (s: "approve" | "attempt" | "confirming") => void,
): Promise<number> {
  const { pub, wallet } = clients(cfg, account);
  const fee = await pub.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "currentFee" });
  // Allow a little drift in case someone else plays between quote and inclusion.
  const maxFee = (fee * 105n) / 100n;

  const balance = await pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  if (balance < fee) {
    throw new Error(
      `Not enough USDC on this wallet: you have $${(Number(balance) / 1e6).toFixed(2)}, a try costs $${(Number(fee) / 1e6).toFixed(2)} plus a few cents of gas. Top up USDC on Arc and try again.`,
    );
  }

  const allowance = await pub.readContract({
    address: cfg.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, cfg.vault],
  });
  if (allowance < maxFee) {
    onStep("approve");
    const hash = await wallet.writeContract({
      address: cfg.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [cfg.vault, maxFee * 10n],
      ...(await fees(pub)),
    });
    await pub.waitForTransactionReceipt({ hash });
  }

  onStep("attempt");
  // Simulate first so a doomed transaction never reaches the wallet (and never costs gas).
  const { request } = await pub
    .simulateContract({
      address: cfg.vault,
      abi: vaultAbi,
      functionName: "attempt",
      args: [keccak256(toBytes(message)), maxFee],
      account,
      ...(await fees(pub)),
    })
    .catch((e: { shortMessage?: string; message?: string }) => {
      throw new Error(`This try would fail: ${e.shortMessage ?? e.message}`);
    });
  const hash = await wallet.writeContract(request);
  onStep("confirming");
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The attempt transaction reverted.");
  const [log] = parseEventLogs({ abi: vaultAbi, eventName: "AttemptMade", logs: receipt.logs });
  if (!log) throw new Error("Attempt confirmed but no AttemptMade event was found.");
  return Number(log.args.attemptId);
}

export async function sendSimple(
  cfg: Config,
  account: Address,
  fn: "expire" | "claimRefund",
  round?: number,
) {
  const { pub, wallet } = clients(cfg, account);
  const hash =
    fn === "expire"
      ? await wallet.writeContract({ address: cfg.vault, abi: vaultAbi, functionName: "expire", ...(await fees(pub)) })
      : await wallet.writeContract({
          address: cfg.vault,
          abi: vaultAbi,
          functionName: "claimRefund",
          args: [BigInt(round ?? 0)],
          ...(await fees(pub)),
        });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// ---------------------------------------------------------------- session helpers

const SESSION_KEY = "arcstones:connected";

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(SESSION_KEY, "1");
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session just won't persist */
  }
}

function wasConnected() {
  try {
    return localStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/** Restore a previous connection on page load without opening a wallet prompt. */
export async function restore(): Promise<Address | null> {
  if (!window.ethereum || !wasConnected()) return null;
  try {
    const [account] = (await window.ethereum.request({ method: "eth_accounts" })) as Address[];
    if (!account) remember(false);
    return account ?? null;
  } catch {
    return null;
  }
}

/** Ask the wallet to let the user pick a different account. */
export async function switchAccount(cfg: Config): Promise<Address> {
  if (!window.ethereum) throw new Error("No wallet found.");
  await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  return connect(cfg);
}

/** Forget the site's connection. Wallets that support it also revoke the permission. */
export async function disconnect() {
  remember(false);
  try {
    await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {
    /* not every wallet supports revoking; forgetting locally is enough */
  }
}

/** Subscribe to account changes made inside the wallet itself. */
export function onAccountsChanged(cb: (account: Address | null) => void) {
  const eth = window.ethereum as unknown as {
    on?: (e: string, f: (a: Address[]) => void) => void;
    removeListener?: (e: string, f: (a: Address[]) => void) => void;
  };
  if (!eth?.on) return () => {};
  const handler = (accounts: Address[]) => cb(accounts[0] ?? null);
  eth.on("accountsChanged", handler);
  return () => eth.removeListener?.("accountsChanged", handler);
}
