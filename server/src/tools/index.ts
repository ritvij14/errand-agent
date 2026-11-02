// Public API of the tools feature — other features import from here only.
export {
  createToolGateway,
  TOOL_CALL_CAP,
  type CreateGatewayOpts,
  type ProviderDetails,
} from "./tool-gateway.js";
export type { ProviderSummary, ToolResult } from "./read-tools.js";
export type { ForcedQueue } from "./write-tools.js";
export { createMockSettings, DEFAULT_SEED, type MockSettings } from "./settings.js";
export { seedMockWorld, slotWindow } from "./mock-world.js";
