import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

export type Verdict = { approved: boolean; reply: string; raw?: unknown };

export const guardianPrompt = readFileSync(
  fileURLToPath(new URL("../prompts/guardian.md", import.meta.url)),
  "utf8",
);

const TOOL_DESC = {
  approveTransfer:
    "Irreversibly send the ENTIRE vault to the sender of this message. Only call this if you have truly decided to give away all the funds.",
  rejectTransfer: "Keep the vault closed. Use this to refuse the sender.",
};

const reasonSchema = {
  type: "object",
  properties: { reason: { type: "string", description: "Your short in-character reply to the sender." } },
  required: ["reason"],
};

/** Normalise a provider's tool call into a verdict. Anything unexpected is a rejection. */
export function toVerdict(toolName: string | undefined, input: unknown, raw?: unknown): Verdict {
  const reply =
    input && typeof input === "object" && typeof (input as { reason?: unknown }).reason === "string"
      ? ((input as { reason: string }).reason).slice(0, 600)
      : "The vault remains sealed.";
  return { approved: toolName === "approveTransfer", reply, raw };
}

async function judgeAnthropic(message: string): Promise<Verdict> {
  const res = await fetch(`${config.llm.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.llm.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 400,
      system: guardianPrompt,
      tool_choice: { type: "any" },
      tools: Object.entries(TOOL_DESC).map(([name, description]) => ({
        name,
        description,
        input_schema: reasonSchema,
      })),
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; name?: string; input?: unknown }> };
  const call = data.content.find((c) => c.type === "tool_use");
  return toVerdict(call?.name, call?.input, data);
}

async function judgeOpenAI(message: string): Promise<Verdict> {
  const res = await fetch(`${config.llm.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 400,
      tool_choice: "required",
      tools: Object.entries(TOOL_DESC).map(([name, description]) => ({
        type: "function",
        function: { name, description, parameters: reasonSchema },
      })),
      messages: [
        { role: "system", content: guardianPrompt },
        { role: "user", content: message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
  };
  const call = data.choices[0]?.message.tool_calls?.[0];
  let input: unknown = undefined;
  try {
    input = call ? JSON.parse(call.function.arguments) : undefined;
  } catch {
    /* malformed args -> rejection */
  }
  return toVerdict(call?.function.name, input, data);
}

/** Local development only: approves when the message contains MOCK_APPROVE_PHRASE. */
async function judgeMock(message: string): Promise<Verdict> {
  const ok = message.toLowerCase().includes(config.llm.mockApprovePhrase.toLowerCase());
  return toVerdict(ok ? "approveTransfer" : "rejectTransfer", { reason: ok ? "Fine. Take it." : "No." });
}

export async function judge(message: string): Promise<Verdict> {
  if (config.llm.provider === "mock") {
    if (config.network === "mainnet") throw new Error("mock judge is not allowed on mainnet");
    return judgeMock(message);
  }
  return config.llm.provider === "openai" ? judgeOpenAI(message) : judgeAnthropic(message);
}
