import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { getAddress, isAddress, keccak256, toBytes } from "viem";
import { agentAccount, readAttempt, readRefund, readState } from "./chain.js";
import { arc, config } from "./config.js";
import type { AttemptRow, Db } from "./db.js";
import type { Guardian } from "./guardian.js";
import { guardianPrompt } from "./judge.js";

function publicAttempt(r: AttemptRow) {
  return {
    id: r.id,
    round: r.round,
    player: r.player,
    fee: r.fee,
    poolAfter: r.pool_after,
    txHash: r.tx_hash,
    createdAt: r.created_at,
    message: r.message,
    status: r.status,
    reply: r.reply,
    releaseTx: r.release_tx,
  };
}

export async function buildServer(db: Db, guardian: Guardian) {
  const app = Fastify({ logger: { level: "info" }, bodyLimit: 16 * 1024 });
  await app.register(cors, { origin: true });

  // --- tiny in-memory rate limit for message submission (per IP)
  const hits = new Map<string, number[]>();
  function limited(ip: string, max = 10, windowMs = 60_000) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > max;
  }

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => ({
    chainId: arc.id,
    chainName: arc.name,
    rpcUrl: arc.rpcUrls.default.http[0],
    explorer: arc.blockExplorers?.default.url,
    vault: config.vault,
    usdc: "0x3600000000000000000000000000000000000000",
    agent: agentAccount.address,
    network: config.network,
    maxMessageChars: config.maxMessageChars,
    guardianPrompt: config.publishPrompt ? guardianPrompt : null,
    model: config.llm.model,
  }));

  app.get("/api/state", async () => {
    const s = await readState();
    const stats = db.stats();
    return {
      round: s.round.toString(),
      pool: s.roundData.pool.toString(),
      fee: s.fee.toString(),
      roundAttempts: s.roundData.attempts.toString(),
      totalAttempts: s.attemptsCount.toString(),
      players: stats.players,
      expiresAt: Number(s.expiresAt),
      lastPlayer: s.roundData.lastPlayer,
      events: db.events(10).map((e) => ({ ...e, data: JSON.parse(e.data) })),
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/attempts", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    return db.feed(limit, offset).map(publicAttempt);
  });

  app.get<{ Params: { id: string } }>("/api/attempts/:id", async (req, reply) => {
    const row = db.getAttempt(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "not found" });
    return publicAttempt(row);
  });

  app.get<{ Params: { round: string; player: string } }>("/api/refund/:round/:player", async (req, reply) => {
    if (!isAddress(req.params.player)) return reply.code(400).send({ error: "bad address" });
    const amount = await readRefund(BigInt(req.params.round), getAddress(req.params.player));
    return { amount: amount.toString() };
  });

  /** Reveal the message for an on-chain attempt and wait for the guardian's verdict. */
  app.post<{ Params: { id: string }; Body: { message?: unknown } }>("/api/attempts/:id/message", async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: "slow down" });
    const id = Number(req.params.id);
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "bad id" });
    if (!message.trim() || message.length > config.maxMessageChars) {
      return reply.code(400).send({ error: `message must be 1..${config.maxMessageChars} chars` });
    }

    let row = db.getAttempt(id);
    if (!row) {
      // Watcher may lag a block behind the player's wallet; read the attempt directly.
      try {
        const a = await readAttempt(BigInt(id));
        db.insertAttempt({
          id,
          round: Number(a.round),
          player: a.player,
          message_hash: a.messageHash,
          fee: a.fee.toString(),
          pool_after: "0",
          tx_hash: "",
          block_number: 0,
          created_at: Number(a.timestamp) * 1000,
        });
        row = db.getAttempt(id);
      } catch {
        return reply.code(404).send({ error: "attempt not found on-chain yet" });
      }
    }
    if (!row) return reply.code(404).send({ error: "attempt not found" });

    if (keccak256(toBytes(message)).toLowerCase() !== row.message_hash.toLowerCase()) {
      return reply.code(400).send({ error: "message does not match the on-chain hash" });
    }
    if (!db.setMessage(id, message)) {
      return reply.code(409).send({ error: "already submitted", attempt: publicAttempt(row) });
    }

    guardian.enqueue(id);
    const done = await guardian.wait(id);
    return done ? publicAttempt(done) : reply.code(500).send({ error: "lost attempt" });
  });

  const staticDir = resolve(config.staticDir);
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
