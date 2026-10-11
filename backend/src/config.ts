import "dotenv/config";
import { defineChain, type Address, type Hex } from "viem";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const network = (process.env.ARC_NETWORK ?? "testnet") as "mainnet" | "testnet" | "local";

export const arc = defineChain(
  network === "local"
    ? {
        id: 31337,
        name: "Local Anvil",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "http://127.0.0.1:8545"] } },
        testnet: true,
      }
    : network === "mainnet"
    ? {
        id: 5042,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io"] } },
        blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
      }
    : {
        id: 5042002,
        name: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io"] } },
        blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
        testnet: true,
      },
);

export const config = {
  network,
  port: Number(process.env.PORT ?? 8787),
  vault: req("VAULT_ADDRESS") as Address,
  agentKey: req("AGENT_PRIVATE_KEY") as Hex,
  startBlock: BigInt(process.env.START_BLOCK ?? "0"),
  pollMs: Number(process.env.POLL_MS ?? 2000),
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai" | "mock",
    apiKey: process.env.LLM_PROVIDER === "mock" ? "" : req("LLM_API_KEY"),
    mockApprovePhrase: process.env.MOCK_APPROVE_PHRASE ?? "open sesame",
    model: process.env.LLM_MODEL ?? "claude-sonnet-5-5",
    baseUrl: process.env.LLM_BASE_URL, // for OpenAI-compatible providers
  },
  maxMessageChars: Number(process.env.MAX_MESSAGE_CHARS ?? 1000),
  publishPrompt: (process.env.PUBLISH_PROMPT ?? "true") === "true",
  dbPath: process.env.DB_PATH ?? "./data/heist.sqlite",
  staticDir: process.env.STATIC_DIR ?? "../frontend/dist",
  // Arc mempool drops anything below 20 gwei maxFeePerGas without a receipt.
  minMaxFeePerGas: 20_000_000_000n,
};
