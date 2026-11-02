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

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
}

export interface AgentBeforeSettleEvent {
  type: "agent_before_settle";
  outcome: "completed" | "aborted" | "error";
  continue: boolean;
}

export interface BoundaryResult {
  entries?: {
    type: "custom_message";
    customType: string;
    content: string;
    display: boolean;
  }[];
  continue?: boolean;
}

export interface ExtensionContext {
  hasUI: boolean;
  cwd: string;
  ui: {
    notify(message: string, style?: "info" | "warning" | "error"): void;
  };
}

export interface ExtensionAPI {
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => unknown): void;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown,
  ): void;
  on(
    event: "agent_before_settle",
    handler: (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => BoundaryResult | undefined,
  ): void;
}
