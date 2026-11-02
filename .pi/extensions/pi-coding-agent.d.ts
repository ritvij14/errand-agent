// Local shim for the pi extension API when this file is opened outside a pi install:
// the real declarations live in the globally installed @earendil-works/pi-coding-agent,
// which is intentionally not a project dependency (pi loads and runs this file itself).
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionToolResultEvent {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    isError: boolean;
  }

  export interface ExtensionAgentSettledEvent {
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

  export interface ExtensionExecResult {
    code: number;
    stdout?: string;
    stderr?: string;
  }

  export interface ExtensionAPI {
    on<K extends "tool_result" | "agent_settled">(
      event: K,
      handler: (event: K extends "tool_result" ? ExtensionToolResultEvent : ExtensionAgentSettledEvent, ctx: ExtensionContext) => unknown,
    ): void;
    exec(command: string, args: string[]): Promise<ExtensionExecResult>;
  }
}