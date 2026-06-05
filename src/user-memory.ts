// Cross-session user memory: durable facts about the customer, extracted
// after conversations and injected into the next session's context.

import { db } from "./db.js";
import { smallCompletion } from "./small-llm.js";

export interface UserMemory {
  fact: string;
  category: string;
  confidence: string;
}

const selectMemories = db.prepare(
  "SELECT fact, category, confidence FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30",
);
const deleteMemories = db.prepare("DELETE FROM user_memories WHERE user_id = ?");
const insertMemory = db.prepare(
  "INSERT INTO user_memories (user_id, fact, category, confidence, updated_at) VALUES (?, ?, ?, ?, ?)",
);

export function getUserMemories(userId: string): UserMemory[] {
  return selectMemories.all(userId) as UserMemory[];
}

const EXTRACTION_SYSTEM = `You maintain a memory file about a customer of an organic baby formula store.
Given the existing memory facts and a new conversation transcript, return the UPDATED full list of facts as a JSON array. Rules:
- Each item: {"fact": "...", "category": "baby_profile|dietary|preferences|logistics|other", "confidence": "explicit|inferred"}
- Keep only durable facts THE CUSTOMER STATED about their own baby or situation (baby's age/birth window, allergies and sensitivities, brand/stage preferences, shipping country, feeding habits). NOT one-off questions or chit-chat.
- CRITICAL: never derive facts from product information in the assistant's answers. A product's allergen list, ingredients, or marketing copy says NOTHING about this customer's baby. "Allergens: milk, whey" in a product description does NOT mean the baby is allergic to milk. Health facts (allergies, sensitivities, medical conditions) may ONLY be stored when the customer explicitly stated them — never inferred.
- Asking about a product is weak evidence of a preference; only record a preference when the customer chose, bought, or clearly favored it.
- Convert relative ages to an absolute birth window, e.g. "baby ~6 months in June 2026" -> "baby born around December 2025".
- Newer information supersedes older facts; merge or drop superseded ones.
- Maximum 15 facts. If nothing durable was learned, return the existing facts unchanged.
- Respond with ONLY the JSON array, no prose.`;

export async function extractAndStoreMemories(userId: string, transcript: string): Promise<void> {
  const existing = getUserMemories(userId);
  const out = await smallCompletion(
    EXTRACTION_SYSTEM,
    `Existing facts:\n${JSON.stringify(existing)}\n\nCurrent date: ${new Date().toISOString().slice(0, 10)}\n\nNew conversation:\n${transcript.slice(0, 8000)}`,
  );
  let facts: UserMemory[];
  try {
    facts = JSON.parse(out.replace(/^```(json)?|```$/g, "").trim());
    if (!Array.isArray(facts)) return;
  } catch {
    return; // extraction is best-effort; never break the chat over it
  }
  const now = Date.now();
  const replaceAll = db.transaction((rows: UserMemory[]) => {
    deleteMemories.run(userId);
    for (const f of rows.slice(0, 15)) {
      if (typeof f.fact === "string" && f.fact.trim()) {
        insertMemory.run(userId, f.fact.trim(), f.category || "other", f.confidence || "inferred", now);
      }
    }
  });
  replaceAll(facts);
}
