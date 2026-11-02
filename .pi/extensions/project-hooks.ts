import * as fs from "node:fs";
import { join } from "node:path";

// Local declarations for the subset of the pi extension API this extension uses.
// They are inlined because pi loads every file in .pi/extensions/ as an extension;
// a separate type-only file here exports nothing at runtime and fails startup. The
// real declarations live in the globally installed @earendil-works/pi-coding-agent,
// intentionally not a project dependency.
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

const FLAG_FILE = ".pi/session-changed";
const WRAP_UP_PROMPT = ".pi/prompts/wrap-up.md";

export default (pi: ExtensionAPI) => {
  let wrapUpRequested = false;

  pi.on("before_agent_start", () => {
    wrapUpRequested = false;
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    fs.writeFileSync(join(ctx.cwd, FLAG_FILE), "");
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome !== "completed" || event.continue) return;
    if (!fs.existsSync(join(ctx.cwd, FLAG_FILE))) return;

    if (wrapUpRequested) {
      return {
        entries: [
          {
            type: "custom_message",
            customType: "project-wrap-up-error",
            content:
              "Automatic /wrap-up did not clear .pi/session-changed. Documentation review remains incomplete. Further automatic attempts stopped to prevent a loop; the flag is retained.",
            display: true,
          },
        ],
      };
    }

    wrapUpRequested = true;
    try {
      const instructions = fs
        .readFileSync(join(ctx.cwd, WRAP_UP_PROMPT), "utf8")
        .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
        .trim();
      if (!instructions) throw new Error("The wrap-up prompt is empty.");

      return {
        entries: [
          {
            type: "custom_message",
            customType: "project-wrap-up",
            content: `Automatically invoking /wrap-up because project files changed. Complete it now without asking the user to invoke it.\n\n${instructions}`,
            display: true,
          },
        ],
        continue: true,
      };
    } catch (error) {
      return {
        entries: [
          {
            type: "custom_message",
            customType: "project-wrap-up-error",
            content: `Automatic /wrap-up could not load its instructions. Documentation review remains incomplete; .pi/session-changed is retained. ${error instanceof Error ? error.message : String(error)}`,
            display: true,
          },
        ],
      };
    }
  });
};
