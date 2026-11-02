import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel.js";

const FACTS = [
  {
    id: "f1",
    key: "area",
    service: null,
    value: "hsr_layout",
    source: "stated",
    status: "active",
    evidence: null,
  },
  {
    id: "f2",
    key: "earliest_time",
    service: null,
    value: "10:00",
    source: "stated",
    status: "active",
    evidence: null,
  },
  {
    id: "f3",
    key: "preferred_provider",
    service: "electrician",
    value: "mp-002",
    source: "inferred",
    status: "awaiting_confirmation",
    evidence: "booked Namma Wires & Lights on 2026-10-25 and 2026-10-30",
  },
];

describe("the memory panel (FR-12)", () => {
  it("lists facts with stated/inferred labels and notes the ones waiting for confirmation", () => {
    render(
      <MemoryPanel
        facts={FACTS as never}
        busy={false}
        onEdit={vi.fn()}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/you told me/).length).toBe(2);
    expect(screen.getByText(/waiting for your confirmation/)).toBeDefined();
    expect(screen.getByText(/HSR Layout/)).toBeDefined();
    expect(screen.getByText(/not before 10:00/)).toBeDefined();
    expect(screen.getByText(/booked Namma Wires & Lights/)).toBeDefined();
  });

  it("Edit turns the value into an input and Save reports the correction", async () => {
    const onEdit = vi.fn();
    render(
      <MemoryPanel
        facts={FACTS as never}
        busy={false}
        onEdit={onEdit}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    const input = screen.getByDisplayValue("hsr_layout") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "koramangala");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onEdit).toHaveBeenCalledWith("f1", "koramangala");
  });

  it("an awaiting fact offers Confirm and Reject; the active one offers Forget", async () => {
    const onConfirm = vi.fn();
    const onReject = vi.fn();
    const onForget = vi.fn();
    render(
      <MemoryPanel
        facts={FACTS as never}
        busy={false}
        onEdit={vi.fn()}
        onConfirm={onConfirm}
        onReject={onReject}
        onForget={onForget}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("f3");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("f3");
    await user.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    expect(onForget).toHaveBeenCalledWith("f1");
  });

  it("an empty panel says nothing is saved", () => {
    render(
      <MemoryPanel
        facts={[]}
        busy={false}
        onEdit={vi.fn()}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    expect(screen.getByText(/nothing saved/i)).toBeDefined();
  });
});
