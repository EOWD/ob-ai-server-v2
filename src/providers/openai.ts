import OpenAI from "openai";
import { config } from "../config.js";
import { TOOLS } from "../tools/index.js";
import type { AgentTurn, LlmProvider, StreamTurnOpts, ToolCall } from "./types.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

// Convert the Anthropic-format tool registry to OpenAI function tools.
const OPENAI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
  },
}));

function toMessages(system: string, turns: AgentTurn[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const t of turns) {
    if (t.role === "user") {
      messages.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      messages.push({
        role: "assistant",
        content: t.text || null,
        tool_calls: t.toolCalls.length
          ? t.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
          : undefined,
      });
    } else {
      for (const r of t.results) {
        messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }
    }
  }
  return messages;
}

export const openaiProvider: LlmProvider = {
  name: `openai:${config.openaiModel}`,

  async streamTurn({ system, turns, onText }: StreamTurnOpts) {
    const stream = await client.chat.completions.create({
      model: config.openaiModel,
      stream: true,
      messages: toMessages(system, turns),
      tools: OPENAI_TOOLS,
    });

    let text = "";
    // tool calls stream in fragments keyed by index
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const entry = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        pending.set(tc.index, entry);
      }
    }

    const toolCalls: ToolCall[] = [...pending.values()].map((e) => ({
      id: e.id,
      name: e.name,
      input: e.args ? JSON.parse(e.args) : {},
    }));

    return { text, toolCalls };
  },
};
