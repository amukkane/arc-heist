/**
 * Server-side ops without Foundry.
 *   npx tsx scripts/ops.ts wallets          create deployer + agent keys (never printed), show addresses
 *   npx tsx scripts/ops.ts status           balances and vault state
 *   npx tsx scripts/ops.ts deploy           deploy HeistVault, write VAULT_ADDRESS/START_BLOCK into .env
 *   npx tsx scripts/ops.ts seed 10          add 10 USDC from the deployer to the pool
 *
 * Keys live in backend/.env (AGENT_PRIVATE_KEY) and backend/.deployer.env (DEPLOYER_PRIVATE_KEY), both chmod 600.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENV = `${root}.env`;
const DEPLOYER_ENV = `${root}.deployer.env`;
const USDC: Address = "0x3600000000000000000000000000000000000000";
const MIN_FEE = 20_000_000_000n; // Arc mempool floor

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

function setEnv(path: string, updates: Record<string, string>) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n?$/, "\n")}${k}=${v}\n`;
  }
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

const env = { ...readEnv(ENV), ...readEnv(DEPLOYER_ENV), ...process.env } as Record<string, string | undefined>;
const network = env.ARC_NETWORK ?? "testnet";
const chain = defineChain(
  network === "mainnet"
    ? {
        id: 5042,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io"] } },
      }
    : {
        id: 5042002,
        name: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io"] } },
      },
);
const explorer = network === "mainnet" ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io";
const pub = createPublicClient({ chain, transport: http() });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function seed(uint256 amount)",
  "function currentRound() view returns (uint256)",
  "function currentFee() view returns (uint256)",
  "function agent() view returns (address)",
  "function owner() view returns (address)",
]);

async function fees() {
  const f = await pub.estimateFeesPerGas();
  return { maxFeePerGas: f.maxFeePerGas < MIN_FEE ? MIN_FEE : f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
}

function deployer() {
  if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("No DEPLOYER_PRIVATE_KEY. Run: npx tsx scripts/ops.ts wallets");
  return privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
}

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

async function wallets() {
  if (!env.DEPLOYER_PRIVATE_KEY) setEnv(DEPLOYER_ENV, { DEPLOYER_PRIVATE_KEY: generatePrivateKey() });
  if (!readEnv(ENV).AGENT_PRIVATE_KEY || readEnv(ENV).AGENT_PRIVATE_KEY === "0x...") {
    setEnv(ENV, { AGENT_PRIVATE_KEY: generatePrivateKey() });
  }
  const d = privateKeyToAccount(readEnv(DEPLOYER_ENV).DEPLOYER_PRIVATE_KEY as Hex);
  const a = privateKeyToAccount(readEnv(ENV).AGENT_PRIVATE_KEY as Hex);
  console.log(`DEPLOYER ${d.address}`);
  console.log(`AGENT    ${a.address}`);
}

async function status() {
  const e = readEnv(ENV);
  const rows: Array<[string, Address]> = [];
  if (env.DEPLOYER_PRIVATE_KEY) rows.push(["deployer", deployer().address]);
  if (e.AGENT_PRIVATE_KEY?.startsWith("0x") && e.AGENT_PRIVATE_KEY.length === 66) {
    rows.push(["agent", privateKeyToAccount(e.AGENT_PRIVATE_KEY as Hex).address]);
  }
  console.log(`network ${network} (chain ${chain.id})`);
  for (const [name, addr] of rows) {
    const bal = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [addr] });
    console.log(`${name.padEnd(9)}${addr}  ${usdc(bal)}`);
  }
  if (e.VAULT_ADDRESS?.startsWith("0x") && e.VAULT_ADDRESS.length === 42) {
    const v = e.VAULT_ADDRESS as Address;
    const [pool, round, fee, agent] = await Promise.all([
      pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [v] }),
      pub.readContract({ address: v, abi: vaultAbi, functionName: "currentRound" }),
      pub.readContract({ address: v, abi: vaultAbi, functionName: "currentFee" }),
      pub.readContract({ address: v, abi: vaultAbi, functionName: "agent" }),
    ]);
    console.log(`vault    ${v}  holds ${usdc(pool)}, round ${round}, next fee ${usdc(fee)}, agent ${agent}`);
    console.log(`         ${explorer}/address/${v}`);
  }
}

async function deploy() {
  const e = readEnv(ENV);
  const agent = privateKeyToAccount(e.AGENT_PRIVATE_KEY as Hex).address;
  const d = deployer();
  const art = JSON.parse(readFileSync(`${root}artifacts/HeistVault.json`, "utf8")) as { abi: Abi; bytecode: Hex };
  const wallet = createWalletClient({ chain, transport: http(), account: d });
  const args = [
    USDC,
    agent,
    (env.TREASURY_ADDRESS as Address) ?? d.address,
    BigInt(env.BASE_FEE ?? 500_000),
    BigInt(env.FEE_GROWTH_BPS ?? 100),
    BigInt(env.MAX_FEE ?? 10_000_000),
    BigInt(env.POOL_SHARE_BPS ?? 9_000),
    BigInt(env.TIMEOUT_SECONDS ?? 72 * 3600),
    BigInt(env.LAST_PLAYER_BONUS_BPS ?? 1_000),
  ] as const;
  console.log(`deploying on ${chain.name} from ${d.address}, agent ${agent}…`);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, ...(await fees()) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || receipt.status !== "success") throw new Error(`deploy failed: ${hash}`);
  setEnv(ENV, { VAULT_ADDRESS: receipt.contractAddress, START_BLOCK: receipt.blockNumber.toString() });
  console.log(`VAULT ${receipt.contractAddress} (block ${receipt.blockNumber})`);
  console.log(`${explorer}/tx/${hash}`);
}

async function seed(amountStr: string) {
  const e = readEnv(ENV);
  const vault = e.VAULT_ADDRESS as Address;
  const amount = parseUnits(amountStr, 6);
  const d = deployer();
  const wallet = createWalletClient({ chain, transport: http(), account: d });
  const allowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [d.address, vault] });
  if (allowance < amount) {
    const h = await wallet.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [vault, amount], ...(await fees()) });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const h = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "seed", args: [amount], ...(await fees()) });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`seeded ${amountStr} USDC: ${explorer}/tx/${h}`);
}

const [cmd, arg] = process.argv.slice(2);
const run = { wallets, status, deploy, seed: () => seed(arg ?? "1") }[cmd ?? ""];
if (!run) {
  console.log("usage: ops.ts wallets | status | deploy | seed <usdc>");
  process.exit(1);
}
await run();
