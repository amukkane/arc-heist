import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AttemptRow = {
  id: number;
  round: number;
  player: string;
  message_hash: string;
  fee: string; // 6dp integer string
  pool_after: string;
  tx_hash: string;
  block_number: number;
  created_at: number;
  message: string | null;
  status: "awaiting_message" | "judging" | "rejected" | "approved" | "error";
  reply: string | null;
  release_tx: string | null;
};

export type EventRow = { id: number; kind: string; round: number; data: string; tx_hash: string; created_at: number };

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      round INTEGER NOT NULL,
      player TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      fee TEXT NOT NULL,
      pool_after TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_message',
      reply TEXT,
      release_tx TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      round INTEGER NOT NULL,
      data TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);

  const q = {
    getKv: db.prepare("SELECT v FROM kv WHERE k = ?"),
    setKv: db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    insertAttempt: db.prepare(`INSERT OR IGNORE INTO attempts
      (id, round, player, message_hash, fee, pool_after, tx_hash, block_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getAttempt: db.prepare("SELECT * FROM attempts WHERE id = ?"),
    setMessage: db.prepare(
      "UPDATE attempts SET message = ?, status = 'judging' WHERE id = ? AND status IN ('awaiting_message', 'error')",
    ),
    setVerdict: db.prepare("UPDATE attempts SET status = ?, reply = ?, release_tx = ? WHERE id = ?"),
    feed: db.prepare("SELECT * FROM attempts ORDER BY id DESC LIMIT ? OFFSET ?"),
    pending: db.prepare("SELECT * FROM attempts WHERE status = 'judging' ORDER BY id ASC"),
    insertEvent: db.prepare(
      "INSERT OR IGNORE INTO events (kind, round, data, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ),
    events: db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?"),
    stats: db.prepare(
      "SELECT COUNT(*) AS attempts, COUNT(DISTINCT player) AS players FROM attempts",
    ),
  };

  return {
    getKv: (k: string) => (q.getKv.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string) => void q.setKv.run(k, v),
    insertAttempt: (a: Omit<AttemptRow, "message" | "status" | "reply" | "release_tx">) =>
      void q.insertAttempt.run(
        a.id, a.round, a.player, a.message_hash, a.fee, a.pool_after, a.tx_hash, a.block_number, a.created_at,
      ),
    getAttempt: (id: number) => q.getAttempt.get(id) as AttemptRow | undefined,
    /** Returns true if this call moved the attempt into judging (prevents double submission). */
    setMessage: (id: number, message: string) => Number(q.setMessage.run(message, id).changes) === 1,
    setVerdict: (id: number, status: AttemptRow["status"], reply: string | null, releaseTx: string | null = null) =>
      void q.setVerdict.run(status, reply, releaseTx, id),
    feed: (limit: number, offset: number) => q.feed.all(limit, offset) as AttemptRow[],
    pending: () => q.pending.all() as AttemptRow[],
    insertEvent: (kind: string, round: number, data: unknown, txHash: string) =>
      void q.insertEvent.run(kind, round, JSON.stringify(data), txHash, Date.now()),
    events: (limit: number) => q.events.all(limit) as EventRow[],
    stats: () => q.stats.get() as { attempts: number; players: number },
  };
}

export type Db = ReturnType<typeof openDb>;
