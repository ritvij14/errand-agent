import type { ExtensionAPI } from "./extension-api";
import * as fs from "node:fs";

const FLAG_FILE = ".pi/session-changed";
const STOP_SCRIPT = "scripts/on-session-stop.sh";

export default function (pi: ExtensionAPI) {
  // PostToolUse(Edit|Write) equivalent: mark the session as changed
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    try {
      fs.writeFileSync(FLAG_FILE, "");
    } catch {
      // flag best-effort only; wrap-up is advisory
    }
  });

  // Stop hook equivalent: remind about doc wrap-up when files changed
  pi.on("agent_settled", async (_event, ctx) => {
    if (!fs.existsSync(FLAG_FILE)) return;
    if (!ctx.hasUI) return;
    const result = await pi.exec("bash", [STOP_SCRIPT]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.code !== 0 || output) {
      ctx.ui.notify(output || "Session files changed — run /wrap-up before closing.", "warning");
    }
  });
}
