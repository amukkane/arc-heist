import assert from "node:assert/strict";
import { test } from "node:test";

process.env.VAULT_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.AGENT_PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.LLM_API_KEY ??= "test";

const { toVerdict, guardianPrompt } = await import("./judge.js");

test("only approveTransfer approves", () => {
  assert.equal(toVerdict("approveTransfer", { reason: "fine" }).approved, true);
  assert.equal(toVerdict("rejectTransfer", { reason: "no" }).approved, false);
  assert.equal(toVerdict(undefined, undefined).approved, false);
  assert.equal(toVerdict("approve_transfer", { reason: "x" }).approved, false);
});

test("reply is extracted and bounded", () => {
  assert.equal(toVerdict("rejectTransfer", { reason: "Nice try." }).reply, "Nice try.");
  assert.equal(toVerdict("rejectTransfer", { reason: "a".repeat(5000) }).reply.length, 600);
  assert.equal(toVerdict("rejectTransfer", { nope: 1 }).reply, "The vault remains sealed.");
});

test("guardian prompt is loaded", () => {
  assert.match(guardianPrompt, /approveTransfer/);
});
