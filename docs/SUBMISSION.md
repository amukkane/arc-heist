# DoraHacks submission: Arcstones

**One-liner:** An AI guards a vault of USDC on Arc. Pay a few cents, send one message, and try to talk it into opening.

**What it does**
Arcstones is a public, financially-incentivised red-team of an AI agent that controls real money. Players pay a small, growing USDC fee to send a single message to Arcstones, an LLM guardian whose only rule is never to release the vault. Each fee grows the pool. If a message convinces Arcstones to call its `approveTransfer` tool, the vault contract pays the entire pool to that player in under a second. Every message and every reply is shown in a public ledger, so the community learns, live, which jailbreaks work against agents with wallets. If nobody plays for 72 hours, the round ends with a bonus for the last player and pro-rata refunds for everyone else.

**What it uses Arc for**
- USDC-denominated gas: one asset for fees, prizes and gas; tries cost predictable cents.
- Deterministic sub-second finality: payouts are instant and the agent acts on one confirmation.
- The USDC ERC-20 interface (`0x3600…0000`) for all vault accounting.

**How it is built**
- `HeistVault.sol`: commit (keccak256 of the message) + fee split + escalating fee, agent-only `release`, permissionless `expire`, pro-rata `claimRefund`. The owner cannot withdraw the pool. 12 Foundry tests including fuzzing.
- Agent (Node/TypeScript, viem): watches events, verifies the revealed message against the on-chain hash, judges attempts strictly in order with an LLM restricted to two tools, signs `release` with a 20 gwei fee floor.
- Web (React + viem): live pool, play flow, public ledger, published system prompt, share-to-X.

**Why it is worth taking further**
Agents that hold money are coming fast, and nobody has good data on how they fail. Arcstones turns that into a game that produces a public dataset of real attacks, and can grow into a red-teaming service where teams put their own agent prompts behind a vault and pay players to break them.

**Links**
- Live app: https://arcstones.xyz
- Contract: https://explorer.arc.io/address/0xc0880060554b2832cca7803bc0cf76cc20a36ab9
- Repo: https://github.com/amukkane/arc-heist
- Builder: https://github.com/amukkane
