// Provider-neutral conversation model. Each provider converts these turns
// to its own wire format. Keeping this neutral lets the agent loop, tools,
// memory, and SSE protocol stay identical across Claude and OpenAI.

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type AgentTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "toolResults"; results: ToolResult[] };

export interface StreamTurnOpts {
  system: string;
  turns: AgentTurn[];
  onText: (delta: string) => void;
}

export interface LlmProvider {
  name: string;
  streamTurn(opts: StreamTurnOpts): Promise<{ text: string; toolCalls: ToolCall[] }>;
}
