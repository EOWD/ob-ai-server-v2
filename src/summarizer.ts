// Rolling conversation summary: when a session's backlog exceeds the verbatim
// window, compress the older turns into session_state.summary so long
// conversations never fall off a cliff at turn 21.

import { memory, MAX_TURNS } from "./memory.js";
import { smallCompletion } from "./small-llm.js";

const SUMMARY_SYSTEM = `Summarize this baby-formula store customer conversation for the assistant's own future reference.
Keep (when present): baby's age and needs, products discussed/recommended, prices quoted, cart and order activity, decisions made, open questions.
Write a compact paragraph (max 150 words). If a previous summary is provided, merge it in — newest information wins.`;

export async function maybeSummarize(sessionId: string): Promise<void> {
  const backlog = await memory.getUnsummarized(sessionId);
  const excess = backlog.length - MAX_TURNS * 2;
  if (excess < 4) return; // summarize in chunks, not every message

  const state = await memory.getState(sessionId);
  const toCompress = backlog.slice(0, excess);
  const transcript = toCompress.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

  const summary = await smallCompletion(
    SUMMARY_SYSTEM,
    `${state.summary ? `Previous summary:\n${state.summary}\n\n` : ""}Conversation to fold in:\n${transcript.slice(0, 12000)}`,
  );
  if (!summary.trim()) return;

  await memory.saveState(sessionId, {
    summary: summary.trim(),
    summarizedThrough: toCompress[toCompress.length - 1].id!,
  });
}
