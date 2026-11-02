// Local declarations for the subset of the pi extension API this project's extensions use.
// The real declarations live in the globally installed @earendil-works/pi-coding-agent,
// which is intentionally not a project dependency (pi loads and runs extension files itself).
export interface ToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  isError: boolean;
}

export interface AgentSettledEvent {
  type: "agent_settled";
  aborted?: boolean;
}

export interface ExtensionContext {
  hasUI: boolean;
  cwd: string;
  ui: {
    notify(message: string, style?: "info" | "warning" | "error"): void;
  };
}

export interface ExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface ExtensionAPI {
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => unknown): void;
  on(event: "agent_settled", handler: (event: AgentSettledEvent, ctx: ExtensionContext) => unknown): void;
  exec(command: string, args: string[]): Promise<ExecResult>;
}