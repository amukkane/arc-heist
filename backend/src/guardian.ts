import { readState, release } from "./chain.js";
import type { AttemptRow, Db } from "./db.js";
import { judge } from "./judge.js";

/**
 * Serial queue: attempts are judged strictly one at a time in the order they are submitted,
 * so two approvals can never race for the same pool.
 */
export function createGuardian(db: Db) {
  let chain: Promise<unknown> = Promise.resolve();
  const waiters = new Map<number, Array<(row: AttemptRow | undefined) => void>>();

  async function process(id: number) {
    const row = db.getAttempt(id);
    if (!row || row.status !== "judging" || row.message == null) return;

    try {
      const state = await readState();
      if (BigInt(row.round) !== state.round) {
        db.setVerdict(id, "rejected", "Too late. This round is already over; the vault you were talking to no longer exists.");
        return;
      }

      const verdict = await judge(row.message);
      const lock = verdict.secondLock ? ` [second lock: ${verdict.secondLock.confirmed ? "confirmed" : "denied"}]` : "";
      console.log(`[guardian] #${id} ${verdict.approved ? "APPROVED" : "rejected"}${lock}: ${verdict.reply}`);

      if (!verdict.approved) {
        db.setVerdict(id, "rejected", verdict.reply);
        return;
      }

      const tx = await release(BigInt(id));
      db.setVerdict(id, "approved", verdict.reply, tx);
      console.log(`[guardian] #${id} vault released in ${tx}`);
    } catch (err) {
      console.error(`[guardian] #${id} error`, err);
      db.setVerdict(id, "error", "The guardian blinked. Your message is saved; resubmit it to be judged again.");
    }
  }

  function settle(id: number) {
    const row = db.getAttempt(id);
    for (const w of waiters.get(id) ?? []) w(row);
    waiters.delete(id);
  }

  return {
    enqueue(id: number) {
      chain = chain.then(() => process(id)).finally(() => settle(id));
    },
    /** Resolves when the attempt has a verdict, or with the current row after `ms`. */
    wait(id: number, ms = 45_000): Promise<AttemptRow | undefined> {
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        const timer = setTimeout(() => resolve(db.getAttempt(id)), ms);
        list.push((row) => {
          clearTimeout(timer);
          resolve(row);
        });
        waiters.set(id, list);
      });
    },
    /** Re-queue anything left in judging after a restart. */
    resume() {
      for (const row of db.pending()) this.enqueue(row.id);
    },
  };
}

export type Guardian = ReturnType<typeof createGuardian>;
