// Cheap LLM helper for background jobs (summaries, memory extraction).
// Uses a small model on whichever provider has a key — never the main model.

import { config } from "./config.js";

export async function smallCompletion(system: string, user: string): Promise<string> {
  if (config.openaiApiKey) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: config.openaiApiKey });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_SMALL_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const res = await client.messages.create({
    model: process.env.CLAUDE_SMALL_MODEL || "claude-haiku-4-5",
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
