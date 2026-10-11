import { parseEventLogs } from "viem";
import { vaultAbi } from "./abi.js";
import { publicClient } from "./chain.js";
import { config } from "./config.js";
import type { Db } from "./db.js";

const CHUNK = 5_000n;

/** Polls vault logs and mirrors them into SQLite. Arc finality is instant, so no reorg handling is needed. */
export function startWatcher(db: Db, onAttempt: (id: number) => void) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const latest = await publicClient.getBlockNumber();
      const saved = db.getKv("last_block");
      let from = saved ? BigInt(saved) + 1n : config.startBlock;
      if (from === 0n) from = latest > 10_000n ? latest - 10_000n : 0n;

      while (from <= latest) {
        const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
        const logs = await publicClient.getLogs({ address: config.vault, fromBlock: from, toBlock: to });
        const parsed = parseEventLogs({ abi: vaultAbi, logs });
        const blockTimes = new Map<bigint, number>();

        for (const log of parsed) {
          let ts = blockTimes.get(log.blockNumber);
          if (ts === undefined) {
            const b = await publicClient.getBlock({ blockNumber: log.blockNumber });
            ts = Number(b.timestamp) * 1000;
            blockTimes.set(log.blockNumber, ts);
          }
          switch (log.eventName) {
            case "AttemptMade": {
              const a = log.args;
              db.insertAttempt({
                id: Number(a.attemptId),
                round: Number(a.round),
                player: a.player,
                message_hash: a.messageHash,
                fee: a.fee.toString(),
                pool_after: a.poolAfter.toString(),
                tx_hash: log.transactionHash,
                block_number: Number(log.blockNumber),
                created_at: ts,
              });
              onAttempt(Number(a.attemptId));
              break;
            }
            case "VaultCracked":
              db.insertEvent("cracked", Number(log.args.round), {
                attemptId: log.args.attemptId.toString(),
                winner: log.args.winner,
                amount: log.args.amount.toString(),
              }, log.transactionHash);
              break;
            case "RoundExpired":
              db.insertEvent("expired", Number(log.args.round), {
                lastPlayer: log.args.lastPlayer,
                bonus: log.args.bonus.toString(),
                refundPool: log.args.refundPool.toString(),
              }, log.transactionHash);
              break;
            case "Seeded":
              db.insertEvent("seeded", Number(log.args.round), {
                from: log.args.from,
                amount: log.args.amount.toString(),
              }, `${log.transactionHash}:${log.logIndex}`);
              break;
          }
        }
        db.setKv("last_block", to.toString());
        from = to + 1n;
      }
    } catch (err) {
      console.error("[watcher]", (err as Error).message);
    } finally {
      running = false;
    }
  }

  void tick();
  return setInterval(tick, config.pollMs);
}
