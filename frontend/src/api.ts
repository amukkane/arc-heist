export type Config = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer?: string;
  vault: `0x${string}`;
  usdc: `0x${string}`;
  agent: `0x${string}`;
  network: "mainnet" | "testnet" | "local";
  maxMessageChars: number;
  guardianPrompt: string | null;
  model: string;
};

export type VaultEvent = {
  id: number;
  kind: "cracked" | "expired" | "seeded";
  round: number;
  data: Record<string, string>;
  tx_hash: string;
  created_at: number;
};

export type State = {
  round: string;
  pool: string;
  fee: string;
  roundAttempts: string;
  totalAttempts: string;
  players: number;
  expiresAt: number;
  lastPlayer: string;
  events: VaultEvent[];
};

export type Attempt = {
  id: number;
  round: number;
  player: string;
  fee: string;
  poolAfter: string;
  txHash: string;
  createdAt: number;
  message: string | null;
  status: "awaiting_message" | "judging" | "rejected" | "approved" | "error";
  reply: string | null;
  releaseTx: string | null;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  config: () => get<Config>("/api/config"),
  state: () => get<State>("/api/state"),
  attempts: (limit = 50) => get<Attempt[]>(`/api/attempts?limit=${limit}`),
  refund: (round: number, player: string) => get<{ amount: string }>(`/api/refund/${round}/${player}`),
  async reveal(id: number, message: string): Promise<Attempt> {
    const r = await fetch(`/api/attempts/${id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
    return body as Attempt;
  },
};

/** USDC amounts from the API are 6-decimal integer strings. */
export function usd(raw: string | bigint, digits = 2): string {
  const n = Number(BigInt(raw)) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
