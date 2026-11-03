import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TracePanel } from "./TracePanel.js";

const TRACE = {
  run: {
    id: "r1",
    conversationId: "c1",
    trigger: "message",
    startedAt: 0,
    endedAt: 10,
    outcome: "completed",
    modelCalls: 2,
    toolCalls: 1,
  },
  events: [
    {
      seq: 1,
      type: "run_started",
      clockAt: 0,
      durationMs: null,
      data: { trigger: "message", phase: "none" },
    },
    { seq: 2, type: "tool_call", clockAt: 2, durationMs: 4000, data: { tool: "search_providers", ok: true } },
    {
      seq: 3,
      type: "state_transition",
      clockAt: 4,
      durationMs: null,
      data: { fromPhase: "searching", toPhase: "choosing" },
    },
  ],
  // not part of the panel's input shape, just keeps the fixture honest
};

describe("the trace panel (MH-7, FR-13)", () => {
  it("shows the timeline in event order, one line per event, coloured by type", () => {
    render(<TracePanel trace={TRACE as never} />);
    const lines = screen.getAllByRole("button", { name: /^#/ });
    expect(lines).toHaveLength(3);
    expect(lines[0]!.textContent).toContain("run_started");
    expect(lines[1]!.textContent).toContain("search_providers");
    expect(lines[1]!.textContent).toContain("(4000 ms)"); // real latency, in ms
    expect(lines[2]!.textContent).toContain("choosing");
    // colours: each line carries a per-type style token
    expect(lines[1]!.className).toContain("trace-tool_call");
    expect(lines[2]!.className).toContain("trace-state_transition");
  });

  it("a line can be expanded to show all its fields; collapsed again on second click", async () => {
    render(<TracePanel trace={TRACE as never} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^#1/ }));
    expect(screen.getByText("trigger", { exact: false }).textContent ?? "").toContain("message");
    expect(screen.getByText(/"phase"/).textContent).toContain("none");
    await user.click(screen.getByRole("button", { name: /^#1/ }));
    expect(screen.queryByText(/"phase"/)).toBeNull();
  });

  it("shows the run's outcome and call counts", () => {
    render(<TracePanel trace={TRACE as never} />);
    expect(screen.getByText(/completed/).textContent).toContain("2");
  });

  it("nothing loaded yet → a quiet placeholder", () => {
    render(<TracePanel trace={null} />);
    expect(screen.getByText(/no trace yet/i)).toBeDefined();
  });
});
