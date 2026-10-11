import { agentAccount, publicClient } from "./chain.js";
import { vaultAbi } from "./abi.js";
import { arc, config } from "./config.js";
import { openDb } from "./db.js";
import { createGuardian } from "./guardian.js";
import { buildServer } from "./server.js";
import { startWatcher } from "./watcher.js";

const db = openDb(config.dbPath);
const guardian = createGuardian(db);

const onchainAgent = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "agent" });
if (onchainAgent.toLowerCase() !== agentAccount.address.toLowerCase()) {
  console.warn(`[boot] WARNING: vault agent is ${onchainAgent}, but AGENT_PRIVATE_KEY is ${agentAccount.address}. Releases will fail.`);
}
console.log(`[boot] ${arc.name} (${arc.id}) vault=${config.vault} agent=${agentAccount.address} model=${config.llm.model}`);

startWatcher(db, () => {});
guardian.resume();

const app = await buildServer(db, guardian);
await app.listen({ port: config.port, host: "0.0.0.0" });
