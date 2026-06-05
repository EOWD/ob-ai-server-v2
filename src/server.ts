import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { memory } from "./memory.js";

const app = express();

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
);
app.use(express.json());

// --- POST /ask — SSE stream the agent's answer -----------------------------
// Wire protocol (matches the existing React widget):
//   data: {"content": "<text delta>"}
//   data: {"status": "searching_products" | ... | "completed"}
//   data: {"tool_response": {"type": "product_list", "rawProducts": [...]}}
//   data: {"suggestions": [{"label": "...", "product"?: {title, image, price}}, ...]}
//   data: {"error": "..."}
//   data: [DONE]
app.post("/ask", async (req, res) => {
  const { question, sessionId, username, customerToken, cartId } = req.body ?? {};
  if (!question || typeof question !== "string") {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > 4000) {
    res.status(400).json({ error: "question too long" });
    return;
  }
  const sid = typeof sessionId === "string" && sessionId ? sessionId : crypto.randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

  const userId = typeof username === "string" && username ? username.toLowerCase() : undefined;

  await runAgent(question, sid, userId, {
    onText: (delta) => send({ content: delta }),
    onStatus: (status) => send({ status }),
    onToolResponse: (payload) => send({ tool_response: payload }),
    onSuggestions: (suggestions) => send({ suggestions }),
    onError: (message) => send({ error: message }),
    onDone: () => {
      send("[DONE]");
      res.end();
    },
  }, typeof customerToken === "string" ? customerToken : undefined,
     typeof cartId === "string" && cartId ? cartId : undefined);
});

// --- Chat history (widget restore + clear) ---------------------------------
app.get("/api/messages/:sessionId", async (req, res) => {
  const history = await memory.getHistory(req.params.sessionId);
  res.json({
    sessionId: req.params.sessionId,
    messages: history.map((m) => ({
      role: m.role === "assistant" ? "ai" : "user",
      content: m.content,
      timestamp: new Date(m.timestamp).toISOString(),
    })),
  });
});

app.delete("/api/messages/:sessionId", async (req, res) => {
  await memory.clear(req.params.sessionId);
  res.json({ success: true, message: "Chat history cleared" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: config.provider,
    model: config.provider === "openai" ? config.openaiModel : config.model,
  });
});

app.listen(config.port, () => {
  console.log(`🤖 ob-agent-v2 listening on http://localhost:${config.port} (model: ${config.model})`);
});
