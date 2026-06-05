import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { TOOLS } from "../tools/index.js";
import type { AgentTurn, LlmProvider, StreamTurnOpts, ToolCall } from "./types.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function toMessages(turns: AgentTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: t.text }] });
    } else if (t.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (t.text) content.push({ type: "text", text: t.text });
      for (const tc of t.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: t.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  // Conversation cache breakpoint on the newest user text block — prior
  // turns are read from cache on the next request.
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
      (lastBlock as any).cache_control = { type: "ephemeral" };
    }
  }
  return messages;
}

export const anthropicProvider: LlmProvider = {
  name: `anthropic:${config.model}`,

  async streamTurn({ system, turns, onText }: StreamTurnOpts) {
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: system,
          // Frozen domain prompt + tool defs cached together
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages: toMessages(turns),
    });

    stream.on("text", onText);
    const message = await stream.finalMessage();

    const toolCalls: ToolCall[] = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return { text, toolCalls };
  },
};
