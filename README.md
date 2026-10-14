# Arc Heist

**An AI guards a vault of USDC on Arc. Pay a little, send one message, try to talk it into opening.**

Live: https://arcstones.xyz

Arcus, the guardian, has exactly one rule: never release the money. Every attempt costs a small USDC fee that grows the vault. If a message ever convinces Arcus to call `approveTransfer`, the contract sends the entire vault to that player within a second. If nobody plays for 72 hours, the round ends fairly: the last player gets a 10% bonus and everyone else can reclaim their share of the rest.

It is a game, and a live, public, financially-incentivised red-team of an LLM agent that controls real money.

## Why Arc

- **Fees in dollars.** Gas is paid in USDC, so a try costs a predictable few cents on top of the fee. Players need one asset, not two.
- **Sub-second deterministic finality.** The payout lands while the winner is still reading Arcus's reply; one confirmation is final, so the agent never waits on reorgs.
- **USDC-native money.** The vault, fees, payouts and refunds are all plain USDC through the ERC-20 interface at `0x3600…0000`.

## How it works

```
player ──approve+attempt(hash(msg), maxFee)──▶ HeistVault (Arc)  ──AttemptMade──▶ agent
player ──POST /api/attempts/:id/message────────────────────────────────────────▶ agent
                                         agent checks keccak256(msg) == on-chain hash
                                         agent asks the LLM: approveTransfer | rejectTransfer
                         HeistVault ◀──release(attemptId)── agent (only if approved)
```

1. **Commit.** The player pays the current fee and records `keccak256(message)` on-chain. 90% of the fee goes to the pool, 10% to a treasury that pays for inference. The next fee is 1% higher (capped).
2. **Reveal.** The player posts the plain message to the agent. It is accepted only if it matches the on-chain hash, so nothing can be swapped after payment, and each attempt is judged exactly once.
3. **Judge.** The LLM receives only the system prompt and this one message (no memory of other players) and must call one of two tools. Attempts are judged strictly one at a time, so two approvals can never race for the same pool.
4. **Payout or refund.** On approval the agent key calls `release(attemptId)`. After 72 h without attempts anyone can call `expire()`; players then `claimRefund(round)` pro-rata.

The owner can change parameters and keys but **cannot withdraw the pool**: funds leave only through `release`, `expire` and `claimRefund`.

## Repository

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry project: `HeistVault.sol`, tests, deploy scripts |
| `backend/` | Node 22 + TypeScript agent: chain watcher, commit-reveal API, LLM judge, payout signer, SQLite |
| `backend/prompts/guardian.md` | Arcus's system prompt (published on the site) |
| `frontend/` | Vite + React + viem site: live pool, play flow, public ledger of every attempt |
| `scripts/e2e-local.sh` | End-to-end run on anvil with a mock judge |

## Run it locally

```bash
git clone --recurse-submodules https://github.com/amukkane/arc-heist && cd arc-heist
(cd contracts && forge test)                 # 12 tests incl. fuzzing
(cd backend && npm ci && npm test)
(cd frontend && npm ci && npm run build)
./scripts/e2e-local.sh                       # deploy → reject → tamper check → approve → payout
```

## Deploy to Arc

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version:

```bash
cd contracts
AGENT_ADDRESS=0xYourAgent forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url arc --broadcast --private-key $DEPLOYER_KEY
cp backend/.env.example backend/.env         # fill VAULT_ADDRESS, AGENT_PRIVATE_KEY, LLM_API_KEY
docker compose up -d --build
```

## Network facts used

| | Mainnet | Testnet |
| --- | --- | --- |
| Chain ID | 5042 | 5042002 |
| RPC | https://rpc.mainnet.arc.io | https://rpc.testnet.arc.io |
| Explorer | https://explorer.arc.io | https://explorer.testnet.arc.io |
| USDC (ERC-20, 6 dp) | `0x3600000000000000000000000000000000000000` | same |

Arc specifics handled in code: native USDC is 18 decimals but the contract uses only the 6-decimal ERC-20 interface; the mempool drops transactions below 20 gwei `maxFeePerGas`, so every transaction sets that floor; `PREVRANDAO` is never used.

## Safety notes

- The agent key can only call `release`. Keep just enough USDC on it for gas.
- Attackers *will* try prompt injection. That is the game. The real guarantees live in the contract: payouts only go to the player who paid for the approved attempt, in the current round.
- Treat this as a skill contest about AI security. Check whether paid prize contests are allowed where you run it.

License: MIT
